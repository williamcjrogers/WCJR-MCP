import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as gemini from "./gemini.js";
import * as grok from "./grok.js";
import * as perplexity from "./perplexity.js";

export const PROVIDERS = {
  /** Kept for legacy configs that still reference `claude-*` model ids; in-repo defaults use other providers. */
  anthropic: { label: "Anthropic (Claude)", adapter: anthropic },
  openai: { label: "OpenAI (GPT)", adapter: openai },
  gemini: { label: "Google (Gemini)", adapter: gemini },
  grok: { label: "xAI (Grok)", adapter: grok },
  perplexity: { label: "Perplexity (Sonar)", adapter: perplexity }
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getAdapter(providerId) {
  const entry = PROVIDERS[providerId];
  if (!entry) throw new Error(`Unknown provider: ${providerId}`);
  return entry.adapter;
}

export function resolveProvider(modelId) {
  if (!modelId) return null;
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("grok")) return "grok";
  if (modelId.startsWith("sonar")) return "perplexity";
  return null;
}
