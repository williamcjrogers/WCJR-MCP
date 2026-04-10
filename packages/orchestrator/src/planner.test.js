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
  const mockParallelInvoker = async ({ messages }) => {
    const content = messages[messages.length - 1]?.content ?? "";
    const isCritic = (messages[0]?.content ?? "").includes("auditing");
    if (isCritic) {
      return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
    }
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
        const phaseId = content.toLowerCase().startsWith("p1") ? "p1" : "p2";
        if (isCritic) {
          // First p1 critic call → retry; everything else accept.
          // Discriminator: "PHASE JUST RUN: p1" from buildCriticPrompt.
          const isP1Critic = content.includes("PHASE JUST RUN: p1");
          if (isP1Critic && callsByPhase.p1 === 1) {
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

test("L2: error in one phase terminates run as failed", async () => {
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
      await new Promise((r) => setTimeout(r, 10));
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
        if (content.includes("P1")) {
          return { content: JSON.stringify({ decision: "escalate", reasoning: "human needed", confidence: 0.1, escalationReason: "ambiguous requirement" }) };
        }
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: "phase done" };
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

test("L2: amendment in a batch triggers re-batch and executes inserted phase", async () => {
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
        // First critic call for P1 → amend; everything else accept
        if (content.includes("P1") && criticCallCount <= 2) {
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
      return { content: "phase done" };
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
  assert.ok(result.error?.includes("Invalid plan"));
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
