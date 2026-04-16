# One-Sprint Overhaul Implementation Plan

> **Branch:** `sprint/one-shot-overhaul` (already active).
> Every task block below ends in a commit. Frequent commits → bisect-friendly history.

**Goal:** Land Phases 1–5 of the forensic review roadmap in one focused sprint — close every P0/P1 security and correctness gap, make the agent loop actually agentic, ship a real skills v1, unify the provider layer, and add durability + observability.

**Architecture:**
- Keep the MCP hub + tool loop we have (they work). Fix the orchestrator around them.
- Centralise every provider-specific tool-format conversion in `packages/tool-loop` so fragile branching in `main.js` disappears.
- Make phase outputs flow forward (a real iterative loop) and make failures loud (no more silent accept).
- Introduce `packages/skills` as a proper filesystem-backed skills system.
- Add structured pino logging + atomic store writes so crashes can't corrupt state.

**Tech stack:**
- Node 20+, ES modules, Electron, `@modelcontextprotocol/sdk` 1.27, zod, pino.
- New deps this sprint: `pino`, `pino-pretty`, `write-file-atomic`, `gray-matter` (SKILL.md frontmatter).

**Non-goals for this sprint (deferred to Phase 6):**
- Ambient background agents as first-class jobs.
- Multi-workspace projects with `.wcjr/` config scoping.
- Deterministic run replay UI.
- Skill-authoring UI (only the registry + execution layer land now).

---

## Task index

Phase 1 — Stop the bleeding
1. Lock down the webhook server and gate `/api/mcp/*`.
2. Unify provider tool conversion and fix Anthropic.
3. Fix OpenAI Responses tool round-trip.
4. Remove `shell: true` + convert schemas to zod in `shell-exec` / `git-ops` / `filesystem-mcp.write_text_file`.
5. Spawn MCPs via `process.execPath` + `ELECTRON_RUN_AS_NODE`; bundle every builtin-* under `extraResources`.
6. Gate DevTools on `!app.isPackaged`; surface `safeStorage` unavailability.
7. Fix or remove the Telegram `/approve` facade.
8. `filesystem-mcp` realpath check against allowed roots.
9. WhatsApp HMAC: reject on mismatch when a secret is configured.

Phase 2 — Make the agent loop actually agentic
10. Thread prior-phase ledger snapshot into each phase's user message.
11. Record `entry.result` alongside `entry.resultPreview` in the tool loop → artifact Layer 1/2 fires.
12. Critic bubbles `_parseError` as `status: "accepted_degraded"` instead of silent accept.
13. Re-enable `getActivitySystemPrompt(taskType)` in iterative mode.
14. Replace `AbortController` theatre with real budget enforcement via `p-limit`.
15. Add `collectRagResults` retriever when `strategy.useRag === true`.
16. `lesson-writer` runs in direct mode too and writes a structured record.

Phase 3 — Real skills v1
17. Create `packages/skills/` with file-system loader + `SKILL.md` frontmatter parser.
18. IPC: `skills:list`, `skills:get`, plus a synthetic `skill_registry` MCP-style tool the agent can call.
19. Ship a starter library of real skills bundled at `skills/` (loaded at runtime).

Phase 4 — Real multi-provider council
20. Centralise `mcpToolsToProvider(providerId, toolSummary)` in `tool-loop`; remove branching from `main.js`.
21. Enable cross-provider specialist routing now that format conversion is unified.
22. Replace `resolveProvider`'s prefix-match with a structured registry populated from `listModels`, and wire `resolveModelForPhase` into the iterative planner.

Phase 5 — Durability + observability
23. Atomic JSON writes (`write-file-atomic`) in `memory-store`, `conversation-store`, `task-store`; make `memory-store.prune` honour `pinned`.
24. Structured pino logging to `logs/wcjr-YYYY-MM-DD.jsonl`; replace silent catches in hot paths.
25. Repo hygiene: delete `electron-builder.release-fresh*.json` variants, `electron-probe*.mjs`, `fix-*.py/sh`, `.claude/`, `eng.traineddata`, `waha-qr*.png`; update `.gitignore`.
26. `asar: true` with `asarUnpack` for MCP scripts.
27. One E2E smoke test under `node --test` that mocks the provider adapter and exercises `assistant:runTask`-equivalent orchestrator flow.

Final step — full `node --test` green.

---

## Task 1 — Lock down webhook + gate /api/mcp/*

**Files:**
- Modify: `apps/desktop/main.js` (startWebhookServer, around L4033–4263)
- Reference: `packages/policy-engine/src/index.js`

**Problem:** `webhookServer.listen(port, ...)` binds to `::`. `/api/mcp/tools` and `/api/mcp/call` have no auth and bypass the policy engine. Any LAN host can run any MCP tool.

**Steps:**
- [ ] Pass `"127.0.0.1"` as the listen host. Introduce `WCJR_WEBHOOK_HOST` env override for advanced users.
- [ ] Require the bearer token on `/api/mcp/tools`, `/api/mcp/call`, `/api/n8n/trigger`. Fail-closed if no token configured.
- [ ] In `/api/mcp/call`, before calling `orchestrator.mcpHub.callTool`, run the request through `policyEngine.evaluateToolCall({ server, tool, args })` (or whatever equivalent exists) and deny on disallow.
- [ ] Commit: `fix(main): lock webhook to loopback and require bearer + policy on /api/mcp/*`.

## Task 2 — Unify provider tool conversion + fix Anthropic

**Files:**
- Modify: `packages/tool-loop/src/index.js` (add `mcpToolsToProvider`)
- Modify: `apps/desktop/main.js` around L2306
- Modify: `packages/providers/src/anthropic.js` tool-mapping block (L96)

**Problem:** `main.js` branches only between `gemini` and OpenAI-shape. Anthropic receives OpenAI wrapper shape and reads `t.name` / `t.parameters` which are undefined. Every tool sent as `name: undefined` → Claude runs with zero tools.

**Steps:**
- [ ] Add `export function mcpToolsToProvider(providerId, toolSummary)` in `packages/tool-loop/src/index.js`. Dispatches to the existing `mcpToolsToGeminiFunctions` / `mcpToolsToOpenAIFunctions` / new `mcpToolsToAnthropicTools`.
- [ ] New `mcpToolsToAnthropicTools(toolSummary)` emits flat `{ name, description, input_schema }` with `registerToolName`.
- [ ] Replace the ternary at `main.js:L2306` with `mcpToolsToProvider(providerId, filteredToolSummary)`.
- [ ] `capToolsForOpenAI` stays as a post-step only for OpenAI-compatible providers.
- [ ] Commit: `fix(tool-loop): unify provider tool conversion and repair Anthropic tool shape`.

## Task 3 — Repair OpenAI Responses API tool round-trip

**Files:**
- Modify: `packages/providers/src/openai-responses.js`

**Problem:** `tool_call` → flattened to bare assistant text, `tool_result` → flattened to `[Tool result for …]` user message. Multi-round tool calling fails on GPT-5-pro, o3, o4, grok-multi-agent.

**Steps:**
- [ ] Emit real `function_call` items for `tool_call` messages: `{ type: "function_call", call_id, name, arguments }`.
- [ ] Emit real `function_call_output` items for `tool_result` messages: `{ type: "function_call_output", call_id, output }`.
- [ ] Parse `response.function_call_arguments.done` / `response.output_item.added` events to surface `toolCalls` with `{ id, name, args }` exactly like the chat path.
- [ ] Commit: `fix(openai-responses): emit real function_call / function_call_output for tool round-trip`.

## Task 4 — Remove shell:true + convert schemas to zod

**Files:**
- Modify: `packages/shell-exec/src/server.js` (spawn flags + inputSchema blocks)
- Modify: `packages/git-ops/src/server.js` (inputSchema blocks)
- Modify: `packages/filesystem-mcp/src/server.js` (`write_text_file` block)

**Problem:** On Windows, `shell: true` routes model-supplied args through `cmd.exe` — args containing `&`, `|`, `>` execute arbitrary commands. Several `inputSchema` blocks use plain JSON-Schema primitives instead of zod.

**Steps:**
- [ ] Drop `shell: process.platform === "win32"` from `runProcess` in `shell-exec`. For the explicit `run_script` tool, keep the shell but document it.
- [ ] Convert `run_command` / `kill_process` / `run_script` / `list_processes` / `get_process_status` inputSchemas to zod.
- [ ] Convert every `git-ops` inputSchema to zod.
- [ ] Convert `write_text_file` inputSchema to zod.
- [ ] Commit: `fix(shell-exec,git-ops,fs-mcp): drop shell:true arg path and migrate to zod schemas`.

## Task 5 — Spawn MCPs via process.execPath

**Files:**
- Modify: `apps/desktop/main.js` (`builtinServerProcessConfig`)
- Modify: `electron-builder.json` (extraResources list)

**Problem:** Packaged builds call `{ command: "node", ... }`. `node` is not on PATH inside a portable Electron app, so every builtin-* MCP silently fails to start. Only 5 of 12 MCP folders are bundled.

**Steps:**
- [ ] Replace `command: "node"` with `command: process.execPath`, set `env: { ...parentEnv, ELECTRON_RUN_AS_NODE: "1" }` on the spawn.
- [ ] Enumerate every builtin kind and add each `packages/<folder>/src/server.js` to `extraResources` with `from` + `to` pairs.
- [ ] Commit: `fix(packaging): spawn MCPs via process.execPath + bundle all builtin-* servers`.

## Task 6 — Gate DevTools + surface safeStorage

**Files:**
- Modify: `apps/desktop/main.js` (`mainWindow.webContents.openDevTools` near L2418; `isLocalEncryptionAvailable` around L1327)

**Steps:**
- [ ] Guard `openDevTools()` behind `!app.isPackaged || process.env.WCJR_DEBUG === "1"`.
- [ ] On first load, if `safeStorage.isEncryptionAvailable()` is false, emit a `assistant:streamChunk` warning once per session and log via pino.
- [ ] Commit: `fix(desktop): gate DevTools to dev builds and warn when safeStorage is unavailable`.

## Task 7 — Fix or remove Telegram /approve facade

**Files:**
- Modify: `apps/desktop/main.js` around L3902–3943 (Telegram /approve path)
- Modify: `apps/desktop/main.js` `_approvePlanImpl` hook + `ipcMain.handle("assistant:approvePlan", ...)`

**Problem:** `ipcMain._events?.["assistant:approvePlan"]` always returns undefined because handlers live on `_invokeHandlers`. State gets corrupted first.

**Steps:**
- [ ] Extract the plan-approval logic into `async function executeApprovedPlan({ taskId, conversationId, userId })`. Register both the IPC handler and the Telegram path to call this function directly — no `_invokeHandlers` lookup.
- [ ] Key `pendingTelegramPlans` by `taskId`, not `chatId`; verify the chat id matches the task's originator before allowing approve.
- [ ] Only mutate `pendingExecutionPlan` after `executeApprovedPlan` resolves, so a failure rolls back cleanly.
- [ ] Commit: `fix(telegram): approve flow executes plan instead of corrupting state`.

## Task 8 — filesystem-mcp realpath check

**Files:**
- Modify: `packages/filesystem-mcp/src/server.js` (`ensureAllowedPath`)

**Steps:**
- [ ] After `path.resolve`, call `await fs.realpath(resolvedPath)` (swallow ENOENT — we allow creating new files). Re-run `getOwningRoot` on the realpath result. Throw if out-of-root.
- [ ] Add a unit test that creates a symlink inside an allowed root pointing at an outside path and asserts the tool rejects it.
- [ ] Commit: `fix(fs-mcp): block symlink escapes with realpath re-check`.

## Task 9 — WhatsApp HMAC reject on mismatch

**Files:**
- Modify: `packages/messaging-bridge/src/whatsapp.js` `handleWebhook` (L254–262)

**Steps:**
- [ ] When `hmacSecret` is set and `signature` is missing or mismatched, return `{ status: 401 }` and skip body processing. Keep the "no secret configured" branch as permissive (local dev).
- [ ] Commit: `fix(whatsapp): enforce HMAC when a secret is configured`.

## Task 10 — Thread prior-phase ledger snapshot into each phase

**Files:**
- Modify: `packages/orchestrator/src/planner.js` (`runPhase`, `runIterativePlan`)

**Problem:** Each phase starts from the original goal + history — it cannot see what earlier phases produced, which defeats the whole point of a multi-phase plan.

**Steps:**
- [ ] Build `buildPhaseContext(ledger, phase)` that returns `{ priorPhases: [{ id, intent, status, contentPreview, artifacts }] }` limited to phases the current phase `dependsOn` (or all prior phases when `dependsOn` is empty).
- [ ] Prepend a `PRIOR PHASES CONTEXT:` block to the phase user message when the snapshot is non-empty.
- [ ] Pass the snapshot through `runPhase → invokeModel`'s `conversationMessages` or via a new `priorContext` field on the phase.
- [ ] Commit: `feat(planner): thread prior-phase ledger snapshot into each phase`.

## Task 11 — Tool-loop trace records entry.result

**Files:**
- Modify: `packages/tool-loop/src/index.js` (`serializeToolResult`, `traceEntry`)
- Modify: `packages/orchestrator/src/artifact-extractor.js` (none — it already reads `entry.result`)

**Steps:**
- [ ] In `runToolLoop`, after `mcpHub.callTool` resolves, attach a size-bounded `entry.result` (the raw JSON object the tool returned, truncated to 64 KB when serialised) to the trace entry in addition to `resultPreview`.
- [ ] Artifact-extractor Layer 1/2 now fires — adjust its unit test to reflect the new shape, and add a test covering a `create_workbook` → `outputPath` round-trip against the real trace format.
- [ ] Commit: `fix(tool-loop): record raw result object in trace so artifact extraction works`.

## Task 12 — Critic: degraded status, not silent accept

**Files:**
- Modify: `packages/orchestrator/src/critic.js`
- Modify: `packages/orchestrator/src/planner.js` (verdict handling in `runPhase`)

**Steps:**
- [ ] `parseVerdict` and `runCritic`: on error/malformed JSON, return `{ decision: "degraded", reasoning, confidence: 0, _parseError: true }`.
- [ ] `runPhase` treats `decision: "degraded"` as "pass through but mark ledger phase `status: "accepted_degraded"` and accumulate a ledger-level `degradedCount`".
- [ ] Update `runIterativePlan` outcome: when `degradedCount > 0` and no retries remain, set outcome `"completed_with_warnings"`.
- [ ] Unit test that an exception inside `critic.stream` yields `accepted_degraded` and increments the counter, not `accepted`.
- [ ] Commit: `fix(critic): degraded status instead of silent accept on failure`.

## Task 13 — Re-enable activity system prompt in iterative mode

**Files:**
- Modify: `packages/orchestrator/src/index.js` around L1618 (iterative systemMessage builder)

**Steps:**
- [ ] Add `getActivitySystemPrompt(resolvedTaskType)` as the first entry of the `systemMessage` array (if present).
- [ ] Commit: `fix(orchestrator): re-enable activity system prompt for iterative runs`.

## Task 14 — Real budget enforcement

**Files:**
- Modify: `packages/orchestrator/src/planner.js` (`runIterativePlan`)
- Add dep: `p-limit`

**Steps:**
- [ ] Replace `Promise.all(batch.map(runPhase))` with a `p-limit(concurrency)` queue.
- [ ] Enforce `totalPhasesExecuted < maxPhases` per-phase (inside the queued task) rather than per-batch.
- [ ] When a phase produces `retry_exhausted` / `error` / `escalate`, the queue aborts queued phases for that batch (not already-running ones).
- [ ] Commit: `fix(planner): real concurrency + per-phase budget enforcement`.

## Task 15 — collectRagResults retriever

**Files:**
- Modify: `packages/orchestrator/src/retrieval.js` (add collector + wire into `buildRetrievalContext`)

**Steps:**
- [ ] New `collectRagResults({ mcpHub, query, servers })` calls the Qdrant MCP `knowledge_query` with `limit: 8` and returns scored entries shaped like the filesystem collector's entries.
- [ ] In `buildRetrievalContext`, when `strategy.useRag === true` and a Qdrant MCP server is available, append this collector to the fan-out.
- [ ] Commit: `feat(retrieval): auto-inject RAG results when strategy.useRag is set`.

## Task 16 — lesson-writer runs in direct mode, structured output

**Files:**
- Modify: `packages/orchestrator/src/index.js` L1632–1657 (the gate)
- Modify: `packages/orchestrator/src/lesson-writer.js` (record shape)

**Steps:**
- [ ] Remove the `runMode === "iterative"` gate; guard only on `memoryStore` + `options.invokeModel` presence.
- [ ] Rewrite `LESSON_SYSTEM` to require `{ taskType, prompt_gist, outcome, tools_used[], artifacts[], errors[], generalization }` and store it as JSON inside the memory entry's `content` plus `metadata: { kind: "run_lesson", ... }`.
- [ ] Commit: `feat(lesson-writer): run for direct mode too and persist structured lessons`.

## Task 17 — packages/skills loader

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/src/index.js`
- Create: `packages/skills/src/index.test.js`
- Add dep: `gray-matter`

**Steps:**
- [ ] Package exports `loadSkills(rootPaths)`, `getSkill(id)`, `listSkills({ filter })`, `SkillSchema`.
- [ ] `loadSkills` scans each root for `**/SKILL.md` (depth ≤ 3), parses frontmatter with `gray-matter`, validates with zod.
- [ ] Frontmatter shape: `{ id?, name, description, triggers?: string[], allowedTools?: string[], tags?: string[], internalOnly?: boolean, version?: string }`. Body text becomes `skill.body`.
- [ ] Unit tests: loads a valid SKILL.md, rejects a malformed one, handles duplicate ids (last wins with warning).
- [ ] Commit: `feat(skills): filesystem-backed SKILL.md loader`.

## Task 18 — Skills IPC + skill_registry synthetic tool

**Files:**
- Modify: `apps/desktop/preload.js` (expose `getSkills`, `getSkill`)
- Modify: `apps/desktop/main.js` (register IPC + skills loader at boot)
- Modify: `packages/tool-loop/src/index.js` (synthetic `skill_registry.list` / `skill_registry.get` tools the agent can call)
- Modify: `packages/orchestrator/src/index.js` (replace the three-string `getSkillInstruction` switch with a registry lookup that returns the skill's body when matched, falling back to the old strings for backward compat)

**Steps:**
- [ ] At app boot, load from `<userData>/skills/`, `<appPath>/skills/`, and any user-configured extra roots (`appConfig.skillRoots`). Merge.
- [ ] Register `assistant:getSkills` and `assistant:getSkill` IPC.
- [ ] Expose `skill_registry` as a synthetic tool in the tool loop — purely in-process, no MCP round-trip. `skill_registry.list()` returns `{id, name, description, triggers}[]`; `skill_registry.get({id})` returns the full body.
- [ ] When `parseSkillCommand` matches a slash-command, look up the skill in the registry and inject its body (capped at 8 KB) into the system message instead of hitting the hardcoded switch.
- [ ] Commit: `feat(skills): IPC + synthetic skill_registry tool + runtime body injection`.

## Task 19 — Bundle starter skills

**Files:**
- Create: `skills/systematic-debugging/SKILL.md`
- Create: `skills/writing-plans/SKILL.md`
- Create: `skills/verification-before-completion/SKILL.md`
- Create: `skills/frontend-design/SKILL.md`
- Modify: `electron-builder.json` (add `skills/` to extraResources)

**Steps:**
- [ ] Write concise, enforceable SKILL.md files with frontmatter (`name`, `description`, `triggers`, `tags`).
- [ ] Bundle in `extraResources` so packaged builds find them at `process.resourcesPath/skills/*`.
- [ ] Commit: `feat(skills): bundle starter library`.

## Task 20 — Unify mcpToolsToProvider

Already folded into Task 2 — no separate step. Remove this from the task list during execution to avoid double-commit; if Task 2 didn't cleanly remove the branching in main.js, fix it here.

## Task 21 — Enable cross-provider specialist routing

**Files:**
- Modify: `packages/orchestrator/src/index.js` around L1832–1842

**Steps:**
- [ ] Remove the `if (council.provider === providerId)` guard. For any council entry, resolve its provider, its API key presence, and adapter support; only then run it.
- [ ] Tools are converted per-specialist via `mcpToolsToProvider(specialistProvider, ...)`. Already possible since Task 2.
- [ ] Commit: `feat(council): enable cross-provider specialist routing`.

## Task 22 — Model registry replaces prefix-match

**Files:**
- Create: `packages/providers/src/registry.js`
- Modify: `packages/providers/src/index.js` (`resolveProvider` delegates to registry)
- Modify: `packages/model-router/src/index.js` (`resolveModelForPhase` wired into planner)
- Modify: `packages/orchestrator/src/planner.js` (`runPhase` picks model via `resolveModelForPhase(phase, ...)` when `phase.depth` is set)

**Steps:**
- [ ] Registry holds `Map<modelId, { provider, capabilities: { tools, vision, reasoning }, maxTokens }>`. Populated at boot from each adapter's `listModels`. Fallback to prefix-match for unknown ids (keep the behaviour the tree already relies on).
- [ ] `resolveProvider` returns registry lookup first, then prefix-match.
- [ ] Planner uses `resolveModelForPhase(phase, { executorModel, modelTiers })` when `phase.depth` is set so `DEFAULT_MODEL_TIERS` is honoured.
- [ ] Commit: `feat(providers): structured model registry + per-phase tier routing`.

## Task 23 — Atomic writes + pinned-aware prune

**Files:**
- Modify: `packages/memory-store/src/index.js`
- Modify: `packages/conversation-store/src/index.js`
- Modify: `packages/task-store/src/index.js`
- Add dep: `write-file-atomic`

**Steps:**
- [ ] Replace `fs.writeFile(p, JSON.stringify(...))` with `writeFileAtomic(p, ..., { encoding: 'utf-8' })` in every `save`.
- [ ] `memory-store.prune` skips entries where `pinned === true` before evicting.
- [ ] Add a unit test that pinned entries survive prune.
- [ ] Commit: `fix(stores): atomic writes + pinned-aware memory prune`.

## Task 24 — Structured pino logging

**Files:**
- Create: `packages/logger/package.json`
- Create: `packages/logger/src/index.js`
- Modify: `apps/desktop/main.js` (replace `logStartup` + silent catches in hot paths)
- Modify: `packages/orchestrator/src/*` (import logger where console.warn is critical)
- Add dep: `pino`, `pino-pretty`

**Steps:**
- [ ] Logger writes to `<userData>/logs/wcjr-YYYY-MM-DD.jsonl` + stderr (pretty in dev, JSON in prod).
- [ ] Expose `createLogger({ module })` returning a bound pino child logger.
- [ ] Swap at least: `logStartup`, IPC handler catches, tool-call failures, critic failures.
- [ ] Commit: `feat(logger): structured pino logging package + hot-path adoption`.

## Task 25 — Repo hygiene

**Files:**
- Delete: `electron-builder.release-fresh*.json` (12 variants)
- Delete: `apps/desktop/electron-probe*.mjs` (3 files)
- Delete: `patch-working-release.mjs`, `fix-auth.py`, `fix-gateway.sh`, `fix-origins.py`
- Delete: `eng.traineddata`, `waha-qr.png`, `waha-qr-bot.png`
- Delete: `.claude/scheduled_tasks.lock`
- Modify: `.gitignore` (add `.claude/`, `release*/`, `waha-qr*.png`, `eng.traineddata`, `logs/`)

**Steps:**
- [ ] One commit for deletions, one for `.gitignore` additions.
- [ ] Commit: `chore(repo): delete legacy release variants, probes, QR snapshots, OCR blob; expand .gitignore`.

## Task 26 — asar:true + asarUnpack

**Files:**
- Modify: `electron-builder.json`

**Steps:**
- [ ] Flip `asar: true`. Add `asarUnpack: ["packages/**/server.js", "skills/**", "node_modules/@modelcontextprotocol/**"]` so MCP scripts remain forkable.
- [ ] Commit: `chore(packaging): asar on with asarUnpack for MCP servers and skills`.

## Task 27 — E2E smoke test

**Files:**
- Create: `apps/desktop/smoke.test.js`

**Steps:**
- [ ] Use `node --test` with a stub `invokeModel` that scripts a two-turn tool-calling exchange against an in-memory MCP hub that returns a known directory listing.
- [ ] Assert the orchestrator returns a non-empty content and records exactly one artifact.
- [ ] Commit: `test(desktop): E2E smoke covering orchestrator + tool-loop + stores round-trip`.

---

## Final verification

- [ ] `node --test` green repo-wide.
- [ ] Hand-run `npm --workspace apps/desktop run dev` and exercise one direct-mode tool-calling prompt against a local Ollama model.
- [ ] Commit: `chore: sprint overhaul green`.
- [ ] Review diff with `git log --oneline origin/main..HEAD`.

## Self-review against forensic report

- [x] Anthropic tool shape — Task 2
- [x] OpenAI Responses round-trip — Task 3
- [x] Webhook auth — Task 1
- [x] Telegram approve — Task 7
- [x] Skills facade — Tasks 17–19
- [x] Critic silent accept — Task 12
- [x] Phase state loss — Task 10
- [x] Artifact extractor — Task 11
- [x] Shell injection — Task 4
- [x] WhatsApp HMAC — Task 9
- [x] Packaging node path — Task 5
- [x] DevTools — Task 6
- [x] Filesystem symlink — Task 8
- [x] AbortController theatre — Task 14
- [x] Cross-provider routing — Task 21
- [x] resolveProvider fragility + phase tiers — Task 22
- [x] RAG collector — Task 15
- [x] Lesson writer gate — Task 16
- [x] Activity prompts in iterative — Task 13
- [x] Atomic writes + pinned prune — Task 23
- [x] Structured logging — Task 24
- [x] Repo hygiene + asar — Tasks 25–26
- [x] Smoke test — Task 27

No placeholders remain.
