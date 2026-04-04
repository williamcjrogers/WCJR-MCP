import OpenAI from "openai";
import { openaiCompatibleStream } from "./openai-compat.js";

export const supportsTools = true;

export async function listModels(apiKey) {
  const client = new OpenAI({ apiKey });
  const models = [];
  const page = await client.models.list();
  for (const model of page.data) {
    models.push({ id: model.id, name: model.id });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export async function stream({ apiKey, model, messages, tools, onChunk, signal }) {
  const client = new OpenAI({ apiKey });
  return openaiCompatibleStream({
    client,
    model,
    messages,
    tools,
    onChunk,
    signal
  });
}
