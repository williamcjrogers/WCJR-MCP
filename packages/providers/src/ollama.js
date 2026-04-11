import OpenAI from "openai";
import { openaiCompatibleStream } from "./openai-compat.js";
import { classifyProviderError } from "./errors.js";

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export const supportsTools = true;

const PROVIDER_ID = "ollama";

/** Health check — resolves true when Ollama is responding. */
export async function checkHealth(signal) {
  try {
    const res = await fetch(`${BASE_URL}/`, { signal });
    const text = await res.text();
    return text.includes("Ollama is running");
  } catch (err) {
    console.warn(`[ollama] health check failed at ${BASE_URL}: ${err?.message ?? err}`);
    return false;
  }
}

export async function listModels() {
  try {
    const client = new OpenAI({ apiKey: "ollama", baseURL: `${BASE_URL}/v1` });
    const page = await client.models.list();
    const models = [];
    for (const model of page.data) {
      models.push({ id: model.id, name: model.id });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  } catch (err) {
    throw classifyProviderError(PROVIDER_ID, err);
  }
}

export async function stream({ model, messages, tools, onChunk, signal }) {
  // Enable thinking mode for qwen3 and extended context for all
  const isThinkingModel = (model ?? "").includes("qwen3");
  const systemMessages = messages?.filter((m) => m.role === "system") ?? [];
  const enableThinking = isThinkingModel && !systemMessages.some((m) =>
    String(m.content ?? "").includes("/no_think")
  );

  // Prepend thinking toggle if qwen3
  const augmentedMessages = enableThinking
    ? messages.map((m) =>
        m.role === "system"
          ? { ...m, content: `/think\n${m.content}` }
          : m
      )
    : messages;

  const client = new OpenAI({ apiKey: "ollama", baseURL: `${BASE_URL}/v1` });
  return openaiCompatibleStream({
    client,
    model,
    messages: augmentedMessages,
    tools,
    onChunk,
    signal,
    provider: PROVIDER_ID
  });
}
