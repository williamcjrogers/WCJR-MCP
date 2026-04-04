import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntimeMetadata,
  formatRuntimeDiagnostics,
  mergeAssistantState
} from "./state-contract.js";

test("buildRuntimeMetadata marks BAT-style launches as source runtime", () => {
  const runtime = buildRuntimeMetadata({
    isPackaged: false,
    appPath: "D:\\WCJR MCP\\WCJR-MCP\\apps\\desktop",
    userDataPath: "C:\\Users\\William\\AppData\\Roaming\\desktop",
    configPath: "C:\\Users\\William\\AppData\\Roaming\\desktop\\assistant-config.json"
  });

  assert.equal(runtime.launchMode, "source");
  assert.match(formatRuntimeDiagnostics(runtime), /Runtime: Source app/i);
  assert.match(formatRuntimeDiagnostics(runtime), /assistant-config\.json/i);
});

test("mergeAssistantState preserves bootstrap controls when workspace data is missing", () => {
  const merged = mergeAssistantState({
    providers: { openai: "OpenAI" },
    keyStatus: { openai: true },
    modelProfiles: { orchestrator: "gpt-5.4-pro" },
    taskTypes: ["orchestrator", "research"],
    activityProfiles: [{ id: "research", label: "Research" }],
    executionMode: "plan_first",
    sandboxPreference: "manual",
    theme: "meritus-via",
    themeIds: ["midnight", "meritus-via"],
    runtime: { launchMode: "source", appPath: "D:\\WCJR MCP\\WCJR-MCP\\apps\\desktop" }
  });

  assert.equal(merged.theme, "meritus-via");
  assert.equal(merged.keyStatus.openai, true);
  assert.deepEqual(merged.conversations, []);
  assert.equal(merged.messaging.enabled, false);
});
