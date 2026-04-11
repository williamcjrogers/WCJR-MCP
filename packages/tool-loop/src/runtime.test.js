import test from "node:test";
import assert from "node:assert/strict";

import { mcpToolsToOpenAIFunctions, runToolLoop } from "./index.js";

test("runToolLoop records timeouts as tool errors", async () => {
  const openaiTools = mcpToolsToOpenAIFunctions([
    {
      server: "Local Filesystem",
      tools: ["read_text_file"],
      toolDetails: [
        {
          name: "read_text_file",
          description: "Read a text file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } }
          }
        }
      ]
    }
  ]);

  const result = await runToolLoop({
    adapter: {
      async stream({ messages }) {
        const toolResults = messages.filter((message) => message.role === "tool_result");
        if (!toolResults.length) {
          return {
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: openaiTools[0].function.name,
                args: JSON.stringify({ path: "notes.txt" })
              }
            ]
          };
        }

        return { content: "The file read timed out." };
      }
    },
    adapterArgs: {
      messages: [{ role: "user", content: "Read notes.txt" }]
    },
    tools: openaiTools,
    mcpHub: {
      async callTool() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { content: [{ type: "text", text: "never reached" }] };
      }
    },
    toolTimeoutMs: 5,
    maxIterations: 2
  });

  assert.equal(result.content, "The file read timed out.");
  assert.equal(result.toolTrace[0].status, "error");
  // formatMcpError now surfaces a human-readable timeout message instead of
  // the raw "Timed out after Nms" from withTimeout().
  assert.match(result.toolTrace[0].resultPreview, /timed out — skipped/);
  assert.match(result.toolTrace[0].error, /timed out — skipped/);
});

test("runToolLoop falls back to a final generation after max iterations", async () => {
  const openaiTools = mcpToolsToOpenAIFunctions([
    {
      server: "Local Filesystem",
      tools: ["list_directory"],
      toolDetails: [
        {
          name: "list_directory",
          description: "List a directory",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } }
          }
        }
      ]
    }
  ]);

  let invocationCount = 0;
  const result = await runToolLoop({
    adapter: {
      async stream({ tools }) {
        invocationCount += 1;
        if (tools?.length) {
          return {
            content: "",
            toolCalls: [
              {
                id: `call_${invocationCount}`,
                name: openaiTools[0].function.name,
                args: JSON.stringify({ path: "." })
              }
            ]
          };
        }

        return { content: "Final summary after exhausting tool iterations." };
      }
    },
    adapterArgs: {
      messages: [{ role: "user", content: "Inspect the current directory" }]
    },
    tools: openaiTools,
    mcpHub: {
      async callTool() {
        return { content: [{ type: "text", text: "directory contents" }] };
      }
    },
    maxIterations: 1
  });

  assert.equal(invocationCount, 2);
  assert.equal(result.content, "Final summary after exhausting tool iterations.");
  assert.equal(result.toolTrace.length, 1);
});