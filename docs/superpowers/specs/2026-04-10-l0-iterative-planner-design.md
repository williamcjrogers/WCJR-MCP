# L0 — Iterative Planner, Self-Critique, Proactive Memory

**Date:** 2026-04-10
**Status:** Approved (William, 2026-04-10)
**Context:** First layer of the "operator console" roadmap. Sits on top of the hardening pass merged earlier the same day ([shimmering-foraging-harbor plan](../../../../Users/William/.claude/plans/shimmering-foraging-harbor.md)). The app's reliability floor is now honest — every error typed, every hang guarded, every swallowed catch surfaced — but execution depth is still shallow: the orchestrator runs phases linearly and trusts the model's first answer. L0 turns `executeTask` from "LLM call → final text" into a **reason → act → critique → amend** loop with proactive memory writes. Every subsequent layer (L1 artifact graph, L2 parallel fan-out, L3 ambient triggers, L4 policy-gated writes, L5 operator dashboard, L6 learned skills) depends on this loop existing.

## Strategic framing

This is not a coding copilot, not a generalist chat. The product identity driving every design decision in the L0-L6 roadmap is:

> An autonomous operator that runs a multi-business owner's work. Accepts commands from any surface (desktop, Telegram, WhatsApp, mail, webhooks, schedule), decomposes them, runs specialists under policy, produces verified artifacts, and learns from every run.

L0 is the smallest change that makes the system stop *sounding* like an agent and start *behaving* like one.

---

## 1. Goal

After this ships, the orchestrator must:

1. Iterate on its own plan — amend, retry, or escalate based on what actually happened, not on what the first generation hoped for.
2. Terminate on a visible stop condition (critic accepted, budget hit, or operator escalation) — never hang, never silently truncate.
3. Write a structured lesson to memory on every terminal state, successful or not, so that the next run of the same task type is informed by prior experience.
4. Keep the existing `direct` mode untouched so nothing regresses.

## 2. Architecture

Three new modules, all in [packages/orchestrator/src/](../../../packages/orchestrator/src/):

- **`planner.js`** — state machine. Owns the `ExecutionPlan` and drives phases sequentially. After each phase, invokes `critic.js`, applies the verdict, and either advances, retries, amends, escalates, or terminates on budget exhaustion. Exposes `runIterativePlan({ plan, taskContext, budget, onChunk, invoker, fallbackChain, collectContext })`.
- **`critic.js`** — stateless verdict producer. Accepts `{ originalGoal, activityProfile, planSoFar, phaseJustRun, phaseResult, toolTrace, artifacts }` and returns a typed verdict (schema in §4). Uses a **different model** from the executor, selected via a new `modelRouter.getCriticModel(executorModel)` helper. Has no tool access — it judges, it does not execute.
- **`lesson-writer.js`** — proactive memory-delta writer. Runs on every terminal state (accept, escalate, budget_exhausted, failed). Produces a structured `run_lesson` memory entry with task type, tool signature, outcome, what worked, what failed, and a one-sentence generalization.

All three are extensions, not replacements. `executeTask` keeps its signature. A new `runMode: "iterative"` opts in. The existing `plan_first` flow becomes `iterative` once the user approves the plan (unchanged from the user's perspective, just deeper underneath).

## 3. State machine

```
START
  │
  ▼
RUN_PHASE ──► CRITIC
                 │
   accept ──────┼──► advance (or DONE if last phase)
   amend_plan ──┼──► apply amendments ──► RUN_PHASE (new phase)
   retry_phase ─┼──► RUN_PHASE (same phase, retry guidance injected)
   escalate ────┴──► DONE(status: escalated, pendingApproval: true)

BUDGET_EXCEEDED (checked on every transition)
  └──► DONE(status: budget_exhausted) — returns last-known-good content
```

### Budget caps

Defaults (per-profile overrides possible via [packages/activity-profiles/src/index.js](../../../packages/activity-profiles/src/index.js)):

| Cap                       | Default              | Rationale |
|---------------------------|----------------------|-----------|
| `maxCriticRoundsPerPhase` | 2                    | First run + up to one retry per phase. |
| `maxTotalPhases`          | 12                   | Original + amended phases combined. Prevents runaway plan mutation. |
| `maxWallClockMs`          | 10 × 60 × 1000       | Operator-level patience ceiling. |
| `maxTokensTotal`          | 400_000              | Sum of executor + critic + lesson-writer tokens for the whole run. |

Budget is enforced inside `planner.js` before each RUN_PHASE. On any cap hit, the planner emits a visible `status` chunk (`"Budget exhausted at phase N — returning last-known-good result"`) and returns normally. Never silent, never hang.

### Retry-exhaustion rule

When a phase hits `maxCriticRoundsPerPhase` and the critic's latest verdict is still `retry_phase`, the planner does **not** ask the critic a third time. Instead, it forces a transition to `escalate` with `escalationReason: "Retry budget exhausted for phase {id} after {N} attempts — last critic reasoning: {reasoning}"`. This is deterministic and visible; the operator sees exactly why the escalation happened and can resume with updated guidance.

## 4. Critic verdict schema

Critic is prompted to emit strict JSON. The `safeJsonParse` `_parseError` handling added in the Tier 1 hardening pass catches malformed output and routes it to a degraded fallback (see §5).

```jsonc
{
  "decision": "accept" | "amend_plan" | "retry_phase" | "escalate",
  "reasoning": "1-3 sentences, cited to the phase result",
  "confidence": 0.0,         // 0.0–1.0
  "amendments": [            // present iff decision == "amend_plan"
    { "action": "insert_phase", "after": "<phaseId>", "phase": { "id": "...", "activity": "...", "intent": "..." } },
    { "action": "replace_phase", "phaseId": "<id>", "phase": { ... } },
    { "action": "drop_phase", "phaseId": "<id>" }
  ],
  "retryGuidance": "string", // present iff decision == "retry_phase"
  "escalationReason": "..."  // present iff decision == "escalate"
}
```

## 5. Critic prompt spine

```
You are auditing another agent's work. You do not execute tools — you judge.

ORIGINAL GOAL: <prompt>
ACTIVITY PROFILE: <taskType> (<profile summary>)
PLAN SO FAR: <phases with status>
PHASE JUST RUN: <phase id + intent>
PHASE RESULT: <truncated content + tool trace summary + artifact list>

Decide exactly one:
- accept: phase fully satisfies its intent AND the overall plan is still coherent.
- amend_plan: plan has a gap this phase revealed — insert/replace/drop phases to close it.
- retry_phase: execution was broken (tool errors, malformed output, wrong data) but plan is fine.
- escalate: progress requires a decision only a human can make.

Be terse. Reason from the result, not from what the plan hoped for.
Return strict JSON matching the schema. No prose outside JSON.
```

### Guardrails

1. **No tools.** The critic prompt explicitly states "you do not execute tools" and `runIterativePlan` invokes the critic with `tools: undefined`. A runaway critic cannot fan out.
2. **Degraded fallback.** If the critic throws (typed via `classifyProviderError` from the hardening pass) or returns malformed JSON (caught by `safeJsonParse._parseError`), the planner logs a warning and treats the verdict as `{ decision: "accept", confidence: 0, reasoning: "critic unavailable — optimistic accept" }`. A broken critic never blocks a task.
3. **Verdict-level budget.** Each critic invocation counts toward `maxTokensTotal`. If the critic alone exhausts the budget, the planner terminates as `budget_exhausted`.

## 6. Critic model selection

New helper in [packages/model-router/src/index.js](../../../packages/model-router/src/index.js):

```js
getCriticModel(executorModel) {
  // A critic must be (a) different family from the executor, (b) cheaper or
  // equivalent tier, (c) not the same instance re-judging itself. Falls back
  // through the default fallback chain until a valid critic is found.
}
```

Initial mapping (codified in the helper, not hardcoded at call sites):

| Executor                       | Critic                        |
|--------------------------------|-------------------------------|
| `gpt-5.4-pro` / `gpt-5.4`      | `claude-sonnet-4-6-20250514`  |
| `claude-opus-4-6-*`            | `gemini-2.5-pro`              |
| `gemini-3.1-pro-preview`       | `gpt-5.4`                     |
| `grok-4.20-multi-agent-*`      | `claude-sonnet-4-6-20250514`  |
| any `-mini` / `flash` tier     | same-family `mini` (OK, cheap)|
| local `qwen3:14b`              | `gemini-2.5-flash` (cloud)    |

If none of the preferred critics have a configured API key, the helper walks the fallback chain and returns the first available model that is not the executor itself. If the only available model *is* the executor, the critic degrades to `accept` with `confidence: 0` and logs `"[critic] no cross-family model available, degrading"`.

## 7. Lesson-writer schema

On every terminal state, run one short model call — intentionally cheap (default `claude-haiku-4-5-20251001`, fallback `gemini-2.5-flash`). Input: `{ prompt, plan, toolTrace, outcome, criticVerdicts }`. Output:

```jsonc
{
  "taskType": "disputes",
  "prompt_gist": "short paraphrase of intent",
  "tools_used": ["matter_analyse", "extract_document_text", "create_workbook"],
  "outcome": "success" | "escalated" | "budget_exhausted" | "failed",
  "what_worked": ["bullet", "list"],
  "what_failed": ["bullet", "list"],
  "generalization": "one sentence an operator could read and believe",
  "confidence": 0.0
}
```

Written via `memoryStore.write({ type: "run_lesson", tags: [taskType, ...tools_used], body: JSON.stringify(lesson), ... })`. Lessons are **always emitted**, including on failure — failure lessons are the most valuable training signal and gating on success would blind the loop.

### Lesson-writer input edge cases

- **Empty plan / zero phases executed** (run crashed before any phase completed): emit a lesson with `outcome: "failed"`, `tools_used: []`, and `generalization` summarizing the crash class (e.g., `"All providers rejected the initial plan — check model availability"`).
- **Lesson-writer itself fails** (provider down, malformed JSON): log a warning through the same `logError` surface the hardening pass shipped, do not retry, do not block the task return. The task completes normally; the lesson is lost but the run isn't.
- **Budget exhausted before lesson-writer runs**: the lesson-writer tokens are reserved from `maxTokensTotal` (see §3 budget table) — the planner subtracts a 4k reserve before each phase so there is always room for the final lesson write.

### Retrieval wiring

[collectToolContext](../../../packages/orchestrator/src/index.js#L941) gets a new pass: before returning, fetch the top-3 matching `run_lesson` entries for the resolved task type and inject them into the system prompt as a dedicated `PRIOR LESSONS` section:

```
PRIOR LESSONS (from previous runs of this task type):
1. [disputes] extract_document_text → create_workbook: succeeded when passed maxChars:50000; failed on PDFs > 120 pages.
2. [disputes] matter_analyse first, then extract: converged faster than extract-first ordering.
3. [disputes] Escalated when conflicting dates between two exhibits — always surface conflicts instead of guessing.
```

Top-3 by recency + task-type tag match. No embedding retrieval for L0 — the memory-store's existing tag search is sufficient; richer retrieval is an L6 concern.

## 8. Wiring into executeTask

Minimal-diff integration at [packages/orchestrator/src/index.js:1200](../../../packages/orchestrator/src/index.js#L1200):

```js
// Pseudocode, real change lives inside executeTask after the plan is resolved.
if (runMode === "iterative" && executionPlan) {
  return this.runIterativePlan({
    plan: executionPlan,
    originalPrompt: prompt,
    taskContext,
    resolvedTaskType,
    activityProfile,
    timeline,
    invoker: this.options.invokeModel,
    fallbackChain,
    emitStatus,
    onChunk,
    budget: resolveBudget(activityProfile)
  });
}
// else: existing direct-mode path, unchanged
```

`runIterativePlan` is added as a method on `Orchestrator` that delegates to [packages/orchestrator/src/planner.js](../../../packages/orchestrator/src/planner.js). The planner re-uses existing primitives:

- `collectToolContext` for per-phase context (now including `PRIOR LESSONS`)
- `this.options.invokeModel` as the executor
- The same fallback chain the outer `executeTask` built
- Existing `onChunk({ type: "status" | "text" | "tool_call" | "tool_result" })` emitters
- [packages/tool-loop/src/index.js](../../../packages/tool-loop/src/index.js) `runToolLoop` for phase execution (unchanged)

### Status chunk vocabulary

Every state transition emits an `onChunk({ type: "status" })` so the routing status row shipped in Tier 3.16 of the hardening pass shows live progress:

| Transition                 | Status text                                                |
|----------------------------|------------------------------------------------------------|
| Phase start                | `"Running phase {n}/{total}: {intent}..."`                 |
| Critic start               | `"Critic reviewing phase {n} ({criticModel})..."`          |
| Critic accept              | `"Phase {n} accepted — advancing..."`                      |
| Critic retry               | `"Retrying phase {n} (attempt {k}/{max})..."`              |
| Critic amend               | `"Amending plan ({+N} phases)..."`                         |
| Critic escalate            | `"Escalating: {reason}"`                                   |
| Budget exhausted           | `"Budget exhausted at phase {n} — returning best-effort"`  |
| Lesson write               | `"Recording lesson..."`                                    |

## 9. The runLedger (observability primitive)

The planner maintains a structured ledger in parallel with the existing timeline:

```jsonc
{
  "taskId": "...",
  "startedAt": 1744300000000,
  "endedAt": 1744300480000,
  "outcome": "success" | "escalated" | "budget_exhausted" | "failed",
  "phases": [
    {
      "id": "p1",
      "intent": "Collect all exhibits for the matter",
      "executorModel": "gpt-5.4",
      "criticModel": "claude-sonnet-4-6-20250514",
      "attempts": 1,
      "status": "accepted",
      "criticVerdicts": [{ ... }],
      "toolTrace": [...],
      "durationMs": 12400
    },
    {
      "id": "p2-inserted",
      "insertedBy": "critic@p1",
      "insertionReason": "p1 revealed a second custodian missing from the plan",
      ...
    }
  ],
  "lessons": [{ ... }],
  "budget": { "phasesUsed": 3, "wallClockMs": 84213, "tokensUsed": 127441 }
}
```

Persisted alongside the existing task record via [packages/task-store/src/index.js](../../../packages/task-store/src/index.js) as `task.runLedger`. For L0, the renderer just shows this as a collapsible JSON tree in the existing task-details pane — no custom UI. Shipping it as structured data now means L5 (operator dashboard) can render it properly without changing the producer.

## 10. Files

### New

- [packages/orchestrator/src/planner.js](../../../packages/orchestrator/src/planner.js) — state machine
- [packages/orchestrator/src/critic.js](../../../packages/orchestrator/src/critic.js) — verdict producer (prompt, schema validation, degraded fallback)
- [packages/orchestrator/src/lesson-writer.js](../../../packages/orchestrator/src/lesson-writer.js) — memory-delta writer
- [packages/orchestrator/src/planner.test.js](../../../packages/orchestrator/src/planner.test.js)
- [packages/orchestrator/src/critic.test.js](../../../packages/orchestrator/src/critic.test.js)
- [packages/orchestrator/src/lesson-writer.test.js](../../../packages/orchestrator/src/lesson-writer.test.js)

### Modified

- [packages/orchestrator/src/index.js](../../../packages/orchestrator/src/index.js) — `executeTask` branches on `runMode === "iterative"`; adds `runIterativePlan` as an `Orchestrator` method that delegates to `planner.js`
- [packages/orchestrator/src/index.js:941](../../../packages/orchestrator/src/index.js#L941) `collectToolContext` — inject `PRIOR LESSONS` section
- [packages/activity-profiles/src/index.js](../../../packages/activity-profiles/src/index.js) — add optional per-profile `budget` object
- [packages/model-router/src/index.js](../../../packages/model-router/src/index.js) — add `getCriticModel(executorModel)` helper
- [packages/memory-store/src/index.js](../../../packages/memory-store/src/index.js) — add `run_lesson` type + tag-based retrieval helper (if not already present)
- [packages/task-store/src/index.js](../../../packages/task-store/src/index.js) — persist `runLedger` alongside task record
- [apps/desktop/renderer.js](../../../apps/desktop/renderer.js) — render `task.runLedger` as a collapsible JSON tree in task details (minimal, no custom UI)

### Not touched

- [packages/tool-loop/src/index.js](../../../packages/tool-loop/src/index.js) — `runToolLoop` is called per phase, unchanged
- Provider adapters in [packages/providers/src/](../../../packages/providers/src/) — all already typed after hardening pass
- Messaging bridges — L3 will change these, L0 does not

## 11. Reused utilities (non-negotiable)

- `safeJsonParse` from [packages/tool-loop/src/index.js:222](../../../packages/tool-loop/src/index.js#L222) — parse critic output, `_parseError` flag routes to degraded fallback
- `classifyProviderError` + `withRetry` from [packages/providers/src/errors.js](../../../packages/providers/src/errors.js) — every critic and lesson-writer call goes through these
- `formatMcpError` from [packages/tool-loop/src/index.js](../../../packages/tool-loop/src/index.js) — tool trace summaries fed to the critic use this for readable error strings
- Routing status row from [apps/desktop/renderer.js](../../../apps/desktop/renderer.js) — the planner's status chunks flow through the existing pipe; no new UI

## 12. Scope discipline — deliberately excluded

These belong to later layers. Including any of them here would compromise the spec.

| Excluded          | Why                                                                 | Layer |
|-------------------|---------------------------------------------------------------------|-------|
| Parallel phases   | Changes critic's reasoning surface; sequential first.               | L2    |
| Artifact graph    | Tool traces exist in runLedger; formal lineage is a separate unit.  | L1    |
| Policy-gated writes | Escalation exists; sandboxed preview-before-commit is its own thing. | L4  |
| Critic ensemble   | Single cheap critic first; only add voting if noise proves to be real. | later |
| Operator UI       | `runLedger` is JSON for now; dashboard renders it properly later.   | L5    |
| Embedding retrieval of lessons | Tag + recency is enough for L0; richer retrieval is L6.  | L6    |
| Ambient triggers  | Messaging bridges unchanged; new surfaces land with L3.             | L3    |

## 13. Verification

Run each of these end-to-end. All must pass before L0 is considered shipped.

**Unit tests**

1. `node --test packages/orchestrator/src/planner.test.js` — state machine: accept advances, amend_plan inserts, retry_phase re-invokes with guidance in messages, budget exhaustion returns last-known-good, escalate terminates with `pendingApproval`.
2. `node --test packages/orchestrator/src/critic.test.js` — curated `{phase, result}` fixtures; broken tool → `retry_phase`, missing data → `amend_plan`, complete work → `accept`, conflicting evidence → `escalate`. Malformed JSON → degraded `accept` with `confidence: 0`.
3. `node --test packages/orchestrator/src/lesson-writer.test.js` — round-trip: run a mock task through the writer, assert the memory-store entry has the expected tags and retrieval on the same task type returns it.

**End-to-end on the live app**

4. Run a multi-phase disputes task. Watch the routing status row: expect `"Running phase 1/N..."`, `"Critic reviewing phase 1 (claude-sonnet-4-6)..."`, `"Phase 1 accepted"`, repeated per phase.
5. Prompt something that produces a broken phase (e.g., "read /tmp/nonexistent.txt and summarize"). Expect `retry_phase` with retry guidance; on second failure expect `escalate` with a reason in the approval banner.
6. Prompt something that reveals a plan gap mid-run (e.g., "analyze the exhibits" when the initial plan only listed one directory but the scan reveals two). Expect `amend_plan` and the inserted phase(s) visible in the timeline + status chunks.
7. Set `maxWallClockMs: 5000` in `activity-profiles` config. Run a long task. Expect `"Budget exhausted at phase N — returning best-effort"` status and non-empty `content`, no hang.
8. After 3 successful runs of the same task type, call `memoryStore.search({ type: "run_lesson", taskType })` and expect 3 entries.
9. Run a 4th task of the same type and confirm the executor's first system prompt contains a `PRIOR LESSONS` section with ≤3 entries.
10. `node --test $(find packages -name '*.test.js' -type f)` — full suite green, no regressions against the 47 tests that currently pass.

Only after all 10 pass is L0 considered shipped and the L1 brainstorm can begin.
