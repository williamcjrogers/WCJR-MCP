import test from "node:test";
import assert from "node:assert/strict";

import { resolveModelForPhase } from "./tiers.js";

const stubRouter = {
  selectModel() {
    return "fallback-model";
  }
};

test("resolveModelForPhase prefers explicit models then UI overrides", () => {
  assert.equal(
    resolveModelForPhase({
      activityId: "coding",
      explicitModel: "gpt-5.2",
      uiOverride: "gemini-2.5-pro",
      modelRouter: stubRouter
    }),
    "gpt-5.2"
  );

  assert.equal(
    resolveModelForPhase({
      activityId: "coding",
      explicitModel: "",
      uiOverride: "gemini-2.5-pro",
      modelRouter: stubRouter
    }),
    "gemini-2.5-pro"
  );
});

test("resolveModelForPhase falls back to the configured tier list", () => {
  assert.equal(
    resolveModelForPhase({
      activityId: "coding",
      depth: "forensic",
      modelRouter: stubRouter,
      modelTiers: {
        quick: ["quick-model"],
        standard: ["standard-model"],
        forensic: ["deep-model"]
      }
    }),
    "deep-model"
  );
});
