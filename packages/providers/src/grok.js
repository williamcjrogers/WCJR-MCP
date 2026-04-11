import OpenAI from "openai";
import { openaiCompatibleStream } from "./openai-compat.js";
import { openaiResponsesStream, requiresResponsesApi } from "./openai-responses.js";
import { assertApiKey, classifyProviderError, withRetry } from "./errors.js";

const BASE_URL = "https://api.x.ai/v1";
export const supportsTools = true;

const PROVIDER_ID = "grok";

export async function listModels(apiKey) {
  assertApiKey(PROVIDER_ID, apiKey);
  try {
    const client = new OpenAI({ apiKey, baseURL: BASE_URL });
    const page = await withRetry(() => client.models.list());
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

export async function stream({ apiKey, model, messages, tools, onChunk, signal }) {
  assertApiKey(PROVIDER_ID, apiKey);
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  if (requiresResponsesApi(model)) {
    return openaiResponsesStream({
      client,
      model,
      messages,
      tools,
      onChunk,
      signal,
      provider: PROVIDER_ID
    });
  }

  return openaiCompatibleStream({
    client,
    model,
    messages,
    tools,
    onChunk,
    signal,
    provider: PROVIDER_ID
  });
}
