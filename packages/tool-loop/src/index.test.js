import test from "node:test";
import assert from "node:assert/strict";

import {
  mcpToolsToGeminiFunctions,
  mcpToolsToOpenAIFunctions,
  parseToolCallName,
  runToolLoop,
  serializeToolResult
} from "./index.js";

test("tool schema conversion preserves compatibility metadata", () => {
  const toolSummary = [
    {
      server: "Local Filesystem",
      tools: ["read_text_file"],
      toolDetails: [
        {
          name: "read_text_file",
          description: "Read a text file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      ]
    }
  ];

  const openaiTools = mcpToolsToOpenAIFunctions(toolSummary);
  const geminiTools = mcpToolsToGeminiFunctions(toolSummary);

  assert.equal(openaiTools.length, 1);
  assert.equal(geminiTools.length, 1);
  assert.equal(openaiTools[0].function.parameters.type, "object");
  assert.deepEqual(openaiTools[0].function.parameters.required, ["path"]);
  assert.equal(geminiTools[0].parameters.properties.path.type, "string");

  const parsed = parseToolCallName(openaiTools[0].function.name);
  assert.deepEqual(parsed, {
    server: "Local Filesystem",
    tool: "read_text_file"
  });
});

test("serializeToolResult guards and truncates tool output", () => {
  const output = serializeToolResult({
    content: [{ type: "text", text: "hello world" }]
  });

  assert.match(output, /UNTRUSTED TOOL RESULT/);
  assert.match(output, /hello world/);
});

test("runToolLoop executes tool calls and returns final content", async () => {
  const emitted = [];
  const adapter = {
    async stream({ messages, onChunk }) {
      const toolResults = messages.filter((message) => message.role === "tool_result");
      if (!toolResults.length) {
        return {
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "Local_Filesystem__read_text_file__known",
              args: JSON.stringify({ path: "notes.txt" })
            }
          ]
        };
      }

      onChunk?.({ type: "text", text: "Summary ready." });
      return {
        content: "Summary ready."
      };
    }
  };

  const mcpHub = {
    async callTool(server, tool, args) {
      assert.equal(server, "Local Filesystem");
      assert.equal(tool, "read_text_file");
      assert.deepEqual(args, { path: "notes.txt" });
      return {
        content: [{ type: "text", text: "File contents" }]
      };
    }
  };

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

  const aliasedName = openaiTools[0].function.name;
  const result = await runToolLoop({
    adapter: {
      async stream({ messages, onChunk }) {
        const toolResults = messages.filter((message) => message.role === "tool_result");
        if (!toolResults.length) {
          return {
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: aliasedName,
                args: JSON.stringify({ path: "notes.txt" })
              }
            ]
          };
        }

        onChunk?.({ type: "text", text: "Summary ready." });
        return { content: "Summary ready." };
      }
    },
    adapterArgs: {
      messages: [{ role: "user", content: "Read notes.txt" }]
    },
    tools: openaiTools,
    mcpHub,
    onChunk: (chunk) => emitted.push(chunk),
    maxIterations: 3
  });

  assert.equal(result.content, "Summary ready.");
  assert.equal(result.toolTrace.length, 1);
  assert.equal(result.toolTrace[0].status, "completed");
  assert.ok(
    emitted.some((chunk) => chunk.type === "tool_call" && chunk.tool === "read_text_file")
  );
  assert.ok(
    emitted.some((chunk) => chunk.type === "tool_result" && chunk.status === "completed")
  );
});

test("runToolLoop records tool failures and still summarizes", async () => {
  const openaiTools = mcpToolsToOpenAIFunctions([
    {
      server: "Desktop Commander",
      tools: ["launch_application"],
      toolDetails: [
        {
          name: "launch_application",
          description: "Launch an application",
          inputSchema: {
            type: "object",
            properties: { app: { type: "string" } }
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
                args: JSON.stringify({ app: "outlook" })
              }
            ]
          };
        }

        return { content: "I could not launch Outlook automatically." };
      }
    },
    adapterArgs: {
      messages: [{ role: "user", content: "Open Outlook" }]
    },
    tools: openaiTools,
    mcpHub: {
      async callTool() {
        throw new Error("Access denied");
      }
    },
    maxIterations: 2
  });

  assert.equal(result.content, "I could not launch Outlook automatically.");
  assert.equal(result.toolTrace[0].status, "error");
  assert.match(result.toolTrace[0].resultPreview, /Access denied/);
});

test("runToolLoop preserves larger extract_document_text results when requested", async () => {
  const openaiTools = mcpToolsToOpenAIFunctions([
    {
      server: "Local Filesystem",
      tools: ["extract_document_text"],
      toolDetails: [
        {
          name: "extract_document_text",
          description: "Extract a document",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              maxChars: { type: "number" }
            }
          }
        }
      ]
    }
  ]);

  const tailMarker = "TAIL_MARKER_PRESENT";
  const largeText = `${"A".repeat(15000)}${tailMarker}`;

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
                args: JSON.stringify({
                  path: "Agreements\\Shareholders Agreement - Articles.docx",
                  maxChars: 30000
                })
              }
            ]
          };
        }

        assert.match(toolResults[0].content, /TAIL_MARKER_PRESENT/);
        return { content: "Document reviewed." };
      }
    },
    adapterArgs: {
      messages: [{ role: "user", content: "Inspect the agreement document." }]
    },
    tools: openaiTools,
    mcpHub: {
      async callTool(server, tool, args) {
        assert.equal(server, "Local Filesystem");
        assert.equal(tool, "extract_document_text");
        assert.equal(args.maxChars, 30000);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path: args.path,
                kind: "docx",
                method: "mammoth",
                truncated: false,
                warnings: [],
                text: largeText
              })
            }
          ]
        };
      }
    },
    maxIterations: 3
  });

  assert.equal(result.content, "Document reviewed.");
});

test("runToolLoop blocks tool execution when the policy hook requires approval", async () => {
  const openaiTools = mcpToolsToOpenAIFunctions([
    {
      server: "Mail & Calendar (Microsoft 365)",
      tools: ["send_email"],
      toolDetails: [
        {
          name: "send_email",
          description: "Send an email",
          inputSchema: {
            type: "object",
            properties: {
              to: { type: "array", items: { type: "string" } },
              subject: { type: "string" }
            }
          }
        }
      ]
    }
  ]);

  let toolCalled = false;
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
                args: JSON.stringify({ to: ["test@example.com"], subject: "Hello" })
              }
            ]
          };
        }

        assert.match(toolResults[0].content, /Policy blocked/i);
        return { content: "Email send blocked pending approval." };
      }
    },
    adapterArgs: {
      messages: [{ role: "user", content: "Send the email" }]
    },
    tools: openaiTools,
    mcpHub: {
      async callTool() {
        toolCalled = true;
        return { content: [{ type: "text", text: "sent" }] };
      }
    },
    beforeToolCall: async () => ({
      decision: "confirm",
      message: "Policy blocked Mail & Calendar (Microsoft 365).send_email: approval required.",
      policy: {
        actionType: "send_email",
        decision: "confirm",
        reason: "approval required",
        context: { channel: "mail-calendar" }
      }
    }),
    maxIterations: 2
  });

  assert.equal(toolCalled, false);
  assert.equal(result.content, "Email send blocked pending approval.");
  assert.equal(result.toolTrace[0].status, "blocked");
  assert.match(result.toolTrace[0].resultPreview, /Policy blocked/i);
});
