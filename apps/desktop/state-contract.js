export const WORKSPACE_STATE_DEFAULTS = Object.freeze({
  modelCache: {},
  conversations: [],
  activeConversationId: null,
  memory: {
    enabled: true,
    autoCapture: true,
    count: 0,
    pinned: 0,
    recent: []
  },
  desktopCommander: {
    enabled: true,
    lookeenPath: "",
    outlookPath: ""
  },
  mcpServers: [],
  mcpStatuses: [],
  sandboxStatus: null,
  suggestedFilesystemRoot: "",
  suggestedDocumentOpsRoot: "",
  policyProfile: "assist",
  policyProfiles: [],
  messaging: {
    enabled: false,
    channel: "telegram",
    hasToken: false,
    allowedChatIds: []
  }
});

export function buildRuntimeMetadata({ isPackaged, appPath, userDataPath, configPath }) {
  return {
    launchMode: isPackaged ? "packaged" : "source",
    appPath,
    userDataPath,
    configPath
  };
}

export function formatRuntimeDiagnostics(runtime) {
  if (!runtime) {
    return "";
  }
  const modeLabel = runtime.launchMode === "packaged" ? "Packaged app" : "Source app";
  const location = runtime.appPath ? ` from ${runtime.appPath}` : "";
  const config = runtime.configPath ? ` | Config: ${runtime.configPath}` : "";
  return `Runtime: ${modeLabel}${location}${config}`;
}

export function buildBootstrapState({
  providers,
  keyStatus,
  modelProfiles,
  taskTypes,
  activityProfiles,
  executionMode,
  sandboxPreference,
  theme,
  themeIds,
  runtime
}) {
  return {
    providers,
    keyStatus,
    modelProfiles,
    taskTypes,
    activityProfiles,
    executionMode,
    sandboxPreference,
    theme,
    themeIds,
    runtime
  };
}

export function buildWorkspaceState(workspace = {}) {
  return {
    ...WORKSPACE_STATE_DEFAULTS,
    ...workspace,
    modelCache: workspace.modelCache ?? WORKSPACE_STATE_DEFAULTS.modelCache,
    conversations: workspace.conversations ?? WORKSPACE_STATE_DEFAULTS.conversations,
    activeConversationId: workspace.activeConversationId ?? WORKSPACE_STATE_DEFAULTS.activeConversationId,
    memory: {
      ...WORKSPACE_STATE_DEFAULTS.memory,
      ...(workspace.memory ?? {})
    },
    desktopCommander: {
      ...WORKSPACE_STATE_DEFAULTS.desktopCommander,
      ...(workspace.desktopCommander ?? {})
    },
    mcpServers: workspace.mcpServers ?? WORKSPACE_STATE_DEFAULTS.mcpServers,
    mcpStatuses: workspace.mcpStatuses ?? WORKSPACE_STATE_DEFAULTS.mcpStatuses,
    sandboxStatus: workspace.sandboxStatus ?? WORKSPACE_STATE_DEFAULTS.sandboxStatus,
    suggestedFilesystemRoot:
      workspace.suggestedFilesystemRoot ?? WORKSPACE_STATE_DEFAULTS.suggestedFilesystemRoot,
    suggestedDocumentOpsRoot:
      workspace.suggestedDocumentOpsRoot ?? WORKSPACE_STATE_DEFAULTS.suggestedDocumentOpsRoot,
    policyProfile: workspace.policyProfile ?? WORKSPACE_STATE_DEFAULTS.policyProfile,
    policyProfiles: workspace.policyProfiles ?? WORKSPACE_STATE_DEFAULTS.policyProfiles,
    messaging: {
      ...WORKSPACE_STATE_DEFAULTS.messaging,
      ...(workspace.messaging ?? {})
    }
  };
}

export function mergeAssistantState(bootstrapState, workspaceState = {}) {
  return {
    ...buildWorkspaceState(workspaceState),
    ...(bootstrapState ?? {})
  };
}
