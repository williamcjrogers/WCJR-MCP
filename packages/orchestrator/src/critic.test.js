import test from "node:test";
import assert from "node:assert/strict";
import { buildCriticPrompt, parseVerdict, runCritic, VERDICT_SCHEMA_DECISIONS } from "./critic.js";

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

test("parseVerdict returns a degraded verdict for malformed JSON", () => {
  const verdict = parseVerdict("this is not json at all");
  // The planner treats 'degraded' as 'pass through but tag the ledger' so the
  // caller can still see that the critic never actually vouched for the phase.
  assert.equal(verdict.decision, "degraded");
  assert.equal(verdict.confidence, 0);
  assert.equal(verdict._parseError, true);
});

test("parseVerdict rejects unknown decision values with a degraded verdict", () => {
  const raw = JSON.stringify({ decision: "destroy", reasoning: "test", confidence: 1 });
  const verdict = parseVerdict(raw);
  assert.equal(verdict.decision, "degraded");
  assert.equal(verdict._parseError, true);
});

test("VERDICT_SCHEMA_DECISIONS contains all four valid decisions", () => {
  assert.deepEqual(
    [...VERDICT_SCHEMA_DECISIONS].sort(),
    ["accept", "amend_plan", "escalate", "retry_phase"]
  );
});

test("runCritic returns a degraded verdict when invokeModel throws", async () => {
  const verdict = await runCritic({
    invokeModel: async () => { throw new Error("network timeout"); },
    criticModel: "test-model",
    criticProvider: "test",
    originalGoal: "goal",
    taskType: "disputes",
    planSummary: "plan",
    phaseId: "p1",
    phaseIntent: "intent",
    phaseResult: "result"
  });
  assert.equal(verdict.decision, "degraded");
  assert.equal(verdict._parseError, true);
});

test("runCritic returns a degraded verdict when invokeModel returns undefined content", async () => {
  const verdict = await runCritic({
    invokeModel: async () => ({ content: undefined }),
    criticModel: "test-model",
    criticProvider: "test",
    originalGoal: "goal",
    taskType: "disputes",
    planSummary: "plan",
    phaseId: "p1",
    phaseIntent: "intent",
    phaseResult: "result"
  });
  assert.equal(verdict.decision, "degraded");
  assert.equal(verdict._parseError, true);
});

test("parseVerdict extracts JSON from fenced block with preamble", () => {
  const raw = "Here is my verdict:\n```json\n{\"decision\":\"accept\",\"reasoning\":\"ok\",\"confidence\":0.85}\n```";
  const verdict = parseVerdict(raw);
  assert.equal(verdict.decision, "accept");
  assert.equal(verdict.confidence, 0.85);
  assert.equal(verdict._parseError, undefined);
});

test("buildCriticPrompt includes ARTIFACTS PRODUCED section when artifacts provided", () => {
  const prompt = buildCriticPrompt({
    originalGoal: "Make a workbook",
    taskType: "disputes",
    planSummary: "Phase 1: make workbook",
    phaseId: "p1",
    phaseIntent: "Create matter.xlsx",
    phaseResult: "Created workbook with 3 sheets",
    toolTraceSummary: "create_workbook: completed",
    artifacts: [
      { path: "/tmp/matter.xlsx", kind: "xlsx", sizeBytes: 12345 }
    ]
  });
  assert.ok(prompt.includes("ARTIFACTS PRODUCED"));
  assert.ok(prompt.includes("/tmp/matter.xlsx"));
  assert.ok(prompt.includes("xlsx"));
});

test("buildCriticPrompt omits ARTIFACTS PRODUCED when artifacts empty", () => {
  const prompt = buildCriticPrompt({
    originalGoal: "Goal",
    taskType: "disputes",
    planSummary: "plan",
    phaseId: "p1",
    phaseIntent: "intent",
    phaseResult: "result",
    toolTraceSummary: "",
    artifacts: []
  });
  assert.ok(!prompt.includes("ARTIFACTS PRODUCED"));
});
