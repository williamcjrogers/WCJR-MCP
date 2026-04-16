const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantApi", {
  getState: () => ipcRenderer.invoke("assistant:getState"),
  getBootstrapState: () => ipcRenderer.invoke("assistant:getBootstrapState"),
  getWorkspaceState: () => ipcRenderer.invoke("assistant:getWorkspaceState"),
  connectMcp: () => ipcRenderer.invoke("assistant:connectMcp"),
  runTask: (payload) => ipcRenderer.invoke("assistant:runTask", payload),
  approvePlan: (payload) => ipcRenderer.invoke("assistant:approvePlan", payload),
  updateModelProfiles: (payload) => ipcRenderer.invoke("assistant:updateModelProfiles", payload),
  setMcpServers: (payload) => ipcRenderer.invoke("assistant:setMcpServers", payload),
  pickDirectory: () => ipcRenderer.invoke("assistant:pickDirectory"),
  pickExecutable: () => ipcRenderer.invoke("assistant:pickExecutable"),
  saveApiKeys: (payload) => ipcRenderer.invoke("assistant:saveApiKeys", payload),
  getKeyStatus: () => ipcRenderer.invoke("assistant:getKeyStatus"),
  listModels: (provider) => ipcRenderer.invoke("assistant:listModels", provider),
  listAllModels: () => ipcRenderer.invoke("assistant:listAllModels"),
  onStreamChunk: (callback) => {
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on("assistant:streamChunk", handler);
    return () => ipcRenderer.removeListener("assistant:streamChunk", handler);
  },
  onStreamDone: (callback) => {
    const handler = (_event, result) => callback(result);
    ipcRenderer.on("assistant:streamDone", handler);
    return () => ipcRenderer.removeListener("assistant:streamDone", handler);
  },
  onStreamError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("assistant:streamError", handler);
    return () => ipcRenderer.removeListener("assistant:streamError", handler);
  },
  newConversation: (payload) => ipcRenderer.invoke("assistant:newConversation", payload),
  getConversation: (conversationId) => ipcRenderer.invoke("assistant:getConversation", conversationId),
  setActiveConversation: (conversationId) => ipcRenderer.invoke("assistant:setActiveConversation", conversationId),
  getMemories: (filters) => ipcRenderer.invoke("assistant:getMemories", filters),
  setMemorySettings: (payload) => ipcRenderer.invoke("assistant:setMemorySettings", payload),
  setDesktopCommanderConfig: (payload) => ipcRenderer.invoke("assistant:setDesktopCommanderConfig", payload),
  taskList: (filters) => ipcRenderer.invoke("assistant:taskList", filters),
  getTask: (taskId) => ipcRenderer.invoke("assistant:getTask", taskId),
  cancelTask: (taskId) => ipcRenderer.invoke("assistant:cancelTask", taskId),
  clearTasks: () => ipcRenderer.invoke("assistant:clearTasks"),
  getAuditTrail: (filters) => ipcRenderer.invoke("assistant:getAuditTrail", filters),
  getPolicy: () => ipcRenderer.invoke("assistant:getPolicy"),
  setPolicy: (payload) => ipcRenderer.invoke("assistant:setPolicy", payload),
  onTaskUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("assistant:taskUpdated", handler);
    return () => ipcRenderer.removeListener("assistant:taskUpdated", handler);
  },
  onConversationUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("assistant:conversationUpdated", handler);
    return () => ipcRenderer.removeListener("assistant:conversationUpdated", handler);
  },
  onMemoryUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("assistant:memoryUpdated", handler);
    return () => ipcRenderer.removeListener("assistant:memoryUpdated", handler);
  },
  runMicrosoft365DeviceCode: (payload) => ipcRenderer.invoke("assistant:runMicrosoft365DeviceCode", payload),
  hasMailCalendarConfig: () => ipcRenderer.invoke("assistant:hasMailCalendarConfig"),
  setMessagingConfig: (payload) => ipcRenderer.invoke("assistant:setMessagingConfig", payload),
  setSandboxPreference: (value) => ipcRenderer.invoke("assistant:setSandboxPreference", value),
  setTheme: (themeId) => ipcRenderer.invoke("assistant:setTheme", themeId),
  onRemoteCommand: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("assistant:remoteCommand", handler);
    return () => ipcRenderer.removeListener("assistant:remoteCommand", handler);
  },
  onDeviceCodeMessage: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("assistant:deviceCodeMessage", handler);
    return () => ipcRenderer.removeListener("assistant:deviceCodeMessage", handler);
  },
  onN8nTrigger: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("assistant:n8nTrigger", handler);
    return () => ipcRenderer.removeListener("assistant:n8nTrigger", handler);
  },
  getKnowledgeCollections: () => ipcRenderer.invoke("assistant:getKnowledgeCollections"),
  ingestToKnowledge: (payload) => ipcRenderer.invoke("assistant:ingestToKnowledge", payload),
  deleteFromKnowledge: (payload) => ipcRenderer.invoke("assistant:deleteFromKnowledge", payload),
  getSkills: (filters) => ipcRenderer.invoke("assistant:getSkills", filters),
  getSkill: (skillId) => ipcRenderer.invoke("assistant:getSkill", skillId),
  reloadSkills: () => ipcRenderer.invoke("assistant:reloadSkills"),
  getLogs: (options) => ipcRenderer.invoke("assistant:getLogs", options),
  revealArtifact: (absolutePath) => ipcRenderer.invoke("shell:revealArtifact", absolutePath)
});
