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


function isRetryable(err) {
  const status = err?.status ?? err?.statusCode ?? 0;
  if (status === 429 || status === 502 || status === 503) return true;
  const code = String(err?.code ?? "");
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED";
}

async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastErr;
}

export async function openaiCompatibleStream({
  client,
  model,
  messages,
  tools,
  onChunk,
  signal
}) {
  const params = {
    model,
    messages: (messages ?? []).map(toOpenAIMessage).filter(Boolean),
    stream: true,
    stream_options: {
      include_usage: true
    }
  };
  if (tools?.length) {
    params.tools = tools;
  }

  const response = await client.chat.completions.create(params, signal ? { signal } : undefined);

  let fullText = "";
  let usage = null;
  const toolCallsByIndex = new Map();

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

  const toolCalls = normalizeToolCalls(toolCallsByIndex);
  return {
    content: fullText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}
