/**
 * Runtime model registry.
 *
 * Prefix matching in `resolveProvider` is brittle: any model id that doesn't
 * start with one of the hardcoded prefixes silently resolves to `null`, and
 * callers downstream default to `"openai"`, which creates a hidden OpenAI
 * key dependency for e.g. local / fine-tuned / Bedrock-style ids.
 *
 * The registry is populated at runtime from each adapter's `listModels()`.
 * Lookups fall through to the prefix match so nothing breaks before the
 * registry has been warmed.
 */

const registry = new Map();

/**
 * Record a model. `modelId` is the string the adapter exposes; `providerId`
 * is one of the known provider keys (`openai`, `anthropic`, ...). Extra
 * metadata (capabilities, displayName) is stored verbatim.
 */
export function registerModel(modelId, providerId, meta = {}) {
  if (!modelId || !providerId) return;
  registry.set(modelId, { providerId, ...meta });
}

/**
 * Record an entire `{modelId -> provider}` slice in one go — useful to seed
 * the registry from cached model lists on boot.
 */
export function registerModels(entries = []) {
  for (const entry of entries) {
    if (entry?.modelId && entry?.providerId) {
      registerModel(entry.modelId, entry.providerId, entry);
    }
  }
}

export function lookupProvider(modelId) {
  if (!modelId) return null;
  const hit = registry.get(modelId);
  return hit?.providerId ?? null;
}

export function lookupMetadata(modelId) {
  if (!modelId) return null;
  return registry.get(modelId) ?? null;
}

export function clearRegistry() {
  registry.clear();
}

export function registrySize() {
  return registry.size;
}
