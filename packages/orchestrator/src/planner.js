// packages/orchestrator/src/planner.js
import { runCritic } from "./critic.js";
import { extractArtifactsFromPhase as defaultExtractArtifacts, mergeArtifactHistory } from "./artifact-extractor.js";

function summarizePlan(phases, currentIndex) {
  return phases
    .map((p, i) => {
      const status = i < currentIndex ? "completed" : i === currentIndex ? "RUNNING" : "pending";
      return `[${status}] ${p.id}: ${p.title ?? p.prompt}`;
    })
    .join("\n");
}

function summarizeToolTrace(trace = []) {
  if (!trace.length) return "";
  return trace
    .map((t) => `${t.tool}: ${t.status} (${t.durationMs ?? 0}ms)${t.error ? ` — ${t.error}` : ""}`)
    .join("\n");
}

function isValidPhase(phase) {
  return phase && typeof phase === "object" && typeof phase.id === "string" && typeof phase.prompt === "string";
}

function applyAmendments(phases, currentIndex, amendments) {
  if (!Array.isArray(amendments) || !amendments.length) return phases;
  let result = [...phases];
  for (const amendment of amendments) {
    if (amendment.action === "insert_phase") {
      if (!isValidPhase(amendment.phase)) {
        console.warn("[planner] ignoring insert_phase with invalid phase:", amendment.phase);
        continue;
      }
      const afterIdx = result.findIndex((p) => p.id === amendment.after);
      const insertAt = afterIdx >= 0 ? afterIdx + 1 : currentIndex + 1;
      result.splice(insertAt, 0, {
        ...amendment.phase,
        _insertedBy: `critic@${phases[currentIndex]?.id ?? "unknown"}`
      });
    } else if (amendment.action === "replace_phase" && amendment.phaseId) {
      const idx = result.findIndex((p) => p.id === amendment.phaseId);
      if (idx >= 0 && amendment.phase && typeof amendment.phase === "object") {
        result[idx] = { ...result[idx], ...amendment.phase };
      }
    } else if (amendment.action === "drop_phase" && amendment.phaseId) {
      result = result.filter((p) => p.id !== amendment.phaseId);
    }
  }
  return result;
}

export async function runIterativePlan({
  plan,
  originalGoal,
  taskType,
  executorModel,
  workspaceDir,
  extractArtifacts,
  invokeModel,
  resolveProvider,
  hasApiKey,
  getCriticModel,
  emitStatus,
  onChunk,
  budget,
  systemMessage,
  conversationMessages,
  enrichedPrompt
}) {
  const startedAt = Date.now();
  const extractArtifactsFn = extractArtifacts ?? defaultExtractArtifacts;
  let phases = [...(plan.phases ?? [])];
  const ledger = {
    startedAt,
    endedAt: null,
    outcome: null,
    phases: [],
    budget: { phasesUsed: 0, wallClockMs: 0, tokensUsed: 0 }
  };
  let lastContent = "";
  let phaseIndex = 0;
  let totalPhasesExecuted = 0;

  const maxPhases = budget?.maxTotalPhases ?? 12;
  const maxWallMs = budget?.maxWallClockMs ?? 10 * 60 * 1000;
  const maxCriticRounds = budget?.maxCriticRoundsPerPhase ?? 2;

  const criticSelection = getCriticModel();

  while (phaseIndex < phases.length) {
    // Budget check: phases
    if (totalPhasesExecuted >= maxPhases) {
      emitStatus?.(`Budget exhausted (${maxPhases} phases) — returning best-effort`);
      ledger.outcome = "budget_exhausted";
      break;
    }
    // Budget check: wall clock
    if (Date.now() - startedAt > maxWallMs) {
      emitStatus?.(`Budget exhausted (${Math.round(maxWallMs / 1000)}s wall clock) — returning best-effort`);
      ledger.outcome = "budget_exhausted";
      break;
    }

    const phaseStartedAt = Date.now();
    totalPhasesExecuted += 1;

    const phase = phases[phaseIndex];
    const phaseNum = phaseIndex + 1;
    const totalPhases = phases.length;
    const phaseEntry = {
      id: phase.id,
      intent: phase.title ?? phase.prompt,
      executorModel: null,
      criticModel: criticSelection?.model ?? null,
      attempts: 0,
      status: "running",
      criticVerdicts: [],
      durationMs: 0,
      _insertedBy: phase._insertedBy ?? null
    };
    ledger.phases.push(phaseEntry);

    let accepted = false;
    let retryGuidance = null;

    for (let attempt = 0; attempt < maxCriticRounds; attempt += 1) {
      phaseEntry.attempts = attempt + 1;

      emitStatus?.(`Running phase ${phaseNum}/${totalPhases}: ${phase.title ?? phase.prompt}...`);

      // Resolve a provider for this phase
      const phaseModel = phase.modelOverride ?? executorModel ?? "gpt-5.4";
      const providerId = resolveProvider?.(phaseModel) ?? "openai";
      phaseEntry.executorModel = phaseModel;

      // Build messages for the phase
      const retryNote = retryGuidance
        ? `\n\nIMPORTANT — RETRY GUIDANCE from the critic: ${retryGuidance}`
        : "";
      const phasePrompt = `${phase.prompt}${retryNote}`;

      try {
        const result = await invokeModel({
          providerId,
          model: phaseEntry.executorModel,
          prompt: phasePrompt,
          messages: [
            { role: "system", content: systemMessage ?? "You are a capable assistant." },
            ...(conversationMessages ?? []),
            { role: "user", content: phasePrompt }
          ],
          taskType: phase.activity ?? taskType,
          taskContext: {},
          suppressStream: true
        });

        lastContent = result?.content ?? "";
        const phaseToolTrace = result?.toolTrace ?? [];
        phaseEntry.toolTrace = phaseToolTrace;

        // ── L1: extract artifacts produced by this phase ──
        const phaseEndedAt = Date.now();
        try {
          phaseEntry.artifacts = await extractArtifactsFn({
            phaseToolTrace,
            workspaceDir,
            phaseId: phase.id,
            runId: plan.taskId ?? "adhoc",
            phaseStartedAt,
            phaseEndedAt
          });
        } catch (extractErr) {
          console.warn(`[planner] artifact extraction failed for ${phase.id}:`, extractErr?.message ?? extractErr);
          phaseEntry.artifacts = [];
        }

        // Run the critic
        if (criticSelection) {
          emitStatus?.(`Critic reviewing phase ${phaseNum} (${criticSelection.model})...`);
          const verdict = await runCritic({
            invokeModel,
            criticModel: criticSelection.model,
            criticProvider: criticSelection.provider,
            originalGoal,
            taskType,
            planSummary: summarizePlan(phases, phaseIndex),
            phaseId: phase.id,
            phaseIntent: phase.title ?? phase.prompt,
            phaseResult: lastContent.slice(0, 3000),
            toolTraceSummary: summarizeToolTrace(phaseToolTrace),
            artifacts: phaseEntry.artifacts
          });

          phaseEntry.criticVerdicts.push(verdict);

          if (verdict.decision === "accept") {
            emitStatus?.(`Phase ${phaseNum} accepted — advancing...`);
            phaseEntry.status = "accepted";
            accepted = true;
            break;
          }

          if (verdict.decision === "retry_phase") {
            retryGuidance = verdict.retryGuidance ?? verdict.reasoning;
            emitStatus?.(`Retrying phase ${phaseNum} (attempt ${attempt + 2}/${maxCriticRounds})...`);
            continue;
          }

          if (verdict.decision === "amend_plan") {
            let amended;
            try {
              amended = applyAmendments(phases, phaseIndex, verdict.amendments);
            } catch (err) {
              console.error("[planner] amendment application failed, treating as accept:", err);
              amended = phases;
            }
            const addedCount = amended.length - phases.length;
            phases = amended;
            emitStatus?.(`Amending plan (${addedCount > 0 ? `+${addedCount}` : addedCount} phases)...`);
            phaseEntry.status = "accepted";
            accepted = true;
            break;
          }

          if (verdict.decision === "escalate") {
            emitStatus?.(`Escalating: ${verdict.escalationReason ?? verdict.reasoning}`);
            phaseEntry.status = "escalated";
            ledger.outcome = "escalated";
            ledger.endedAt = Date.now();
            ledger.budget.wallClockMs = Date.now() - startedAt;
            ledger.budget.phasesUsed = totalPhasesExecuted;
            const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
            ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
            return {
              outcome: "escalated",
              content: lastContent,
              pendingApproval: true,
              escalationReason: verdict.escalationReason ?? verdict.reasoning,
              ledger
            };
          }
        } else {
          // No critic available — optimistic accept
          phaseEntry.status = "accepted";
          accepted = true;
          break;
        }
      } catch (err) {
        console.error(`[planner] phase ${phase.id} failed:`, err?.message ?? err);
        phaseEntry.status = "error";
        phaseEntry.error = err?.message ?? String(err);
        break;
      }
    }

    // Retry budget exhausted — force escalate
    if (!accepted && phaseEntry.status === "running") {
      const lastVerdict = phaseEntry.criticVerdicts[phaseEntry.criticVerdicts.length - 1];
      const reason = `Retry budget exhausted for phase ${phase.id} after ${phaseEntry.attempts} attempts — last critic reasoning: ${lastVerdict?.reasoning ?? "unknown"}`;
      emitStatus?.(`Escalating: ${reason}`);
      phaseEntry.status = "escalated";
      phaseEntry.durationMs = Date.now() - phaseStartedAt;
      ledger.outcome = "escalated";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
      return {
        outcome: "escalated",
        content: lastContent,
        pendingApproval: true,
        escalationReason: reason,
        ledger
      };
    }

    // Execution error — terminate as failed (spec §9 outcome)
    if (phaseEntry.status === "error") {
      emitStatus?.(`Phase ${phaseNum} failed: ${phaseEntry.error} — terminating run`);
      phaseEntry.durationMs = Date.now() - phaseStartedAt;
      ledger.outcome = "failed";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
      return {
        outcome: "failed",
        content: lastContent,
        pendingApproval: false,
        error: phaseEntry.error,
        ledger
      };
    }

    phaseEntry.durationMs = Date.now() - phaseStartedAt;
    phaseIndex += 1;
  }

  if (!ledger.outcome) {
    ledger.outcome = "success";
  }
  ledger.endedAt = Date.now();
  ledger.budget.wallClockMs = Date.now() - startedAt;
  ledger.budget.phasesUsed = totalPhasesExecuted;

  // ── L1: merge phase-level artifacts into a run-level list ──
  const allArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
  ledger.artifacts = mergeArtifactHistory(allArtifacts);

  return {
    outcome: ledger.outcome,
    content: lastContent,
    pendingApproval: ledger.outcome === "escalated",
    ledger
  };
}
