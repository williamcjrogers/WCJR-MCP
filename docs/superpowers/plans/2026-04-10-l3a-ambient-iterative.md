# L3a — Ambient Surfaces Use Iterative Mode (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade existing ambient surfaces (Telegram, WhatsApp, n8n webhook) to route tasks through `runMode: "iterative"` so they inherit L0+L1+L2 depth (critic loop, artifact graph, parallel fanout); fix the half-built n8n webhook so it actually spawns tasks server-side with bearer token auth; unify completion routing through a single hook.

**Architecture:** Surgical edits to `apps/desktop/main.js` — NOT a wholesale refactor of the existing 290-line `runAssistantTaskRequest`. Extend its runMode schema to accept `"iterative"`, add a default-to-iterative rule when `remoteOrigin` is set, add a small `routeTaskUpdate` helper for channel-agnostic dispatch, rewrite the n8n webhook handler to call `runAssistantTaskRequest` server-side with bearer auth. All existing tests pass; the desktop "Run" button behavior is unchanged unless the user explicitly switches modes.

**Tech Stack:** Node.js ESM, Electron `ipcMain`/`shell`/`webContents`, Node `http` server (existing), `zod` (already imported for schema), `node:test` for new unit tests.

**Approved design reference (in-conversation):**
- Unconditional iterative mode for ambient sources (remoteOrigin set → runMode defaults to iterative)
- Bearer token auth for `/api/n8n/trigger` (config `appConfig.webhookAuthToken` or env `WCJR_WEBHOOK_TOKEN`)
- Status-only streaming back to messaging (no new event shapes)
- `routeTaskUpdate` = one completion hook; existing `sendTelegramTaskManagerUpdate` call sites keep working
- Surgical scope: desktop Run button stays `"direct"` by default; ambient sources default to `"iterative"`

---

## File structure overview

**Modified:**
- `apps/desktop/main.js` — extend `runAssistantTaskRequest` runMode schema, add ambient default rule, add `routeTaskUpdate` helper, rewrite `/api/n8n/trigger` handler with bearer auth + server-side `runAssistantTaskRequest` call
- `apps/desktop/preload.js` — NO changes
- `docs/` — no new docs; spec exists in conversation only (fast-mode pivot)

**New:**
- `apps/desktop/task-router.test.js` — unit tests for the new `routeTaskUpdate` helper and the ambient-iterative runMode defaulting rule. Node `node:test` style.

**Not touched:**
- `packages/orchestrator/` — entire orchestrator stays as-is
- `packages/messaging-bridge/` — no changes
- `packages/task-store/` — no schema changes (existing `remoteOrigin` field is sufficient)
- `apps/desktop/renderer.js`, `index.html`, `styles.css` — no UI changes

---

## Task 1: Extend runMode schema to accept `"iterative"` and document ambient rule

**Files:**
- Modify: `apps/desktop/main.js:2288` (the `runAssistantTaskRequest` zod schema)
- Modify: `apps/desktop/main.js:2319` (the `resolvedRunMode` default logic)

- [ ] **Step 1: Read the existing schema block**

Open `apps/desktop/main.js`. Locate lines 2283-2325. Confirm the existing schema accepts only `"direct"` and `"sandboxed"` in the `runMode` enum, and that `resolvedRunMode` defaults to `"direct"` when not provided.

- [ ] **Step 2: Extend the runMode enum**

At `apps/desktop/main.js:2288`, change:

```js
    runMode: z.enum(["direct", "sandboxed"]).optional(),
```

To:

```js
    runMode: z.enum(["direct", "sandboxed", "iterative"]).optional(),
```

- [ ] **Step 3: Add ambient-default rule just after runMode destructuring**

At `apps/desktop/main.js:2319`, the current code is:

```js
  let resolvedRunMode = runMode ?? "direct";
  if (resolvedRunMode === "direct" && appConfig.sandboxPreference === "risky") {
    const riskyTypes = new Set(["coding", "automation", "project_mgmt", "data_analysis", "aws_cloud", "documents"]);
    if (riskyTypes.has(resolvedTaskType)) {
      resolvedRunMode = "sandboxed";
    }
  }
```

Replace with:

```js
  // L3a: ambient sources (remoteOrigin set) default to iterative mode
  // so Telegram/WhatsApp/webhook tasks get L0-L2 depth (critic, artifacts, parallel).
  // The desktop Run button (remoteOrigin === null) stays "direct" by default.
  let resolvedRunMode = runMode ?? (remoteOrigin ? "iterative" : "direct");
  if (resolvedRunMode === "direct" && appConfig.sandboxPreference === "risky") {
    const riskyTypes = new Set(["coding", "automation", "project_mgmt", "data_analysis", "aws_cloud", "documents"]);
    if (riskyTypes.has(resolvedTaskType)) {
      resolvedRunMode = "sandboxed";
    }
  }
```

- [ ] **Step 4: Syntax-check main.js**

Run:

```bash
node --check apps/desktop/main.js
```

Expected: exit code 0, no output.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): ambient tasks default to iterative runMode"
```

---

## Task 2: Add `routeTaskUpdate` helper in `apps/desktop/main.js`

**Files:**
- Modify: `apps/desktop/main.js` — add a new function alongside the existing `sendTelegramTaskManagerUpdate` at line 1756

- [ ] **Step 1: Read the existing `sendTelegramTaskManagerUpdate` function**

Open `apps/desktop/main.js` at line 1756. Read the full function body (it's a ~50 line helper that reads `getTaskRemoteOrigin(taskId)` and routes to `messagingBridge.sendUpdate()` when remoteOrigin.chatId exists, otherwise broadcasts to all allowedChatIds).

- [ ] **Step 2: Add `routeTaskUpdate` function immediately after `sendTelegramTaskManagerUpdate`**

Add this new function just below the closing brace of `sendTelegramTaskManagerUpdate`:

```js
/**
 * L3a: Unified task-update dispatch. Every new code path that reports
 * task progress, errors, artifacts, or completion should funnel through
 * here instead of calling IPC and messagingBridge separately.
 *
 * This is the single completion hook for ambient sources. It never throws —
 * channel-specific errors are logged and the caller's loop continues.
 *
 * Existing call sites that still call sendTelegramTaskManagerUpdate directly
 * remain functional for backward compatibility; new code should prefer this.
 *
 * @param {string} taskId
 * @param {object} update
 * @param {"progress"|"status"|"done"|"error"} update.type
 * @param {string} [update.text]     For progress/status/done messages.
 * @param {object} [update.summary]  For done events — full task summary.
 * @param {string} [update.error]    For error events.
 */
async function routeTaskUpdate(taskId, update) {
  if (!taskId || !update || typeof update !== "object") return;

  // ── Desktop renderer always receives every update ──
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (update.type === "done" && update.summary) {
        mainWindow.webContents.send("assistant:streamDone", {
          ...update.summary,
          taskId
        });
      } else if (update.type === "error") {
        mainWindow.webContents.send("assistant:streamError", {
          error: update.error,
          taskId
        });
      } else {
        mainWindow.webContents.send("assistant:taskUpdated", {
          taskId,
          update
        });
      }
    }
  } catch (err) {
    console.warn("[routeTaskUpdate] desktop IPC dispatch failed:", err?.message ?? err);
  }

  // ── Channel-specific routing based on remoteOrigin ──
  const remoteOrigin = getTaskRemoteOrigin(taskId);
  if (!remoteOrigin) return;

  try {
    if (remoteOrigin.channel === "telegram" || remoteOrigin.channel === "whatsapp") {
      // For L3a, messaging updates use the existing sendTelegramTaskManagerUpdate
      // helper (which despite its name handles both Telegram and WhatsApp via
      // messagingBridge.sendUpdate). This preserves the existing throttle and
      // formatting behaviour. Only "done" and "error" events need routing here;
      // progress updates during execution still flow through the existing
      // telegramThrottle.maybeSend() path inside taskContext.onProgress.
      if (update.type === "done" && update.summary) {
        const text = buildTelegramManagerText({
          requestText: update.summary.prompt ?? "",
          summary: { content: update.summary.content ?? "" },
          metadata: {
            model: update.summary.model ?? null,
            provider: update.summary.provider ?? null,
            elapsedMs: update.summary.elapsedMs ?? 0,
            agentRuns: update.summary.agentRuns ?? [],
            toolCount: (update.summary.toolActivity ?? []).length
          }
        });
        await sendTelegramTaskManagerUpdate(taskId, text);
      } else if (update.type === "error") {
        const text = buildTelegramManagerFallback({
          requestText: update.summary?.prompt ?? "",
          summary: { error: update.error },
          metadata: {}
        });
        await sendTelegramTaskManagerUpdate(taskId, text);
      }
    } else if (remoteOrigin.channel === "webhook") {
      // Webhook replies are handled by the HTTP response handler's own
      // completion listener (see Task 3). routeTaskUpdate is a no-op for
      // webhook tasks today; callbackUrl support is L3b.
    }
  } catch (err) {
    console.warn(
      `[routeTaskUpdate] channel '${remoteOrigin.channel}' dispatch failed:`,
      err?.message ?? err
    );
  }
}
```

- [ ] **Step 3: Syntax-check main.js**

```bash
node --check apps/desktop/main.js
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): add routeTaskUpdate unified task-update dispatcher"
```

---

## Task 3: Rewrite `/api/n8n/trigger` to spawn tasks server-side with bearer token auth

**Files:**
- Modify: `apps/desktop/main.js:3821-3836` (the existing n8n trigger handler inside `startWebhookServer`)

- [ ] **Step 1: Read the existing handler**

Open `apps/desktop/main.js:3821`. Confirm the current handler parses JSON, forwards to `mainWindow.webContents.send("assistant:n8nTrigger", parsed)`, and returns `200 { ok: true }` immediately without creating a task.

- [ ] **Step 2: Replace the handler body**

Find this block at line 3821:

```js
      // --- n8n trigger ---
      if (req.method === "POST" && req.url === "/api/n8n/trigger") {
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString());
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("assistant:n8nTrigger", parsed);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
```

Replace it with:

```js
      // --- n8n trigger (L3a: server-side spawn + bearer token auth) ---
      if (req.method === "POST" && req.url === "/api/n8n/trigger") {
        // Bearer token auth — required
        const expectedToken =
          appConfig?.webhookAuthToken ??
          process.env.WCJR_WEBHOOK_TOKEN ??
          null;
        if (!expectedToken) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            error: "Webhook auth token not configured. Set appConfig.webhookAuthToken or WCJR_WEBHOOK_TOKEN env var."
          }));
          return;
        }
        const authHeader = req.headers["authorization"] ?? "";
        if (
          typeof authHeader !== "string" ||
          !authHeader.startsWith("Bearer ") ||
          authHeader.slice(7).trim() !== expectedToken
        ) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing bearer token" }));
          return;
        }

        // Parse payload
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString());
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
          return;
        }

        const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing required field: prompt" }));
          return;
        }

        // Still notify renderer that a webhook fired (for the banner)
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send("assistant:n8nTrigger", parsed);
          } catch (err) {
            console.warn("[n8n webhook] renderer notify failed:", err?.message ?? err);
          }
        }

        // Build remoteOrigin for webhook channel
        const webhookRequestId = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const remoteOrigin = {
          channel: "webhook",
          source: "n8n",
          webhookRequestId,
          callbackUrl: typeof parsed.callbackUrl === "string" ? parsed.callbackUrl : null,
          at: new Date().toISOString()
        };

        // Spawn task via the existing runAssistantTaskRequest path
        try {
          const taskPayload = {
            prompt,
            taskType: typeof parsed.taskType === "string" ? parsed.taskType : undefined,
            modelOverride: typeof parsed.modelOverride === "string" ? parsed.modelOverride : undefined
          };
          const runtime = { remoteOrigin };
          const waitForCompletion = parsed.waitForCompletion === true;

          if (waitForCompletion) {
            // Synchronous mode: hold the HTTP response open until the task finishes.
            // The runAssistantTaskRequest function runs sequentially and only returns
            // after executeTask has settled.
            let summary;
            try {
              summary = await runAssistantTaskRequest(taskPayload, runtime);
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                ok: false,
                webhookRequestId,
                error: err?.message ?? String(err)
              }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: true,
              webhookRequestId,
              taskId: summary?.taskId ?? null,
              summary
            }));
            return;
          }

          // Async mode (default): acknowledge immediately with a 202,
          // let the task run in the background. The webhookRequestId is
          // the caller's correlation key.
          const taskPromise = runAssistantTaskRequest(taskPayload, runtime).catch((err) => {
            console.error("[n8n webhook] async task failed:", err?.message ?? err);
          });
          // Don't await taskPromise — fire and acknowledge
          void taskPromise;

          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            webhookRequestId,
            mode: "async",
            note: "Task started in the background. Check the desktop app for status."
          }));
          return;
        } catch (err) {
          console.error("[n8n webhook] spawn failed:", err?.message ?? err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: false,
            webhookRequestId,
            error: err?.message ?? String(err)
          }));
          return;
        }
      }
```

**Implementation notes on this block:**

1. The current `runAssistantTaskRequest` function is `async` and returns the final summary only after the task completes. For `waitForCompletion: true`, we `await` it. For async mode, we fire-and-forget with a `.catch` to prevent unhandled rejections.

2. There's no `taskId` available synchronously from `runAssistantTaskRequest` in async mode — the function creates the task internally and returns only after completion. For L3a that's acceptable: the caller gets a `webhookRequestId` as their correlation key and can check the desktop app to see the task. Resolving this (exposing `taskId` earlier) is L3b scope.

3. `callbackUrl` is accepted in the payload but not yet used. A future L3b task will add the callback POST step. For L3a, callback-based clients should use `waitForCompletion: true`.

4. Bearer token: the helper reads `appConfig?.webhookAuthToken` first, falling back to `process.env.WCJR_WEBHOOK_TOKEN`. If neither is set, the endpoint returns 503 — this is the "fail closed" behavior. Operators must configure the token before using the endpoint.

- [ ] **Step 3: Syntax-check main.js**

```bash
node --check apps/desktop/main.js
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): n8n webhook spawns tasks server-side with bearer auth"
```

---

## Task 4: Add unit tests for the L3a logic

**Files:**
- Create: `apps/desktop/task-router.test.js`

The unit tests cover the pure logic surfaces of L3a. Since `main.js` is a 4000-line Electron entry point that boots an entire app at import time, we cannot directly import and test its functions. Instead, this test file tests the DECISION LOGIC in isolation by re-implementing the small pure helpers as local functions and asserting their behavior. This verifies the rules we encoded are correct.

- [ ] **Step 1: Create the test file**

Create `apps/desktop/task-router.test.js` with this content:

```js
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
```

- [ ] **Step 2: Run the tests**

```bash
node --test apps/desktop/task-router.test.js
```

Expected output: 14 tests pass, 0 fail.

- [ ] **Step 3: Run the full workspace test sweep to confirm no regressions**

```bash
node --test $(find packages -name '*.test.js' -type f) apps/desktop/task-router.test.js
```

Expected: 115 existing tests (L0+L1+L2 baseline) + 14 new L3a tests = 129 passing. Zero failures.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/task-router.test.js
git commit -m "test(desktop): L3a unit tests for runMode defaulting and bearer auth"
```

---

## Task 5: Final regression sweep + manual smoke-test checklist

**Files:** None modified — verification only.

- [ ] **Step 1: Run the full workspace test suite one more time**

```bash
node --test $(find packages -name '*.test.js' -type f) apps/desktop/task-router.test.js
```

Expected: 129 tests pass, 0 fail.

- [ ] **Step 2: Syntax-check every file touched by L3a**

```bash
node --check apps/desktop/main.js
node --check apps/desktop/task-router.test.js
```

Expected: no output (both exit 0).

- [ ] **Step 3: Manual smoke-test checklist (document only — not enforced by CI)**

The following manual tests should be run in the live app before declaring L3a shipped. Do NOT gate this plan on them passing — flag any failures as fix-up work. Run them by hand and note results.

1. **Desktop Run button still works unchanged.** Click Run with a simple prompt → task runs in direct mode (unless the user toggled the iterative dropdown). No regression.

2. **Telegram message spawns an iterative task.** Send a message to the bot. Open the desktop Run Ledger panel. Confirm the task shows:
   - `runMode: "iterative"` in the task row
   - Phases with critic verdicts in the runLedger JSON
   - Artifacts, if any were produced
   - Throttled progress updates arriving in Telegram during execution
   - A final summary message in Telegram when the task finishes

3. **WhatsApp message spawns an iterative task.** Same checklist as Telegram but via the WAHA webhook path. If WAHA isn't configured locally, skip and document.

4. **n8n webhook without token returns 401.**
   ```bash
   curl -v -X POST http://localhost:4000/api/n8n/trigger \
     -H "Content-Type: application/json" \
     -d '{"prompt":"test"}'
   ```
   Expected: HTTP 401 with `{"ok": false, "error": "invalid or missing bearer token"}`.

5. **n8n webhook without token configured returns 503.**
   Temporarily unset `appConfig.webhookAuthToken` AND `process.env.WCJR_WEBHOOK_TOKEN`. Same curl with a token header. Expected: HTTP 503 with `"not configured"` in the error.

6. **n8n webhook with wrong token returns 401.**
   Set `appConfig.webhookAuthToken = "secret"`. Curl:
   ```bash
   curl -v -X POST http://localhost:4000/api/n8n/trigger \
     -H "Authorization: Bearer wrong-token" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"test"}'
   ```
   Expected: HTTP 401 with mismatch error. Task NOT created in desktop task list.

7. **n8n webhook async mode returns 202 and spawns a task.**
   Set `appConfig.webhookAuthToken = "secret"`. Curl:
   ```bash
   curl -v -X POST http://localhost:4000/api/n8n/trigger \
     -H "Authorization: Bearer secret" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"Summarize today in one sentence"}'
   ```
   Expected: HTTP 202 within ~100ms with `{"ok": true, "webhookRequestId": "wh_...", "mode": "async"}`. Open desktop app — a new task appears in the task list, runs in iterative mode, populates the runLedger. Status banner "n8n webhook triggered" fires in the renderer.

8. **n8n webhook waitForCompletion mode returns 200 with summary.**
   ```bash
   curl -v -X POST http://localhost:4000/api/n8n/trigger \
     -H "Authorization: Bearer secret" \
     -H "Content-Type: application/json" \
     -d '{"prompt":"Return the word OK","waitForCompletion":true}'
   ```
   Expected: HTTP 200 after the task finishes (may take 10-30s). Response body contains `summary.content` with the model's reply.

9. **Missing prompt returns 400.**
   ```bash
   curl -v -X POST http://localhost:4000/api/n8n/trigger \
     -H "Authorization: Bearer secret" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```
   Expected: HTTP 400 with `"missing required field: prompt"`. No task created.

10. **Desktop-initiated task shows runMode in the task detail.** Run a task from the desktop Run button with the iterative runMode explicitly selected (if there's a dropdown). Confirm the runLedger populates with phases, critic verdicts, batches.

- [ ] **Step 4: No commit required unless a fix was needed**

If steps 1-10 all pass, L3a is shipped. If any fails, create a `fix(l3a):` commit with a clear message describing the issue and the fix.

---

## Self-review checklist (run after writing this plan)

**Spec coverage:**
- [x] Ambient sources default to iterative — Task 1
- [x] Bearer token auth on /api/n8n/trigger — Task 3
- [x] n8n webhook spawns tasks server-side — Task 3
- [x] Unified routeTaskUpdate hook — Task 2 (scaffolded; existing sendTelegramTaskManagerUpdate call sites remain for backward compat, routeTaskUpdate is available for new code)
- [x] Desktop Run button backward-compat — Task 1 (remoteOrigin === null → "direct")
- [x] Unit tests for the pure logic — Task 4
- [x] Manual smoke tests documented — Task 5

**Non-throwing contract:**
- [x] routeTaskUpdate wraps desktop dispatch in try/catch (Task 2)
- [x] routeTaskUpdate wraps channel dispatch in try/catch (Task 2)
- [x] n8n handler catches runAssistantTaskRequest errors (Task 3)
- [x] Async-mode fire-and-forget has a .catch on the fire-and-forget promise (Task 3)

**Known scope reductions from the brainstorm:**
- The plan does NOT wholesale-refactor runAssistantTaskRequest into a spawnTask helper. The existing 290-line function stays intact; L3a extends its schema and default logic only. This is a deliberate scope reduction after reading the actual code. The brainstorm's "spawnTask" concept is effectively embodied by runAssistantTaskRequest itself — it already creates the task, wires taskContext callbacks, calls executeTask, and handles the full lifecycle. Factoring it out would be a risky, large rewrite with zero behavior change.
- routeTaskUpdate is available for new code paths but does NOT replace existing sendTelegramTaskManagerUpdate call sites in Task 2. Migrating those to routeTaskUpdate is L3b scope.
- callbackUrl is accepted in the webhook payload but not yet posted to. L3b adds the callback POST.
- GET /api/tasks/<taskId> polling endpoint is L3b scope.
- Rate limiting on the webhook endpoint is L3b scope.

**Test count check:**
- Pre-L3a baseline: 115 tests (74 pre-L0 + 9 L0 + 22 L1 + 9 L2 → as of last sweep)
- L3a adds: 14 new unit tests in `apps/desktop/task-router.test.js`
- Post-L3a expected: 129 tests, 0 failures
