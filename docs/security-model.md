# Security Model

## Desktop Isolation

- `nodeIntegration: false`
- preload-only API exposure via `contextBridge`
- narrow API surface (`getState`, `connectMcp`, `runTask`, config updates)

## IPC Guardrails

- typed schema validation on incoming IPC payloads
- deny unsupported MCP transport types
- reject invalid MCP URLs early

## Planned Hardening

- policy engine for file/network scopes
- explicit approval prompts before high-impact actions
- egress control for remote tools/providers
- immutable run audit log
