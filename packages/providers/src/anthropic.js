import Anthropic from "@anthropic-ai/sdk";
import { assertApiKey, classifyProviderError, withRetry } from "./errors.js";

export const supportsTools = true;

const PROVIDER_ID = "anthropic";

function toAnthropicMessages(messages) {
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const converted = [];
  for (const m of rest) {
    if (m.role === "tool_call") {
      // Map to Anthropic assistant message with tool_use blocks
      converted.push({
        role: "assistant",
        content: (m.toolCalls ?? []).map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: typeof tc.args === "string" ? JSON.parse(tc.args || "{}") : (tc.args ?? {})
        }))
      });
    } else if (m.role === "tool_result") {
      // Map to Anthropic user message with tool_result block
      converted.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? {})
        }]
      });
    } else {
      converted.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" });
    }
  }
  return { system: system?.content, messages: converted };
}

function mapUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
  };
}

export async function listModels(apiKey) {
  assertApiKey(PROVIDER_ID, apiKey);
  const client = new Anthropic({ apiKey });
  const models = [];
  try {
    const page = await withRetry(() => client.models.list({ limit: 100 }));
    for (const model of page.data ?? []) {
      models.push({ id: model.id, name: model.display_name ?? model.id });
    }
    // If page.data doesn't work, try async iteration
    if (!models.length) {
      for await (const model of client.models.list({ limit: 100 })) {
        models.push({ id: model.id, name: model.display_name ?? model.id });
      }
    }
  } catch (err) {
    const typed = classifyProviderError(PROVIDER_ID, err);
    if (typed.code === "auth") throw typed;
    // For non-auth failures fall back to known models so the UI stays usable.
    console.warn(`[anthropic] listModels failed (${typed.userMessage}); using known fallback list.`);
  }
  return models.length ? models : [
    { id: "claude-opus-4-6-20260401", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6-20260401", name: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" }
  ];
}

export async function stream({ apiKey, model, messages, tools, onChunk, signal }) {
  assertApiKey(PROVIDER_ID, apiKey);
  const client = new Anthropic({ apiKey });
  const { system, messages: convertedMessages } = toAnthropicMessages(messages);

  // Enable extended thinking for Opus/Sonnet models
  const isThinkingCapable = model.includes("opus") || model.includes("sonnet");
  const request = {
    model,
    max_tokens: isThinkingCapable ? 128000 : 16384,
    messages: convertedMessages,
    ...(system ? { system } : {}),
    ...(isThinkingCapable ? {
      thinking: {
        type: "enabled",
        budget_tokens: 32000
      }
    } : {}),
    ...(tools?.length ? {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.parameters ?? t.parametersJsonSchema ?? { type: "object", properties: {} }
      }))
    } : {})
  };

  let fullText = "";
  const toolCalls = [];
  let usage = null;
  const pending = {};

  let eventStream;
  try {
    eventStream = await withRetry(() => client.messages.stream(request));
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err, { model });
  }
  if (signal) {
    signal.addEventListener("abort", () => eventStream.abort(), { once: true });
  }

  try {
  for await (const event of eventStream) {
    if (signal?.aborted) break;
    const type = event.type;
    if (type === "content_block_start" && event.content_block?.type === "tool_use") {
      pending[event.index] = { id: event.content_block.id, name: event.content_block.name, argsRaw: "" };
    } else if (type === "content_block_start" && event.content_block?.type === "thinking") {
      // Extended thinking block started — we'll collect it but not show raw thinking to user
      pending[event.index] = { type: "thinking", text: "" };
    } else if (type === "content_block_delta") {
      if (event.delta?.type === "thinking_delta" && pending[event.index]?.type === "thinking") {
        pending[event.index].text += event.delta.thinking ?? "";
      } else if (event.delta?.type === "input_json_delta" && pending[event.index]) {
        pending[event.index].argsRaw += event.delta.partial_json ?? "";
      } else if (event.delta?.type === "text_delta") {
        const text = event.delta.text ?? "";
        if (text) { fullText += text; onChunk?.({ type: "text", text }); }
      }
    } else if (type === "content_block_stop" && pending[event.index]) {
      const tc = pending[event.index];
      toolCalls.push({ id: tc.id, name: tc.name, args: tc.argsRaw });
      delete pending[event.index];
    } else if (type === "message_delta" && event.usage) {
      usage = mapUsage({ input_tokens: 0, output_tokens: event.usage.output_tokens ?? 0 });
    } else if (type === "message_start" && event.message?.usage) {
      usage = mapUsage(event.message.usage);
    }
  }
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err, { model });
  }

  return {
    content: fullText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}
