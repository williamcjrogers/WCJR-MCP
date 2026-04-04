# Architecture

## Layers

- `apps/desktop`: Electron shell + one-screen UX
- `packages/orchestrator`: task planner/executor facade
- `packages/model-router`: task-to-model profile mapping and fallback chain
- `packages/mcp-hub`: MCP connection manager for local and remote servers

## Data Flow

1. User enters a goal in the command center.
2. Renderer calls `assistant:runTask` through preload API.
3. Orchestrator classifies the task and requests available MCP tools.
4. Model router selects primary model + fallback chain.
5. Result + timeline are returned to UI for transparent replay.

## Security Boundary

- Renderer has no direct Node/Electron access.
- All privileged operations go through `ipcMain.handle`.
- Payloads are validated before execution.
