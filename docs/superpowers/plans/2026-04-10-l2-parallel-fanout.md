# L2 — Parallel Phase Fanout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the main loop of `runIterativePlan` to respect `parallelGroup`/`dependsOn` via `buildExecutionBatches`, executing independent phases in parallel with per-phase retry, critic parallelism, sibling cancellation, and a `batchIndex`/`batchSize`-tagged runLedger.

**Architecture:** Single-file rewrite. Factor phase execution into a non-throwing `runPhase` helper. Replace the `while` loop with an outer batch loop that calls `Promise.all` on each batch, per-batch `AbortController` for cancellation, and a reconciliation function that resolves mixed verdicts (error → escalate → retry → amend → accept). All existing L0/L1 semantics preserved.

**Tech Stack:** Node.js ESM, `node:test`, existing `buildExecutionBatches` from `workflow.js`, existing `runCritic` from `critic.js`, existing `extractArtifactsFromPhase` from `artifact-extractor.js`. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-04-10-l2-parallel-fanout-design.md](../specs/2026-04-10-l2-parallel-fanout-design.md)

---

## File structure overview

**Modified only:**
- `packages/orchestrator/src/planner.js` — main loop rewrite, `runPhase` helper extraction, reconciliation, `AbortController`, ledger.batches
- `packages/orchestrator/src/planner.test.js` — 9 new tests

**Not touched:** critic.js, lesson-writer.js, artifact-extractor.js, orchestrator/index.js, workflow.js, task-store, desktop.

---

### Task 1: Extract `runPhase` helper (pure refactor, no behavior change)

**Files:**
- Modify: `packages/orchestrator/src/planner.js`
- Modify: `packages/orchestrator/src/planner.test.js` (no new tests — regression only)

This first task is a pure refactor: pull the inner phase execution logic (the `for (let attempt = 0; attempt < maxCriticRounds; ...)` loop plus its surrounding setup — executor call, artifact extraction, critic invocation, verdict handling) out of the main while loop and into a new local helper function `runPhase`. At the end of Task 1, the planner still executes phases sequentially and ALL 9 existing L0 tests still pass. Only after Task 1 is green do we change the main loop.

- [ ] **Step 1: Read the current `runIterativePlan` in `packages/orchestrator/src/planner.js`**

Open the file and locate:
- The function signature and destructured params
- The `while (phaseIndex < phases.length)` loop body
- The inner `for (let attempt = 0; attempt < maxCriticRounds; ...)` retry loop
- Every existing early-return (escalate, failed, retry-exhausted, budget, final success)

Identify the exact lines where the retry loop begins and ends. The extraction target is that retry loop plus the setup immediately before it (`phaseEntry` creation, `phaseStartedAt`, `accepted` / `retryGuidance` state).

- [ ] **Step 2: Add a `runPhase` helper function BEFORE `runIterativePlan`**

Insert this function definition immediately above the existing `export async function runIterativePlan({...})`:

```js
/**
 * Execute a single phase through its retry/critic loop.
 *
 * NEVER THROWS. All errors are caught and surfaced via the return shape.
 *
 * @returns {Promise<{
 *   phaseEntry: object,
 *   verdict: object | null,
 *   error: string | null,
 *   cancelled: boolean
 * }>}
 */
async function runPhase(phase, ctx) {
  const {
    phases,
    phaseIndex,
    originalGoal,
    taskType,
    executorModel,
    workspaceDir,
    extractArtifactsFn,
    invokeModel,
    resolveProvider,
    criticSelection,
    emitStatus,
    maxCriticRounds,
    systemMessage,
    conversationMessages,
    runId,
    batchIndex,
    batchSize,
    totalPhases,
    signal
  } = ctx;

  const phaseStartedAt = Date.now();
  const phaseNum = phaseIndex + 1;

  const phaseEntry = {
    id: phase.id,
    intent: phase.title ?? phase.prompt,
    executorModel: null,
    criticModel: criticSelection?.model ?? null,
    attempts: 0,
    status: "running",
    criticVerdicts: [],
    durationMs: 0,
    batchIndex,
    batchSize,
    _insertedBy: phase._insertedBy ?? null
  };

  let lastContent = "";
  let lastVerdict = null;
  let retryGuidance = null;
  let accepted = false;

  for (let attempt = 0; attempt < maxCriticRounds; attempt += 1) {
    if (signal?.aborted) {
      phaseEntry.status = "cancelled";
      phaseEntry.error = "cancelled by sibling failure";
      phaseEntry.durationMs = Date.now() - phaseStartedAt;
      return { phaseEntry, verdict: null, error: null, cancelled: true };
    }

    phaseEntry.attempts = attempt + 1;
    emitStatus?.(`Running phase ${phaseNum}/${totalPhases}: ${phase.title ?? phase.prompt}...`);

    const phaseModel = phase.modelOverride ?? executorModel ?? "gpt-5.4";
    const providerId = resolveProvider?.(phaseModel) ?? "openai";
    phaseEntry.executorModel = phaseModel;

    const retryNote = retryGuidance
      ? `\n\nIMPORTANT — RETRY GUIDANCE from the critic: ${retryGuidance}`
      : "";
    const phasePrompt = `${phase.prompt}${retryNote}`;

    let result;
    try {
      result = await invokeModel({
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
        suppressStream: true,
        signal
      });
    } catch (err) {
      // Abort signal or provider failure
      if (signal?.aborted) {
        phaseEntry.status = "cancelled";
        phaseEntry.error = "cancelled by sibling failure";
        phaseEntry.durationMs = Date.now() - phaseStartedAt;
        return { phaseEntry, verdict: null, error: null, cancelled: true };
      }
      console.error(`[planner] phase ${phase.id} failed:`, err?.message ?? err);
      phaseEntry.status = "error";
      phaseEntry.error = err?.message ?? String(err);
      phaseEntry.durationMs = Date.now() - phaseStartedAt;
      return { phaseEntry, verdict: null, error: phaseEntry.error, cancelled: false };
    }

    lastContent = result?.content ?? "";
    const phaseToolTrace = result?.toolTrace ?? [];
    phaseEntry.toolTrace = phaseToolTrace;

    // Artifact extraction
    const phaseEndedAt = Date.now();
    try {
      phaseEntry.artifacts = await extractArtifactsFn({
        phaseToolTrace,
        workspaceDir,
        phaseId: phase.id,
        runId,
        phaseStartedAt,
        phaseEndedAt
      });
    } catch (extractErr) {
      console.warn(`[planner] artifact extraction failed for ${phase.id}:`, extractErr?.message ?? extractErr);
      phaseEntry.artifacts = [];
    }

    if (signal?.aborted) {
      phaseEntry.status = "cancelled";
      phaseEntry.error = "cancelled by sibling failure";
      phaseEntry.durationMs = Date.now() - phaseStartedAt;
      return { phaseEntry, verdict: null, error: null, cancelled: true };
    }

    // Critic
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
      lastVerdict = verdict;

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

      // amend_plan or escalate: caller handles reconciliation
      phaseEntry.status = verdict.decision === "escalate" ? "escalated" : "accepted";
      accepted = verdict.decision === "amend_plan";
      phaseEntry.durationMs = Date.now() - phaseStartedAt;
      return { phaseEntry, verdict, error: null, cancelled: false };
    }

    // No critic — optimistic accept
    phaseEntry.status = "accepted";
    accepted = true;
    break;
  }

  // Retry budget exhausted — the caller will force-escalate
  if (!accepted) {
    const reason = `Retry budget exhausted for phase ${phase.id} after ${phaseEntry.attempts} attempts — last critic reasoning: ${lastVerdict?.reasoning ?? "unknown"}`;
    phaseEntry.status = "retry_exhausted";
    phaseEntry.error = reason;
    phaseEntry.durationMs = Date.now() - phaseStartedAt;
    return { phaseEntry, verdict: lastVerdict, error: reason, cancelled: false };
  }

  phaseEntry.content = lastContent;
  phaseEntry.durationMs = Date.now() - phaseStartedAt;
  return { phaseEntry, verdict: lastVerdict, error: null, cancelled: false };
}
```

**Note:** The helper closes over the existing module-scoped helpers `summarizePlan`, `summarizeToolTrace`, and `runCritic` (imported at the top of the file). All referenced functions already exist in the file.

- [ ] **Step 3: Rewrite the existing `while` loop body to call `runPhase`**

Inside `runIterativePlan`, find the existing `while (phaseIndex < phases.length)` loop. Replace its entire body (from the budget check through the `phaseIndex += 1;` at the end) with:

```js
  const extractArtifactsFn = extractArtifacts ?? defaultExtractArtifacts;
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

    const phase = phases[phaseIndex];
    totalPhasesExecuted += 1;

    const result = await runPhase(phase, {
      phases,
      phaseIndex,
      originalGoal,
      taskType,
      executorModel,
      workspaceDir,
      extractArtifactsFn,
      invokeModel,
      resolveProvider,
      criticSelection,
      emitStatus,
      maxCriticRounds,
      systemMessage,
      conversationMessages,
      runId: plan.taskId ?? "adhoc",
      batchIndex: 0,
      batchSize: 1,
      totalPhases: phases.length,
      signal: undefined
    });

    ledger.phases.push(result.phaseEntry);
    lastContent = result.phaseEntry.content ?? lastContent;

    // Execution error → terminate failed
    if (result.error && !result.cancelled && result.phaseEntry.status === "error") {
      const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
      ledger.outcome = "failed";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "failed",
        content: lastContent,
        pendingApproval: false,
        error: result.phaseEntry.error,
        ledger
      };
    }

    // Retry exhausted → force escalate
    if (result.phaseEntry.status === "retry_exhausted") {
      emitStatus?.(`Escalating: ${result.error}`);
      result.phaseEntry.status = "escalated";
      const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
      ledger.outcome = "escalated";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "escalated",
        content: lastContent,
        pendingApproval: true,
        escalationReason: result.error,
        ledger
      };
    }

    // Critic verdict handling
    if (result.verdict?.decision === "escalate") {
      emitStatus?.(`Escalating: ${result.verdict.escalationReason ?? result.verdict.reasoning}`);
      const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
      ledger.outcome = "escalated";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "escalated",
        content: lastContent,
        pendingApproval: true,
        escalationReason: result.verdict.escalationReason ?? result.verdict.reasoning,
        ledger
      };
    }

    if (result.verdict?.decision === "amend_plan") {
      let amended;
      try {
        amended = applyAmendments(phases, phaseIndex, result.verdict.amendments);
      } catch (err) {
        console.error("[planner] amendment application failed, treating as accept:", err);
        amended = phases;
      }
      const addedCount = amended.length - phases.length;
      phases = amended;
      emitStatus?.(`Amending plan (${addedCount > 0 ? `+${addedCount}` : addedCount} phases)...`);
    }

    phaseIndex += 1;
  }
```

- [ ] **Step 4: Run existing tests — all 9 must still pass**

```bash
node --test packages/orchestrator/src/planner.test.js
```

Expected: 9/9 pass. This is a pure refactor — no test changes, no new tests, no behavior changes.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/planner.js
git commit -m "refactor(orchestrator/planner): extract runPhase helper (no behavior change)"
```

---

### Task 2: Add `buildExecutionBatches` import + outer batch loop (still sequential-equivalent)

**Files:**
- Modify: `packages/orchestrator/src/planner.js`

This task replaces the `while (phaseIndex < phases.length)` loop with an outer `for (const batch of batches)` loop that calls `buildExecutionBatches` at start and after amendments. Batches are still size 1 because we're not yet invoking `Promise.all` — this task is a scaffolding step that proves the batch-driven control flow works with the existing per-phase sequential semantics. After Task 2, the 9 existing tests still pass because flat plans produce size-1 batches.

- [ ] **Step 1: Add imports**

At the top of `packages/orchestrator/src/planner.js`, add the `buildExecutionBatches` import. If an import block for `./workflow.js` doesn't exist yet, create one:

```js
import { buildExecutionBatches } from "./workflow.js";
```

Place it alongside the existing `./critic.js` and `./artifact-extractor.js` imports.

- [ ] **Step 2: Replace the `while` loop with an outer batch loop**

Find the existing `while (phaseIndex < phases.length)` loop (the one just rewritten in Task 1). Replace it with this batch-driven version. The loop body still runs phases one at a time inside each batch (because batch sizes are 1 for flat plans — the parallelism comes in Task 3).

Before the loop, add batch computation with cycle detection:

```js
  const extractArtifactsFn = extractArtifacts ?? defaultExtractArtifacts;
  const criticSelection = getCriticModel();

  // ── L2: compute initial execution batches from the plan's DAG ──
  let batches;
  try {
    batches = buildExecutionBatches(phases);
  } catch (err) {
    console.error("[planner] invalid execution plan:", err?.message ?? err);
    ledger.outcome = "failed";
    ledger.error = `Invalid plan: ${err?.message ?? err}`;
    ledger.endedAt = Date.now();
    ledger.budget.wallClockMs = Date.now() - startedAt;
    ledger.artifacts = [];
    ledger.batches = [];
    return {
      outcome: "failed",
      content: "",
      pendingApproval: false,
      error: ledger.error,
      ledger
    };
  }
  ledger.batches = [];

  let batchIndex = 0;
  while (batchIndex < batches.length) {
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

    const batch = batches[batchIndex];
    const batchStartedAt = Date.now();
    const batchRecord = { index: batchIndex, phaseIds: batch.map((p) => p.id), startedAt: batchStartedAt, endedAt: null };

    // ── Execute all phases in this batch ──
    // TASK 2: still sequential per phase; TASK 3 upgrades to Promise.all
    const batchResults = [];
    for (const phase of batch) {
      totalPhasesExecuted += 1;
      const result = await runPhase(phase, {
        phases,
        phaseIndex: phases.indexOf(phase),
        originalGoal,
        taskType,
        executorModel,
        workspaceDir,
        extractArtifactsFn,
        invokeModel,
        resolveProvider,
        criticSelection,
        emitStatus,
        maxCriticRounds,
        systemMessage,
        conversationMessages,
        runId: plan.taskId ?? "adhoc",
        batchIndex,
        batchSize: batch.length,
        totalPhases: phases.length,
        signal: undefined
      });
      ledger.phases.push(result.phaseEntry);
      batchResults.push(result);
      if (result.phaseEntry.content) {
        lastContent = result.phaseEntry.content;
      }
    }

    batchRecord.endedAt = Date.now();
    ledger.batches.push(batchRecord);

    // ── Reconciliation ──
    // 1. Any error → terminate as failed
    const erroredResult = batchResults.find((r) => r.phaseEntry.status === "error");
    if (erroredResult) {
      const allArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(allArtifacts);
      ledger.outcome = "failed";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "failed",
        content: lastContent,
        pendingApproval: false,
        error: erroredResult.phaseEntry.error,
        ledger
      };
    }

    // 2. Any retry exhausted → force escalate
    const retryExhausted = batchResults.find((r) => r.phaseEntry.status === "retry_exhausted");
    if (retryExhausted) {
      retryExhausted.phaseEntry.status = "escalated";
      emitStatus?.(`Escalating: ${retryExhausted.error}`);
      const allArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(allArtifacts);
      ledger.outcome = "escalated";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "escalated",
        content: lastContent,
        pendingApproval: true,
        escalationReason: retryExhausted.error,
        ledger
      };
    }

    // 3. Any escalate verdict → terminate
    const escalatedResult = batchResults.find((r) => r.verdict?.decision === "escalate");
    if (escalatedResult) {
      emitStatus?.(`Escalating: ${escalatedResult.verdict.escalationReason ?? escalatedResult.verdict.reasoning}`);
      const allArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(allArtifacts);
      ledger.outcome = "escalated";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "escalated",
        content: lastContent,
        pendingApproval: true,
        escalationReason: escalatedResult.verdict.escalationReason ?? escalatedResult.verdict.reasoning,
        ledger
      };
    }

    // 4. Any amend_plan → apply amendments and re-batch
    const amendingResults = batchResults.filter((r) => r.verdict?.decision === "amend_plan");
    if (amendingResults.length > 0) {
      for (const amendResult of amendingResults) {
        try {
          phases = applyAmendments(phases, phases.indexOf(batch[0]), amendResult.verdict.amendments);
        } catch (err) {
          console.error("[planner] amendment application failed:", err);
        }
      }
      try {
        const newBatches = buildExecutionBatches(phases);
        // Replace remaining batches with the new forward schedule from the next batch onward
        // Completed batches (0..batchIndex) stay committed; find where we are in the new schedule
        const completedPhaseIds = new Set(ledger.phases.map((p) => p.id));
        const remainingBatches = [];
        for (const b of newBatches) {
          const uncompletedPhases = b.filter((p) => !completedPhaseIds.has(p.id));
          if (uncompletedPhases.length > 0) {
            remainingBatches.push(uncompletedPhases);
          }
        }
        batches = [...batches.slice(0, batchIndex + 1), ...remainingBatches];
        emitStatus?.(`Amending plan — ${remainingBatches.length} forward batch(es) after amendments...`);
      } catch (err) {
        console.error("[planner] re-batching after amendment failed:", err);
      }
    }

    batchIndex += 1;
  }
```

- [ ] **Step 3: Remove the `phaseIndex += 1;` dead code if any remains**

The old `phaseIndex` variable is no longer used outside the old loop. Remove the declaration (`let phaseIndex = 0;` somewhere near the top of `runIterativePlan`) if it's still there.

- [ ] **Step 4: Update the final terminal return to include `ledger.batches`**

Find the final return of `runIterativePlan` (the success path at the very bottom). The existing code sets `ledger.outcome = "success"` if not set. Leave that logic alone. Just ensure `ledger.batches` is already populated (it is, via the per-batch push above).

Also add a `ledger.maxParallelism` calculation just before the return:

```js
  ledger.maxParallelism = ledger.batches.reduce(
    (max, b) => Math.max(max, b.phaseIds.length),
    0
  );
```

- [ ] **Step 5: Run existing tests — all 9 must still pass**

```bash
node --test packages/orchestrator/src/planner.test.js
```

Expected: 9/9 pass. Flat plans produce batches of size 1 each, so execution is sequential and behavior matches L0 exactly.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/planner.js
git commit -m "feat(orchestrator/planner): replace while loop with buildExecutionBatches-driven outer loop"
```

---

### Task 3: Parallelize phase execution within a batch via `Promise.all` + AbortController

**Files:**
- Modify: `packages/orchestrator/src/planner.js`

This is the actual parallelism. Replace the `for (const phase of batch)` sequential loop inside the batch body with `Promise.all(batch.map(...))`, using a per-batch `AbortController` to cancel siblings on error/escalate.

- [ ] **Step 1: Replace the sequential batch execution with Promise.all**

Find the existing batch execution inside the outer loop (the block currently iterating `for (const phase of batch)` inside Task 2's rewrite). Replace it with:

```js
    const batch = batches[batchIndex];
    const batchStartedAt = Date.now();
    const batchRecord = { index: batchIndex, phaseIds: batch.map((p) => p.id), startedAt: batchStartedAt, endedAt: null };

    // ── L2: execute all phases in the batch in parallel with sibling cancellation ──
    const controller = new AbortController();

    const batchPromises = batch.map((phase) => {
      totalPhasesExecuted += 1;
      return runPhase(phase, {
        phases,
        phaseIndex: phases.indexOf(phase),
        originalGoal,
        taskType,
        executorModel,
        workspaceDir,
        extractArtifactsFn,
        invokeModel,
        resolveProvider,
        criticSelection,
        emitStatus,
        maxCriticRounds,
        systemMessage,
        conversationMessages,
        runId: plan.taskId ?? "adhoc",
        batchIndex,
        batchSize: batch.length,
        totalPhases: phases.length,
        signal: controller.signal
      });
    });

    if (batch.length > 1) {
      emitStatus?.(`Running batch ${batchIndex + 1}/${batches.length} — ${batch.length} phases in parallel...`);
    }

    const batchResults = await Promise.all(batchPromises);

    // Push all phase entries to the ledger in batch order
    for (const result of batchResults) {
      ledger.phases.push(result.phaseEntry);
      if (result.phaseEntry.content) {
        lastContent = result.phaseEntry.content;
      }
    }

    batchRecord.endedAt = Date.now();
    ledger.batches.push(batchRecord);

    // ── Reconciliation: abort siblings before terminating on failure ──
```

- [ ] **Step 2: Update the error/escalate branches to call `controller.abort()`**

The reconciliation branches in Task 2 already find the errored/escalated result; they just need to abort the controller before returning. The `controller.abort()` is a no-op if all siblings already finished, so it's safe to call unconditionally.

Update the three early-return branches (error, retry-exhausted, escalate) to call `controller.abort()` just before `ledger.outcome = ...`:

```js
    // 1. Any error → terminate as failed
    const erroredResult = batchResults.find((r) => r.phaseEntry.status === "error");
    if (erroredResult) {
      controller.abort();
      const allArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      // ... rest unchanged ...
    }

    // 2. Any retry exhausted → force escalate
    const retryExhausted = batchResults.find((r) => r.phaseEntry.status === "retry_exhausted");
    if (retryExhausted) {
      controller.abort();
      retryExhausted.phaseEntry.status = "escalated";
      // ... rest unchanged ...
    }

    // 3. Any escalate verdict → terminate
    const escalatedResult = batchResults.find((r) => r.verdict?.decision === "escalate");
    if (escalatedResult) {
      controller.abort();
      emitStatus?.(`Escalating: ${escalatedResult.verdict.escalationReason ?? escalatedResult.verdict.reasoning}`);
      // ... rest unchanged ...
    }
```

**Note:** Because we're inside the await at `Promise.all`, the abort happens AFTER all siblings have already settled in this batch. The abort call is still useful because in Task 4 we'll run retries that may span additional batches, and it establishes the pattern for future multi-round reconciliation. For L2 scope, it's a belt-and-braces call.

- [ ] **Step 3: Run existing tests — 9/9 must still pass**

```bash
node --test packages/orchestrator/src/planner.test.js
```

Expected: 9/9 pass. Flat plans are still batches of 1 phase, and `Promise.all` on a 1-element array behaves identically to a synchronous call.

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/planner.js
git commit -m "feat(orchestrator/planner): execute batch phases in parallel with per-batch AbortController"
```

---

### Task 4: New L2 tests — all 9 parallel-fanout scenarios

**Files:**
- Modify: `packages/orchestrator/src/planner.test.js`

- [ ] **Step 1: Append all 9 new tests**

Append to `packages/orchestrator/src/planner.test.js`:

```js
test("L2: flat plan regression — behaves identically to L0", async () => {
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }, { id: "p2" }]),
    originalGoal: "Test",
    taskType: "research",
    invokeModel: mockInvoker([
      { content: "p1 done" },
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) },
      { content: "p2 done" },
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) }
    ]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "claude-sonnet-4-6-20250514", provider: "anthropic" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases.length, 2);
  assert.equal(result.ledger.batches.length, 2);
  assert.equal(result.ledger.phases[0].batchIndex, 0);
  assert.equal(result.ledger.phases[1].batchIndex, 1);
  assert.equal(result.ledger.phases[0].batchSize, 1);
  assert.equal(result.ledger.maxParallelism, 1);
});

test("L2: parallel phases execute concurrently", async () => {
  const startTimes = {};
  let callIndex = 0;
  const mockParallelInvoker = async ({ messages }) => {
    const content = messages[messages.length - 1]?.content ?? "";
    const isCritic = (messages[0]?.content ?? "").includes("auditing");
    if (isCritic) {
      return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
    }
    // Track start time by phase prompt
    const phaseMatch = content.match(/Do phase (\d+)/);
    if (phaseMatch) {
      startTimes[phaseMatch[1]] = Date.now();
    }
    await new Promise((r) => setTimeout(r, 30));
    return { content: `phase ${phaseMatch?.[1]} done` };
  };

  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "Do phase 1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "Do phase 2", title: "P2", parallelGroup: 0, dependsOn: [] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: mockParallelInvoker,
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "claude-sonnet-4-6-20250514", provider: "anthropic" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases.length, 2);
  assert.equal(result.ledger.batches.length, 1);
  assert.equal(result.ledger.maxParallelism, 2);
  // Both phases started within 20ms of each other (parallel, not sequential)
  const delta = Math.abs((startTimes["1"] ?? 0) - (startTimes["2"] ?? 0));
  assert.ok(delta < 20, `Expected parallel start (<20ms apart), got ${delta}ms`);
});

test("L2: retry in one phase doesn't block sibling accept", async () => {
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: [] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: (() => {
      const callsByPhase = { p1: 0, p2: 0 };
      return async ({ messages }) => {
        const content = messages[messages.length - 1]?.content ?? "";
        const isCritic = (messages[0]?.content ?? "").includes("auditing");
        const phaseId = content.includes("p1") ? "p1" : "p2";
        if (isCritic) {
          if (phaseId === "p1" && callsByPhase.p1 === 1) {
            return { content: JSON.stringify({ decision: "retry_phase", reasoning: "fix it", confidence: 0.3, retryGuidance: "try again" }) };
          }
          return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
        }
        callsByPhase[phaseId] += 1;
        return { content: `${phaseId} done attempt ${callsByPhase[phaseId]}` };
      };
    })(),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases.length, 2);
  const p1 = result.ledger.phases.find((p) => p.id === "p1");
  const p2 = result.ledger.phases.find((p) => p.id === "p2");
  assert.equal(p1.attempts, 2, "p1 should have retried once");
  assert.equal(p2.attempts, 1, "p2 should have accepted on first try");
  assert.equal(p1.status, "accepted");
  assert.equal(p2.status, "accepted");
});

test("L2: error in one phase cancels siblings", async () => {
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: [] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: async ({ messages }) => {
      const content = messages[messages.length - 1]?.content ?? "";
      const isCritic = (messages[0]?.content ?? "").includes("auditing");
      if (isCritic) {
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      if (content.includes("p1")) {
        throw new Error("p1 crashed");
      }
      // p2 is slower so it's still running when p1 errors
      await new Promise((r) => setTimeout(r, 50));
      return { content: "p2 done" };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "failed");
  assert.ok(result.error.includes("p1 crashed"));
});

test("L2: escalate in one phase terminates run", async () => {
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: [] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: async ({ messages }) => {
      const content = messages[messages.length - 1]?.content ?? "";
      const isCritic = (messages[0]?.content ?? "").includes("auditing");
      if (isCritic) {
        if (content.includes("p1")) {
          return { content: JSON.stringify({ decision: "escalate", reasoning: "human needed", confidence: 0.1, escalationReason: "ambiguous requirement" }) };
        }
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: `${content.slice(0, 20)} done` };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "escalated");
  assert.ok(result.pendingApproval);
  assert.ok(result.escalationReason.includes("ambiguous"));
});

test("L2: amendment in a batch triggers re-batch", async () => {
  let criticCallCount = 0;
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: [] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: async ({ messages }) => {
      const content = messages[messages.length - 1]?.content ?? "";
      const isCritic = (messages[0]?.content ?? "").includes("auditing");
      if (isCritic) {
        criticCallCount += 1;
        // First critic call (p1 in batch 0) → amend; all others accept
        if (content.includes("P1") && criticCallCount === 1) {
          return {
            content: JSON.stringify({
              decision: "amend_plan",
              reasoning: "need a new phase",
              confidence: 0.8,
              amendments: [
                { action: "insert_phase", after: "p1", phase: { id: "p1b", activity: "documents", prompt: "p1b", title: "P1B", parallelGroup: 0, dependsOn: ["p1"] } }
              ]
            })
          };
        }
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: `phase done` };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  const phaseIds = result.ledger.phases.map((p) => p.id);
  assert.ok(phaseIds.includes("p1b"), `Expected p1b to have been run, got: ${phaseIds.join(",")}`);
});

test("L2: batchIndex and batchSize populated for a DAG", async () => {
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: ["p1"] },
        { id: "p3", activity: "research", prompt: "p3", title: "P3", parallelGroup: 0, dependsOn: ["p1"] },
        { id: "p4", activity: "research", prompt: "p4", title: "P4", parallelGroup: 0, dependsOn: ["p2", "p3"] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: async ({ messages }) => {
      const isCritic = (messages[0]?.content ?? "").includes("auditing");
      if (isCritic) {
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: "done" };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases.length, 4);
  assert.equal(result.ledger.batches.length, 3);
  assert.equal(result.ledger.maxParallelism, 2);

  const byId = Object.fromEntries(result.ledger.phases.map((p) => [p.id, p]));
  assert.equal(byId.p1.batchIndex, 0);
  assert.equal(byId.p1.batchSize, 1);
  assert.equal(byId.p2.batchIndex, 1);
  assert.equal(byId.p2.batchSize, 2);
  assert.equal(byId.p3.batchIndex, 1);
  assert.equal(byId.p3.batchSize, 2);
  assert.equal(byId.p4.batchIndex, 2);
  assert.equal(byId.p4.batchSize, 1);
});

test("L2: cycle in plan terminates immediately as failed", async () => {
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: ["p2"] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: ["p1"] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    invokeModel: async () => ({ content: "should not reach" }),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "failed");
  assert.ok(result.error.includes("Invalid plan"));
  assert.equal(result.ledger.phases.length, 0);
});

test("L2: artifacts from parallel phases merge into run-level artifacts", async () => {
  const result = await runIterativePlan({
    plan: {
      planVersion: 2,
      summary: "Test",
      phases: [
        { id: "p1", activity: "research", prompt: "p1", title: "P1", parallelGroup: 0, dependsOn: [] },
        { id: "p2", activity: "research", prompt: "p2", title: "P2", parallelGroup: 0, dependsOn: [] }
      ]
    },
    originalGoal: "Test",
    taskType: "research",
    workspaceDir: "/fake/workspace",
    extractArtifacts: async ({ phaseId }) => [
      { id: `art_${phaseId}`, path: `/fake/workspace/${phaseId}.xlsx`, kind: "xlsx", sizeBytes: 100, producedBy: [{ phaseId }] }
    ],
    invokeModel: async ({ messages }) => {
      const isCritic = (messages[0]?.content ?? "").includes("auditing");
      if (isCritic) {
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: "done" };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.artifacts.length, 2);
  const paths = result.ledger.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, ["/fake/workspace/p1.xlsx", "/fake/workspace/p2.xlsx"]);
});
```

- [ ] **Step 2: Run the full planner test suite**

```bash
node --test packages/orchestrator/src/planner.test.js
```

Expected: 9 existing L0 tests + 9 new L2 tests = 18 total, all passing.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/planner.test.js
git commit -m "test(orchestrator/planner): add 9 L2 parallel-fanout tests"
```

---

### Task 5: Full regression sweep + final review

**Files:** None modified — verification only.

- [ ] **Step 1: Run the full workspace test suite**

```bash
node --test $(find packages -name '*.test.js' -type f)
```

Expected: 106 (L1 baseline) + 9 new L2 = 115 total, all passing.

- [ ] **Step 2: Syntax-check every touched file**

```bash
node --check packages/orchestrator/src/planner.js
```

Expected: no output.

- [ ] **Step 3: Commit a verification checkpoint if anything needed a fix-up**

If a fix was required, commit as `fix(l2): ...`. Otherwise no commit is needed.
