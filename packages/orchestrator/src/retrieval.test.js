import test from "node:test";
import assert from "node:assert/strict";

import { buildRetrievalContext } from "./retrieval.js";

test("buildRetrievalContext consumes Lookeen document payloads and falls back to preview text", async () => {
  const calls = [];
  const mcpHub = {
    async callTool(server, tool, args) {
      calls.push({ server, tool, args });
      if (tool === "search") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                documents: [
                  {
                    title: "VeriCase - Shareholders Agreement.docx",
                    name: "VeriCase - Shareholders Agreement.docx",
                    path: "C:\\Users\\William\\OneDrive - Vericase LTD\\Agreements",
                    preview: "High level rights and restrictions summary.",
                    uri: "lookeen://agreement-1",
                    itemType: "FILE",
                    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  }
                ]
              })
            }
          ]
        };
      }
      if (tool === "get_text") {
        return {
          content: [
            {
              type: "text",
              text: "Unable to load text for agreement-1 com.lookeen.backend.processor.ConversionException"
            }
          ]
        };
      }
      throw new Error(`Unexpected tool call: ${tool}`);
    }
  };

  const context = await buildRetrievalContext({
    prompt: 'Search for "shareholder agreement"',
    taskType: "documents",
    serverContexts: [
      {
        name: "Lookeen MCP",
        tools: ["search", "get_text"]
      }
    ],
    mcpHub,
    memoryItems: []
  });

  assert.deepEqual(calls[0], {
    server: "Lookeen MCP",
    tool: "search",
    args: { query: "shareholder agreement type:file" }
  });
  assert.equal(context.retrievalResults.length, 1);
  assert.equal(context.retrievalResults[0].source, "lookeen");
  assert.equal(
    context.retrievalResults[0].snippet,
    "High level rights and restrictions summary."
  );
  assert.match(
    context.contextSections[0],
    /VeriCase - Shareholders Agreement\.docx/
  );
});

test("buildRetrievalContext searches local files by full document phrase before extraction", async () => {
  const calls = [];
  const mcpHub = {
    async callTool(server, tool, args) {
      calls.push({ server, tool, args });
      if (tool === "search_text_in_files") {
        return {
          content: [{ type: "text", text: 'No matches found for "shareholders agreement" under .' }]
        };
      }
      if (tool === "find_files_by_name") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query: args.query,
                matches: args.query === "shareholders agreement"
                  ? [{ path: "Agreements\\VeriCase - Shareholders Agreement.docx" }]
                  : []
              })
            }
          ]
        };
      }
      if (tool === "extract_document_text") {
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
                text: "Board consent is required for reserved matters."
              })
            }
          ]
        };
      }
      throw new Error(`Unexpected tool call: ${tool}`);
    }
  };

  const context = await buildRetrievalContext({
    prompt: 'Search for "shareholders agreement" in local files',
    taskType: "documents",
    serverContexts: [
      {
        name: "Local Filesystem",
        kind: "builtin-filesystem",
        tools: ["search_text_in_files", "find_files_by_name", "extract_document_text"]
      }
    ],
    mcpHub,
    memoryItems: []
  });

  assert.ok(
    calls.some(
      (call) => call.tool === "find_files_by_name" && call.args.query === "shareholders agreement"
    )
  );
  assert.equal(context.retrievalResults.length, 1);
  assert.equal(context.retrievalResults[0].source, "filesystem");
  assert.match(context.retrievalResults[0].snippet, /reserved matters/i);
});

test("buildRetrievalContext inspects an explicit folder path before broad filesystem search", async () => {
  const calls = [];
  const mcpHub = {
    async callTool(server, tool, args) {
      calls.push({ server, tool, args });
      if (tool === "list_directory") {
        return {
          content: [
            {
              type: "text",
              text: [
                "Directory: C:\\Users\\William\\OneDrive - Vericase LTD\\Agreements",
                "FILE Shareholders Agreement - Articles.docx",
                "FILE VeriCase - Shareholders Agreement.docx"
              ].join("\n")
            }
          ]
        };
      }
      if (tool === "extract_document_text") {
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
                text: `Extracted text for ${args.path}`
              })
            }
          ]
        };
      }
      throw new Error(`Unexpected tool call: ${tool}`);
    }
  };

  const context = await buildRetrievalContext({
    prompt: "Can you review the agreements in C:\\Users\\William\\OneDrive - Vericase LTD\\Agreements",
    taskType: "documents",
    serverContexts: [
      {
        name: "Local Filesystem",
        kind: "builtin-filesystem",
        tools: ["list_directory", "search_text_in_files", "find_files_by_name", "extract_document_text"]
      }
    ],
    mcpHub,
    memoryItems: []
  });

  assert.equal(calls[0].tool, "list_directory");
  assert.ok(!calls.some((call) => call.tool === "search_text_in_files"));
  assert.equal(context.retrievalResults.length, 2);
  assert.equal(calls.filter((call) => call.tool === "extract_document_text").length, 2);
  assert.ok(calls.filter((call) => call.tool === "extract_document_text").every((call) => call.args.maxChars === 50000));
});

test("buildRetrievalContext honors explicit maxChars for direct document extraction and keeps late text in evidence", async () => {
  const calls = [];
  const longText = `${"A".repeat(2500)} final clause marker`;
  const mcpHub = {
    async callTool(server, tool, args) {
      calls.push({ server, tool, args });
      if (tool === "extract_document_text") {
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
                text: longText
              })
            }
          ]
        };
      }
      throw new Error(`Unexpected tool call: ${tool}`);
    }
  };

  const context = await buildRetrievalContext({
    prompt: '{ "path": "C:\\Users\\William\\OneDrive - Vericase LTD\\Agreements\\Shareholders Agreement - Articles.docx", "maxChars": 30000 }',
    taskType: "documents",
    serverContexts: [
      {
        name: "Local Filesystem",
        kind: "builtin-filesystem",
        tools: ["extract_document_text"]
      }
    ],
    mcpHub,
    memoryItems: []
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "extract_document_text");
  assert.equal(calls[0].args.maxChars, 30000);
  assert.match(context.contextSections[0], /final clause marker/);
});
