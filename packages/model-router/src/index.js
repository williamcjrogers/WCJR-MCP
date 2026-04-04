import { ACTIVITY_ORDER, getDefaultModelProfiles } from "@wcjr/activity-profiles";

export { DEFAULT_MODEL_TIERS, resolveModelForPhase } from "./tiers.js";

const DEFAULT_MODEL_PROFILES = getDefaultModelProfiles();

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
    return profiles[taskType] ?? "gpt-5.4-pro";
  }

  getFallbackChain(primaryModel) {
    const noAnthropic = (m) => m && !String(m).toLowerCase().startsWith("claude");
    const prim = noAnthropic(primaryModel) ? primaryModel : "gpt-5.4-pro";
    const fallbacks = [
      "gpt-5.4-pro",
      "gpt-5.4",
      "grok-4.20-multi-agent-0309",
      "grok-4-fast-reasoning",
      "gemini-3.1-pro-preview-customtools",
      "gemini-3.1-pro-preview"
    ].filter(
      (model) => model !== prim && noAnthropic(model)
    );
    return [prim, ...fallbacks];
  }
}

export const TASK_TYPES = ACTIVITY_ORDER;
