# WCJR MCP Assistant

Local Electron-first personal assistant with:

- MCP-native tooling (`stdio` + streamable HTTP ready)
- per-task model routing profiles
- one-screen UX for daily use
- secure preload/IPC boundary
- direct model execution with fallback across configured providers
- optional NemoClaw/OpenShell sandboxed runs
- built-in Local Filesystem MCP server

## Quick Start

1. Install dependencies:
   - `npm install`
2. Run desktop app:
   - `npm run dev`
3. In the app:
   - open `Setup`
   - paste API keys for any providers you want to use
   - click `Refresh Models`
   - assign models to task types
   - enable `Local Filesystem` and choose a root folder if you want local file access
   - click `Connect Tools`
4. Run a task:
   - choose `Direct` for normal provider-backed runs
   - choose `Sandboxed (NemoClaw)` to route the run through the WSL sandbox when available

## Packaging

- Build a Windows portable app:
  - `npm run dist:win`
- Output goes to:
  - `release/`

Note:

- The built-in Local Filesystem MCP server is launched through the local `node` runtime on Windows.
- Sandboxed mode expects WSL + OpenShell/NemoClaw to already be installed on this machine.

## Current MVP

- Command center UI
- Task execution timeline
- Model profile editor
- MCP server management inside the app
- Built-in Local Filesystem MCP integration
- Direct vs Sandboxed execution mode
- Orchestrator + model router + MCP hub package split
- Real provider adapters (OpenAI / Google Gemini / xAI Grok / Perplexity; Anthropic optional for legacy configs — see [docs/MODEL_IDS.md](docs/MODEL_IDS.md))
- Retry/fallback execution with live API calls
