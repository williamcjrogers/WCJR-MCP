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
