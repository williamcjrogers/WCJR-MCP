import Anthropic from "@anthropic-ai/sdk";

export const supportsTools = true;

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
  const client = new Anthropic({ apiKey });
  const response = await client.models.list();
  return (response.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
}

export async function stream({ apiKey, model, messages, tools, onChunk, signal }) {
  const client = new Anthropic({ apiKey });
  const { system, messages: convertedMessages } = toAnthropicMessages(messages);

  const request = {
    model,
    max_tokens: 8192,
    messages: convertedMessages,
    ...(system ? { system } : {}),
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

  const eventStream = client.messages.stream(request);
  if (signal) {
    signal.addEventListener("abort", () => eventStream.abort(), { once: true });
  }

  for await (const event of eventStream) {
    if (signal?.aborted) break;
    const type = event.type;
    if (type === "content_block_start" && event.content_block?.type === "tool_use") {
      pending[event.index] = { id: event.content_block.id, name: event.content_block.name, argsRaw: "" };
    } else if (type === "content_block_delta") {
      if (event.delta?.type === "input_json_delta" && pending[event.index]) {
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

  return {
    content: fullText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}
