import test from "node:test";
import assert from "node:assert/strict";

import { Orchestrator, normalizeExecutionPlan } from "./index.js";
import { buildExecutionBatches } from "./workflow.js";

test("normalizeExecutionPlan preserves v2 phase metadata", () => {
  const normalized = normalizeExecutionPlan({
    planVersion: 2,
    summary: "Review then implement",
    runMode: "direct",
    phases: [
      {
        id: "p1",
        activity: "research",
        prompt: "Inspect the codebase",
        depth: "forensic",
        parallelGroup: 0,
        dependsOn: []
      },
      {
        id: "p2",
        activity: "coding",
        prompt: "Apply fixes",
        depth: "standard",
        parallelGroup: 1,
        dependsOn: ["p1"]
      }
    ]
  });

  assert.equal(normalized.planVersion, 2);
  assert.equal(normalized.phases.length, 2);
  assert.deepEqual(normalized.phases[1].dependsOn, ["p1"]);
  assert.equal(normalized.phases[0].depth, "forensic");
  assert.equal(normalized.phases[0].title, "Review sources");
  assert.equal(normalized.phases[1].title, "Apply the changes");
  assert.equal(normalized.phases[0].approvalRequired, false);
});

test("normalizeExecutionPlan keeps explicit titles and approval flags", () => {
  const normalized = normalizeExecutionPlan({
    planVersion: 2,
    summary: "Draft and verify",
    phases: [
      {
        id: "p1",
        activity: "documents",
        title: "Draft amended agreement",
        prompt: "Amend the agreement draft using the review findings",
        approvalRequired: true
      }
    ]
  });

  assert.equal(normalized.phases[0].title, "Draft amended agreement");
  assert.equal(normalized.phases[0].approvalRequired, true);
});

test("buildExecutionBatches groups parallel work after dependencies are satisfied", () => {
  const batches = buildExecutionBatches([
    { id: "p1", dependsOn: [], parallelGroup: 0 },
    { id: "p2", dependsOn: ["p1"], parallelGroup: 0 },
    { id: "p3", dependsOn: ["p1"], parallelGroup: 0 },
    { id: "p4", dependsOn: ["p2", "p3"], parallelGroup: 0 }
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((phase) => phase.id)),
    [["p1"], ["p2", "p3"], ["p4"]]
  );
});

test("orchestrator synthesizes a workflow for explicit local-path document review requests", async () => {
  const orchestrator = new Orchestrator(
    {},
    {
      resolveProvider: () => "openai",
      hasApiKey: async () => true,
      invokeModel: async () => ({
        content: "I can help once you upload the files."
      })
    }
  );

  const summary = await orchestrator.executeTask({
    prompt: "Can you review the agreements in C:\\Users\\William\\OneDrive - Vericase LTD\\Agreements",
    taskType: "orchestrator",
    executionPhase: "plan"
  });

  assert.equal(summary.pendingApproval, true);
  assert.equal(summary.executionPlan?.phases?.[0]?.activity, "documents");
  assert.match(summary.content, /prepared a workflow/i);
});
