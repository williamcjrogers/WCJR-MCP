import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { assertApiKey, classifyProviderError, withRetry } from "./errors.js";

export const supportsTools = true;

const PROVIDER_ID = "gemini";

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


export async function listModels(apiKey) {
  assertApiKey(PROVIDER_ID, apiKey);
  try {
    const ai = new GoogleGenAI({ apiKey });
    const models = [];
    const pager = await withRetry(() => ai.models.list());
    for await (const model of pager) {
      if (model.name) {
        const id = model.name.replace("models/", "");
        models.push({ id, name: model.displayName ?? id });
      }
    }
    return models;
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err);
  }
}

export async function stream({ apiKey, model, messages, tools, onChunk, signal }) {
  assertApiKey(PROVIDER_ID, apiKey);
  if (signal?.aborted) {
    throw abortError(signal);
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemMsg = messages.find((m) => m.role === "system");
  const userMessages = messages.filter((m) => m.role !== "system");

  const contents = userMessages.map(toGeminiContent).filter(Boolean);

  const config = {
    maxOutputTokens: 65536
  };
  // Enable thinking for Gemini 2.5+ models
  if (model.includes("2.5") || model.includes("3.")) {
    config.thinkingConfig = { thinkingBudget: 16384 };
  }
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

  let response;
  try {
    response = await withRetry(() =>
      ai.models.generateContentStream({ model, contents, config })
    );
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err, { model });
  }

  let fullText = "";
  const toolCalls = [];
  let usage = null;
  try {
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
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err, { model });
  }

  return {
    content: fullText,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {})
  };
}
