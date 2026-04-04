import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";

export const supportsTools = true;

function abortError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(reason ? String(reason) : "Operation aborted");
}

function normalizeText(part) {
  return typeof part?.text === "string" ? part.text : "";
}

function toGeminiContent(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  if (message.role === "tool_call") {
    return {
      role: "model",
      parts: (message.toolCalls ?? []).map((toolCall) => ({
        functionCall: {
          id: toolCall.id,
          name: toolCall.name,
          args:
            typeof toolCall.args === "string" ? JSON.parse(toolCall.args || "{}") : toolCall.args ?? {}
        }
      }))
    };
  }

  if (message.role === "tool_result") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: message.toolCallId,
            name: message.name,
            response: {
              content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? {}),
              status: message.status ?? "completed"
            }
          }
        }
      ]
    };
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof message.content === "string" ? message.content : "" }]
  };
}

function collectFunctionCalls(chunk) {
  if (Array.isArray(chunk?.functionCalls) && chunk.functionCalls.length) {
    return chunk.functionCalls;
  }

  return (
    chunk?.candidates?.[0]?.content?.parts
      ?.filter((part) => part?.functionCall)
      .map((part) => part.functionCall) ?? []
  );
}

function mapUsage(usageMetadata) {
  if (!usageMetadata) {
    return null;
  }
  return {
    inputTokens: usageMetadata.promptTokenCount ?? usageMetadata.cachedContentTokenCount ?? null,
    outputTokens: usageMetadata.candidatesTokenCount ?? null,
    totalTokens: usageMetadata.totalTokenCount ?? null
  };
}


function isRetryable(err) {
  const status = err?.status ?? err?.statusCode ?? 0;
  if (status === 429 || status === 502 || status === 503) return true;
  const code = String(err?.code ?? "");
  return code === "ECONNRESET" || code === "ETIMEDOUT";
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

export async function listModels(apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const models = [];
  const pager = await ai.models.list();
  for await (const model of pager) {
    if (model.name) {
      const id = model.name.replace("models/", "");
      models.push({ id, name: model.displayName ?? id });
    }
  }
  return models;
}

export async function stream({ apiKey, model, messages, tools, onChunk, signal }) {
  if (signal?.aborted) {
    throw abortError(signal);
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemMsg = messages.find((m) => m.role === "system");
  const userMessages = messages.filter((m) => m.role !== "system");

  const contents = userMessages.map(toGeminiContent).filter(Boolean);

  const config = {};
  if (systemMsg) {
    config.systemInstruction = systemMsg.content;
  }
  if (tools?.length) {
    config.toolConfig = {
      functionCallingConfig: {
        // AUTO allows Gemini to call tools when needed AND return text when done,
        // preventing wasteful iterations where ANY forces a tool call every turn.
        mode: FunctionCallingConfigMode.AUTO
      }
    };
    config.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters ?? tool.parametersJsonSchema ?? {}
        }))
      }
    ];
  }

  const response = await withRetry(() => ai.models.generateContentStream({
    model,
    contents,
    config
  }));

  let fullText = "";
  const toolCalls = [];
  let usage = null;
  for await (const chunk of response) {
    if (signal?.aborted) {
      throw abortError(signal);
    }

    const text = chunk.text ?? chunk.candidates?.[0]?.content?.parts?.map(normalizeText).join("") ?? "";
    if (text) {
      fullText += text;
      onChunk?.({ type: "text", text });
    }

    for (const functionCall of collectFunctionCalls(chunk)) {
      toolCalls.push({
        id: functionCall.id ?? `tool_call_${toolCalls.length}`,
        name: functionCall.name,
        args: JSON.stringify(functionCall.args ?? {})
      });
    }

    usage = mapUsage(chunk.usageMetadata) ?? usage;
  }

  return {
    content: fullText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}
