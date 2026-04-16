import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as gemini from "./gemini.js";
import * as grok from "./grok.js";
import * as perplexity from "./perplexity.js";
import * as ollama from "./ollama.js";
import { lookupProvider, registerModel, registerModels } from "./registry.js";

export {
  ProviderError,
  AuthError,
  QuotaError,
  RateLimitError,
  ModelNotFoundError,
  ProviderUnreachableError,
  ProviderTimeoutError,
  assertApiKey,
  classifyProviderError,
  isRetryable,
  withRetry
} from "./errors.js";

export { registerModel, registerModels, lookupProvider, lookupMetadata, clearRegistry } from "./registry.js";

export const PROVIDERS = {
  /** Kept for legacy configs that still reference `claude-*` model ids; in-repo defaults use other providers. */
  anthropic: { label: "Anthropic (Claude)", adapter: anthropic },
  openai: { label: "OpenAI (GPT)", adapter: openai },
  gemini: { label: "Google (Gemini)", adapter: gemini },
  grok: { label: "xAI (Grok)", adapter: grok },
  perplexity: { label: "Perplexity (Sonar)", adapter: perplexity },
  ollama: { label: "Ollama (Local)", adapter: ollama }
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function getAdapter(providerId) {
  const entry = PROVIDERS[providerId];
  if (!entry) throw new Error(`Unknown provider: ${providerId}`);
  return entry.adapter;
}

export function resolveProvider(modelId) {
  if (!modelId) return null;
  // Prefer the runtime registry — adapters populate it from their listModels()
  // calls so a fine-tuned or custom id that the user has actually seen this
  // session resolves correctly.
  const registered = lookupProvider(modelId);
  if (registered) return registered;
  // Prefix fallback so cold-boot paths (before any listModels call) still
  // resolve the common well-known id patterns.
  if (modelId.startsWith("claude") || modelId.startsWith("anthropic")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("grok")) return "grok";
  if (modelId.startsWith("sonar")) return "perplexity";
  if (modelId.includes(":")) return "ollama";
  return null;
}
