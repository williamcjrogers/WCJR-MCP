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
        connection.client.close().catch(() => undefined);
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
      } catch {
        // Ignore stale connection cleanup failures.
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
      transport = new StreamableHTTPClientTransport(new URL(server.url));
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
      for (const [serverName, client] of this._clients.entries()) {
        try {
          await Promise.race([
            client.listTools(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), 5000))
          ]);
        } catch {
          console.error(`[mcp-hub] Health check failed for ${serverName}, reconnecting...`);
          this._clients.delete(serverName);
          this._toolSummaryCache = null;
          const server = this._servers?.find?.((s) => s.name === serverName);
          if (server) {
            try { await this.connectServer(server); } catch (e) {
              console.error(`[mcp-hub] Reconnect failed for ${serverName}: ${e.message}`);
            }
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
      } catch {
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

  async callTool(serverName, toolName, arguments_ = {}) {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }

    return connection.client.callTool({
      name: toolName,
      arguments: arguments_
    });
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
