# Model Routing

Defaults are documented with **Context7** library references in [MODEL_IDS.md](./MODEL_IDS.md). Confirm ids with **Setup → Refresh Models** for your API keys.

## Task-to-model defaults (in-repo)

| Activity        | Default model id | Provider (typical) |
|----------------|------------------|----------------------|
| orchestrator   | `gpt-5.2`        | OpenAI               |
| research       | `sonar-pro`      | Perplexity           |
| coding         | `gpt-5.2-pro`    | OpenAI               |
| documents      | `gemini-2.5-pro` | Google Gemini        |
| automation     | `grok-4.20-beta-latest-non-reasoning` | xAI |
| data_analysis  | `gpt-5.2-pro`    | OpenAI               |
| communication  | `gpt-5.2-chat-latest` | OpenAI          |
| project_mgmt   | `gpt-5.2-pro`    | OpenAI               |
| creative       | `gemini-3.1-pro-preview` | Google Gemini  |
| aws_cloud      | `gpt-5.2-pro`    | OpenAI               |

## Depth tiers (`modelTiers` in config)

Defaults in `packages/model-router/src/tiers.js`:

- **quick** — `gemini-2.5-flash`, `gpt-5.1-mini`, `grok-3`
- **standard** — `gpt-5.2`, `gemini-2.5-pro`
- **forensic** — `gpt-5.2-pro`, `gemini-3.1-pro-preview`, `sonar-pro`

## Runtime behavior

1. Explicit `phase.model` in an approved plan wins.
2. Else global model override from UI (when no per-phase model).
3. Else first entry in the tier list for the phase `depth`.
4. Else activity `defaultModel` via `ModelRouter`.

## Retry fallback chain

On failure, `ModelRouter.getFallbackChain` tries (excluding the primary):  
`gpt-5.2` → `gemini-2.5-pro` → `grok-4-0709` → `sonar-pro`.

Failure messages from the orchestrator include the last few fallback timeline lines when every candidate errors.

## Planned expansion

- Quality / latency / cost-aware classifier routing
- Per-task SLA profiles (fast, balanced, high-quality)
- Provider health and circuit-breaker logic

## Legacy configs

Saved `assistant-config.json` may still reference `claude-*` or older snapshot ids. The Anthropic adapter remains registered in `packages/providers` for those entries.
