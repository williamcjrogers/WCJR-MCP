import test from "node:test";
import assert from "node:assert/strict";

import { openaiCompatibleStream } from "./openai-compat.js";

function createStreamingResponse(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  };
}

test("openaiCompatibleStream accumulates streamed tool-call arguments", async () => {
  const emitted = [];
  const client = {
    chat: {
      completions: {
        create() {
          return createStreamingResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: {
                          name: "Filesystem__read_text_file__abc",
                          arguments: '{"path":"'
                        }
                      }
                    ]
                  }
                }
              ]
            },
            {
              choices: [
                {
                  delta: {
                    content: "Working on it.",
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: 'notes.txt"}'
                        }
                      }
                    ]
                  }
                }
              ]
            },
            {
              choices: [{ delta: {} }],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 5,
                total_tokens: 17
              }
            }
          ]);
        }
      }
    }
  };

  const result = await openaiCompatibleStream({
    client,
    model: "gpt-5.2",
    messages: [{ role: "user", content: "Read notes.txt" }],
    tools: [],
    onChunk: (chunk) => emitted.push(chunk)
  });

  assert.equal(result.content, "Working on it.");
  assert.deepEqual(result.toolCalls, [
    {
      id: "call_1",
      name: "Filesystem__read_text_file__abc",
      args: '{"path":"notes.txt"}'
    }
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17
  });
  assert.deepEqual(emitted, [{ type: "text", text: "Working on it." }]);
});