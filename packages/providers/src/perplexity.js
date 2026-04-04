import OpenAI from "openai";
import { openaiCompatibleStream } from "./openai-compat.js";

const BASE_URL = "https://api.perplexity.ai";
export const supportsTools = false;

const KNOWN_MODELS = [
  { id: "sonar", name: "Sonar" },
  { id: "sonar-pro", name: "Sonar Pro" },
  { id: "sonar-deep-research", name: "Sonar Deep Research" },
  { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro" }
];

export async function listModels(_apiKey) {
  return KNOWN_MODELS;
}

export async function stream({ apiKey, model, messages, onChunk, signal }) {
  const client = new OpenAI({ apiKey, baseURL: BASE_URL });
  return openaiCompatibleStream({
    client,
    model,
    messages,
    onChunk,
    signal
  });
}
