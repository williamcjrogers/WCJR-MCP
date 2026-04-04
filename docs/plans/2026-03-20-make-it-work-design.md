# Make It Work: Functional Assistant Design

## Problem

The app launches but is useless because:

1. **preload.js uses ESM imports** -- Electron preload scripts must use CommonJS `require()`. The entire IPC bridge is silently broken.
2. **No real AI provider calls** -- `invokeModel()` returns hardcoded placeholder text.
3. **No API key management** -- no way to enter or store keys.
4. **Hardcoded model names** -- no live model discovery.
5. **No streaming** -- UI freezes then dumps text.
6. **No error surfacing** -- failures are swallowed.

## Solution

### 1. Fix preload.js (CommonJS)

Convert `import` to `require()`. This restores the entire UI.

### 2. Provider adapters with live model listing

New `packages/providers/` package. One adapter per provider:

- **Anthropic**: `@anthropic-ai/sdk` -- `client.models.list()` + `client.messages.stream()`
- **OpenAI**: `openai` -- `client.models.list()` + `client.chat.completions.create({stream:true})`
- **Google Gemini**: `@google/genai` -- `ai.models.list()` + `ai.models.generateContentStream()`
- **xAI/Grok**: `openai` with `baseURL: https://api.x.ai/v1` -- `client.models.list()` + streaming
- **Perplexity**: `openai` with `baseURL: https://api.perplexity.ai` -- hardcoded model list (no list endpoint) + streaming

Each adapter exposes: `listModels(apiKey)`, `stream(apiKey, model, messages, onChunk)`.

### 3. API key management

- Setup panel in UI with fields per provider.
- `safeStorage.encryptString()` for at-rest encryption.
- Keys decrypted only in main process.
- IPC: `saveApiKeys`, `getKeyStatus`, `listModels`.

### 4. Live model selector

- On key save, fetch live model list from that provider.
- Cache model lists locally, refresh on demand.
- Model profile editor shows real model IDs from live lists.
- Task type dropdown auto-selects from configured models.

### 5. Streaming to UI

- Main process sends chunks via `webContents.send()`.
- Renderer appends text incrementally.
- "Thinking..." indicator during processing.

### 6. Error surfacing

- All IPC handlers wrapped in try/catch returning `{ error }`.
- Error banner in UI for auth, rate limit, and network failures.

## Dependencies

- `@anthropic-ai/sdk`
- `openai`
- `@google/genai`
