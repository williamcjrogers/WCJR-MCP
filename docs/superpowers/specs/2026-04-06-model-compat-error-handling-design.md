# Fix Model Compatibility, Error Handling & Operational Visibility

**Date:** 2026-04-06
**Status:** Draft
**Context:** The app's default models (gpt-5.4-pro, grok-4.20-multi-agent-0309) use the new Responses API (`/v1/responses`), but the provider layer only supports Chat Completions (`/v1/chat/completions`). This causes 404 errors that cascade through the fallback chain, dumping raw JSON into the output. Additionally, quota exhaustion errors (Gemini free tier) show as unformatted multi-hundred-byte JSON dumps.

---

## 1. Responses API Support

### Problem
OpenAI's `gpt-5.4-pro` and xAI's `grok-4.20-multi-agent` require the Responses API format, not Chat Completions. The app's `openaiCompatibleStream()` in `packages/providers/src/openai-compat.js` only uses `client.chat.completions.create()`.

### Solution
Add a second streaming path: `openaiResponsesStream()` that uses the Responses API format. The provider adapters detect which API a model needs and route accordingly.

**New file:** `packages/providers/src/openai-responses.js`
- Uses `client.responses.create()` (OpenAI SDK v4.96+ supports this)
- Handles the Responses API streaming format (different chunk structure)
- Normalizes output to the same `{ content, toolCalls, usage }` shape as `openaiCompatibleStream()`

**Modified files:**
- `packages/providers/src/openai.js` — detect `gpt-5.4-pro` → route to Responses stream
- `packages/providers/src/grok.js` — detect `grok-4.20-multi-agent*` → route to Responses stream
- `packages/providers/src/openai-compat.js` — no changes (Chat Completions path unchanged)

**Model routing heuristic:**
```
if model starts with "o3" or "o4" or includes "-pro" → Responses API
if model includes "multi-agent" → Responses API
else → Chat Completions API
```

### Verification
- Send a test prompt to `gpt-5.4-pro` via the Responses endpoint → should stream successfully
- Send a test prompt to `grok-4.20-multi-agent-0309` → should stream successfully
- Existing `gpt-5.4`, `gpt-5.4-mini` → should still use Chat Completions unchanged

---

## 2. Correct Default Model Assignments

### Problem
Some default models are suboptimal for their task type or use Responses-only models where Chat Completions models would be more reliable as defaults.

### Solution
Update `packages/activity-profiles/src/index.js` and `packages/model-router/src/tiers.js` with the best model for each task, preferring Chat Completions models as defaults (since they're more broadly compatible) with Responses models available as overrides.

**Model Tiers** (`packages/model-router/src/tiers.js`):

| Tier | Primary | Secondary | Tertiary | Local Fallback |
|------|---------|-----------|----------|----------------|
| quick | `gpt-5.4-mini` | `gemini-2.5-flash` | `grok-3-mini-beta` | `qwen2.5:1.5b` |
| standard | `gpt-5.4` | `gemini-2.5-pro` | `grok-3-beta` | `qwen3:14b` |
| forensic | `gpt-5.4-pro` | `gemini-3.1-pro-preview` | `grok-4.20-multi-agent-0309` | `qwen3:14b` |

**Activity Profile Defaults** (`packages/activity-profiles/src/index.js`):

| Activity | Default Model | Rationale |
|----------|--------------|-----------|
| orchestrator | `gpt-5.4` | Reliable tool calling via Chat Completions |
| research | `gpt-5.4` | Strong retrieval and synthesis |
| coding | `gpt-5.4` | Top-tier code gen, Chat Completions compatible |
| documents | `gemini-3.1-pro-preview` | 1M context for document review |
| automation | `gpt-5.4` | Reliable tool execution |
| data_analysis | `gpt-5.4` | Structured reasoning |
| communication | `gpt-5.4-mini` | Fast for emails/drafts |
| project_mgmt | `gpt-5.4` | Planning and coordination |
| creative | `gpt-5.4` | Versatile generation |
| aws_cloud | `gpt-5.4` | Technical precision |

**Fallback Chain** (`packages/model-router/src/index.js`):
```
gpt-5.4 → gpt-5.4-mini → gemini-2.5-pro → gemini-2.5-flash → grok-3-beta → claude-sonnet-4-6-20250514 → qwen3:14b
```

The chain progresses: best available → cheaper cloud → different provider → local. The last entry (`qwen3:14b`) ensures something ALWAYS works even when all cloud providers are down.

---

## 3. Error Formatting

### Problem
Provider errors (quota exceeded, 404, timeout) surface as raw JSON in the output area. MCP errors show as `MCP error -32001: Request timed out`.

### Solution

**Provider error formatting** (`packages/providers/src/openai-compat.js` and new `openai-responses.js`):
- Catch known error patterns and return clean summaries
- `429 / RESOURCE_EXHAUSTED` → `"[provider] quota exceeded — trying next model"`
- `404 / model not found` → `"[model] not available on this endpoint — trying next model"`
- `401 / invalid key` → `"[provider] API key invalid or expired"`
- Connection errors → `"[provider] unreachable — trying next model"`

**Orchestrator fallback formatting** (`packages/orchestrator/src/index.js`):
- Replace raw `"${model} failed: ${error.message}"` with structured fallback entries
- Emit `onChunk({ type: "status" })` with clean fallback message instead of including in main output
- Format: `"Routing: [model] unavailable (quota) → trying [next_model]..."`

**MCP error formatting** (`packages/tool-loop/src/index.js`):
- `-32001` → `"[tool_name] timed out (30s) — skipped"`
- `-32600` → `"[tool_name] received invalid request"`
- Generic → `"[tool_name] failed: [short_message]"` (truncate to 120 chars)

**Renderer error formatting** (`apps/desktop/renderer.js`):
- `showError()` truncates messages to 200 chars
- The output area never shows raw JSON — errors render as styled warning cards

---

## 4. Auto-Detection & Provider Status

### Problem
No visibility into which providers are working, which models are available, or why things fail.

### Solution

**Startup auto-detection** (`apps/desktop/main.js`):
- On app ready, query each configured provider's model list endpoint in parallel
- Cache results in `appConfig.modelCache` (already exists)
- For Ollama: also run health check and cache available local models
- Populate the Providers tab with live status per provider

**Provider status display** (renderer changes):
- Each provider in key-fields shows: green dot = key valid + models loaded, yellow = key saved but models failed to load, red = no key
- Show model count: "OpenAI (23 models)" / "Ollama (4 models)" / "Gemini (no key)"

**Live routing status bar** (Command tab):
- Below the textarea, show a single-line status during task execution:
  - `DETECTING → documents | MODEL → gemini-3.1-pro-preview | TOOLS → 5 bound | STATUS → streaming...`
  - On fallback: `FALLBACK → gpt-5.4 (gemini quota exceeded) | TOOLS → 5 bound | STATUS → streaming...`
- After completion: `COMPLETED → gpt-5.4 | 3 tools used | 1,247 tokens`

---

## 5. Files to Modify

| File | Changes |
|------|---------|
| `packages/providers/src/openai-responses.js` | **NEW** — Responses API streaming path |
| `packages/providers/src/openai.js` | Route to Responses or Chat Completions based on model |
| `packages/providers/src/grok.js` | Route to Responses or Chat Completions based on model |
| `packages/providers/src/openai-compat.js` | Add error formatting to catch block |
| `packages/activity-profiles/src/index.js` | Update 10 defaultModel values |
| `packages/model-router/src/tiers.js` | Update 9 model IDs in tier lists |
| `packages/model-router/src/index.js` | Update fallback chain (7 model IDs), add Ollama as terminal fallback |
| `packages/orchestrator/src/index.js` | Format fallback messages, emit status chunks |
| `packages/tool-loop/src/index.js` | Format MCP error codes |
| `apps/desktop/main.js` | Add startup model auto-detection |
| `apps/desktop/renderer.js` | Add routing status bar, format error display, enhance provider status |
| `apps/desktop/styles.css` | Add routing-status-bar styles |

---

## 6. Verification

1. **Responses API**: Send "hello" with model override `gpt-5.4-pro` → should stream via Responses API
2. **Chat Completions**: Send "hello" with model override `gpt-5.4-mini` → should stream via Chat Completions
3. **Fallback chain**: Temporarily invalid-ify the OpenAI key → should cascade through Gemini → Grok → Ollama
4. **Error formatting**: Trigger a quota error → output should show clean one-line message, not JSON
5. **MCP timeout**: Run a filesystem search on a very large directory → timeout should show clean message
6. **Auto-detection**: Restart app → Providers tab should show green/red status per provider with model counts
7. **Routing status**: Run any task → status bar should show live model/tool/status info
