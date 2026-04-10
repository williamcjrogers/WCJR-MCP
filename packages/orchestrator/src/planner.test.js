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

test("planner terminates as failed when invokeModel throws", async () => {
  let call = 0;
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }, { id: "p2" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return { content: "should not reach" };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.ledger.phases.length, 1);
  assert.equal(result.ledger.phases[0].status, "error");
  assert.ok(result.error.includes("boom"));
});

test("planner optimistically accepts when getCriticModel returns null", async () => {
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }]),
    originalGoal: "Test goal",
    taskType: "research",
    invokeModel: mockInvoker([{ content: "p1 done" }]),
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => null,
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases[0].status, "accepted");
  assert.equal(result.ledger.phases[0].criticVerdicts.length, 0);
});

test("planner uses provided executorModel on phases without modelOverride", async () => {
  const seenModels = [];
  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }]),
    originalGoal: "Test goal",
    taskType: "research",
    executorModel: "claude-sonnet-4-6-20250514",
    invokeModel: async ({ model }) => {
      seenModels.push(model);
      // First call: executor. Second call: critic.
      if (seenModels.length === 1) {
        return { content: "p1 done" };
      }
      return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
    },
    resolveProvider: () => "anthropic",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "gemini-2.5-pro", provider: "gemini" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(seenModels[0], "claude-sonnet-4-6-20250514", "executor should use provided model");
  assert.equal(seenModels[1], "gemini-2.5-pro", "critic should use critic model");
});

test("planner attaches artifacts from the extractor and forwards them to the critic", async () => {
  const criticCalls = [];

  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }]),
    originalGoal: "Test goal",
    taskType: "research",
    workspaceDir: "/fake/workspace",
    extractArtifacts: async () => [
      { id: "art_1", path: "/fake/workspace/out.xlsx", kind: "xlsx", sizeBytes: 123, producedBy: [{ phaseId: "p1" }] }
    ],
    invokeModel: async (opts) => {
      // Executor call vs critic call: distinguish by the presence of "auditing" in system message
      const isCriticCall = (opts.messages?.[0]?.content ?? "").includes("auditing");
      if (isCriticCall) {
        criticCalls.push(opts.messages[1]?.content ?? "");
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: "phase 1 done" };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "claude-sonnet-4-6-20250514", provider: "anthropic" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases[0].artifacts.length, 1);
  assert.equal(result.ledger.phases[0].artifacts[0].kind, "xlsx");
  assert.equal(result.ledger.artifacts.length, 1);
  // Critic should have been given the artifacts section
  assert.equal(criticCalls.length, 1);
  assert.ok(criticCalls[0].includes("ARTIFACTS PRODUCED"));
  assert.ok(criticCalls[0].includes("/fake/workspace/out.xlsx"));
});
