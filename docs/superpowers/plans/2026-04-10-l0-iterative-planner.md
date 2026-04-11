# L0 — Iterative Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the orchestrator's linear phase execution into a reason → act → critique → amend loop with proactive memory writes, so the agent self-corrects mid-run and learns from every task.

**Architecture:** Three new modules (`planner.js`, `critic.js`, `lesson-writer.js`) inside `packages/orchestrator/src/`. The planner drives phases sequentially, invokes the critic after each, and applies verdicts (accept / amend / retry / escalate). The lesson-writer runs on terminal state and writes structured run-lessons into memory-store. `executeTask` gains a `runMode: "iterative"` branch that delegates to the planner. All other modes untouched.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, existing `@wcjr/providers`, `@wcjr/model-router`, `@wcjr/memory-store`, `@wcjr/task-store`.

**Spec:** `docs/superpowers/specs/2026-04-10-l0-iterative-planner-design.md`

---

### Task 1: Add `getCriticModel()` to ModelRouter

**Files:**
- Modify: `packages/model-router/src/index.js`
- Create: `packages/model-router/src/critic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// packages/model-router/src/critic.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "./index.js";

test("getCriticModel returns a cross-family model when available", () => {
  const router = new ModelRouter({});
  const critic = router.getCriticModel("gpt-5.4", (model) => {
    // Pretend all cloud keys are present
    if (model.includes("qwen")) return false;
    return true;
  });
  // Should not be the same model or family
  assert.ok(!critic.startsWith("gpt-"), `critic '${critic}' should not be same family as executor`);
  assert.ok(critic, "critic model should not be empty");
});

test("getCriticModel returns fallback chain head when no cross-family model has a key", () => {
  const router = new ModelRouter({});
  // Only OpenAI keys available
  const critic = router.getCriticModel("gpt-5.4", (model) => model.startsWith("gpt-"));
  // Falls back to gpt-5.4-mini (same family but different model) — degraded but functional
  assert.ok(critic !== "gpt-5.4", "critic should not be the executor itself");
  assert.ok(critic, "critic model should not be empty");
});

test("getCriticModel returns null when only the executor model is available", () => {
  const router = new ModelRouter({});
  const critic = router.getCriticModel("gpt-5.4", (model) => model === "gpt-5.4");
  assert.equal(critic, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/model-router/src/critic.test.js`
Expected: FAIL — `getCriticModel` is not defined

- [ ] **Step 3: Write the implementation**

Add to `packages/model-router/src/index.js`, inside the `ModelRouter` class, after `getFallbackChain`:

```js
  /**
   * Select a critic model that is (a) from a different family than the executor
   * and (b) has an available API key. Falls back through the chain until one
   * is found. Returns null if the only available model is the executor itself.
   *
   * @param {string} executorModel - Model ID the executor is using.
   * @param {(model: string) => boolean} hasKey - Sync check for key availability.
   * @returns {string|null}
   */
  getCriticModel(executorModel, hasKey) {
    const CRITIC_PREFERENCES = {
      "gpt-": "claude-sonnet-4-6-20250514",
      "claude-": "gemini-2.5-pro",
      "gemini-": "gpt-5.4",
      "grok-": "claude-sonnet-4-6-20250514",
      "qwen": "gemini-2.5-flash",
      "sonar": "gpt-5.4-mini"
    };

    const executorFamily = Object.keys(CRITIC_PREFERENCES).find((prefix) =>
      executorModel.startsWith(prefix)
    );

    // Try the preferred cross-family critic first
    if (executorFamily) {
      const preferred = CRITIC_PREFERENCES[executorFamily];
      if (preferred !== executorModel && hasKey(preferred)) {
        return preferred;
      }
    }

    // Walk the fallback chain for any model from a different family
    const chain = this.getFallbackChain(executorModel);
    for (const candidate of chain) {
      if (candidate === executorModel) continue;
      const sameFamily =
        executorFamily && candidate.startsWith(executorFamily);
      if (!sameFamily && hasKey(candidate)) {
        return candidate;
      }
    }

    // Degraded: same family, different model (e.g. gpt-5.4-mini critiquing gpt-5.4)
    for (const candidate of chain) {
      if (candidate === executorModel) continue;
      if (hasKey(candidate)) {
        return candidate;
      }
    }

    return null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/model-router/src/critic.test.js`
Expected: 3 tests, 3 pass

- [ ] **Step 5: Commit**

```bash
git add packages/model-router/src/index.js packages/model-router/src/critic.test.js
git commit -m "feat(model-router): add getCriticModel for cross-family critic selection"
```

---

### Task 2: Create `critic.js` — verdict producer

**Files:**
- Create: `packages/orchestrator/src/critic.js`
- Create: `packages/orchestrator/src/critic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// packages/orchestrator/src/critic.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildCriticPrompt, parseVerdict, VERDICT_SCHEMA_DECISIONS } from "./critic.js";

test("buildCriticPrompt includes the original goal and phase result", () => {
  const prompt = buildCriticPrompt({
    originalGoal: "Summarize the exhibits",
    taskType: "disputes",
    planSummary: "Phase 1: collect, Phase 2: summarize",
    phaseId: "p1",
    phaseIntent: "Collect all exhibit files",
    phaseResult: "Found 3 files in /exhibits",
    toolTraceSummary: "extract_document_text: completed (2.3s)"
  });
  assert.ok(prompt.includes("Summarize the exhibits"));
  assert.ok(prompt.includes("Collect all exhibit files"));
  assert.ok(prompt.includes("Found 3 files"));
  assert.ok(prompt.includes("extract_document_text"));
});

test("parseVerdict accepts valid accept verdict", () => {
  const raw = JSON.stringify({
    decision: "accept",
    reasoning: "Phase output matches intent",
    confidence: 0.9
  });
  const verdict = parseVerdict(raw);
  assert.equal(verdict.decision, "accept");
  assert.equal(verdict.confidence, 0.9);
  assert.equal(verdict._parseError, undefined);
});

test("parseVerdict returns degraded accept for malformed JSON", () => {
  const verdict = parseVerdict("this is not json at all");
  assert.equal(verdict.decision, "accept");
  assert.equal(verdict.confidence, 0);
  assert.equal(verdict._degraded, true);
});

test("parseVerdict rejects unknown decision values", () => {
  const raw = JSON.stringify({ decision: "destroy", reasoning: "test", confidence: 1 });
  const verdict = parseVerdict(raw);
  assert.equal(verdict.decision, "accept");
  assert.equal(verdict._degraded, true);
});

test("VERDICT_SCHEMA_DECISIONS contains all four valid decisions", () => {
  assert.deepEqual(
    [...VERDICT_SCHEMA_DECISIONS].sort(),
    ["accept", "amend_plan", "escalate", "retry_phase"]
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/orchestrator/src/critic.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/orchestrator/src/critic.test.js`
Expected: 5 tests, 5 pass

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/critic.js packages/orchestrator/src/critic.test.js
git commit -m "feat(orchestrator): add critic module with verdict parsing and degraded fallback"
```

---

### Task 3: Create `lesson-writer.js` — proactive memory writes

**Files:**
- Create: `packages/orchestrator/src/lesson-writer.js`
- Create: `packages/orchestrator/src/lesson-writer.test.js`

- [ ] **Step 1: Write the failing test**

```js
// packages/orchestrator/src/lesson-writer.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildLessonPrompt, parseLesson, writeLesson } from "./lesson-writer.js";

test("buildLessonPrompt includes task type and outcome", () => {
  const prompt = buildLessonPrompt({
    taskType: "disputes",
    originalGoal: "Summarize exhibits",
    outcome: "success",
    toolsUsed: ["extract_document_text"],
    criticVerdicts: [{ decision: "accept", reasoning: "good" }]
  });
  assert.ok(prompt.includes("disputes"));
  assert.ok(prompt.includes("success"));
  assert.ok(prompt.includes("extract_document_text"));
});

test("parseLesson parses valid JSON", () => {
  const lesson = parseLesson(JSON.stringify({
    taskType: "disputes",
    prompt_gist: "summarize exhibits",
    tools_used: ["extract_document_text"],
    outcome: "success",
    what_worked: ["reading PDFs with maxChars:50000"],
    what_failed: [],
    generalization: "Use maxChars:50000 for exhibit PDFs",
    confidence: 0.8
  }));
  assert.equal(lesson.taskType, "disputes");
  assert.equal(lesson.outcome, "success");
  assert.equal(lesson.confidence, 0.8);
});

test("parseLesson returns fallback for malformed JSON", () => {
  const lesson = parseLesson("not json");
  assert.equal(lesson, null);
});

test("writeLesson persists to memory store", async () => {
  const written = [];
  const mockMemoryStore = {
    upsert(entry) {
      written.push(entry);
      return { ...entry, id: "mem_test" };
    },
    async save() {}
  };

  await writeLesson({
    memoryStore: mockMemoryStore,
    lesson: {
      taskType: "disputes",
      prompt_gist: "summarize",
      tools_used: ["extract_document_text"],
      outcome: "success",
      what_worked: ["maxChars:50000"],
      what_failed: [],
      generalization: "Use maxChars:50000",
      confidence: 0.8
    }
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].category, "run_lesson");
  assert.ok(written[0].tags.includes("disputes"));
  assert.ok(written[0].tags.includes("extract_document_text"));
  assert.ok(written[0].content.includes("maxChars:50000"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/orchestrator/src/lesson-writer.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// packages/orchestrator/src/lesson-writer.js

const LESSON_SYSTEM = `You are summarizing a completed agent run into a structured lesson for future runs of the same task type.

Return strict JSON:
{
  "taskType": "string",
  "prompt_gist": "short paraphrase of what was asked",
  "tools_used": ["tool_name", ...],
  "outcome": "success" | "escalated" | "budget_exhausted" | "failed",
  "what_worked": ["bullet", ...],
  "what_failed": ["bullet", ...],
  "generalization": "one sentence an operator could read and believe",
  "confidence": 0.0-1.0
}
No prose outside JSON.`;

export function buildLessonPrompt({
  taskType,
  originalGoal,
  outcome,
  toolsUsed,
  criticVerdicts,
  planSummary
}) {
  const verdictSummary = (criticVerdicts ?? [])
    .map((v, i) => `Phase ${i + 1}: ${v.decision} (${v.reasoning})`)
    .join("\n");

  return [
    `TASK TYPE: ${taskType}`,
    `GOAL: ${originalGoal}`,
    `OUTCOME: ${outcome}`,
    `TOOLS USED: ${(toolsUsed ?? []).join(", ") || "none"}`,
    planSummary ? `PLAN:\n${planSummary}` : "",
    verdictSummary ? `CRITIC VERDICTS:\n${verdictSummary}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseLesson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || !parsed.taskType) return null;
    return {
      taskType: String(parsed.taskType),
      prompt_gist: String(parsed.prompt_gist ?? ""),
      tools_used: Array.isArray(parsed.tools_used) ? parsed.tools_used.map(String) : [],
      outcome: String(parsed.outcome ?? "unknown"),
      what_worked: Array.isArray(parsed.what_worked) ? parsed.what_worked.map(String) : [],
      what_failed: Array.isArray(parsed.what_failed) ? parsed.what_failed.map(String) : [],
      generalization: String(parsed.generalization ?? ""),
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5
    };
  } catch {
    return null;
  }
}

export async function writeLesson({ memoryStore, lesson }) {
  if (!memoryStore || !lesson) return null;
  const entry = memoryStore.upsert({
    category: "run_lesson",
    content: [
      `[${lesson.taskType}] ${lesson.prompt_gist}`,
      `Outcome: ${lesson.outcome}`,
      lesson.what_worked.length ? `Worked: ${lesson.what_worked.join("; ")}` : "",
      lesson.what_failed.length ? `Failed: ${lesson.what_failed.join("; ")}` : "",
      `Generalization: ${lesson.generalization}`
    ]
      .filter(Boolean)
      .join("\n"),
    tags: [lesson.taskType, ...lesson.tools_used],
    pinned: false
  });
  await memoryStore.save();
  return entry;
}

/**
 * Run the lesson-writer model call and persist the result.
 * On failure, logs and returns null — never blocks the task.
 */
export async function generateAndWriteLesson({
  invokeModel,
  lessonModel,
  lessonProvider,
  memoryStore,
  taskType,
  originalGoal,
  outcome,
  toolsUsed,
  criticVerdicts,
  planSummary
}) {
  try {
    const userMessage = buildLessonPrompt({
      taskType,
      originalGoal,
      outcome,
      toolsUsed,
      criticVerdicts,
      planSummary
    });

    const result = await invokeModel({
      providerId: lessonProvider,
      model: lessonModel,
      prompt: userMessage,
      messages: [
        { role: "system", content: LESSON_SYSTEM },
        { role: "user", content: userMessage }
      ],
      taskType,
      skipTools: true,
      suppressStream: true
    });

    const lesson = parseLesson(result.content);
    if (!lesson) {
      console.warn("[lesson-writer] could not parse lesson from model output");
      return null;
    }

    return await writeLesson({ memoryStore, lesson });
  } catch (err) {
    console.warn("[lesson-writer] failed, skipping:", err?.message ?? err);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/orchestrator/src/lesson-writer.test.js`
Expected: 4 tests, 4 pass

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/lesson-writer.js packages/orchestrator/src/lesson-writer.test.js
git commit -m "feat(orchestrator): add lesson-writer for proactive run-lesson memory writes"
```

---

### Task 4: Create `planner.js` — the iterative state machine

**Files:**
- Create: `packages/orchestrator/src/planner.js`
- Create: `packages/orchestrator/src/planner.test.js`

- [ ] **Step 1: Write the failing test**

```js
// packages/orchestrator/src/planner.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { runIterativePlan } from "./planner.js";

function mockInvoker(responses = []) {
  let callIndex = 0;
  return async () => {
    const response = responses[callIndex] ?? { content: "default response" };
    callIndex += 1;
    return response;
  };
}

function makePlan(phases) {
  return {
    planVersion: 2,
    summary: "Test plan",
    phases: phases.map((p, i) => ({
      id: p.id ?? `p${i + 1}`,
      activity: p.activity ?? "research",
      prompt: p.prompt ?? `Do phase ${i + 1}`,
      title: p.title ?? `Phase ${i + 1}`,
      ...p
    }))
  };
}

test("planner advances through phases on accept verdicts", async () => {
  const statuses = [];
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }, { id: "p2" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: mockInvoker([
      { content: "phase 1 done" },             // p1 executor
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) }, // p1 critic
      { content: "phase 2 done" },             // p2 executor
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) }  // p2 critic
    ]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "claude-sonnet-4-6-20250514", provider: "anthropic" }),
    emitStatus: (text) => statuses.push(text),
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases.length, 2);
  assert.equal(result.ledger.phases[0].status, "accepted");
  assert.equal(result.ledger.phases[1].status, "accepted");
  assert.ok(statuses.some((s) => s.includes("Phase 1")));
});

test("planner retries a phase on retry_phase verdict", async () => {
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: mockInvoker([
      { content: "broken attempt" },             // p1 executor attempt 1
      { content: JSON.stringify({ decision: "retry_phase", reasoning: "tool error", confidence: 0.3, retryGuidance: "try again" }) },
      { content: "fixed attempt" },              // p1 executor attempt 2
      { content: JSON.stringify({ decision: "accept", reasoning: "ok now", confidence: 0.9 }) }
    ]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases[0].attempts, 2);
  assert.equal(result.ledger.phases[0].status, "accepted");
});

test("planner escalates when retry budget exhausted", async () => {
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: mockInvoker([
      { content: "fail 1" },
      { content: JSON.stringify({ decision: "retry_phase", reasoning: "still broken", confidence: 0.2, retryGuidance: "fix it" }) },
      { content: "fail 2" },
      { content: JSON.stringify({ decision: "retry_phase", reasoning: "still broken", confidence: 0.2, retryGuidance: "fix it again" }) }
    ]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "escalated");
  assert.ok(result.pendingApproval);
});

test("planner applies amend_plan verdicts", async () => {
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }, { id: "p2" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: mockInvoker([
      { content: "p1 discovered something" },
      { content: JSON.stringify({
        decision: "amend_plan",
        reasoning: "need an extra phase",
        confidence: 0.8,
        amendments: [
          { action: "insert_phase", after: "p1", phase: { id: "p1b", activity: "documents", prompt: "handle new discovery", title: "Handle discovery" } }
        ]
      }) },
      { content: "p1b done" },
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) },
      { content: "p2 done" },
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) }
    ]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases.length, 3);
  assert.equal(result.ledger.phases[1].id, "p1b");
});

test("planner terminates on budget exhaustion", async () => {
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }, { id: "p2" }, { id: "p3" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: mockInvoker([
      { content: "p1 done" },
      { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) }
    ]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 1, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "budget_exhausted");
  assert.ok(result.content.length > 0, "should return last-known-good content");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/orchestrator/src/planner.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// packages/orchestrator/src/planner.js
import { runCritic } from "./critic.js";

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

function applyAmendments(phases, currentIndex, amendments) {
  if (!Array.isArray(amendments) || !amendments.length) return phases;
  let result = [...phases];
  for (const amendment of amendments) {
    if (amendment.action === "insert_phase" && amendment.phase) {
      const afterIdx = result.findIndex((p) => p.id === amendment.after);
      const insertAt = afterIdx >= 0 ? afterIdx + 1 : currentIndex + 1;
      result.splice(insertAt, 0, {
        ...amendment.phase,
        _insertedBy: `critic@${phases[currentIndex]?.id ?? "unknown"}`
      });
    } else if (amendment.action === "replace_phase" && amendment.phase && amendment.phaseId) {
      const idx = result.findIndex((p) => p.id === amendment.phaseId);
      if (idx >= 0) {
        result[idx] = { ...result[idx], ...amendment.phase };
      }
    } else if (amendment.action === "drop_phase" && amendment.phaseId) {
      result = result.filter((p) => p.id !== amendment.phaseId);
    }
  }
  return result;
}

const LESSON_TOKEN_RESERVE = 4000;

export async function runIterativePlan({
  plan,
  originalGoal,
  taskType,
  invokeModel,
  resolveProvider,
  hasApiKey,
  getCriticModel,
  emitStatus,
  onChunk,
  budget,
  collectContext,
  toolSummary,
  systemMessage,
  conversationMessages,
  enrichedPrompt
}) {
  const startedAt = Date.now();
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
  const maxTokens = budget?.maxTokensTotal ?? 400000;
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
      totalPhasesExecuted += 1;

      emitStatus?.(`Running phase ${phaseNum}/${totalPhases}: ${phase.title ?? phase.prompt}...`);

      // Resolve a provider for this phase's activity type
      const phaseModel = phase.modelOverride ?? null;
      const providerId = resolveProvider?.(phaseModel ?? "gpt-5.4") ?? "openai";

      phaseEntry.executorModel = phaseModel ?? "gpt-5.4";

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

        lastContent = result.content ?? "";
        const phaseToolTrace = result.toolTrace ?? [];

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
            toolTraceSummary: summarizeToolTrace(phaseToolTrace)
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
            const amended = applyAmendments(phases, phaseIndex, verdict.amendments);
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
      ledger.outcome = "escalated";
      ledger.endedAt = Date.now();
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      return {
        outcome: "escalated",
        content: lastContent,
        pendingApproval: true,
        escalationReason: reason,
        ledger
      };
    }

    phaseEntry.durationMs = Date.now() - startedAt;
    phaseIndex += 1;
  }

  if (!ledger.outcome) {
    ledger.outcome = "success";
  }
  ledger.endedAt = Date.now();
  ledger.budget.wallClockMs = Date.now() - startedAt;
  ledger.budget.phasesUsed = totalPhasesExecuted;

  return {
    outcome: ledger.outcome,
    content: lastContent,
    pendingApproval: ledger.outcome === "escalated",
    ledger
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test packages/orchestrator/src/planner.test.js`
Expected: 5 tests, 5 pass

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/planner.js packages/orchestrator/src/planner.test.js
git commit -m "feat(orchestrator): add iterative planner state machine with critic loop"
```

---

### Task 5: Wire `runIterativePlan` into `executeTask`

**Files:**
- Modify: `packages/orchestrator/src/index.js`

- [ ] **Step 1: Add the import at the top of the file**

At the top of `packages/orchestrator/src/index.js`, after the existing imports, add:

```js
import { runIterativePlan } from "./planner.js";
import { generateAndWriteLesson } from "./lesson-writer.js";
```

- [ ] **Step 2: Add `runMode: "iterative"` branch in `executeTask`**

In `packages/orchestrator/src/index.js`, inside the `executeTask` method, right after the sandboxed-mode section ends (after `return { ... sandboxStatus };`) and before `const selectedModel = this.modelRouter.selectModel(...)`, insert:

```js
    // ── Iterative mode: run the plan through the critic loop ──
    if (runMode === "iterative" && taskContext?.executionPlan) {
      const selectedModel = this.modelRouter.selectModel(resolvedTaskType, modelOverride);
      const fallbackChain = this.modelRouter.getFallbackChain(selectedModel);
      const providerId = this.options.resolveProvider?.(selectedModel) ?? "openai";

      const criticSelection = this.modelRouter.getCriticModel(
        selectedModel,
        (model) => {
          const pid = this.options.resolveProvider?.(model);
          return pid ? (this.options.hasApiKey ? this.options.hasApiKey(pid) : false) : false;
        }
      );

      timeline.push({
        stage: "iterative",
        detail: `Iterative mode: executor=${selectedModel}, critic=${criticSelection?.model ?? "degraded"}`
      });

      const iterativeResult = await runIterativePlan({
        plan: taskContext.executionPlan,
        originalGoal: prompt,
        taskType: resolvedTaskType,
        invokeModel: this.options.invokeModel,
        resolveProvider: this.options.resolveProvider,
        hasApiKey: (model) => {
          const pid = this.options.resolveProvider?.(model);
          return pid ? this.options.hasApiKey?.(pid) : false;
        },
        getCriticModel: () =>
          criticSelection
            ? { model: criticSelection, provider: this.options.resolveProvider?.(criticSelection) }
            : null,
        emitStatus,
        onChunk: quietMode ? undefined : (chunk) => {
          if (chunk?.type === "status" && this.options.emitStatus) {
            this.options.emitStatus(chunk.text);
          }
        },
        budget: activityProfile.budget ?? {
          maxCriticRoundsPerPhase: 2,
          maxTotalPhases: 12,
          maxWallClockMs: 10 * 60 * 1000,
          maxTokensTotal: 400000
        },
        systemMessage: [
          "You are a highly capable personal assistant. Be concise, accurate, and actionable.",
          getSkillInstruction(skillId),
          memoryContext ? `Remembered user context:\n${memoryContext}` : ""
        ].filter(Boolean).join("\n\n"),
        conversationMessages: sanitizedConversationMessages,
        enrichedPrompt
      });

      // Lesson writer — always runs, never blocks
      if (this.options.memoryStore) {
        emitStatus("Recording lesson...");
        const lessonModel = criticSelection ?? selectedModel;
        const lessonProvider = this.options.resolveProvider?.(lessonModel) ?? providerId;
        await generateAndWriteLesson({
          invokeModel: this.options.invokeModel,
          lessonModel: typeof lessonModel === "string" ? lessonModel : lessonModel,
          lessonProvider,
          memoryStore: this.options.memoryStore,
          taskType: resolvedTaskType,
          originalGoal: prompt,
          outcome: iterativeResult.outcome,
          toolsUsed: (iterativeResult.ledger?.phases ?? []).flatMap(
            (p) => (p.toolTrace ?? []).map((t) => t.tool)
          ),
          criticVerdicts: (iterativeResult.ledger?.phases ?? []).flatMap(
            (p) => p.criticVerdicts ?? []
          ),
          planSummary: (iterativeResult.ledger?.phases ?? [])
            .map((p) => `${p.id}: ${p.status}`)
            .join(", ")
        });
      }

      timeline.push({
        stage: "result",
        detail: `Iterative plan ${iterativeResult.outcome} (${iterativeResult.ledger?.budget?.phasesUsed ?? 0} phases)`
      });

      return {
        taskType: resolvedTaskType,
        model: selectedModel,
        provider: providerId,
        content: iterativeResult.content,
        timeline,
        toolSummary,
        toolActivity,
        toolTrace,
        runMode,
        fallbackChain,
        pendingApproval: iterativeResult.pendingApproval ?? false,
        runLedger: iterativeResult.ledger
      };
    }
```

- [ ] **Step 3: Run existing tests to ensure no regression**

Run: `node --test packages/orchestrator/src/workflow.test.js packages/orchestrator/src/retrieval.test.js`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/index.js
git commit -m "feat(orchestrator): wire iterative planner into executeTask"
```

---

### Task 6: Inject PRIOR LESSONS into `collectToolContext`

**Files:**
- Modify: `packages/orchestrator/src/index.js` (the `collectToolContext` method)

- [ ] **Step 1: Add the memory-store lesson retrieval**

At the end of the `collectToolContext` method in `packages/orchestrator/src/index.js`, just before the final `return`, add:

```js
    // ── Prior lessons from memory store ──
    if (this.options.memoryStore) {
      const lessons = this.options.memoryStore.search(
        `run_lesson ${resolvedTaskType}`,
        { limit: 3 }
      ).filter((m) => m.category === "run_lesson");

      if (lessons.length > 0) {
        const lessonBlock = lessons
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join("\n");
        contextSections.push(
          `PRIOR LESSONS (from previous runs of this task type):\n${lessonBlock}`
        );
      }
    }
```

- [ ] **Step 2: Run existing retrieval test to confirm no regression**

Run: `node --test packages/orchestrator/src/retrieval.test.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/index.js
git commit -m "feat(orchestrator): inject PRIOR LESSONS from memory store into tool context"
```

---

### Task 7: Persist `runLedger` in task-store and render in desktop

**Files:**
- Modify: `apps/desktop/renderer.js` (task details rendering)
- Modify: `apps/desktop/main.js` (pass `runLedger` into task update)

- [ ] **Step 1: Find where task results are saved in `main.js`**

Search for `taskStore.update` calls that set `result` — the `runLedger` needs to be stored alongside.

In `apps/desktop/main.js`, wherever the orchestrator result is saved to the task store (the `taskStore.update(taskId, { status: "completed", result: ... })` call), extend the update to include `runLedger`:

```js
// Add to the task update payload wherever result is persisted:
runLedger: orchestratorResult.runLedger ?? null,
```

- [ ] **Step 2: Render the `runLedger` in the task details pane**

In `apps/desktop/renderer.js`, inside `renderSelectedTaskDetails()`, after the existing task detail rendering, add a conditional block:

```js
    // Render run ledger if present (L0 iterative planner output)
    if (selectedTask?.runLedger) {
      const ledgerSection = document.createElement("details");
      ledgerSection.className = "task-detail-section";
      ledgerSection.innerHTML = `
        <summary><strong>Run Ledger</strong> (${selectedTask.runLedger.outcome ?? "unknown"} — ${selectedTask.runLedger.budget?.phasesUsed ?? 0} phases)</summary>
        <pre class="run-ledger-json">${escapeHtml(JSON.stringify(selectedTask.runLedger, null, 2))}</pre>
      `;
      // Append to task detail container
      els.taskDetailContainer?.appendChild(ledgerSection);
    }
```

- [ ] **Step 3: Run the app locally, trigger a multi-phase task, and verify the ledger appears in the task details pane**

Expected: Collapsible "Run Ledger" section with the JSON tree.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/main.js apps/desktop/renderer.js
git commit -m "feat(desktop): persist and render runLedger in task details"
```

---

### Task 8: Full test suite + regression check

**Files:**
- All test files across the workspace

- [ ] **Step 1: Run all new tests**

Run:
```bash
node --test packages/model-router/src/critic.test.js packages/orchestrator/src/critic.test.js packages/orchestrator/src/lesson-writer.test.js packages/orchestrator/src/planner.test.js
```
Expected: All pass (17 new tests)

- [ ] **Step 2: Run the full workspace test suite**

Run:
```bash
node --test $(find packages -name '*.test.js' -type f)
```
Expected: 64+ tests, 0 failures

- [ ] **Step 3: Syntax-check all modified files**

Run:
```bash
for f in packages/orchestrator/src/index.js packages/orchestrator/src/planner.js packages/orchestrator/src/critic.js packages/orchestrator/src/lesson-writer.js packages/model-router/src/index.js apps/desktop/main.js apps/desktop/renderer.js; do node --check "$f" || echo "FAIL: $f"; done
```
Expected: No failures

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: L0 iterative planner — full test suite green"
```
