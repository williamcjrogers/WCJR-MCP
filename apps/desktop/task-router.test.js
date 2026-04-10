import test from "node:test";
import assert from "node:assert/strict";

// ── Pure re-implementation of the L3a rules ──
// main.js can't be imported (it boots Electron on load), so we re-implement
// the three pure rules here and test them in isolation. These must stay in
// sync with the actual code in apps/desktop/main.js. If they drift, the
// test suite is silently wrong — the regression risk is mitigated by
// manual verification in Task 5.

const RISKY_TYPES = new Set([
  "coding",
  "automation",
  "project_mgmt",
  "data_analysis",
  "aws_cloud",
  "documents"
]);

function resolveRunMode({ requestedRunMode, remoteOrigin, sandboxPreference, resolvedTaskType }) {
  // Mirror of apps/desktop/main.js:2319 (post-Task 1)
  let resolvedRunMode = requestedRunMode ?? (remoteOrigin ? "iterative" : "direct");
  if (resolvedRunMode === "direct" && sandboxPreference === "risky") {
    if (RISKY_TYPES.has(resolvedTaskType)) {
      resolvedRunMode = "sandboxed";
    }
  }
  return resolvedRunMode;
}

function validateBearerToken({ expectedToken, authHeader }) {
  // Mirror of apps/desktop/main.js n8n handler auth block
  if (!expectedToken) return { ok: false, status: 503, reason: "not configured" };
  if (typeof authHeader !== "string") return { ok: false, status: 401, reason: "missing" };
  if (!authHeader.startsWith("Bearer ")) return { ok: false, status: 401, reason: "wrong scheme" };
  if (authHeader.slice(7).trim() !== expectedToken) return { ok: false, status: 401, reason: "mismatch" };
  return { ok: true, status: 200 };
}

function buildWebhookRemoteOrigin(parsed) {
  // Mirror of apps/desktop/main.js n8n handler remoteOrigin construction
  const webhookRequestId = `wh_test_${Math.random().toString(36).slice(2, 8)}`;
  return {
    channel: "webhook",
    source: "n8n",
    webhookRequestId,
    callbackUrl: typeof parsed.callbackUrl === "string" ? parsed.callbackUrl : null,
    at: new Date().toISOString()
  };
}

// ── Tests ──

test("resolveRunMode: desktop (no remoteOrigin) defaults to direct", () => {
  const result = resolveRunMode({
    requestedRunMode: undefined,
    remoteOrigin: null,
    sandboxPreference: "manual",
    resolvedTaskType: "research"
  });
  assert.equal(result, "direct");
});

test("resolveRunMode: ambient (remoteOrigin set) defaults to iterative", () => {
  const result = resolveRunMode({
    requestedRunMode: undefined,
    remoteOrigin: { channel: "telegram", chatId: "123" },
    sandboxPreference: "manual",
    resolvedTaskType: "research"
  });
  assert.equal(result, "iterative");
});

test("resolveRunMode: explicit runMode always wins over defaults", () => {
  assert.equal(
    resolveRunMode({
      requestedRunMode: "direct",
      remoteOrigin: { channel: "telegram", chatId: "123" },
      sandboxPreference: "manual",
      resolvedTaskType: "research"
    }),
    "direct"
  );
  assert.equal(
    resolveRunMode({
      requestedRunMode: "iterative",
      remoteOrigin: null,
      sandboxPreference: "manual",
      resolvedTaskType: "research"
    }),
    "iterative"
  );
  assert.equal(
    resolveRunMode({
      requestedRunMode: "sandboxed",
      remoteOrigin: null,
      sandboxPreference: "manual",
      resolvedTaskType: "research"
    }),
    "sandboxed"
  );
});

test("resolveRunMode: direct + risky preference upgrades risky task types to sandboxed", () => {
  const result = resolveRunMode({
    requestedRunMode: undefined,
    remoteOrigin: null,
    sandboxPreference: "risky",
    resolvedTaskType: "coding"
  });
  assert.equal(result, "sandboxed");
});

test("resolveRunMode: ambient (iterative) is NOT downgraded by risky preference", () => {
  const result = resolveRunMode({
    requestedRunMode: undefined,
    remoteOrigin: { channel: "telegram", chatId: "123" },
    sandboxPreference: "risky",
    resolvedTaskType: "coding"
  });
  // iterative takes precedence; risky upgrade only fires when resolvedRunMode === "direct"
  assert.equal(result, "iterative");
});

test("resolveRunMode: non-risky task type is not upgraded even with risky preference", () => {
  const result = resolveRunMode({
    requestedRunMode: undefined,
    remoteOrigin: null,
    sandboxPreference: "risky",
    resolvedTaskType: "creative"
  });
  assert.equal(result, "direct");
});

test("validateBearerToken: missing config returns 503", () => {
  const result = validateBearerToken({ expectedToken: null, authHeader: "Bearer abc" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test("validateBearerToken: missing header returns 401", () => {
  const result = validateBearerToken({ expectedToken: "secret", authHeader: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("validateBearerToken: wrong scheme returns 401", () => {
  const result = validateBearerToken({ expectedToken: "secret", authHeader: "Basic abc" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("validateBearerToken: mismatch returns 401", () => {
  const result = validateBearerToken({ expectedToken: "secret", authHeader: "Bearer wrong" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("validateBearerToken: valid token returns 200", () => {
  const result = validateBearerToken({ expectedToken: "secret", authHeader: "Bearer secret" });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test("validateBearerToken: trims trailing whitespace on token", () => {
  const result = validateBearerToken({ expectedToken: "secret", authHeader: "Bearer secret  " });
  assert.equal(result.ok, true);
});

test("buildWebhookRemoteOrigin: sets channel and source", () => {
  const origin = buildWebhookRemoteOrigin({});
  assert.equal(origin.channel, "webhook");
  assert.equal(origin.source, "n8n");
  assert.equal(origin.callbackUrl, null);
  assert.match(origin.webhookRequestId, /^wh_test_/);
  assert.ok(origin.at);
});

test("buildWebhookRemoteOrigin: preserves callbackUrl when present and string", () => {
  const origin = buildWebhookRemoteOrigin({ callbackUrl: "https://example.com/cb" });
  assert.equal(origin.callbackUrl, "https://example.com/cb");
});

test("buildWebhookRemoteOrigin: drops non-string callbackUrl", () => {
  const origin = buildWebhookRemoteOrigin({ callbackUrl: 42 });
  assert.equal(origin.callbackUrl, null);
});
