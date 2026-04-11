import test from "node:test";
import assert from "node:assert/strict";

import { MCPHub } from "./index.js";

test("MCPHub.getStatuses preserves tools compatibility fields", () => {
  const hub = new MCPHub({
    mcpServers: [{ name: "Local Filesystem", enabled: true }]
  });

  const statuses = hub.getStatuses();

  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0].tools, []);
  assert.deepEqual(statuses[0].toolDetails, []);
});

test("MCPHub.getToolSummary returns both tool names and tool details", async () => {
  const hub = new MCPHub({
    mcpServers: [{ name: "Local Filesystem", enabled: true }]
  });

  hub.connections.set("Local Filesystem", {
    client: {
      async listTools() {
        return {
          tools: [
            {
              name: "read_text_file",
              description: "Read a text file",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string" }
                },
                required: ["path"]
              }
            }
          ]
        };
      }
    }
  });

  const summary = await hub.getToolSummary();

  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0].tools, ["read_text_file"]);
  assert.equal(summary[0].toolDetails[0].name, "read_text_file");
  assert.equal(summary[0].toolDetails[0].description, "Read a text file");
  assert.deepEqual(summary[0].toolDetails[0].inputSchema.required, ["path"]);
});

test("MCPHub.connectAll isolates partial failures across servers", async () => {
  const hub = new MCPHub({
    mcpServers: [
      { name: "Server A", enabled: true },
      { name: "Server B", enabled: true }
    ]
  });

  hub.connectServer = async (server) => {
    if (server.name === "Server B") {
      throw new Error("Connection failed");
    }
    const status = { name: server.name, status: "connected", tools: [], toolDetails: [] };
    hub.statuses.set(server.name, status);
    return status;
  };

  const statuses = await hub.connectAll();

  assert.equal(statuses.length, 2);
  assert.equal(statuses.find((item) => item.name === "Server A")?.status, "connected");
  assert.equal(statuses.find((item) => item.name === "Server B")?.status, "error");
});

test("MCPHub.startHealthChecks iterates this.connections without ReferenceError", async () => {
  const hub = new MCPHub({
    mcpServers: [{ name: "Server A", enabled: true }]
  });

  let listCalls = 0;
  let reconnectCalls = 0;
  hub.connections.set("Server A", {
    client: {
      async listTools() {
        listCalls += 1;
        throw new Error("simulated failure");
      }
    }
  });

  hub.connectServer = async (server) => {
    reconnectCalls += 1;
    const status = { name: server.name, status: "connected", tools: [], toolDetails: [] };
    hub.statuses.set(server.name, status);
    return status;
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    hub.startHealthChecks(10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    hub.stopHealthChecks();
  } finally {
    console.error = originalError;
  }

  assert.ok(listCalls >= 1, "listTools should have been called at least once");
  assert.ok(reconnectCalls >= 1, "connectServer should have been invoked for reconnect");
});

test("MCPHub.disconnectAll waits for all closes and clears connections", async () => {
  const hub = new MCPHub({
    mcpServers: [{ name: "Server A", enabled: true }]
  });

  let closeCalls = 0;
  hub.connections.set("Server A", {
    client: {
      async close() {
        closeCalls += 1;
        throw new Error("close failed");
      }
    }
  });

  await hub.disconnectAll({ preserveStatuses: false });

  assert.equal(closeCalls, 1);
  assert.equal(hub.connections.size, 0);
  assert.equal(hub.statuses.size, 0);
});
