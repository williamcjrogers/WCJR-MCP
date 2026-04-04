#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "@wcjr/memory-store";

function getStorePath() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--store");
  if (index === -1 || !args[index + 1]) {
    throw new Error("Memory MCP server requires --store <path>.");
  }
  return args[index + 1];
}

const memoryStore = new MemoryStore({
  storagePath: getStorePath(),
  maxMemories: 500
});

await memoryStore.load();

function formatMemory(memory, index) {
  const prefix = index != null ? `${index + 1}. ` : "- ";
  const tags = memory.tags?.length ? ` [${memory.tags.join(", ")}]` : "";
  return `${prefix}[${memory.category}] ${memory.content}${tags}`;
}

const server = new McpServer({
  name: "wcjr-memory",
  version: "0.1.0"
});

server.registerTool(
  "search_memory",
  {
    description: "Search remembered user preferences, profile facts, and long-term context.",
    inputSchema: {
      query: z.string().min(2).describe("What to search for in memory."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum memories to return.")
    }
  },
  async ({ query, limit = 8 }) => {
    const results = memoryStore.search(query, { limit });
    if (!results.length) {
      return {
        content: [{ type: "text", text: `No memory results for "${query}".` }]
      };
    }
    memoryStore.markUsed(results.map((memory) => memory.id));
    await memoryStore.save();
    return {
      content: [{ type: "text", text: results.map((memory, index) => formatMemory(memory, index)).join("\n") }]
    };
  }
);

server.registerTool(
  "list_memory",
  {
    description: "List remembered facts and preferences.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("Maximum memories to return."),
      category: z.string().optional().describe("Optional category filter.")
    }
  },
  async ({ limit = 20, category }) => {
    const results = memoryStore.list({ limit, category });
    if (!results.length) {
      return {
        content: [{ type: "text", text: "No memories stored yet." }]
      };
    }
    return {
      content: [{ type: "text", text: results.map((memory, index) => formatMemory(memory, index)).join("\n") }]
    };
  }
);

server.registerTool(
  "remember_memory",
  {
    description: "Store a new long-term memory item such as a preference, profile fact, company detail, or recurring instruction.",
    inputSchema: {
      content: z.string().min(3).describe("Memory content to store."),
      category: z.string().optional().describe("Optional category such as preference, profile, company, workflow, or project."),
      tags: z.array(z.string()).optional().describe("Optional tags.")
    }
  },
  async ({ content, category = "general", tags = [] }) => {
    const memory = memoryStore.upsert({ content, category, tags });
    await memoryStore.save();
    return {
      content: [{ type: "text", text: `Stored memory: ${formatMemory(memory)}` }]
    };
  }
);

server.registerTool(
  "forget_memory",
  {
    description: "Delete a stored memory by ID.",
    inputSchema: {
      memoryId: z.string().min(1).describe("ID of the memory to delete.")
    }
  },
  async ({ memoryId }) => {
    const deleted = memoryStore.delete(memoryId);
    if (!deleted) {
      return {
        content: [{ type: "text", text: `No memory found with ID ${memoryId}.` }]
      };
    }
    await memoryStore.save();
    return {
      content: [{ type: "text", text: `Deleted memory ${memoryId}.` }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
