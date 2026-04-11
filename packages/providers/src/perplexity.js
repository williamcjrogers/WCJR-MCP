import OpenAI from "openai";
import { assertApiKey, classifyProviderError, withRetry } from "./errors.js";

const BASE_URL = "https://api.perplexity.ai";
export const supportsTools = false;

const PROVIDER_ID = "perplexity";

const KNOWN_MODELS = [
  { id: "sonar", name: "Sonar" },
  { id: "sonar-pro", name: "Sonar Pro" },
  { id: "sonar-deep-research", name: "Sonar Deep Research" },
  { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro" },
  { id: "sonar-reasoning", name: "Sonar Reasoning" }
];

export async function listModels(_apiKey) {
  // Perplexity doesn't expose a models endpoint; return the curated list.
  // Key check still happens when stream() is invoked.
  return KNOWN_MODELS;
}

function toPerplexityMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.role === "tool_call" || msg.role === "tool_result") return null;
  return {
    role: msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user",
    content: typeof msg.content === "string" ? msg.content : String(msg.content ?? "")
  };
}

export async function stream({ apiKey, model, messages, onChunk, signal }) {
  assertApiKey(PROVIDER_ID, apiKey);
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  const params = {
    model,
    messages: (messages ?? []).map(toPerplexityMessage).filter(Boolean),
    stream: true,
    max_tokens: 16384,
    web_search_options: {
      search_context_size: "high"
    },
    return_related_questions: true
  };

  let response;
  try {
    response = await withRetry(() =>
      client.chat.completions.create(params, signal ? { signal } : undefined)
    );
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err, { model });
  }

  let fullText = "";
  let usage = null;
  let citations = [];

  try {
  for await (const chunk of response) {
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0)
      };
    }
    // Capture citations if available
    if (chunk.citations?.length) {
      citations = chunk.citations;
    }

    const delta = chunk.choices?.[0]?.delta;
    const text = delta?.content ?? "";
    if (text) {
      fullText += text;
      onChunk?.({ type: "text", text });
    }
  }
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err, { model });
  }

  // Append citations as sources if available
  if (citations.length > 0) {
    const sourcesBlock = "\n\n**Sources:**\n" + citations.map((url, i) => `${i + 1}. ${url}`).join("\n");
    fullText += sourcesBlock;
    onChunk?.({ type: "text", text: sourcesBlock });
  }

  return {
    content: fullText,
    ...(usage ? { usage } : {})
  };
}
