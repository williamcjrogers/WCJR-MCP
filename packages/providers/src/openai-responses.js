/**
 * Streaming via the OpenAI Responses API (/v1/responses).
 * Used by models like gpt-5.4-pro, o3, o4-mini, and grok-4.20-multi-agent
 * that require the Responses API instead of Chat Completions.
 *
 * Returns the same { content, toolCalls, usage } shape as openaiCompatibleStream().
 */

import { classifyProviderError, withRetry } from "./errors.js";

function normalizeTextContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : item?.text ?? "")).join("");
  }
  return "";
}

/**
 * Convert the app's internal message format to Responses API input format.
 *
 * The Responses API expects a mix of message items and structured
 * `function_call` / `function_call_output` items — it does NOT accept tool
 * results smuggled into user text. Getting this wrong silently breaks
 * multi-round tool calling on gpt-5-pro / o3 / o4 / grok-multi-agent.
 *
 * Shapes (current OpenAI Responses API):
 *   { type: "message", role, content: [{type:"input_text"|"output_text", text}] }
 *   { type: "function_call", call_id, name, arguments }
 *   { type: "function_call_output", call_id, output }
 */
function toResponsesInput(messages) {
  const input = [];
  for (const msg of messages ?? []) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "system") {
      input.push({
        role: "system",
        content: normalizeTextContent(msg.content)
      });
      continue;
    }

    if (msg.role === "user") {
      input.push({
        role: "user",
        content: normalizeTextContent(msg.content)
      });
      continue;
    }

    if (msg.role === "tool_call") {
      // The assistant previously emitted tool calls. Replay each call as a
      // structured function_call item so the model can link the matching
      // function_call_output to it by call_id.
      const text = normalizeTextContent(msg.content);
      if (text) {
        input.push({ role: "assistant", content: text });
      }
      for (const tc of msg.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name ?? "",
          arguments:
            typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {})
        });
      }
      continue;
    }

    if (msg.role === "assistant") {
      input.push({
        role: "assistant",
        content: normalizeTextContent(msg.content)
      });
      continue;
    }

    if (msg.role === "tool_result" || msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.toolCallId ?? "unknown",
        output: normalizeTextContent(msg.content)
      });
      continue;
    }
  }
  return input;
}

export async function openaiResponsesStream({
  client,
  model,
  messages,
  tools,
  onChunk,
  signal,
  provider = "openai"
}) {
  const m = (model ?? "").toLowerCase();
  const isReasoning = m.startsWith("o3") || m.startsWith("o4") || m.includes("-pro");

  const params = {
    model,
    input: toResponsesInput(messages),
    stream: true,
    max_output_tokens: isReasoning ? 100000 : 32000,
    ...(isReasoning ? { reasoning: { effort: "high" } } : {})
  };

  // Convert Chat Completions tool format to Responses API format
  // Chat Completions: { type: "function", function: { name, description, parameters } }
  // Responses API:    { type: "function", name, description, parameters }
  if (tools?.length) {
    params.tools = tools.map((tool) => ({
      type: "function",
      name: tool.function?.name ?? tool.name ?? "",
      description: tool.function?.description ?? tool.description ?? "",
      parameters: tool.function?.parameters ?? tool.parameters ?? {}
    }));
  }

  let response;
  try {
    response = await withRetry(() =>
      client.responses.create(params, signal ? { signal } : undefined)
    );
  } catch (err) {
    throw classifyProviderError(provider, err, { model });
  }

  let fullText = "";
  let usage = null;
  const toolCalls = [];

  try {
  for await (const event of response) {
    // Text deltas
    if (event.type === "response.output_text.delta") {
      const delta = event.delta ?? "";
      if (delta) {
        fullText += delta;
        onChunk?.({ type: "text", text: delta });
      }
    }

    // Function call outputs — the Responses API emits `response.output_item.added`
    // with the full function_call item (including call_id + name) and then one
    // or more `response.function_call_arguments.delta` events, followed by
    // `response.function_call_arguments.done` with the complete arguments
    // string. We capture call_id at `output_item.added` time and fill the
    // arguments in at `.done` time. `event.name` on the arguments.done event
    // is deprecated on newer API builds, so we cannot rely on it alone.
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      toolCalls.push({
        id: event.item.call_id ?? event.item.id ?? `tool_call_${toolCalls.length}`,
        name: event.item.name ?? "",
        args: event.item.arguments ?? ""
      });
    }

    if (event.type === "response.function_call_arguments.done") {
      const existing = toolCalls.find(
        (tc) => tc.id === (event.call_id ?? event.item_id)
      );
      if (existing) {
        existing.args = event.arguments ?? existing.args ?? "{}";
        if (!existing.name && event.name) existing.name = event.name;
      } else {
        // Back-compat: some API builds still only emit `.done` with item_id.
        toolCalls.push({
          id: event.call_id ?? event.item_id ?? `tool_call_${toolCalls.length}`,
          name: event.name ?? "",
          args: event.arguments ?? "{}"
        });
      }
    }

    // Usage info
    if (event.type === "response.completed" && event.response?.usage) {
      const u = event.response.usage;
      usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      };
    }
  }
  } catch (err) {
    throw classifyProviderError(provider, err, { model });
  }

  // Parse tool call arguments
  const parsedToolCalls = toolCalls.map((tc) => {
    let args;
    try {
      args = typeof tc.args === "string" ? JSON.parse(tc.args) : tc.args;
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.name, args };
  });

  return {
    content: fullText,
    ...(parsedToolCalls.length ? { toolCalls: parsedToolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}

/**
 * Check if a model requires the Responses API instead of Chat Completions.
 */
export function requiresResponsesApi(modelId) {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  // OpenAI models that use Responses API
  if (m.includes("-pro") && (m.startsWith("gpt-") || m.startsWith("o"))) return true;
  if (m.startsWith("o3") || m.startsWith("o4")) return true;
  // Grok multi-agent models use Responses API
  if (m.includes("multi-agent")) return true;
  return false;
}
