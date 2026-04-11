import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function makeClientName(serverName) {
  return `wcjr-assistant-${serverName}`;
}

function buildToolMetadata(listToolsResult) {
  const availableTools = listToolsResult?.tools ?? [];
  return {
    tools: availableTools.map((tool) => tool.name),
    toolDetails: availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? {}
    }))
  };
}

export class MCPHub {
  _toolSummaryCache = null;

  constructor(config) {
    this.config = config;
    this.connections = new Map();
    this.statuses = new Map();
  }

  getServers() {
    return this.config.mcpServers ?? [];
  }

  setServers(servers) {
    this.config.mcpServers = servers;
    const activeServerNames = new Set(servers.map((server) => server.name));
    for (const [serverName, connection] of this.connections.entries()) {
      if (!activeServerNames.has(serverName)) {
        connection.client.close().catch((err) => {
          console.warn(`[mcp-hub] failed to close removed server '${serverName}':`, err?.message ?? err);
        });
        this.connections.delete(serverName);
        this.statuses.delete(serverName);
      }
    }
    return this.config.mcpServers;
  }

  getStatuses() {
    return this.getServers().map((server) => ({
      name: server.name,
      enabled: server.enabled !== false,
      ...(this.statuses.get(server.name) ?? {
        status: server.enabled === false ? "disabled" : "not_connected",
        tools: [],
        toolDetails: []
      })
    }));
  }

  async connectServer(server) {
    if (!server.enabled) {
      const disabledStatus = { name: server.name, status: "disabled", tools: [], toolDetails: [] };
      this.statuses.set(server.name, disabledStatus);
      return disabledStatus;
    }

    if (this.connections.has(server.name)) {
      try {
        await this.connections.get(server.name).client.close();
      } catch (err) {
        console.warn(
          `[mcp-hub] failed to close stale connection for '${server.name}':`,
          err instanceof Error ? err.message : err
        );
      }
      this.connections.delete(server.name);
    }

    const client = new Client({
      name: makeClientName(server.name),
      version: "0.1.0"
    });

    let transport;
    if (server.transport === "stdio") {
      if (!server.command) {
        throw new Error(`Server '${server.name}' is missing a command`);
      }
      let stderrOutput = "";
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        cwd: server.cwd,
        stderr: "pipe"
      });
      transport.stderr?.on("data", (chunk) => {
        stderrOutput += chunk.toString();
      });
      try {
        await client.connect(transport);
        this.connections.set(server.name, { client, transport });
        const tools = await client.listTools();
        const toolMetadata = buildToolMetadata(tools);

        const connectedStatus = {
          name: server.name,
          status: "connected",
          ...toolMetadata
        };
        this.statuses.set(server.name, connectedStatus);
        return connectedStatus;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = stderrOutput.trim();
        throw new Error(detail ? `${message}\n${detail}` : message);
      }
    } else if (server.transport === "streamable-http") {
      if (!server.url) {
        throw new Error(`Server '${server.name}' is missing a URL`);
      }
      const httpOptions = {};
      if (server.authToken) {
        httpOptions.requestInit = {
          headers: { Authorization: `Bearer ${server.authToken}` }
        };
      }
      transport = new StreamableHTTPClientTransport(new URL(server.url), httpOptions);
    } else {
      throw new Error(`Unsupported transport '${server.transport}'`);
    }

    await client.connect(transport);
    this.connections.set(server.name, { client, transport });
    const tools = await client.listTools();
    const toolMetadata = buildToolMetadata(tools);

    const connectedStatus = {
      name: server.name,
      status: "connected",
      ...toolMetadata
    };
    this.statuses.set(server.name, connectedStatus);
    return connectedStatus;
  }

  async connectAll() {
    this._toolSummaryCache = null;
    await this.disconnectAll({ preserveStatuses: false });
    const settled = await Promise.all(
      this.getServers().map(async (server) => {
        try {
          return await this.connectServer(server);
        } catch (error) {
          const errorStatus = {
            name: server.name,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            tools: [],
            toolDetails: []
          };
          this.statuses.set(server.name, errorStatus);
          return errorStatus;
        }
      })
    );
    return settled;
  }

  startHealthChecks(intervalMs = 60000) {
    if (this._healthCheckTimer) return;
    this._healthCheckTimer = setInterval(async () => {
      // Snapshot entries up front — the map may be mutated by reconnect calls.
      const entries = [...this.connections.entries()];
      for (const [serverName, connection] of entries) {
        try {
          await Promise.race([
            connection.client.listTools(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), 5000))
          ]);
        } catch (pingErr) {
          const pingMsg = pingErr instanceof Error ? pingErr.message : String(pingErr);
          console.error(
            `[mcp-hub] Health check failed for '${serverName}' (${pingMsg}), attempting reconnect...`
          );
          this.connections.delete(serverName);
          this._toolSummaryCache = null;

          const server = this.getServers().find((s) => s.name === serverName);
          if (!server) {
            console.warn(
              `[mcp-hub] No server definition found for '${serverName}'; cannot reconnect.`
            );
            continue;
          }
          try {
            await this.connectServer(server);
            console.error(`[mcp-hub] Reconnected '${serverName}'.`);
          } catch (reconnectErr) {
            const reconnectMsg =
              reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
            console.error(`[mcp-hub] Reconnect failed for '${serverName}': ${reconnectMsg}`);
            this.statuses.set(serverName, {
              name: serverName,
              status: "error",
              error: reconnectMsg,
              tools: [],
              toolDetails: []
            });
          }
        }
      }
    }, intervalMs);
    this._healthCheckTimer.unref?.();
  }

  stopHealthChecks() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

async getToolSummary() {
    if (this._toolSummaryCache) return this._toolSummaryCache;
    const result = await this._getToolSummaryUncached();
    this._toolSummaryCache = result;
    return result;
  }

  async _getToolSummaryUncached() {
    const summary = [];
    for (const [serverName, connection] of this.connections.entries()) {
      try {
        const tools = await connection.client.listTools();
        const toolMetadata = buildToolMetadata(tools);
        summary.push({
          server: serverName,
          ...toolMetadata
        });
      } catch (err) {
        console.warn(
          `[mcp-hub] failed to list tools for '${serverName}':`,
          err instanceof Error ? err.message : err
        );
        summary.push({
          server: serverName,
          tools: [],
          toolDetails: [],
          status: "stale"
        });
      }
    }
    return summary;
  }

  async callTool(serverName, toolName, arguments_ = {}, options = {}) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }

    // Default 5 minute ceiling. Callers can override per-call for legitimately
    // long tools (e.g. extract_document_text on huge PDFs).
    const timeout = options.timeout ?? 300000;

    return connection.client.callTool(
      { name: toolName, arguments: arguments_ },
      undefined,
      { timeout }
    );
  }

  async disconnectAll({ preserveStatuses = true } = {}) {
    const connections = [...this.connections.values()];
    await Promise.allSettled(
      connections.map((connection) => connection.client.close())
    );
    this.connections.clear();
    if (!preserveStatuses) {
      this.statuses.clear();
    }
  }
}
