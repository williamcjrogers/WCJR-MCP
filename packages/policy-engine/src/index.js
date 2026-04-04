/**
 * Policy and approval engine for the operations assistant.
 * Named profiles: Observe, Assist, Scoped Autonomy, High Autonomy.
 */

import { z } from "zod";

export const POLICY_PROFILES = {
  observe: "observe",
  assist: "assist",
  scoped_autonomy: "scoped_autonomy",
  high_autonomy: "high_autonomy"
};

export const ACTION_TYPES = {
  read: "read",
  draft: "draft",
  edit: "edit",
  move: "move",
  delete: "delete",
  launch_application: "launch_application",
  clipboard_write: "clipboard_write",
  browser_fetch: "browser_fetch",
  send_email: "send_email",
  send_message: "send_message",
  calendar_create: "calendar_create",
  calendar_update: "calendar_update",
  file_write: "file_write",
  external_send: "external_send",
  bulk_change: "bulk_change"
};

const RISK_LEVEL = {
  low: "low",
  medium: "medium",
  high: "high"
};

function riskForAction(actionType, context = {}) {
  switch (actionType) {
    case ACTION_TYPES.read:
      return RISK_LEVEL.low;
    case ACTION_TYPES.browser_fetch:
      return context.internalTarget ? RISK_LEVEL.high : RISK_LEVEL.low;
    case ACTION_TYPES.draft:
      return RISK_LEVEL.low;
    case ACTION_TYPES.edit:
    case ACTION_TYPES.file_write:
      return context.destructive ? RISK_LEVEL.high : RISK_LEVEL.medium;
    case ACTION_TYPES.move:
      return RISK_LEVEL.medium;
    case ACTION_TYPES.delete:
      return RISK_LEVEL.high;
    case ACTION_TYPES.launch_application:
      return context.approvedApp ? RISK_LEVEL.medium : RISK_LEVEL.high;
    case ACTION_TYPES.clipboard_write:
      return RISK_LEVEL.medium;
    case ACTION_TYPES.send_email:
    case ACTION_TYPES.send_message:
    case ACTION_TYPES.external_send:
      return context.newRecipient ? RISK_LEVEL.high : RISK_LEVEL.medium;
    case ACTION_TYPES.calendar_create:
    case ACTION_TYPES.calendar_update:
      return RISK_LEVEL.medium;
    case ACTION_TYPES.bulk_change:
      return RISK_LEVEL.high;
    default:
      return RISK_LEVEL.medium;
  }
}

/**
 * Returns "allow" | "deny" | "confirm".
 * - allow: proceed without user confirmation
 * - deny: block the action
 * - confirm: require explicit user approval before proceeding
 */
export function evaluateAction(profile, actionType, context = {}) {
  const risk = riskForAction(actionType, context);
  const inApprovedScope = context.approvedFolder === true || context.approvedApp === true;

  switch (profile) {
    case POLICY_PROFILES.observe:
      return actionType === ACTION_TYPES.read ? "allow" : "deny";

    case POLICY_PROFILES.assist:
      if (actionType === ACTION_TYPES.read || actionType === ACTION_TYPES.draft) {
        return "allow";
      }
      return "confirm";

    case POLICY_PROFILES.scoped_autonomy:
      if (actionType === ACTION_TYPES.read || actionType === ACTION_TYPES.draft) {
        return "allow";
      }
      if (inApprovedScope && risk !== RISK_LEVEL.high) {
        return "allow";
      }
      if (risk === RISK_LEVEL.high || !inApprovedScope) {
        return "confirm";
      }
      return "allow";

    case POLICY_PROFILES.high_autonomy:
      if (actionType === ACTION_TYPES.read || actionType === ACTION_TYPES.draft) {
        return "allow";
      }
      if (risk === RISK_LEVEL.high) {
        return "confirm";
      }
      return "allow";

    default:
      return "confirm";
  }
}

export const PolicyEngineSchema = z.object({
  profile: z.enum(Object.values(POLICY_PROFILES)),
  approvedFolders: z.array(z.string()).optional().default([]),
  approvedApps: z.array(z.string()).optional().default([])
});

export class PolicyEngine {
  constructor(config = {}) {
    const parsed = PolicyEngineSchema.safeParse(config);
    this.profile = parsed.success ? parsed.data.profile : POLICY_PROFILES.assist;
    this.approvedFolders = parsed.success ? parsed.data.approvedFolders : [];
    this.approvedApps = parsed.success ? parsed.data.approvedApps : [];
  }

  setProfile(profile) {
    if (Object.values(POLICY_PROFILES).includes(profile)) {
      this.profile = profile;
    }
  }

  check(actionType, context = {}) {
    context.approvedFolder = this.approvedFolders.some(
      (f) => {
        // Separator-boundary check: prevent /docs-evil matching /docs
        const sep = (f.endsWith("/") || f.endsWith("\\")) ? "" : "/";
        const prefix = (f + sep).replace(/\\/g, "/");
        const fp = (context.folderPath ?? "").replace(/\\/g, "/");
        const p  = (context.path ?? "").replace(/\\/g, "/");
        return fp === prefix.slice(0, -1) || fp.startsWith(prefix)
            || p  === prefix.slice(0, -1) || p.startsWith(prefix);
      }
    );
    context.approvedApp = this.approvedApps.some(
      (app) => context.appId === app || context.channel === app
    );
    return evaluateAction(this.profile, actionType, context);
  }

  isReadOnly() {
    return this.profile === POLICY_PROFILES.observe;
  }
}
