// packages/orchestrator/src/critic.js

export const VERDICT_SCHEMA_DECISIONS = new Set([
  "accept",
  "amend_plan",
  "retry_phase",
  "escalate"
]);

const CRITIC_SYSTEM = `You are auditing another agent's work. You do not execute tools — you judge.

Decide exactly one:
- accept: phase fully satisfies its intent AND the overall plan is still coherent.
- amend_plan: plan has a gap this phase revealed — insert/replace/drop phases to close it.
- retry_phase: execution was broken (tool errors, malformed output, wrong data) but plan is fine.
- escalate: progress requires a decision only a human can make.

Be terse. Reason from the result, not from what the plan hoped for.
Return strict JSON matching this schema:
{
  "decision": "accept" | "amend_plan" | "retry_phase" | "escalate",
  "reasoning": "1-3 sentences",
  "confidence": 0.0-1.0,
  "amendments": [{ "action": "insert_phase"|"replace_phase"|"drop_phase", ... }],
  "retryGuidance": "string if retry_phase",
  "escalationReason": "string if escalate"
}
No prose outside JSON.`;

export function buildCriticPrompt({
  originalGoal,
  taskType,
  planSummary,
  phaseId,
  phaseIntent,
  phaseResult,
  toolTraceSummary
}) {
  return [
    `ORIGINAL GOAL: ${originalGoal}`,
    `ACTIVITY PROFILE: ${taskType}`,
    `PLAN SO FAR:\n${planSummary}`,
    `PHASE JUST RUN: ${phaseId} — ${phaseIntent}`,
    `PHASE RESULT:\n${phaseResult}`,
    toolTraceSummary ? `TOOL TRACE:\n${toolTraceSummary}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseVerdict(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { decision: "accept", reasoning: "critic returned empty", confidence: 0, _degraded: true };
  }

  // Strip markdown fences if the model wrapped it
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn("[critic] malformed verdict JSON, degrading to accept");
    return { decision: "accept", reasoning: `parse error: ${raw.slice(0, 120)}`, confidence: 0, _degraded: true };
  }

  if (!parsed || typeof parsed !== "object" || !VERDICT_SCHEMA_DECISIONS.has(parsed.decision)) {
    console.warn(`[critic] unknown decision '${parsed?.decision}', degrading to accept`);
    return { decision: "accept", reasoning: "unknown decision value", confidence: 0, _degraded: true };
  }

  return {
    decision: parsed.decision,
    reasoning: String(parsed.reasoning ?? ""),
    confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    ...(parsed.amendments ? { amendments: parsed.amendments } : {}),
    ...(parsed.retryGuidance ? { retryGuidance: String(parsed.retryGuidance) } : {}),
    ...(parsed.escalationReason ? { escalationReason: String(parsed.escalationReason) } : {})
  };
}

export function getCriticSystemPrompt() {
  return CRITIC_SYSTEM;
}

/**
 * Invoke the critic model and return a typed verdict.
 * On any error, returns a degraded accept so the task isn't blocked.
 */
export async function runCritic({
  invokeModel,
  criticModel,
  criticProvider,
  originalGoal,
  taskType,
  planSummary,
  phaseId,
  phaseIntent,
  phaseResult,
  toolTraceSummary
}) {
  const userMessage = buildCriticPrompt({
    originalGoal,
    taskType,
    planSummary,
    phaseId,
    phaseIntent,
    phaseResult,
    toolTraceSummary
  });

  try {
    const result = await invokeModel({
      providerId: criticProvider,
      model: criticModel,
      prompt: userMessage,
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: userMessage }
      ],
      taskType,
      skipTools: true,
      suppressStream: true
    });
    return parseVerdict(result.content);
  } catch (err) {
    console.error("[critic] invocation failed, degrading to accept:", err?.message ?? err);
    return { decision: "accept", reasoning: `critic failed: ${err?.message ?? err}`, confidence: 0, _degraded: true };
  }
}
