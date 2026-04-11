import { classifyProviderError, withRetry } from "./errors.js";

function normalizeTextContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return item.text ?? "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function toOpenAIMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  if (message.role === "tool_call") {
    return {
      role: "assistant",
      content: normalizeTextContent(message.content),
      tool_calls: (message.toolCalls ?? []).map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments:
            typeof toolCall.args === "string" ? toolCall.args : JSON.stringify(toolCall.args ?? {})
        }
      }))
    };
  }

  if (message.role === "tool_result") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: normalizeTextContent(message.content)
    };
  }

  return {
    role: message.role,
    content: normalizeTextContent(message.content)
  };
}

function mapUsage(usage) {
  if (!usage) {
    return null;
  }
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null
  };
}

function normalizeToolCalls(toolCallsByIndex) {
  return [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, toolCall]) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args
    }))
    .filter((toolCall) => toolCall.name);
}


export async function openaiCompatibleStream({
  client,
  model,
  messages,
  tools,
  onChunk,
  signal,
  provider = "openai"
}) {
  const params = {
    model,
    messages: (messages ?? []).map(toOpenAIMessage).filter(Boolean),
    stream: true,
    stream_options: {
      include_usage: true
    },
    max_completion_tokens: 32000
  };
  if (tools?.length) {
    params.tools = tools;
  }

  let response;
  try {
    response = await withRetry(() =>
      client.chat.completions.create(params, signal ? { signal } : undefined)
    );
  } catch (err) {
    throw classifyProviderError(provider, err, { model });
  }

  let fullText = "";
  let usage = null;
  const toolCallsByIndex = new Map();

  try {
  for await (const chunk of response) {
    if (chunk.usage) {
      usage = mapUsage(chunk.usage);
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const deltaText = normalizeTextContent(delta?.content);
    if (deltaText) {
      fullText += deltaText;
      onChunk?.({ type: "text", text: deltaText });
    }

    for (const toolCallDelta of delta?.tool_calls ?? []) {
      const index = toolCallDelta.index ?? 0;
      const current = toolCallsByIndex.get(index) ?? {
        id: toolCallDelta.id ?? `tool_call_${index}`,
        name: "",
        args: ""
      };

      if (toolCallDelta.id) {
        current.id = toolCallDelta.id;
      }
      if (toolCallDelta.function?.name) {
        current.name = toolCallDelta.function.name;
      }
      if (toolCallDelta.function?.arguments) {
        current.args += toolCallDelta.function.arguments;
      }

      toolCallsByIndex.set(index, current);
    }
  }
  } catch (err) {
    throw classifyProviderError(provider, err, { model });
  }

  const toolCalls = normalizeToolCalls(toolCallsByIndex);
  return {
    content: fullText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}
