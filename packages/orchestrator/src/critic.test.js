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
