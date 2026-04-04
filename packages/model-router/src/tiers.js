import { ACTIVITY_PROFILES } from "@wcjr/activity-profiles";

/** @type { Record<string, string[]> } */
export const DEFAULT_MODEL_TIERS = {
  quick: ["gpt-5.4-mini", "grok-3-mini", "gemini-2.5-flash"],
  standard: ["gpt-5.4", "grok-4-fast-reasoning", "gemini-3.1-pro-preview"],
  forensic: ["gpt-5.4-pro", "grok-4.20-multi-agent-0309", "gemini-3.1-pro-preview-customtools"]
};

/**
 * Resolve which model id to use for one workflow phase.
 * Precedence: explicit phase.model > UI override > tier list (by depth) > activity profile default via ModelRouter.
 *
 * @param { object } opts
 * @param { string } opts.activityId
 * @param { string } [opts.depth]
 * @param { string } [opts.explicitModel] from plan phase.model
 * @param { string } [opts.uiOverride] global model override from UI (applies when phase has no explicit model)
 * @param { import("./index.js").ModelRouter } opts.modelRouter
 * @param { Record<string, string[]> } [opts.modelTiers]
 */
export function resolveModelForPhase({
  activityId,
  depth = "standard",
  explicitModel,
  uiOverride,
  modelRouter,
  modelTiers = DEFAULT_MODEL_TIERS
}) {
  if (typeof explicitModel === "string" && explicitModel.trim()) {
    return explicitModel.trim();
  }
  if (typeof uiOverride === "string" && uiOverride.trim()) {
    return uiOverride.trim();
  }

  const tierKey = ["quick", "standard", "forensic"].includes(depth) ? depth : "standard";
  const tierList = modelTiers?.[tierKey] ?? modelTiers?.standard ?? DEFAULT_MODEL_TIERS.standard;

  if (Array.isArray(tierList) && tierList.length > 0) {
    return tierList[0];
  }

  const prof = ACTIVITY_PROFILES[activityId];
  if (prof?.defaultModel) {
    return prof.defaultModel;
  }

  return modelRouter.selectModel(activityId, null);
}
