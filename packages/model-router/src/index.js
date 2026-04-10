import { ACTIVITY_ORDER, getDefaultModelProfiles } from "@wcjr/activity-profiles";

export { DEFAULT_MODEL_TIERS, resolveModelForPhase } from "./tiers.js";

const DEFAULT_MODEL_PROFILES = getDefaultModelProfiles();

// Single source of truth for the fallback chain. Ordered best-available →
// cheaper cloud → different provider → local terminal fallback.
const DEFAULT_FALLBACK_CHAIN = Object.freeze([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "grok-3-beta",
  "claude-sonnet-4-6-20250514",
  "qwen3:14b"
]);

// The head of the fallback chain is the always-available default when no
// profile or override can resolve a specific model.
const DEFAULT_MODEL = DEFAULT_FALLBACK_CHAIN[0];

export class ModelRouter {
  constructor(config) {
    this.config = config;
  }

  getProfiles() {
    return {
      ...DEFAULT_MODEL_PROFILES,
      ...(this.config?.modelProfiles ?? {})
    };
  }

  updateProfiles(nextProfiles) {
    this.config.modelProfiles = {
      ...this.getProfiles(),
      ...nextProfiles
    };
    return this.config.modelProfiles;
  }

  selectModel(taskType, override) {
    if (override) {
      return override;
    }

    const profiles = this.getProfiles();
    const profiled = profiles[taskType];
    if (profiled) {
      return profiled;
    }

    console.warn(
      `[model-router] No profile for taskType '${taskType}', falling back to '${DEFAULT_MODEL}'.`
    );
    return DEFAULT_MODEL;
  }

  getFallbackChain(primaryModel) {
    const prim = primaryModel || DEFAULT_MODEL;
    const fallbacks = DEFAULT_FALLBACK_CHAIN.filter((model) => model !== prim);
    return [prim, ...fallbacks];
  }

  /**
   * Select a critic model that is (a) from a different family than the executor
   * and (b) has an available API key. Falls back through the chain until one
   * is found. Returns null if the only available model is the executor itself.
   *
   * @param {string} executorModel - Model ID the executor is using.
   * @param {(model: string) => boolean} hasKey - Sync check for key availability.
   * @returns {string|null}
   */
  getCriticModel(executorModel, hasKey) {
    if (!executorModel || typeof hasKey !== "function") {
      console.warn("[model-router] getCriticModel called with invalid arguments");
      return null;
    }
    const CRITIC_PREFERENCES = {
      "gpt-": "claude-sonnet-4-6-20250514",
      "claude-": "gemini-2.5-pro",
      "gemini-": "gpt-5.4",
      "grok-": "claude-sonnet-4-6-20250514",
      "qwen": "gemini-2.5-flash",
      "sonar": "gpt-5.4-mini"
    };

    const executorFamily = Object.keys(CRITIC_PREFERENCES).find((prefix) =>
      executorModel.startsWith(prefix)
    );

    // Try the preferred cross-family critic first
    if (executorFamily) {
      const preferred = CRITIC_PREFERENCES[executorFamily];
      if (preferred !== executorModel && hasKey(preferred)) {
        return preferred;
      }
    }

    // Walk the fallback chain for any model from a different family
    const chain = this.getFallbackChain(executorModel);
    for (const candidate of chain) {
      if (candidate === executorModel) continue;
      const sameFamily =
        executorFamily && candidate.startsWith(executorFamily);
      if (!sameFamily && hasKey(candidate)) {
        return candidate;
      }
    }

    // Degraded: same family, different model (e.g. gpt-5.4-mini critiquing gpt-5.4)
    for (const candidate of chain) {
      if (candidate === executorModel) continue;
      if (hasKey(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

export const TASK_TYPES = ACTIVITY_ORDER;
