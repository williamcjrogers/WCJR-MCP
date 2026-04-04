# Default model IDs (Context7 + verification)

In-repo defaults use **model id strings** that appear in official provider documentation retrieved via **Context7** MCP (library IDs below). Your account may expose additional or newer aliases (e.g. newer GPT snapshots): always confirm with **Setup → Refresh Models** after saving API keys.

**Verification date:** 2026-03-20

## OpenAI (`chat/completions` `model` parameter)

- **Context7 library ID:** `/websites/developers_openai_api_reference`
- **Topics queried:** Chat Completions, `ChatModel` identifiers

Documented examples used in this repo:

| Id | Use in WCJR |
|----|----------------|
| `gpt-5.2` | Orchestrator default, tier `standard`, router fallback |
| `gpt-5.2-pro` | data_analysis, project_mgmt, aws_cloud |
| `gpt-5.2-chat-latest` | communication |
| `gpt-5.2-pro` | coding (shared with other “heavy” activities) |
| `gpt-5.1-mini` | tier `quick` |

## Google Gemini (`generateContent` `model`)

- **Context7 library ID:** `/websites/ai_google_dev_gemini-api`
- **Topics queried:** Supported models table, `model_id`

| Id | Use in WCJR |
|----|----------------|
| `gemini-2.5-flash` | tier `quick` |
| `gemini-2.5-pro` | documents default, tier `standard`, router fallback |
| `gemini-3.1-pro-preview` | creative default, tier `forensic` |

## xAI Grok (`/v1/chat/completions` `model`)

- **Context7 library ID:** `/websites/x_ai_developers`
- **Topics queried:** chat completions, model examples

| Id | Use in WCJR |
|----|----------------|
| `grok-4.20-beta-latest-non-reasoning` | automation default |
| `grok-3` | tier `quick` |
| `grok-4-0709` | router fallback chain |

## Perplexity

- **Source:** app adapter [`packages/providers/src/perplexity.js`](../packages/providers/src/perplexity.js) (fixed list; no Context7 slug required for `sonar` / `sonar-pro`)

| Id | Use in WCJR |
|----|----------------|
| `sonar-pro` | research default, tier `forensic`, router fallback |

## If a default 404s or errors

1. Open **Setup → Refresh Models** for that provider.
2. Pick an id from the returned list for the same activity in the model profile editor.
3. Optionally re-query Context7 for the latest `/websites/developers_openai_api_reference` (OpenAI adds snapshot ids frequently).
