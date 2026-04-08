import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import http from "node:http";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  ACTIVITY_ORDER,
  ACTIVITY_PROFILES,
  getDefaultModelProfiles,
  getVisibleSkillDefinitions,
  getMcpPresetDefinitions,
  resolveSkillDefinition
} from "@wcjr/activity-profiles";
import { PROVIDERS, PROVIDER_IDS, getAdapter, resolveProvider } from "@wcjr/providers";
import { Orchestrator, normalizeExecutionPlan, buildExecutionBatches } from "@wcjr/orchestrator";
import { resolveModelForPhase, DEFAULT_MODEL_TIERS } from "@wcjr/model-router";
import { TaskStore, TASK_STATUS } from "@wcjr/task-store";
import { ConversationStore } from "@wcjr/conversation-store";
import { MemoryStore } from "@wcjr/memory-store";
import { PolicyEngine, POLICY_PROFILES, ACTION_TYPES } from "@wcjr/policy-engine";
import { createChannel } from "@wcjr/messaging-bridge";
import {
  clearToolNameRegistry,
  mcpToolsToGeminiFunctions,
  mcpToolsToOpenAIFunctions,
  runToolLoop
} from "@wcjr/tool-loop";
import { buildTelegramManagerFallback, buildTelegramManagerText } from "./telegram-manager.js";
import {
  buildBootstrapState,
  buildRuntimeMetadata,
  buildWorkspaceState,
  mergeAssistantState
} from "./state-contract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG = {
  apiKeys: {},
  modelProfiles: getDefaultModelProfiles(),
  /** Per-depth default model ids (first match wins before activity default). Editable in assistant-config.json. */
  modelTiers: { ...DEFAULT_MODEL_TIERS },
  modelCache: {},
  mcpServers: [],
  executionMode: "plan_first",
  sandbox: {
    distro: "Ubuntu-24.04",
    gatewayName: "nemoclaw",
    sandboxName: "wcjr",
    agentId: "main"
  },
  sandboxPreference: "manual",
  policy: {
    profile: "assist",
    approvedFolders: [],
    approvedApps: []
  },
  messaging: {
    enabled: false,
    channel: "telegram",
    botToken: "",
    allowedChatIds: [],
    wahaUrl: "http://localhost:3000",
    wahaApiKey: "",
    wahaHmacSecret: "",
    wahaSession: "default"
  },
  desktopCommander: {
    enabled: true,
    apps: {
      outlook: {
        displayName: "Outlook",
        path: ""
      },
      lookeen: {
        displayName: "Lookeen",
        path: ""
      }
    }
  },
  memory: {
    enabled: true,
    autoCapture: true
  },
  theme: "midnight",
  activeConversationId: null
};

const PROFILE_TASK_TYPES = new Set(ACTIVITY_ORDER);
const MODEL_TIER_KEYS = ["quick", "standard", "forensic"];
const PREFERRED_PROFILE_PROVIDERS = new Set(["openai", "grok", "gemini", "anthropic", "perplexity", "ollama"]);

function isSelectableModelId(modelId) {
  const providerId = resolveProvider(modelId);
  return Boolean(providerId && PREFERRED_PROFILE_PROVIDERS.has(providerId));
}

function sanitizeModelList(models = []) {
  const seen = new Set();
  const next = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || !isSelectableModelId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push({
      id,
      name: typeof model?.name === "string" && model.name.trim() ? model.name.trim() : id
    });
  }
  return next;
}

function sanitizeModelCache(modelCache = {}) {
  const next = {};
  for (const [providerId, models] of Object.entries(modelCache ?? {})) {
    const filtered = sanitizeModelList(models);
    if (filtered.length) {
      next[providerId] = filtered;
    }
  }
  return next;
}

function sanitizeModelProfiles(modelProfiles = {}) {
  const next = {};
  for (const [taskType, modelId] of Object.entries(modelProfiles ?? {})) {
    if (!PROFILE_TASK_TYPES.has(taskType)) {
      continue;
    }
    const candidate = typeof modelId === "string" ? modelId.trim() : "";
    if (!candidate || !isSelectableModelId(candidate)) {
      continue;
    }
    next[taskType] = candidate;
  }
  return next;
}

function hydrateModelProfiles(modelProfiles = {}) {
  return {
    ...getDefaultModelProfiles(),
    ...sanitizeModelProfiles(modelProfiles)
  };
}

function sanitizeModelTiers(modelTiers = {}) {
  const defaults = { ...DEFAULT_MODEL_TIERS };
  const next = {};
  for (const tierKey of MODEL_TIER_KEYS) {
    const requested = Array.isArray(modelTiers?.[tierKey]) ? modelTiers[tierKey] : defaults[tierKey];
    const filtered = requested
      .map((modelId) => (typeof modelId === "string" ? modelId.trim() : ""))
      .filter((modelId, index, arr) => modelId && isSelectableModelId(modelId) && arr.indexOf(modelId) === index);
    next[tierKey] = filtered.length ? filtered : defaults[tierKey];
  }
  return next;
}

let mainWindow;
let appConfig;
let orchestrator;
let taskStore;
let conversationStore;
let memoryStore;
let policyEngine;
let messagingBridge;
let configSaveQueue = Promise.resolve();
// chatId (number) → { taskId, conversationId } for plan approval via Telegram
const pendingTelegramPlans = new Map();
let _approvePlanImpl = async () => { throw new Error("approvePlan not yet initialized"); };
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const startupLogPath = path.join(
  process.env.TEMP || process.cwd(),
  "wcjr-assistant-startup.log"
);

if (!gotSingleInstanceLock) {
  app.quit();
}

const MCP_SERVER_SCHEMA = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  kind: z.enum([
    "builtin-filesystem", "builtin-document-ops", "builtin-file-ops", "builtin-mail-calendar",
    "builtin-browser-ops", "builtin-memory", "builtin-desktop-commander", "builtin-shell-exec",
    "builtin-git-ops", "builtin-qdrant-rag", "builtin-xlsx-engine", "builtin-docx-engine",
    "catalog-brave-search", "catalog-github", "catalog-notion", "catalog-slack",
    "catalog-stripe", "catalog-supabase", "catalog-neon", "catalog-cloudflare", "catalog-vercel",
    "catalog-mongodb", "catalog-asana", "catalog-playwright", "catalog-home-assistant",
    "catalog-aws", "catalog-sentry", "catalog-docker", "catalog-tavily", "catalog-exa",
    "catalog-context7", "catalog-firecrawl", "catalog-linear", "catalog-todoist", "catalog-jira",
    "catalog-huggingface", "catalog-sequential-thinking",
    "custom"
  ]).optional().default("custom"),
  transport: z.enum(["stdio", "streamable-http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  authToken: z.string().optional(),
  rootPath: z.string().optional(),
  roots: z.array(z.string()).optional(),
  allowAnyPath: z.boolean().optional()
});

function configPath() {
  return path.join(app.getPath("userData"), "assistant-config.json");
}

function logStartup(message, error) {
  const detail = error
    ? `${message}\n${error.stack ?? error.message ?? String(error)}`
    : message;
  const line = `[${new Date().toISOString()}] ${detail}\n`;
  try {
    fsSync.appendFileSync(startupLogPath, line, "utf-8");
  } catch {
    // Ignore logging failures.
  }
}

function filesystemServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "filesystem-mcp", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "filesystem-mcp", "src", "server.js");
}

function documentOpsServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "document-ops", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "document-ops", "src", "server.js");
}

function browserOpsServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "browser-ops", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "browser-ops", "src", "server.js");
}

function fileOpsServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "file-ops", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "file-ops", "src", "server.js");
}

function mailCalendarServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "mail-calendar", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "mail-calendar", "src", "server.js");
}

function mailCalendarConfigPath() {
  return path.join(app.getPath("userData"), "mail-calendar-config.json");
}

function memoryStorePath() {
  return path.join(app.getPath("userData"), "memory-store.json");
}

function desktopCommanderConfigPath() {
  return configPath();
}

function desktopCommanderServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "desktop-commander", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "desktop-commander", "src", "server.js");
}


function shellExecServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "shell-exec", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "shell-exec", "src", "server.js");
}

function gitOpsServerScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "git-ops", "server.js");
  }
  return path.resolve(__dirname, "..", "..", "packages", "git-ops", "src", "server.js");
}

function detectLookeenPath() {
  const candidates = [
    "C:\\Program Files\\Lookeen\\Lookeen.exe",
    "C:\\Program Files (x86)\\Lookeen\\Lookeen.exe"
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? "";
}

function detectLookeenMcpPath() {
  const candidates = [
    "C:\\Program Files\\Lookeen\\Desktop\\mcp.exe",
    "C:\\Program Files (x86)\\Lookeen\\Desktop\\mcp.exe"
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? "";
}

function detectOutlookPath() {
  const candidates = [
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE",
    "C:\\Program Files\\Microsoft Office\\Office16\\OUTLOOK.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\Office16\\OUTLOOK.EXE"
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? "";
}

function normalizeRoots(server, fallbackRoot) {
  const roots = Array.isArray(server?.roots) && server.roots.length > 0
    ? server.roots
    : [server?.rootPath || fallbackRoot];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function builtinServerProcessConfig(packageFolder, args = []) {
  if (app.isPackaged) {
    const scriptPath = path.join(app.getAppPath(), "packages", packageFolder, "src", "server.js");
    return {
      command: "node",
      args: [scriptPath, ...args],
      cwd: app.getAppPath()
    };
  }

  return {
    command: "node",
    args: [path.resolve(__dirname, "..", "..", "packages", packageFolder, "src", "server.js"), ...args],
    cwd: path.resolve(__dirname, "..", "..")
  };
}

function extractCandidateMemories(text = "") {
  const candidates = [];
  const rules = [
    { regex: /\bmy name is ([^.!\n]+)/i, category: "profile", tags: ["name"], format: (value) => `User's name is ${value}` },
    { regex: /\bcall me ([^.!\n]+)/i, category: "profile", tags: ["name"], format: (value) => `User prefers to be called ${value}` },
    { regex: /\bmy company is ([^.!\n]+)/i, category: "company", tags: ["company"], format: (value) => `User's company is ${value}` },
    { regex: /\bI work (?:at|for) ([^.!\n]+)/i, category: "company", tags: ["company"], format: (value) => `User works at ${value}` },
    { regex: /\bI prefer ([^.!\n]+)/i, category: "preference", tags: ["preference"], format: (value) => `User prefers ${value}` },
    { regex: /\bmy preferred ([^.!\n]+?) is ([^.!\n]+)/i, category: "preference", tags: ["preference"], format: (value, _, match) => `User's preferred ${match[1].trim()} is ${match[2].trim()}` },
    { regex: /\bmy timezone is ([^.!\n]+)/i, category: "preference", tags: ["timezone"], format: (value) => `User's timezone is ${value}` },
    { regex: /\bremember that ([^.!\n]+)/i, category: "instruction", tags: ["remember"], format: (value) => value },
    { regex: /\bplease remember that ([^.!\n]+)/i, category: "instruction", tags: ["remember"], format: (value) => value },
    { regex: /\bdon't forget that ([^.!\n]+)/i, category: "instruction", tags: ["remember"], format: (value) => value },
    { regex: /\bwe use ([^.!\n]+)/i, category: "workflow", tags: ["tools"], format: (value) => `User's team uses ${value}` },
    { regex: /\balways ([^.!\n]+)/i, category: "workflow", tags: ["instruction"], format: (value) => `User wants the assistant to always ${value}` },
    { regex: /\bavoid ([^.!\n]+)/i, category: "preference", tags: ["avoid"], format: (value) => `User prefers to avoid ${value}` }
  ];

  for (const rule of rules) {
    const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
    const regex = new RegExp(rule.regex.source, flags);
    for (const match of text.matchAll(regex)) {
      const value = match[1]?.trim();
      if (!value) continue;
      candidates.push({
        category: rule.category,
        content: rule.format(value, text, match),
        tags: rule.tags
      });
    }
  }

  return candidates;
}

function buildMemoryContext(memories = []) {
  if (!memories.length) return "";
  return memories
    .map((memory) => `- [${memory.category}] ${memory.content}`)
    .join("\n");
}

function compactWorkflowText(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractPromptPathHints(prompt = "") {
  const seen = new Set();
  const patterns = [
    /`([^`]+)`/g,
    /"([A-Za-z]:\\[^"]+)"/g,
    /'([A-Za-z]:\\[^']+)'/g,
    /([A-Za-z]:\\[^\s"'`]+)/g,
    /([.]{1,2}[\\/][^\s"'`]+)/g
  ];

  for (const pattern of patterns) {
    for (const match of String(prompt ?? "").matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        seen.add(candidate);
      }
    }
  }

  return [...seen].slice(0, 4);
}

function shouldAutoExecuteDeterministicPrompt(prompt = "", taskType, executionMode) {
  if (taskType !== "orchestrator" || executionMode !== "plan_first") {
    return false;
  }

  const hasExplicitPath = extractPromptPathHints(prompt).length > 0;
  if (!hasExplicitPath) {
    return false;
  }

  const text = String(prompt ?? "");
  const readOnlyIntent =
    /\b(review|summari[sz]e|inspect|check|find|search|compare|list|show|analy[sz]e|read|open)\b/i.test(text);
  const mutatingIntent =
    /\b(write|edit|change|modify|delete|move|rename|send|draft|create|update|apply|patch|fix|refactor|amend|redraft)\b/i.test(text);

  return readOnlyIntent && !mutatingIntent;
}

function stripWcjrPlanBlock(content = "") {
  return String(content ?? "")
    .replace(/```wcjr-plan\s*[\s\S]*?```/gi, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getActivityLabel(activityId) {
  return ACTIVITY_PROFILES[activityId]?.label ?? activityId ?? "Unknown";
}

function buildPhasePromptPreview(prompt = "", maxChars = 180) {
  const compact = compactWorkflowText(prompt);
  if (!compact) {
    return "";
  }
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildWorkflowPreview(executionPlan) {
  const normalized = normalizeExecutionPlan(executionPlan);
  if (!normalized?.phases?.length) {
    return null;
  }

  return {
    summary: normalized.summary ?? "",
    runMode: normalized.runMode ?? "direct",
    phaseCount: normalized.phases.length,
    phases: normalized.phases.map((phase) => ({
      id: phase.id,
      title: phase.title ?? getActivityLabel(phase.activity),
      activity: phase.activity,
      activityLabel: getActivityLabel(phase.activity),
      depth: phase.depth ?? "standard",
      model: phase.model ?? null,
      parallelGroup: phase.parallelGroup ?? 0,
      dependsOn: Array.isArray(phase.dependsOn) ? phase.dependsOn : [],
      approvalRequired: phase.approvalRequired === true,
      promptPreview: buildPhasePromptPreview(phase.prompt)
    }))
  };
}

function buildWorkflowState(executionPlan, status = "awaiting_approval") {
  const preview = buildWorkflowPreview(executionPlan);
  if (!preview) {
    return null;
  }

  return {
    ...preview,
    status,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    failedPhaseId: null,
    phases: preview.phases.map((phase) => ({
      ...phase,
      status: "pending",
      taskId: null,
      runMode: null,
      provider: null,
      modelUsed: null,
      startedAt: null,
      completedAt: null,
      error: null,
      outputPreview: ""
    }))
  };
}

function updateWorkflowPhaseState(workflow, phaseId, updates = {}) {
  if (!workflow?.phases?.length) {
    return workflow ?? null;
  }

  return {
    ...workflow,
    ...updates,
    phases: workflow.phases.map((phase) =>
      phase.id === phaseId ? { ...phase, ...updates.phaseUpdates } : phase
    )
  };
}

function setWorkflowPhaseData(workflow, phaseId, phaseUpdates = {}, workflowUpdates = {}) {
  if (!workflow?.phases?.length) {
    return workflow ?? null;
  }

  return {
    ...workflow,
    ...workflowUpdates,
    phases: workflow.phases.map((phase) =>
      phase.id === phaseId ? { ...phase, ...phaseUpdates } : phase
    )
  };
}

function buildWorkflowCompletionContent(workflow, phaseResults = []) {
  if (!phaseResults.length) {
    return "Workflow completed.";
  }

  if (phaseResults.length === 1) {
    return phaseResults[0]?.summary?.content ?? "Workflow completed.";
  }

  return [
    `Workflow completed across ${phaseResults.length} phases.`,
    "",
    ...phaseResults.map((item) => [
      `### ${item.phase.title ?? getActivityLabel(item.phase.activity)}`,
      "",
      item.summary?.content ?? "Completed."
    ].join("\n"))
  ].join("\n\n");
}

function buildActivityProfileState() {
  return ACTIVITY_ORDER.map((activityId) => {
    const profile = ACTIVITY_PROFILES[activityId];
    return {
      id: profile.id,
      label: profile.label,
      description: profile.description,
      defaultModel: profile.defaultModel,
      mcpPresets: getMcpPresetDefinitions(profile.mcpPresets).map((preset) => ({
        id: preset.id,
        label: preset.label,
        kind: preset.kind ?? null,
        serverNamePatterns: preset.serverNamePatterns ?? []
      })),
      recommendedSkills: getVisibleSkillDefinitions(profile.recommendedSkills).map((skill) => ({
        id: skill.id,
        label: skill.label,
        slashCommand: skill.slashCommand,
        description: skill.description
      })),
      specialistAgents: profile.specialistAgents
    };
  });
}

function parseSkillCommand(prompt) {
  const match = String(prompt).trim().match(/^\/([a-z0-9-]+)\b/i);
  if (!match) {
    return { skillId: null, prompt };
  }
  const commandId = match[1].toLowerCase();
  const skill = resolveSkillDefinition(commandId);
  if (!skill) {
    return { skillId: null, prompt };
  }
  const cleanedPrompt = String(prompt).replace(/^\/[a-z0-9-]+\b\s*/i, "").trim();
  return {
    skillId: skill.id,
    prompt: cleanedPrompt || prompt
  };
}

function hydrateMcpServer(server) {
  if (server.kind === "builtin-filesystem") {
    const roots = normalizeRoots(server, app.getPath("documents"));
    const allowAnyPath = server.allowAnyPath === true;
    return {
      name: server.name || "Local Filesystem",
      enabled: server.enabled !== false,
      kind: "builtin-filesystem",
      rootPath: roots[0],
      roots,
      allowAnyPath,
      transport: "stdio",
      ...builtinServerProcessConfig(
        "filesystem-mcp",
        [...roots.flatMap((root) => ["--root", root]), ...(allowAnyPath ? ["--allow-any-path"] : [])]
      )
    };
  }
  if (server.kind === "builtin-document-ops") {
    const rootPath = server.rootPath || path.join(app.getPath("documents"), "AssistantReports");
    return {
      name: server.name || "Documents & Reports",
      enabled: server.enabled !== false,
      kind: "builtin-document-ops",
      rootPath,
      transport: "stdio",
      ...builtinServerProcessConfig("document-ops", ["--root", rootPath])
    };
  }
  if (server.kind === "builtin-file-ops") {
    const roots = normalizeRoots(server, app.getPath("documents"));
    const allowAnyPath = server.allowAnyPath === true;
    return {
      name: server.name || "File organization",
      enabled: server.enabled !== false,
      kind: "builtin-file-ops",
      rootPath: roots[0],
      roots,
      allowAnyPath,
      transport: "stdio",
      ...builtinServerProcessConfig(
        "file-ops",
        [...roots.flatMap((root) => ["--root", root]), ...(allowAnyPath ? ["--allow-any-path"] : [])]
      )
    };
  }
  if (server.kind === "builtin-mail-calendar") {
    return {
      name: server.name || "Mail & Calendar (Microsoft 365)",
      enabled: server.enabled !== false,
      kind: "builtin-mail-calendar",
      transport: "stdio",
      ...builtinServerProcessConfig("mail-calendar", ["--config", mailCalendarConfigPath()]),
      env: buildMailCalendarServerEnv()
    };
  }
  if (server.kind === "builtin-browser-ops") {
    return {
      name: server.name || "Browser / Web fetch",
      enabled: server.enabled !== false,
      kind: "builtin-browser-ops",
      transport: "stdio",
      ...builtinServerProcessConfig("browser-ops")
    };
  }
  if (server.kind === "builtin-memory") {
    return {
      name: server.name || "Persistent Memory",
      enabled: server.enabled !== false,
      kind: "builtin-memory",
      transport: "stdio",
      ...builtinServerProcessConfig("memory-mcp", ["--store", memoryStorePath()])
    };
  }

  if (server.kind === "builtin-shell-exec") {
    const cwd = server.rootPath || app.getPath("documents");
    return {
      name: server.name || "Shell / Terminal",
      enabled: server.enabled !== false,
      kind: "builtin-shell-exec",
      rootPath: cwd,
      transport: "stdio",
      ...builtinServerProcessConfig("shell-exec", ["--cwd", cwd])
    };
  }
  if (server.kind === "builtin-git-ops") {
    const repo = server.rootPath || app.getPath("documents");
    return {
      name: server.name || "Git Operations",
      enabled: server.enabled !== false,
      kind: "builtin-git-ops",
      rootPath: repo,
      transport: "stdio",
      ...builtinServerProcessConfig("git-ops", ["--repo", repo])
    };
  }
  if (server.kind === "builtin-desktop-commander") {
    return {
      name: server.name || "Desktop Commander",
      enabled: server.enabled !== false,
      kind: "builtin-desktop-commander",
      transport: "stdio",
      ...builtinServerProcessConfig("desktop-commander", ["--config", desktopCommanderConfigPath()])
    };
  }
  if (server.kind === "builtin-qdrant-rag") {
    return {
      name: server.name || "Qdrant RAG",
      enabled: server.enabled !== false,
      kind: "builtin-qdrant-rag",
      transport: "stdio",
      ...builtinServerProcessConfig("qdrant-rag-mcp")
    };
  }
  if (server.kind === "builtin-xlsx-engine") {
    return {
      name: server.name || "Excel Engine",
      enabled: server.enabled !== false,
      kind: "builtin-xlsx-engine",
      transport: "stdio",
      ...builtinServerProcessConfig("xlsx-engine-mcp")
    };
  }
  if (server.kind === "builtin-docx-engine") {
    return {
      name: server.name || "Document Engine",
      enabled: server.enabled !== false,
      kind: "builtin-docx-engine",
      transport: "stdio",
      ...builtinServerProcessConfig("docx-engine-mcp")
    };
  }

  return {
    enabled: server.enabled !== false,
    kind: server.kind || "custom",
    ...server
  };
}

function dehydrateMcpServer(server) {
  if (server.kind === "builtin-filesystem") {
    const roots = normalizeRoots(server, app.getPath("documents"));
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-filesystem",
      rootPath: roots[0],
      roots,
      allowAnyPath: server.allowAnyPath === true
    };
  }
  if (server.kind === "builtin-document-ops") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-document-ops",
      rootPath: server.rootPath
    };
  }
  if (server.kind === "builtin-file-ops") {
    const roots = normalizeRoots(server, app.getPath("documents"));
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-file-ops",
      rootPath: roots[0],
      roots,
      allowAnyPath: server.allowAnyPath === true
    };
  }
  if (server.kind === "builtin-mail-calendar") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-mail-calendar"
    };
  }
  if (server.kind === "builtin-browser-ops") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-browser-ops"
    };
  }
  if (server.kind === "builtin-memory") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-memory"
    };
  }

  if (server.kind === "builtin-shell-exec") {
    return { name: server.name, enabled: server.enabled !== false, kind: "builtin-shell-exec", rootPath: server.rootPath };
  }
  if (server.kind === "builtin-git-ops") {
    return { name: server.name, enabled: server.enabled !== false, kind: "builtin-git-ops", rootPath: server.rootPath };
  }
  if (server.kind === "builtin-desktop-commander") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-desktop-commander"
    };
  }
  if (server.kind === "builtin-qdrant-rag") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-qdrant-rag"
    };
  }
  if (server.kind === "builtin-xlsx-engine") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-xlsx-engine"
    };
  }
  if (server.kind === "builtin-docx-engine") {
    return {
      name: server.name,
      enabled: server.enabled !== false,
      kind: "builtin-docx-engine"
    };
  }

  return {
    name: server.name,
    enabled: server.enabled !== false,
    kind: server.kind || "custom",
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    env: server.env,
    url: server.url,
    authToken: server.authToken
  };
}

const THEME_IDS = [
  "midnight",
  "charcoal",
  "slate",
  "ocean",
  "lavender",
  "meritus-via",
  "light",
  "paper",
  "high-contrast"
];

function isValidTheme(value) {
  return typeof value === "string" && THEME_IDS.includes(value);
}

function hydrateConfig(config) {
  const hydrated = {
    ...DEFAULT_CONFIG,
    ...config,
    modelProfiles: hydrateModelProfiles(config?.modelProfiles ?? DEFAULT_CONFIG.modelProfiles),
    sandbox: {
      ...DEFAULT_CONFIG.sandbox,
      ...(config?.sandbox ?? {})
    },
    sandboxPreference: config?.sandboxPreference ?? DEFAULT_CONFIG.sandboxPreference,
    policy: {
      ...DEFAULT_CONFIG.policy,
      ...(config?.policy ?? {})
    },
    messaging: hydrateMessagingConfig(config?.messaging ?? {}),
    desktopCommander: {
      ...DEFAULT_CONFIG.desktopCommander,
      ...(config?.desktopCommander ?? {}),
      apps: {
        ...DEFAULT_CONFIG.desktopCommander.apps,
        ...(config?.desktopCommander?.apps ?? {})
      }
    },
    memory: {
      ...DEFAULT_CONFIG.memory,
      ...(config?.memory ?? {})
    },
    modelTiers: sanitizeModelTiers(config?.modelTiers ?? DEFAULT_CONFIG.modelTiers),
    modelCache: sanitizeModelCache(config?.modelCache ?? DEFAULT_CONFIG.modelCache),
    theme: isValidTheme(config?.theme) ? config.theme : DEFAULT_CONFIG.theme,
    mcpServers: (config?.mcpServers ?? DEFAULT_CONFIG.mcpServers).map(hydrateMcpServer)
  };
  if (!hydrated.desktopCommander.apps.lookeen.path) {
    hydrated.desktopCommander.apps.lookeen.path = detectLookeenPath();
  }
  if (!hydrated.desktopCommander.apps.outlook.path) {
    hydrated.desktopCommander.apps.outlook.path = detectOutlookPath();
  }
  return hydrated;
}

function getDefaultMcpServers() {
  const documentsPath = app.getPath("documents");
  const reportsPath = path.join(documentsPath, "AssistantReports");
  return [
    {
      name: "Local Filesystem",
      kind: "builtin-filesystem",
      enabled: true,
      rootPath: documentsPath,
      roots: [documentsPath],
      allowAnyPath: false
    },
    {
      name: "Documents & Reports",
      kind: "builtin-document-ops",
      enabled: true,
      rootPath: reportsPath
    },
    {
      name: "File organization",
      kind: "builtin-file-ops",
      enabled: true,
      rootPath: documentsPath,
      roots: [documentsPath],
      allowAnyPath: false
    },
    {
      name: "Browser / Web fetch",
      kind: "builtin-browser-ops",
      enabled: true
    },
    {
      name: "Persistent Memory",
      kind: "builtin-memory",
      enabled: true
    },
    {
      name: "Desktop Commander",
      kind: "builtin-desktop-commander",
      enabled: true
    },
    {
      name: "Mail & Calendar (Microsoft 365)",
      kind: "builtin-mail-calendar",
      enabled: false
    },
    {
      name: "Shell / Terminal",
      kind: "builtin-shell-exec",
      enabled: true
    },
    {
      name: "Git Operations",
      kind: "builtin-git-ops",
      enabled: false
    },
    {
      name: "Qdrant RAG",
      kind: "builtin-qdrant-rag",
      enabled: false
    },
    {
      name: "Excel Engine",
      kind: "builtin-xlsx-engine",
      enabled: true
    },
    {
      name: "Document Engine",
      kind: "builtin-docx-engine",
      enabled: true
    },
    // --- MCP Catalog: Tier 1 — Official first-party servers ---
    {
      name: "GitHub",
      kind: "catalog-github",
      enabled: false,
      transport: "streamable-http",
      url: "https://api.githubcopilot.com/mcp/"
    },
    {
      name: "Notion",
      kind: "catalog-notion",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.notion.com/mcp"
    },
    {
      name: "Slack",
      kind: "catalog-slack",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.slack.com"
    },
    {
      name: "Stripe",
      kind: "catalog-stripe",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@stripe/mcp"],
      env: { STRIPE_SECRET_KEY: "" }
    },
    {
      name: "Supabase",
      kind: "catalog-supabase",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.supabase.com/mcp"
    },
    {
      name: "Neon",
      kind: "catalog-neon",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.neon.tech/mcp"
    },
    {
      name: "Cloudflare",
      kind: "catalog-cloudflare",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.cloudflare.com/mcp"
    },
    {
      name: "Vercel",
      kind: "catalog-vercel",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.vercel.com"
    },
    {
      name: "MongoDB",
      kind: "catalog-mongodb",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "mongodb-mcp-server"],
      env: { MDB_MCP_CONNECTION_STRING: "" }
    },
    {
      name: "Asana",
      kind: "catalog-asana",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.asana.com/sse"
    },
    {
      name: "Playwright",
      kind: "catalog-playwright",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp"]
    },
    {
      name: "Home Assistant",
      kind: "catalog-home-assistant",
      enabled: false,
      transport: "streamable-http",
      url: "http://homeassistant.local:8123/api/mcp"
    },
    {
      name: "AWS",
      kind: "catalog-aws",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@awslabs/mcp-server-aws-api"]
    },
    {
      name: "Sentry",
      kind: "catalog-sentry",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@sentry/mcp-server"],
      env: { SENTRY_AUTH_TOKEN: "" }
    },
    {
      name: "Docker",
      kind: "catalog-docker",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-server-docker"]
    },
    // --- MCP Catalog: Tier 2 — High-quality community servers ---
    {
      name: "Brave Search",
      kind: "catalog-brave-search",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      env: { BRAVE_API_KEY: "" }
    },
    {
      name: "Tavily",
      kind: "catalog-tavily",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "tavily-mcp"],
      env: { TAVILY_API_KEY: "" }
    },
    {
      name: "Exa",
      kind: "catalog-exa",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "exa-mcp-server"],
      env: { EXA_API_KEY: "" }
    },
    {
      name: "Context7",
      kind: "catalog-context7",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"]
    },
    {
      name: "Firecrawl",
      kind: "catalog-firecrawl",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: { FIRECRAWL_API_KEY: "" }
    },
    {
      name: "Linear",
      kind: "catalog-linear",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@tacticlaunch/mcp-linear"],
      env: { LINEAR_API_KEY: "" }
    },
    {
      name: "Todoist",
      kind: "catalog-todoist",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "todoist-mcp"],
      env: { TODOIST_API_KEY: "" }
    },
    {
      name: "Jira",
      kind: "catalog-jira",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@orengrinker/jira-mcp-server"],
      env: { JIRA_API_TOKEN: "", JIRA_BASE_URL: "", JIRA_EMAIL: "" }
    },
    {
      name: "Hugging Face",
      kind: "catalog-huggingface",
      enabled: false,
      transport: "stdio",
      command: "uvx",
      args: ["huggingface-mcp-server"],
      env: { HF_TOKEN: "" }
    },
    {
      name: "Sequential Thinking",
      kind: "catalog-sequential-thinking",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  ];
}

function mergeBuiltinServers(existingServers = []) {
  const defaults = getDefaultMcpServers();
  const byKind = new Map(existingServers.map((server) => [server.kind, server]));
  for (const builtin of defaults) {
    if (!byKind.has(builtin.kind)) {
      existingServers.push(builtin);
    }
  }
  return existingServers;
}

function mergeDetectedCustomServers(existingServers = []) {
  const lookeenMcpPath = detectLookeenMcpPath();
  if (!lookeenMcpPath) {
    return existingServers;
  }

  const normalizePath = (value) => path.resolve(String(value ?? "")).toLowerCase();
  const configured = existingServers.some(
    (server) =>
      (server.kind ?? "custom") === "custom" &&
      (server.transport ?? "stdio") === "stdio" &&
      typeof server.command === "string" &&
      normalizePath(server.command) === normalizePath(lookeenMcpPath)
  );

  if (!configured) {
    existingServers.push({
      name: "Lookeen MCP",
      kind: "custom",
      enabled: true,
      transport: "stdio",
      command: lookeenMcpPath,
      args: []
    });
  }

  return existingServers;
}

async function loadConfig() {
  let config;
  try {
    const json = await fs.readFile(configPath(), "utf-8");
    config = JSON.parse(json);
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  config.mcpServers = mergeBuiltinServers(config.mcpServers ?? []);
  config.mcpServers = mergeDetectedCustomServers(config.mcpServers ?? []);
  return hydrateConfig(config);
}

async function saveConfig() {
  configSaveQueue = configSaveQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(configPath()), { recursive: true });
      const serializableConfig = {
        ...appConfig,
        messaging: serializeMessagingConfig(appConfig.messaging),
        mcpServers: (appConfig.mcpServers ?? []).map(dehydrateMcpServer)
      };
      await fs.writeFile(configPath(), JSON.stringify(serializableConfig, null, 2), "utf-8");
    });
  return configSaveQueue;
}

function encryptKey(plaintext) {
  if (!plaintext) return "";
  const buf = safeStorage.encryptString(plaintext);
  return buf.toString("base64");
}

function decryptKey(base64) {
  if (!base64) return "";
  const buf = Buffer.from(base64, "base64");
  return safeStorage.decryptString(buf);
}

function normalizeAllowedChatIds(chatIds = []) {
  return (Array.isArray(chatIds) ? chatIds : [])
    .map((chatId) => Number.parseInt(chatId, 10))
    .filter((chatId) => Number.isInteger(chatId));
}

function getMessagingBotToken(messaging = {}) {
  if (typeof messaging?.botToken === "string" && messaging.botToken.trim()) {
    return messaging.botToken.trim();
  }
  if (typeof messaging?.encryptedBotToken === "string" && messaging.encryptedBotToken.trim()) {
    try {
      return decryptKey(messaging.encryptedBotToken.trim());
    } catch {
      return "";
    }
  }
  return "";
}

function hydrateMessagingConfig(messaging = {}) {
  const channel = ["telegram", "whatsapp", "stub"].includes(messaging?.channel) ? messaging.channel : DEFAULT_CONFIG.messaging.channel;
  return {
    ...DEFAULT_CONFIG.messaging,
    enabled: messaging?.enabled === true,
    channel,
    allowedChatIds: normalizeAllowedChatIds(messaging?.allowedChatIds),
    botToken: getMessagingBotToken(messaging),
    wahaUrl: messaging?.wahaUrl || DEFAULT_CONFIG.messaging.wahaUrl,
    wahaApiKey: messaging?.wahaApiKey || DEFAULT_CONFIG.messaging.wahaApiKey,
    wahaHmacSecret: messaging?.wahaHmacSecret || DEFAULT_CONFIG.messaging.wahaHmacSecret,
    wahaSession: messaging?.wahaSession || DEFAULT_CONFIG.messaging.wahaSession
  };
}

function serializeMessagingConfig(messaging = {}) {
  const channel = ["telegram", "whatsapp", "stub"].includes(messaging?.channel) ? messaging.channel : DEFAULT_CONFIG.messaging.channel;
  const serialized = {
    enabled: messaging?.enabled === true,
    channel,
    allowedChatIds: normalizeAllowedChatIds(messaging?.allowedChatIds),
    wahaUrl: messaging?.wahaUrl || "",
    wahaApiKey: messaging?.wahaApiKey || "",
    wahaHmacSecret: messaging?.wahaHmacSecret || "",
    wahaSession: messaging?.wahaSession || "default"
  };
  const botToken = getMessagingBotToken(messaging);
  if (!botToken) {
    return serialized;
  }
  if (isLocalEncryptionAvailable()) {
    return {
      ...serialized,
      encryptedBotToken: encryptKey(botToken)
    };
  }
  return {
    ...serialized,
    botToken
  };
}

function isLocalEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readMailCalendarConfigSync() {
  try {
    return JSON.parse(fsSync.readFileSync(mailCalendarConfigPath(), "utf-8"));
  } catch {
    return null;
  }
}

function getMailCalendarRefreshToken(config = readMailCalendarConfigSync()) {
  if (!config) {
    return "";
  }
  if (typeof config.refreshToken === "string" && config.refreshToken.trim()) {
    return config.refreshToken.trim();
  }
  if (typeof config.encryptedRefreshToken === "string" && config.encryptedRefreshToken.trim()) {
    try {
      return decryptKey(config.encryptedRefreshToken.trim());
    } catch {
      return "";
    }
  }
  return "";
}

function buildMailCalendarServerEnv() {
  const refreshToken = getMailCalendarRefreshToken();
  if (!refreshToken) {
    return undefined;
  }
  return {
    ...process.env,
    WCJR_MAIL_REFRESH_TOKEN: refreshToken
  };
}

async function writeMailCalendarConfig({ clientId, tenantId, refreshToken }) {
  const configPathValue = mailCalendarConfigPath();
  await fs.mkdir(path.dirname(configPathValue), { recursive: true });
  const baseConfig = { clientId, tenantId };
  const serialized = isLocalEncryptionAvailable()
    ? {
        ...baseConfig,
        encryptedRefreshToken: encryptKey(refreshToken)
      }
    : {
        ...baseConfig,
        refreshToken
      };
  await fs.writeFile(
    configPathValue,
    JSON.stringify(serialized, null, 2),
    "utf-8"
  );
}

async function migrateMailCalendarConfig() {
  const current = readMailCalendarConfigSync();
  if (!current?.clientId || !current?.tenantId) {
    return;
  }
  if (!current.refreshToken || !isLocalEncryptionAvailable()) {
    return;
  }
  await writeMailCalendarConfig({
    clientId: current.clientId,
    tenantId: current.tenantId,
    refreshToken: current.refreshToken
  });
}

function getDecryptedKey(providerId) {
  const encrypted = appConfig.apiKeys?.[providerId];
  if (!encrypted) return null;
  try {
    const decrypted = decryptKey(encrypted);
    return decrypted || null;
  } catch (err) {
    logStartup(`Key decryption failed for ${providerId}: ${err.message}`);
    return null;
  }
}

function emitStream(chunk) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("assistant:streamChunk", chunk);
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runCommand(command, args, { timeoutMs = 20000, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      }
    });
  });
}

async function detectSandboxStatus() {
  if (process.platform !== "win32") {
    return {
      available: false,
      reason: "Sandboxed mode is only implemented for Windows + WSL in this build."
    };
  }

  const distro = appConfig.sandbox?.distro || DEFAULT_CONFIG.sandbox.distro;
  const configuredSandbox = appConfig.sandbox?.sandboxName?.trim();
  const gatewayName = appConfig.sandbox?.gatewayName || DEFAULT_CONFIG.sandbox.gatewayName;
  const agentId = appConfig.sandbox?.agentId || DEFAULT_CONFIG.sandbox.agentId;

  try {
    const sandboxList = await runCommand(
      "wsl.exe",
      ["-d", distro, "--", "bash", "-lc", "command -v openshell >/dev/null 2>&1 && openshell sandbox list || true"],
      { timeoutMs: 15000 }
    );

    if (!sandboxList.stdout.trim()) {
      return {
        available: false,
        reason: `No OpenShell sandboxes were found in ${distro}.`
      };
    }

    const readyLines = sandboxList.stdout
      .split(/\r?\n/)
      .filter((line) => /\bReady\b/.test(line));

    const fallbackSandbox = readyLines[0]?.trim().split(/\s+/)[0];
    const sandboxName = configuredSandbox && sandboxList.stdout.includes(configuredSandbox)
      ? configuredSandbox
      : fallbackSandbox;

    if (!sandboxName) {
      return {
        available: false,
        reason: "OpenShell is installed, but there is no ready sandbox to use."
      };
    }

    const nemoclawList = await runCommand(
      "wsl.exe",
      ["-d", distro, "--", "bash", "-lc", "command -v nemoclaw >/dev/null 2>&1 && nemoclaw list || true"],
      { timeoutMs: 15000 }
    );

    return {
      available: true,
      distro,
      gatewayName,
      sandboxName,
      agentId,
      registered: nemoclawList.stdout.includes(sandboxName),
      detail: nemoclawList.stdout.includes(sandboxName)
        ? "Registered with NemoClaw"
        : "Available via OpenShell only"
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runSandboxedTask({ prompt, onChunk }) {
  const sandboxStatus = await detectSandboxStatus();
  if (!sandboxStatus.available) {
    throw new Error(sandboxStatus.reason ?? "Sandbox is unavailable.");
  }
  const safeAgentId = String(sandboxStatus.agentId ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(safeAgentId)) {
    throw new Error("Sandbox agent id contains unsupported characters.");
  }

  const promptB64 = Buffer.from(prompt, "utf-8").toString("base64");
  const remoteScript = [
    `PROMPT_B64=${shellEscape(promptB64)}`,
    "python3 - <<'PY'",
    "import base64",
    "import os",
    "import subprocess",
    "prompt = base64.b64decode(os.environ['PROMPT_B64']).decode('utf-8')",
    `subprocess.run(['openclaw', 'agent', '--local', '--agent', '${safeAgentId}', '--message', prompt], check=False)`,
    "PY"
  ].join("\n");

  const cleanSandboxOutput = (text) =>
    text
      .replace(/^Warning:.*\r?\n?/gm, "")
      .replace(/^\(node:\d+\).*?\r?\n?/gm, "")
      .replace(/^\[plugins\].*\r?\n?/gm, "")
      .trim();

  const sshCommand = [
    "ssh",
    "-o",
    shellEscape("StrictHostKeyChecking=accept-new"),
    "-o",
    shellEscape("UserKnownHostsFile=~/.wcjr-openshell-known_hosts"),
    "-o",
    shellEscape(
      `ProxyCommand=/usr/local/bin/openshell ssh-proxy --gateway-name ${sandboxStatus.gatewayName} --name ${sandboxStatus.sandboxName}`
    ),
    shellEscape(`sandbox@openshell-${sandboxStatus.sandboxName}`),
    shellEscape(remoteScript)
  ].join(" ");

  const result = await runCommand(
    "wsl.exe",
    ["-d", sandboxStatus.distro, "--", "bash", "-lc", sshCommand],
    {
      timeoutMs: 120000,
      onStdout: (text) => {
        const cleaned = cleanSandboxOutput(text);
        if (cleaned.trim()) {
          onChunk?.(`${cleaned}\n`);
        }
      }
    }
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Sandboxed execution failed.");
  }

  return {
    content: cleanSandboxOutput(result.stdout) || "Sandboxed execution completed with no stdout output.",
    model: "nemoclaw/openclaw"
  };
}

async function invokeDirectModel({
  providerId,
  model,
  prompt,
  messages,
  onChunk,
  suppressStream = false,
  signal
}) {
  const apiKey = providerId === "ollama" ? "ollama" : getDecryptedKey(providerId);
  if (!apiKey) {
    throw new Error(`No API key configured for ${providerId}.`);
  }

  const adapter = getAdapter(providerId);
  const resolvedMessages = messages ?? [
    {
      role: "system",
      content: "You are a highly capable personal assistant. Be concise, accurate, and actionable."
    },
    { role: "user", content: prompt }
  ];

  return adapter.stream({
    apiKey,
    model,
    messages: resolvedMessages,
    signal,
    onChunk: (chunk) => {
      onChunk?.(chunk);
      if (!suppressStream) {
        emitStream(chunk);
      }
    }
  });
}

function matchesMcpPreset(server, preset) {
  if (!preset || !server) return false;
  if (preset.kind) {
    return server.kind === preset.kind;
  }
  const haystack = `${server.name} ${server.command ?? ""} ${(server.args ?? []).join(" ")}`.toLowerCase();
  return (preset.serverNamePatterns ?? []).every((pattern) => haystack.includes(pattern.toLowerCase()));
}

function filterToolSummaryForTaskType(toolSummary, taskType) {
  const profile = taskType ? ACTIVITY_PROFILES[taskType] : null;
  if (!profile?.mcpPresets?.length) {
    return toolSummary;
  }

  const presets = getMcpPresetDefinitions(profile.mcpPresets);
  const enabledServers = (appConfig?.mcpServers ?? []).filter((server) => server.enabled !== false);
  const matchingServerNames = new Set(
    enabledServers
      .filter((server) => presets.some((preset) => matchesMcpPreset(server, preset)))
      .map((server) => server.name)
  );

  if (!matchingServerNames.size) {
    return toolSummary;
  }

  const filtered = toolSummary.filter((entry) => matchingServerNames.has(entry.server));
  return filtered.length ? filtered : toolSummary;
}

function hasConnectedTools(toolSummary) {
  return toolSummary.some(
    (entry) => (entry.toolDetails?.length ?? entry.tools?.length ?? 0) > 0
  );
}

async function buildTelegramManagerReply({ requestText, summary }) {
  return buildTelegramManagerText({ requestText, summary });
}

function getTaskRemoteOrigin(taskId) {
  return getTaskStore().get(taskId)?.remoteOrigin ?? null;
}

async function sendTelegramTaskManagerUpdate(taskId, text) {
  if (!messagingBridge || !String(text ?? "").trim()) return false;

  // Try remote origin first (task started from messaging)
  const remoteOrigin = getTaskRemoteOrigin(taskId);
  if (remoteOrigin?.chatId) {
    return messagingBridge.sendUpdate({
      taskId,
      chatId: remoteOrigin.chatId,
      commandId: remoteOrigin.commandId,
      type: "completed",
      summary: text
    });
  }

  // For desktop-initiated tasks, push status to the first allowed chat ID
  const messaging = appConfig?.messaging ?? {};
  const chatIds = Array.isArray(messaging.allowedChatIds) ? messaging.allowedChatIds : [];
  if (chatIds.length > 0) {
    return messagingBridge.sendUpdate({
      taskId,
      chatId: String(chatIds[0]),
      type: "completed",
      summary: text
    });
  }

  return false;
}

/**
 * Push a short operational status update to messaging (WhatsApp/Telegram).
 * Used for proactive notifications — not full responses.
 */
async function pushOpsNotification(text) {
  if (!messagingBridge || !String(text ?? "").trim()) return false;
  const messaging = appConfig?.messaging ?? {};
  const chatIds = Array.isArray(messaging.allowedChatIds) ? messaging.allowedChatIds : [];
  if (chatIds.length === 0) return false;
  return messagingBridge.sendUpdate({
    chatId: String(chatIds[0]),
    type: "progress",
    summary: text
  });
}

function getConfiguredServerByName(serverName) {
  return (appConfig?.mcpServers ?? []).find((server) => server.name === serverName) ?? null;
}

function buildToolPolicyRule(serverName, toolName, args = {}) {
  const server = getConfiguredServerByName(serverName);
  const kind = server?.kind ?? "";
  const normalizedPath =
    typeof args.path === "string" ? path.normalize(args.path) : undefined;

  switch (toolName) {
    case "draft_reply":
      return {
        actionType: ACTION_TYPES.draft,
        context: {
          channel: "mail-calendar",
          appId: "mail-calendar"
        }
      };
    case "send_email":
      return {
        actionType: ACTION_TYPES.send_email,
        context: {
          channel: "mail-calendar",
          appId: "mail-calendar",
          newRecipient: Array.isArray(args.to) && args.to.length > 0
        }
      };
    case "create_calendar_event":
      return {
        actionType: ACTION_TYPES.calendar_create,
        context: {
          channel: "mail-calendar",
          appId: "mail-calendar"
        }
      };
    case "write_markdown":
    case "write_report":
    case "export_csv":
    case "export_xlsx":
      return {
        actionType: ACTION_TYPES.file_write,
        context: {
          path: normalizedPath,
          folderPath: typeof args.path === "string" ? path.dirname(path.normalize(args.path)) : undefined
        }
      };
    case "create_directory":
      return {
        actionType: ACTION_TYPES.file_write,
        context: {
          path: normalizedPath,
          folderPath: normalizedPath
        }
      };
    case "move_file":
    case "rename_file":
      return {
        actionType: ACTION_TYPES.move,
        context: {
          path: typeof args.to === "string" ? path.normalize(args.to) : normalizedPath,
          folderPath: typeof args.to === "string" ? path.dirname(path.normalize(args.to)) : undefined
        }
      };
    case "delete_file":
      return {
        actionType: ACTION_TYPES.delete,
        context: {
          path: normalizedPath,
          folderPath: normalizedPath
        }
      };
    case "archive_to_subfolder":
      return {
        actionType: ACTION_TYPES.bulk_change,
        context: {
          path: normalizedPath,
          folderPath: normalizedPath
        }
      };
    case "launch_application":
      return {
        actionType: ACTION_TYPES.launch_application,
        context: {
          appId: typeof args.app === "string" ? args.app : serverName
        }
      };
    case "write_clipboard":
      return {
        actionType: ACTION_TYPES.clipboard_write,
        context: {
          appId: "clipboard"
        }
      };
    case "fetch_page_content":
    case "fetch_page_raw":
      return {
        actionType: ACTION_TYPES.browser_fetch,
        context: {
          channel: "browser",
          appId: "browser-ops"
        }
      };
    default:
      break;
  }

  if (kind === "builtin-document-ops" && /^write_|^export_/.test(toolName)) {
    return {
      actionType: ACTION_TYPES.file_write,
      context: {
        path: normalizedPath,
        folderPath: typeof args.path === "string" ? path.dirname(path.normalize(args.path)) : undefined
      }
    };
  }

  return null;
}

function evaluateToolPolicy({ serverName, toolName, args = {}, policyApproved = false }) {
  const rule = buildToolPolicyRule(serverName, toolName, args);
  if (!rule) {
    return {
      decision: "allow",
      policy: null
    };
  }

  const engine = getPolicyEngine();
  const rawDecision = engine.check(rule.actionType, { ...rule.context });
  const decision = policyApproved && rawDecision === "confirm" ? "allow" : rawDecision;
  const reason =
    decision === "allow"
      ? policyApproved && rawDecision === "confirm"
        ? "Allowed because this workflow phase was explicitly approved."
        : "Allowed by the active policy."
      : decision === "confirm"
        ? "Blocked pending explicit approval under the active policy."
        : "Denied by the active policy.";

  return {
    decision,
    message:
      decision === "allow"
        ? ""
        : `Policy blocked ${serverName}.${toolName}: ${reason}`,
    policy: {
      actionType: rule.actionType,
      decision,
      reason,
      context: rule.context
    }
  };
}

async function invokeAgenticModel({
  providerId,
  model,
  prompt,
  messages,
  onChunk,
  suppressStream = false,
  skipTools = false,
  taskType,
  signal,
  taskContext
}) {
  const apiKey = providerId === "ollama" ? "ollama" : getDecryptedKey(providerId);
  if (!apiKey) {
    throw new Error(`No API key configured for ${providerId}.`);
  }

  const adapter = getAdapter(providerId);
  const resolvedMessages = messages ?? [
    {
      role: "system",
      content: "You are a highly capable personal assistant. Be concise, accurate, and actionable."
    },
    { role: "user", content: prompt }
  ];

  const emitChunk = (chunk) => {
    onChunk?.(chunk);
    if (!suppressStream) {
      emitStream(chunk);
    }
  };

  if (skipTools || !adapter.supportsTools || !orchestrator?.mcpHub) {
    return invokeDirectModel({
      providerId,
      model,
      prompt,
      messages: resolvedMessages,
      onChunk,
      suppressStream,
      signal
    });
  }

  const filteredToolSummary = filterToolSummaryForTaskType(
    await orchestrator.mcpHub.getToolSummary(),
    taskType
  );

  if (!hasConnectedTools(filteredToolSummary)) {
    return invokeDirectModel({
      providerId,
      model,
      prompt,
      messages: resolvedMessages,
      onChunk,
      suppressStream,
      signal
    });
  }

  clearToolNameRegistry();
  const tools =
    providerId === "gemini"
      ? mcpToolsToGeminiFunctions(filteredToolSummary)
      : mcpToolsToOpenAIFunctions(filteredToolSummary);

  if (!tools.length) {
    return invokeDirectModel({
      providerId,
      model,
      prompt,
      messages: resolvedMessages,
      onChunk,
      suppressStream,
      signal
    });
  }

  return runToolLoop({
    adapter,
    adapterArgs: {
      apiKey,
      model,
      messages: resolvedMessages
    },
    tools,
    mcpHub: orchestrator.mcpHub,
    beforeToolCall: async ({ server, tool, args }) =>
      evaluateToolPolicy({
        serverName: server,
        toolName: tool,
        args,
        policyApproved: taskContext?.policyApproved === true
      }),
    maxIterations: 10,
    signal,
    onChunk: emitChunk
  });
}

function createOrchestrator() {
  orchestrator = new Orchestrator(appConfig, {
    resolveProvider,
    hasApiKey: async (providerId) => providerId === "ollama" || !!getDecryptedKey(providerId),
    invokeModel: invokeAgenticModel,
    emitStatus: (text) => emitStream({ type: "status", text: `${text}\n\n` }),
    emitText: (text) => emitStream({ type: "text", text }),
    detectSandboxStatus,
    runSandboxedTask
  });
}

function getTaskStore() {
  if (!taskStore) {
    const storagePath = path.join(app.getPath("userData"), "task-store.json");
    taskStore = new TaskStore({ storagePath, maxTasks: 500, maxAuditEntries: 5000 });
  }
  return taskStore;
}

function getConversationStore() {
  if (!conversationStore) {
    const storagePath = path.join(app.getPath("userData"), "conversation-store.json");
    conversationStore = new ConversationStore({
      storagePath,
      maxSessions: 100,
      maxMessagesPerSession: 200
    });
  }
  return conversationStore;
}

function getMemoryStore() {
  if (!memoryStore) {
    memoryStore = new MemoryStore({
      storagePath: memoryStorePath(),
      maxMemories: 500
    });
  }
  return memoryStore;
}

function getPolicyEngine() {
  if (!policyEngine && appConfig) {
    policyEngine = new PolicyEngine(appConfig.policy ?? {});
  }
  return policyEngine;
}

function createWindow() {
  logStartup("Creating main window");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: "WCJR Assistant",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logStartup("Renderer finished load");
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    logStartup(`Renderer failed load: ${errorCode} ${errorDescription}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logStartup(`Renderer process gone: ${details.reason}`);
  });
  mainWindow.on("closed", () => {
    logStartup("Main window closed");
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

async function runAssistantTaskRequest(payload, runtime = {}) {
  const schema = z.object({
    prompt: z.string().min(1),
    taskType: z.string().optional(),
    modelOverride: z.string().optional(),
    runMode: z.enum(["direct", "sandboxed"]).optional(),
    conversationId: z.string().optional(),
    executionMode: z.enum(["plan_first", "direct"]).optional()
  });
  const {
    prompt: rawPrompt,
    taskType,
    modelOverride,
    runMode,
    conversationId,
    executionMode
  } = schema.parse(payload);
  const remoteOrigin = runtime.remoteOrigin ?? null;
  const policyApproved = runtime.policyApproved === true;
  const { skillId, prompt } = parseSkillCommand(rawPrompt);
  const planExecutionMode = executionMode ?? appConfig.executionMode ?? "plan_first";
  appConfig.executionMode = planExecutionMode;
  await saveConfig();
  const taskTypeTrim = taskType?.trim();
  let resolvedTaskType = taskTypeTrim || "orchestrator";
  let executionPhase = "execute";
  if (resolvedTaskType === "orchestrator") {
    if (
      planExecutionMode === "direct" ||
      shouldAutoExecuteDeterministicPrompt(prompt, resolvedTaskType, planExecutionMode)
    ) {
      resolvedTaskType = orchestrator.inferTaskType(prompt) || "project_mgmt";
    } else {
      executionPhase = "plan";
    }
  }
  let resolvedRunMode = runMode ?? "direct";
  if (resolvedRunMode === "direct" && appConfig.sandboxPreference === "risky") {
    const riskyTypes = new Set(["coding", "automation", "project_mgmt", "data_analysis", "aws_cloud", "documents"]);
    if (riskyTypes.has(resolvedTaskType)) {
      resolvedRunMode = "sandboxed";
    }
  }

  const store = getTaskStore();
  const conversationStoreRef = getConversationStore();
  const memoryStoreRef = getMemoryStore();
  let activeConversation =
    (conversationId && conversationStoreRef.getSession(conversationId)) ||
    (appConfig.activeConversationId && conversationStoreRef.getSession(appConfig.activeConversationId));

  if (!activeConversation) {
    activeConversation = conversationStoreRef.createSession();
    appConfig.activeConversationId = activeConversation.id;
    await conversationStoreRef.save();
    await saveConfig();
  } else if (appConfig.activeConversationId !== activeConversation.id) {
    appConfig.activeConversationId = activeConversation.id;
    await saveConfig();
  }

  const priorConversationMessages = (activeConversation.messages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
  const relevantMemories =
    appConfig.memory?.enabled === false ? [] : memoryStoreRef.search(prompt, { limit: 8 });
  if (relevantMemories.length > 0) {
    memoryStoreRef.markUsed(relevantMemories.map((memory) => memory.id));
    await memoryStoreRef.save();
  }

  const task = store.create({
    prompt: rawPrompt,
    taskType: taskTypeTrim || "orchestrator",
    runMode: resolvedRunMode,
    remoteOrigin
  });
  store.update(task.id, {
    status: TASK_STATUS.RUNNING,
    progress: { current: 0, total: 1, message: "Starting..." }
  });
  await store.save();
  if (mainWindow) {
    mainWindow.webContents.send("assistant:taskUpdated", { taskId: task.id, status: TASK_STATUS.RUNNING });
  }
  pushOpsNotification(`Task started: ${compactWorkflowText(rawPrompt).slice(0, 80)}`).catch(() => {});

  conversationStoreRef.appendMessage(activeConversation.id, {
    role: "user",
    content: prompt,
    taskId: task.id
  });
  await conversationStoreRef.save();
  if (appConfig.memory?.autoCapture !== false) {
    const extractedMemories = extractCandidateMemories(prompt).map((memory) => ({
      ...memory,
      source: {
        conversationId: activeConversation.id,
        taskId: task.id
      }
    }));
    if (extractedMemories.length > 0) {
      memoryStoreRef.rememberMany(extractedMemories);
      await memoryStoreRef.save();
    }
  }
  if (mainWindow) {
    mainWindow.webContents.send("assistant:conversationUpdated", {
      conversationId: activeConversation.id
    });
    mainWindow.webContents.send("assistant:memoryUpdated");
  }

  const taskContext = {
    taskId: task.id,
    policyApproved,
    onProgress: (progress) => {
      store.update(task.id, { progress });
      store.save();
      if (mainWindow) {
        mainWindow.webContents.send("assistant:taskUpdated", { taskId: task.id, progress });
      }
    },
    onToolActivity: (toolActivity) => {
      store.update(task.id, { toolActivity });
      store.appendAuditEntry(task.id, "tool_activity", { count: toolActivity?.length ?? 0 });
      store.save();
    },
    onToolTrace: (toolTrace) => {
      store.update(task.id, { toolTrace });
      store.appendAuditEntry(task.id, "tool_trace", { count: toolTrace?.length ?? 0 });
      store.save();
    },
    onAudit: (action, detail) => {
      store.appendAuditEntry(task.id, action, detail);
      store.save();
    }
  };

  try {
    const summary = await orchestrator.executeTask({
      prompt,
      taskType: resolvedTaskType,
      modelOverride,
      runMode: resolvedRunMode,
      taskContext,
      conversationMessages: priorConversationMessages,
      memoryItems: relevantMemories,
      memoryContext: buildMemoryContext(relevantMemories),
      skillId,
      executionPhase
    });

    const finalTask = store.get(task.id);
    const pendingApproval = Boolean(summary?.pendingApproval);
    const normalizedWorkflowPlan = pendingApproval ? normalizeExecutionPlan(summary?.executionPlan) : null;
    const workflowState = normalizedWorkflowPlan
      ? buildWorkflowState(normalizedWorkflowPlan, "awaiting_approval")
      : null;
    const assistantContent = stripWcjrPlanBlock(summary?.content ?? "");
    const updates = {
      timeline: summary?.timeline ?? finalTask?.timeline ?? [],
      agentRuns: summary?.agentRuns ?? finalTask?.agentRuns ?? [],
      toolActivity: summary?.toolActivity ?? finalTask?.toolActivity ?? [],
      toolTrace: summary?.toolTrace ?? finalTask?.toolTrace ?? [],
      result: summary?.error ? null : { content: assistantContent || summary?.content, model: summary?.model, provider: summary?.provider },
      error: summary?.error ?? null,
      pendingExecutionPlan: normalizedWorkflowPlan,
      workflow: workflowState,
      status: summary?.error
        ? TASK_STATUS.FAILED
        : pendingApproval
          ? TASK_STATUS.AWAITING_APPROVAL
          : TASK_STATUS.COMPLETED,
      progress: {
        current: 1,
        total: 1,
        message: summary?.error ? "Failed" : pendingApproval ? "Awaiting approval" : "Completed"
      }
    };
    store.update(task.id, updates);
    store.appendAuditEntry(
      task.id,
      summary?.error ? "task_failed" : pendingApproval ? "plan_awaiting_approval" : "task_completed",
      summary?.error ? { error: summary.error } : { model: summary?.model, pendingApproval }
    );
    await store.save();

    if (summary?.error) {
      if (mainWindow) {
        mainWindow.webContents.send("assistant:streamError", { error: summary.error });
        mainWindow.webContents.send("assistant:taskUpdated", { taskId: task.id, status: TASK_STATUS.FAILED });
      }
      return { ...summary, taskId: task.id, conversationId: activeConversation.id };
    }

    conversationStoreRef.appendMessage(activeConversation.id, {
      role: "assistant",
      content: assistantContent || (summary?.content ?? ""),
      taskId: task.id,
      toolTrace: summary?.toolTrace ?? [],
      workflowPreview: workflowState
    });
    await conversationStoreRef.save();
    if (mainWindow) {
      mainWindow.webContents.send("assistant:conversationUpdated", {
        conversationId: activeConversation.id
      });
      mainWindow.webContents.send("assistant:memoryUpdated");
    }

    if (mainWindow) {
      mainWindow.webContents.send("assistant:streamDone", {
        ...summary,
        content: assistantContent || (summary?.content ?? ""),
        pendingApproval,
        executionPlan: normalizedWorkflowPlan,
        workflowPreview: workflowState,
        taskId: task.id,
        conversationId: activeConversation.id
      });
      mainWindow.webContents.send("assistant:taskUpdated", {
        taskId: task.id,
        status: pendingApproval ? TASK_STATUS.AWAITING_APPROVAL : TASK_STATUS.COMPLETED
      });
    }

    return {
      ...summary,
      pendingApproval,
      taskId: task.id,
      conversationId: activeConversation.id
    };
  } catch (err) {
    const errorMsg = err.message ?? String(err);
    store.update(task.id, {
      status: TASK_STATUS.FAILED,
      error: errorMsg,
      progress: { current: 1, total: 1, message: "Failed" }
    });
    store.appendAuditEntry(task.id, "task_failed", { error: errorMsg });
    await store.save();
    if (mainWindow) {
      mainWindow.webContents.send("assistant:streamError", { error: errorMsg });
      mainWindow.webContents.send("assistant:taskUpdated", { taskId: task.id, status: TASK_STATUS.FAILED });
    }
    return { error: errorMsg, taskId: task.id, conversationId: activeConversation.id };
  }
}

function getRuntimeMetadata() {
  return buildRuntimeMetadata({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    userDataPath: app.getPath("userData"),
    configPath: configPath()
  });
}

function buildKeyStatus() {
  const keyStatus = {};
  for (const id of PROVIDER_IDS) {
    if (id === "ollama") {
      keyStatus[id] = true;
      continue;
    }
    // Check if key actually decrypts, not just if encrypted blob exists
    const decrypted = getDecryptedKey(id);
    keyStatus[id] = !!decrypted;
  }
  return keyStatus;
}

function getBootstrapStatePayload() {
  return buildBootstrapState({
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, provider]) => [id, provider.label])
    ),
    keyStatus: buildKeyStatus(),
    modelProfiles: appConfig.modelProfiles,
    taskTypes: orchestrator.getTaskTypes(),
    activityProfiles: buildActivityProfileState(),
    executionMode: appConfig.executionMode ?? "plan_first",
    sandboxPreference: appConfig.sandboxPreference ?? "manual",
    theme: appConfig.theme ?? "midnight",
    themeIds: THEME_IDS,
    runtime: getRuntimeMetadata()
  });
}

async function getWorkspaceStatePayload() {
  const runtimeSnapshot = orchestrator.getConfigSnapshot();
  const engine = getPolicyEngine();
  const memoryStoreRef = getMemoryStore();
  const memoryStats = memoryStoreRef.getStats();

  return buildWorkspaceState({
    modelCache: appConfig.modelCache ?? {},
    conversations: getConversationStore().listSessions({ limit: 50 }),
    activeConversationId: appConfig.activeConversationId ?? null,
    memory: {
      enabled: appConfig.memory?.enabled !== false,
      autoCapture: appConfig.memory?.autoCapture !== false,
      count: memoryStats.count,
      pinned: memoryStats.pinned,
      recent: memoryStoreRef.list({ limit: 8 })
    },
    desktopCommander: {
      enabled: appConfig.desktopCommander?.enabled !== false,
      lookeenPath: appConfig.desktopCommander?.apps?.lookeen?.path ?? "",
      outlookPath: appConfig.desktopCommander?.apps?.outlook?.path ?? ""
    },
    mcpServers: appConfig.mcpServers ?? [],
    mcpStatuses: runtimeSnapshot.mcpStatuses ?? [],
    sandboxStatus: await detectSandboxStatus(),
    suggestedFilesystemRoot: app.getPath("documents"),
    suggestedDocumentOpsRoot: path.join(app.getPath("documents"), "AssistantReports"),
    policyProfile: engine.profile,
    policyProfiles: Object.values(POLICY_PROFILES),
    messaging: {
      enabled: !!appConfig.messaging?.enabled,
      channel: appConfig.messaging?.channel ?? "telegram",
      hasToken: !!getMessagingBotToken(appConfig.messaging),
      allowedChatIds: normalizeAllowedChatIds(appConfig.messaging?.allowedChatIds)
    }
  });
}

function registerIpcHandlers() {
  ipcMain.handle("assistant:getBootstrapState", async () => getBootstrapStatePayload());

  ipcMain.handle("assistant:getWorkspaceState", async () => getWorkspaceStatePayload());

  ipcMain.handle("assistant:getState", async () =>
    mergeAssistantState(getBootstrapStatePayload(), await getWorkspaceStatePayload())
  );

  ipcMain.handle("assistant:newConversation", async (_event, payload) => {
    const store = getConversationStore();
    const session = store.createSession({ title: payload?.title });
    appConfig.activeConversationId = session.id;
    await store.save();
    await saveConfig();
    return {
      conversation: session,
      conversations: store.listSessions({ limit: 50 }),
      activeConversationId: session.id
    };
  });

  ipcMain.handle("assistant:getConversation", async (_event, conversationId) => {
    return getConversationStore().getSession(conversationId);
  });

  ipcMain.handle("assistant:setActiveConversation", async (_event, conversationId) => {
    const session = getConversationStore().getSession(conversationId);
    if (!session) {
      return { activeConversationId: appConfig.activeConversationId ?? null };
    }
    appConfig.activeConversationId = session.id;
    await saveConfig();
    return { activeConversationId: session.id };
  });

  ipcMain.handle("assistant:setMemorySettings", async (_event, payload) => {
    const schema = z.object({
      enabled: z.boolean().optional(),
      autoCapture: z.boolean().optional()
    });
    const parsed = schema.parse(payload);
    if (!appConfig.memory) appConfig.memory = { ...DEFAULT_CONFIG.memory };
    if (parsed.enabled != null) appConfig.memory.enabled = parsed.enabled;
    if (parsed.autoCapture != null) appConfig.memory.autoCapture = parsed.autoCapture;
    await saveConfig();
    return {
      enabled: appConfig.memory.enabled,
      autoCapture: appConfig.memory.autoCapture,
      ...getMemoryStore().getStats()
    };
  });

  ipcMain.handle("assistant:getMemories", async (_event, filters) => {
    return getMemoryStore().list(filters ?? { limit: 20 });
  });

  ipcMain.handle("assistant:saveApiKeys", async (_event, payload) => {
    const schema = z.record(z.string(), z.string());
    const keys = schema.parse(payload);
    if (!appConfig.apiKeys) appConfig.apiKeys = {};
    for (const [providerId, rawKey] of Object.entries(keys)) {
      if (rawKey.trim()) {
        appConfig.apiKeys[providerId] = encryptKey(rawKey.trim());
      } else {
        delete appConfig.apiKeys[providerId];
      }
    }
    await saveConfig();
    return buildKeyStatus();
  });

  ipcMain.handle("assistant:getKeyStatus", async () => {
    return buildKeyStatus();
  });

  ipcMain.handle("assistant:listModels", async (_event, providerId) => {
    const apiKey = providerId === "ollama" ? "ollama" : getDecryptedKey(providerId);
    if (!apiKey) return { error: `No API key configured for ${providerId}` };
    try {
      const adapter = getAdapter(providerId);
      const models = sanitizeModelList(await adapter.listModels(apiKey));
      if (!appConfig.modelCache) appConfig.modelCache = {};
      if (models.length) {
        appConfig.modelCache[providerId] = models;
      } else {
        delete appConfig.modelCache[providerId];
      }
      appConfig.modelCache = sanitizeModelCache(appConfig.modelCache);
      await saveConfig();
      return { models };
    } catch (err) {
      return { error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("assistant:listAllModels", async () => {
    const results = {};
    for (const providerId of PROVIDER_IDS) {
      const apiKey = providerId === "ollama" ? "ollama" : getDecryptedKey(providerId);
      if (!apiKey) {
        results[providerId] = { models: [], error: "No API key" };
        continue;
      }
      try {
        const adapter = getAdapter(providerId);
        const models = sanitizeModelList(await adapter.listModels(apiKey));
        if (!appConfig.modelCache) appConfig.modelCache = {};
        appConfig.modelCache[providerId] = models;
        results[providerId] = { models };
      } catch (err) {
        logStartup(`listModels failed for ${providerId}: ${err.message}`);
        results[providerId] = {
          models: sanitizeModelList(appConfig.modelCache?.[providerId] ?? []),
          error: err.message
        };
      }
    }
    appConfig.modelCache = sanitizeModelCache(appConfig.modelCache ?? {});
    await saveConfig();
    return results;
  });

  ipcMain.handle("assistant:updateModelProfiles", async (_event, payload) => {
    const schema = z.record(z.string(), z.string());
    const profiles = sanitizeModelProfiles(schema.parse(payload));
    appConfig.modelProfiles = orchestrator.updateModelProfiles(profiles);
    await saveConfig();
    return appConfig.modelProfiles;
  });

  ipcMain.handle("assistant:setMcpServers", async (_event, payload) => {
    const schema = z.array(MCP_SERVER_SCHEMA);
    const nextServers = schema.parse(payload).map(hydrateMcpServer);
    appConfig.mcpServers = nextServers;
    orchestrator.setMcpServers(nextServers);
    await saveConfig();
    return {
      mcpServers: appConfig.mcpServers,
      mcpStatuses: orchestrator.getConfigSnapshot().mcpStatuses
    };
  });

  ipcMain.handle("assistant:connectMcp", async () => {
    const statuses = await orchestrator.connectMcp();
    return statuses;
  });

  ipcMain.handle("assistant:pickDirectory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder for Local Filesystem access",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("assistant:pickExecutable", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose an application executable",
      properties: ["openFile"],
      filters: [
        { name: "Applications", extensions: ["exe", "bat", "cmd", "lnk"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("assistant:setDesktopCommanderConfig", async (_event, payload) => {
    const schema = z.object({
      enabled: z.boolean().optional(),
      lookeenPath: z.string().optional()
    });
    const parsed = schema.parse(payload);
    if (!appConfig.desktopCommander) {
      appConfig.desktopCommander = { ...DEFAULT_CONFIG.desktopCommander };
    }
    if (parsed.enabled != null) {
      appConfig.desktopCommander.enabled = parsed.enabled;
    }
    if (parsed.lookeenPath != null) {
      appConfig.desktopCommander.apps = {
        ...(appConfig.desktopCommander.apps ?? {}),
        lookeen: {
          displayName: "Lookeen",
          path: parsed.lookeenPath
        }
      };
    }
    await saveConfig();
    return {
      enabled: appConfig.desktopCommander.enabled !== false,
      lookeenPath: appConfig.desktopCommander.apps?.lookeen?.path ?? ""
    };
  });

  ipcMain.handle("assistant:runTask", async (_event, payload) => {
    return runAssistantTaskRequest(payload);
  });

  ipcMain.handle("assistant:approvePlan", async (_event, payload) => _approvePlanImpl(payload));
  _approvePlanImpl = async (payload) => {
    const schema = z.object({
      taskId: z.string(),
      conversationId: z.string(),
      modelOverride: z.string().optional()
    });
    const { taskId, conversationId, modelOverride } = schema.parse(payload);
    const store = getTaskStore();
    const conversationStoreRef = getConversationStore();
    const memoryStoreRef = getMemoryStore();
    const planTask = store.get(taskId);
    const rawPlan = planTask?.pendingExecutionPlan;
    const normalized = normalizeExecutionPlan(rawPlan);
    if (!normalized?.phases?.length) {
      return { error: "No pending plan to approve for this task." };
    }
    const session = conversationStoreRef.getSession(conversationId);
    if (!session) {
      return { error: "Conversation not found." };
    }

    const totalPhases = normalized.phases.length;
    const workflowStartedAt = new Date().toISOString();
    const initialWorkflow = {
      ...(planTask?.workflow ?? buildWorkflowState(normalized, "running")),
      status: "running",
      approvedAt: workflowStartedAt,
      startedAt: workflowStartedAt,
      completedAt: null,
      failedPhaseId: null
    };

    store.update(taskId, {
      pendingExecutionPlan: null,
      status: TASK_STATUS.RUNNING,
      progress: { current: 0, total: totalPhases, message: `Workflow approved. Running ${totalPhases} phase(s)...` },
      workflow: initialWorkflow
    });
    store.appendAuditEntry(taskId, "plan_approved", {
      phaseCount: normalized.phases.length,
      firstActivity: normalized.phases[0].activity
    });
    await store.save();

    const baseConversationMessages = (session.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: message.content
      }));

    const riskyTypes = new Set([
      "coding",
      "automation",
      "project_mgmt",
      "data_analysis",
      "aws_cloud",
      "documents"
    ]);

    let batches;
    try {
      batches = buildExecutionBatches(normalized.phases);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }

    let priorPhaseContext = "";
    const phaseOrder = new Map(normalized.phases.map((phase, index) => [phase.id, index + 1]));
    const completedPhaseResults = [];

    const persistParentTaskUpdate = async (updates = {}) => {
      store.update(taskId, updates);
      await store.save();
      if (mainWindow) {
        mainWindow.webContents.send("assistant:taskUpdated", {
          taskId,
          status: updates.status,
          progress: updates.progress
        });
      }
    };

    const updateParentWorkflowPhase = async (phase, phaseUpdates = {}, workflowUpdates = {}) => {
      const currentParent = store.get(taskId);
      const currentWorkflow = currentParent?.workflow ?? initialWorkflow;
      const nextWorkflow = setWorkflowPhaseData(currentWorkflow, phase.id, phaseUpdates, workflowUpdates);
      const completedCount = nextWorkflow?.phases?.filter((item) => item.status === "completed").length ?? 0;
      const failedPhase = nextWorkflow?.phases?.find((item) => item.status === "failed") ?? null;
      const inFlightCount = nextWorkflow?.phases?.filter((item) => item.status === "running").length ?? 0;
      const currentMessage = failedPhase
        ? `Workflow failed in ${failedPhase.title}.`
        : inFlightCount > 0
          ? `Workflow running: ${completedCount}/${totalPhases} phase(s) completed.`
          : nextWorkflow?.status === "completed"
            ? "Workflow completed."
            : `Workflow approved. Running ${totalPhases} phase(s)...`;

      await persistParentTaskUpdate({
        workflow: nextWorkflow,
        status:
          nextWorkflow?.status === "failed"
            ? TASK_STATUS.FAILED
            : nextWorkflow?.status === "completed"
              ? TASK_STATUS.COMPLETED
              : TASK_STATUS.RUNNING,
        progress: {
          current: completedCount,
          total: totalPhases,
          message: currentMessage
        }
      });

      return nextWorkflow;
    };

    try {
      const executeWorkflowPhase = async (phase, batchContext) => {
        const phaseIndex = phaseOrder.get(phase.id) ?? 0;
        const phaseTitle = phase.title ?? getActivityLabel(phase.activity);
        const phasePrompt = [
          phase.prompt,
          batchContext
            ? `\n\n---\nWorkflow context (completed phases):\n${batchContext}`
            : ""
        ].join("");

        const relevantMemories =
          appConfig.memory?.enabled === false ? [] : memoryStoreRef.search(phasePrompt, { limit: 8 });
        if (relevantMemories.length > 0) {
          memoryStoreRef.markUsed(relevantMemories.map((m) => m.id));
          await memoryStoreRef.save();
        }

        const modelForPhase = resolveModelForPhase({
          activityId: phase.activity,
          depth: phase.depth,
          explicitModel: phase.model,
          uiOverride: modelOverride,
          modelRouter: orchestrator.modelRouter,
          modelTiers: appConfig.modelTiers ?? DEFAULT_MODEL_TIERS
        });

        let resolvedRunMode = normalized.runMode === "sandboxed" ? "sandboxed" : "direct";
        if (resolvedRunMode === "direct" && appConfig.sandboxPreference === "risky") {
          if (riskyTypes.has(phase.activity)) {
            resolvedRunMode = "sandboxed";
          }
        }

        const execTask = store.create({
          prompt: phasePrompt,
          taskType: phase.activity,
          runMode: resolvedRunMode,
          parentTaskId: taskId,
          phase: {
            workflowTaskId: taskId,
            phaseId: phase.id,
            title: phaseTitle,
            index: phaseIndex,
            total: totalPhases
          }
        });
        store.update(execTask.id, {
          status: TASK_STATUS.RUNNING,
          progress: {
            current: phaseIndex,
            total: totalPhases,
            message: `${phaseTitle} (${phaseIndex}/${totalPhases})...`
          }
        });
        await store.save();
        if (mainWindow) {
          mainWindow.webContents.send("assistant:taskUpdated", {
            taskId: execTask.id,
            status: TASK_STATUS.RUNNING
          });
        }

        await updateParentWorkflowPhase(
          phase,
          {
            status: "running",
            taskId: execTask.id,
            runMode: resolvedRunMode,
            startedAt: new Date().toISOString(),
            error: null
          }
        );

        const taskContext = {
          taskId: execTask.id,
          policyApproved: true,
          onProgress: (progress) => {
            store.update(execTask.id, { progress });
            store.save();
            if (mainWindow) {
              mainWindow.webContents.send("assistant:taskUpdated", { taskId: execTask.id, progress });
            }
          },
          onToolActivity: (toolActivity) => {
            store.update(execTask.id, { toolActivity });
            store.appendAuditEntry(execTask.id, "tool_activity", { count: toolActivity?.length ?? 0 });
            store.save();
          },
          onToolTrace: (toolTrace) => {
            store.update(execTask.id, { toolTrace });
            store.appendAuditEntry(execTask.id, "tool_trace", { count: toolTrace?.length ?? 0 });
            store.save();
          },
          onAudit: (action, detail) => {
            store.appendAuditEntry(execTask.id, action, detail);
            store.save();
          }
        };

        const summary = await orchestrator.executeTask({
          prompt: phasePrompt,
          taskType: phase.activity,
          modelOverride: modelForPhase,
          runMode: resolvedRunMode,
          taskContext,
          conversationMessages: baseConversationMessages,
          memoryItems: relevantMemories,
          memoryContext: buildMemoryContext(relevantMemories),
          skillId: null,
          executionPhase: "execute",
          quietMode: true
        });

        const finalExec = store.get(execTask.id);
        const cleanContent = stripWcjrPlanBlock(summary?.content ?? "");
        const outputPreview = buildPhasePromptPreview(cleanContent || summary?.error || "", 240);
        const now = new Date().toISOString();
        const updates = {
          timeline: summary?.timeline ?? finalExec?.timeline ?? [],
          agentRuns: summary?.agentRuns ?? finalExec?.agentRuns ?? [],
          toolActivity: summary?.toolActivity ?? finalExec?.toolActivity ?? [],
          toolTrace: summary?.toolTrace ?? finalExec?.toolTrace ?? [],
          result: summary?.error ? null : { content: cleanContent || summary?.content, model: summary?.model, provider: summary?.provider },
          error: summary?.error ?? null,
          status: summary?.error ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED,
          progress: { current: 1, total: 1, message: summary?.error ? "Failed" : "Completed" }
        };
        store.update(execTask.id, updates);
        store.appendAuditEntry(
          execTask.id,
          summary?.error ? "task_failed" : "task_completed",
          summary?.error ? { error: summary.error } : { model: summary?.model }
        );
        await store.save();

        const nextWorkflow = await updateParentWorkflowPhase(
          phase,
          {
            status: summary?.error ? "failed" : "completed",
            completedAt: now,
            provider: summary?.provider ?? null,
            modelUsed: summary?.model ?? null,
            error: summary?.error ?? null,
            outputPreview
          },
          summary?.error
            ? { status: "failed", failedPhaseId: phase.id }
            : {}
        );

        if (mainWindow) {
          mainWindow.webContents.send("assistant:taskUpdated", {
            taskId: execTask.id,
            status: summary?.error ? TASK_STATUS.FAILED : TASK_STATUS.COMPLETED
          });
        }

        return {
          phase,
          phaseIndex,
          phaseTitle,
          execTaskId: execTask.id,
          summary: {
            ...summary,
            content: cleanContent || (summary?.content ?? "")
          },
          workflow: nextWorkflow
        };
      };

      for (const batch of batches) {
        const batchContext = priorPhaseContext;
        const batchResults = await Promise.all(batch.map((phase) => executeWorkflowPhase(phase, batchContext)));
        const orderedBatchResults = batchResults.sort((a, b) => a.phaseIndex - b.phaseIndex);

        for (const result of orderedBatchResults) {
          if (result.summary?.error) {
            const failureMessage = `Workflow failed in "${result.phaseTitle}": ${result.summary.error}`;
            const failedWorkflow = {
              ...(result.workflow ?? store.get(taskId)?.workflow ?? initialWorkflow),
              status: "failed",
              failedPhaseId: result.phase.id,
              completedAt: new Date().toISOString()
            };

            await persistParentTaskUpdate({
              status: TASK_STATUS.FAILED,
              workflow: failedWorkflow,
              error: failureMessage,
              progress: {
                current: completedPhaseResults.length,
                total: totalPhases,
                message: "Workflow failed."
              }
            });

            conversationStoreRef.appendMessage(conversationId, {
              role: "assistant",
              content: `${failureMessage}\n\nThe workflow stopped before later phases could run.`,
              taskId,
              workflowPreview: failedWorkflow
            });
            await conversationStoreRef.save();

            if (mainWindow) {
              mainWindow.webContents.send("assistant:conversationUpdated", { conversationId });
              mainWindow.webContents.send("assistant:taskUpdated", {
                taskId,
                status: TASK_STATUS.FAILED
              });
            }

            await sendTelegramTaskManagerUpdate(
              taskId,
              buildTelegramManagerFallback({
                requestText: planTask?.prompt ?? "",
                summary: { error: failureMessage }
              })
            );

            if (mainWindow) {
              mainWindow.webContents.send("assistant:streamError", {
                error: failureMessage
              });
            }
            return {
              ...result.summary,
              error: failureMessage,
              taskId,
              failedPhaseId: result.phase.id,
              parentTaskId: taskId,
              conversationId,
              workflowFailedAtPhase: result.phaseIndex,
              workflowPreview: failedWorkflow
            };
          }

          completedPhaseResults.push(result);
          const assistantBody = `### ${result.phaseTitle}\n\n${result.summary.content ?? ""}`;
          priorPhaseContext += `\n\n## ${result.phase.id} (${result.phaseTitle})\n${result.summary.content ?? ""}`;

          conversationStoreRef.appendMessage(conversationId, {
            role: "assistant",
            content: assistantBody,
            taskId: result.execTaskId,
            toolTrace: result.summary?.toolTrace ?? []
          });
          await conversationStoreRef.save();
          if (mainWindow) {
            mainWindow.webContents.send("assistant:conversationUpdated", { conversationId });
            mainWindow.webContents.send("assistant:memoryUpdated");
          }
        }
      }

      const finalWorkflow = {
        ...(store.get(taskId)?.workflow ?? initialWorkflow),
        status: "completed",
        completedAt: new Date().toISOString()
      };
      const workflowContent = buildWorkflowCompletionContent(finalWorkflow, completedPhaseResults);

      await persistParentTaskUpdate({
        status: TASK_STATUS.COMPLETED,
        workflow: finalWorkflow,
        result: {
          content: workflowContent,
          model: completedPhaseResults.at(-1)?.summary?.model ?? null,
          provider: completedPhaseResults.at(-1)?.summary?.provider ?? null
        },
        progress: {
          current: totalPhases,
          total: totalPhases,
          message: "Workflow completed."
        }
      });

      conversationStoreRef.appendMessage(conversationId, {
        role: "assistant",
        content: `Workflow completed across ${totalPhases} phase(s). Review the phase outputs above for the detailed results.`,
        taskId,
        workflowPreview: finalWorkflow
      });
      await conversationStoreRef.save();
      if (mainWindow) {
        mainWindow.webContents.send("assistant:conversationUpdated", { conversationId });
      }

      if (completedPhaseResults.length) {
        await sendTelegramTaskManagerUpdate(
          taskId,
          buildTelegramManagerText({
            requestText: planTask?.prompt ?? "",
            summary: { content: workflowContent }
          })
        );
      }

      if (mainWindow) {
        mainWindow.webContents.send("assistant:streamDone", {
          ...completedPhaseResults.at(-1)?.summary,
          content: workflowContent,
          taskId,
          parentTaskId: taskId,
          conversationId,
          approvedFromPlan: true,
          workflowPhases: totalPhases,
          workflowPreview: finalWorkflow
        });
        mainWindow.webContents.send("assistant:taskUpdated", {
          taskId,
          status: TASK_STATUS.COMPLETED
        });
      }

      return {
        ...completedPhaseResults.at(-1)?.summary,
        content: workflowContent,
        taskId,
        parentTaskId: taskId,
        conversationId,
        workflowPhases: totalPhases,
        workflowPreview: finalWorkflow
      };
    } catch (err) {
      const errorMsg = err.message ?? String(err);
      const failedWorkflow = {
        ...(store.get(taskId)?.workflow ?? initialWorkflow),
        status: "failed"
      };
      await persistParentTaskUpdate({
        status: TASK_STATUS.FAILED,
        workflow: failedWorkflow,
        error: errorMsg,
        progress: {
          current: failedWorkflow.phases?.filter((phase) => phase.status === "completed").length ?? 0,
          total: totalPhases,
          message: "Workflow failed."
        }
      });
      await sendTelegramTaskManagerUpdate(
        taskId,
        buildTelegramManagerFallback({
          requestText: planTask?.prompt ?? "",
          summary: { error: errorMsg }
        })
      );
      if (mainWindow) {
        mainWindow.webContents.send("assistant:streamError", { error: errorMsg });
      }
      return { error: errorMsg, parentTaskId: taskId, conversationId };
    }
  };

  ipcMain.handle("assistant:taskList", async (_event, filters) => {
    const store = getTaskStore();
    return store.list(filters ?? { limit: 50 });
  });

  ipcMain.handle("assistant:getTask", async (_event, taskId) => {
    const store = getTaskStore();
    return store.get(taskId);
  });

  ipcMain.handle("assistant:cancelTask", async (_event, taskId) => {
    const store = getTaskStore();
    const task = store.get(taskId);
    if (task && (task.status === "running" || task.status === "pending" || task.status === "awaiting_approval")) {
      store.update(taskId, { status: "cancelled", error: "Cancelled by user" });
      await store.save();
      return { ok: true };
    }
    return { error: "Task not cancellable" };
  });

  ipcMain.handle("assistant:clearTasks", async () => {
    const store = getTaskStore();
    const tasks = store.list({ limit: 500 });
    let cleared = 0;
    for (const task of tasks) {
      if (task.status === "running" || task.status === "pending") {
        store.update(task.id, { status: "cancelled", error: "Bulk cancelled" });
        cleared++;
      }
    }
    await store.save();
    return { cleared };
  });

  ipcMain.handle("assistant:getAuditTrail", async (_event, filters) => {
    const store = getTaskStore();
    return store.getAuditTrail(filters ?? { limit: 100 });
  });

  ipcMain.handle("assistant:getPolicy", async () => {
    const engine = getPolicyEngine();
    return {
      profile: engine.profile,
      approvedFolders: engine.approvedFolders,
      approvedApps: engine.approvedApps
    };
  });

  ipcMain.handle("assistant:runMicrosoft365DeviceCode", async (_event, payload) => {
    const schema = z.object({
      clientId: z.string().min(1),
      tenantId: z.string().min(1)
    });
    const { clientId, tenantId } = schema.parse(payload);
    try {
      const { runDeviceCodeFlow } = await import("@wcjr/mail-calendar");
      const { refreshToken } = await runDeviceCodeFlow({
        clientId,
        tenantId,
        onMessage: (message) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("assistant:deviceCodeMessage", message);
          }
        }
      });
      await writeMailCalendarConfig({ clientId, tenantId, refreshToken });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("assistant:getMailCalendarConfigPath", () => mailCalendarConfigPath());

  ipcMain.handle("assistant:setMessagingConfig", async (_event, payload) => {
    const schema = z.object({
      enabled: z.boolean(),
      channel: z.enum(["telegram", "stub"]),
      botToken: z.string().optional(),
      allowedChatIds: z.array(z.number()).optional()
    });
    const parsed = schema.parse(payload);
    if (!appConfig.messaging) appConfig.messaging = {};
    appConfig.messaging.enabled = parsed.enabled;
    appConfig.messaging.channel = parsed.channel;
    if (Object.hasOwn(parsed, "botToken")) appConfig.messaging.botToken = parsed.botToken ?? "";
    if (parsed.allowedChatIds !== undefined) appConfig.messaging.allowedChatIds = normalizeAllowedChatIds(parsed.allowedChatIds);
    await saveConfig();
    await startMessagingBridge();
    return {
      enabled: appConfig.messaging.enabled,
      channel: appConfig.messaging.channel,
      hasToken: !!getMessagingBotToken(appConfig.messaging),
      allowedChatIds: normalizeAllowedChatIds(appConfig.messaging.allowedChatIds)
    };
  });

  ipcMain.handle("assistant:hasMailCalendarConfig", async () => {
    const config = readMailCalendarConfigSync();
    return !!(config?.clientId && config?.tenantId && getMailCalendarRefreshToken(config));
  });

  ipcMain.handle("assistant:setTheme", async (_event, themeId) => {
    if (!isValidTheme(themeId)) {
      return appConfig.theme ?? "midnight";
    }
    appConfig.theme = themeId;
    await saveConfig();
    return appConfig.theme;
  });

  ipcMain.handle("assistant:setSandboxPreference", async (_event, value) => {
    if (value !== "manual" && value !== "risky") return appConfig.sandboxPreference;
    appConfig.sandboxPreference = value;
    await saveConfig();
    return appConfig.sandboxPreference;
  });

  ipcMain.handle("assistant:setPolicy", async (_event, payload) => {
    const schema = z.object({
      profile: z.enum(Object.values(POLICY_PROFILES)),
      approvedFolders: z.array(z.string()).optional(),
      approvedApps: z.array(z.string()).optional()
    });
    const parsed = schema.parse(payload);
    if (!appConfig.policy) appConfig.policy = {};
    appConfig.policy.profile = parsed.profile;
    if (parsed.approvedFolders != null) appConfig.policy.approvedFolders = parsed.approvedFolders;
    if (parsed.approvedApps != null) appConfig.policy.approvedApps = parsed.approvedApps;
    getPolicyEngine().setProfile(parsed.profile);
    getPolicyEngine().approvedFolders = parsed.approvedFolders ?? getPolicyEngine().approvedFolders;
    getPolicyEngine().approvedApps = parsed.approvedApps ?? getPolicyEngine().approvedApps;
    await saveConfig();
    return { profile: getPolicyEngine().profile, approvedFolders: getPolicyEngine().approvedFolders, approvedApps: getPolicyEngine().approvedApps };
  });

  ipcMain.handle("assistant:getKnowledgeCollections", async () => {
    try {
      const result = await orchestrator.callMcpTool("Qdrant RAG", "knowledge_list", {});
      return JSON.parse(result?.content?.[0]?.text ?? "[]");
    } catch (err) {
      return { error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("assistant:ingestToKnowledge", async (_event, { source, collection, tags }) => {
    try {
      const result = await orchestrator.callMcpTool("Qdrant RAG", "knowledge_ingest", {
        source,
        collection,
        tags: tags ?? {}
      });
      return JSON.parse(result?.content?.[0]?.text ?? "{}");
    } catch (err) {
      return { error: err.message ?? String(err) };
    }
  });

  ipcMain.handle("assistant:deleteFromKnowledge", async (_event, { collection, source, filter, deleteEntireCollection }) => {
    try {
      const result = await orchestrator.callMcpTool("Qdrant RAG", "knowledge_delete", {
        collection,
        source,
        filter,
        deleteEntireCollection: deleteEntireCollection ?? false
      });
      return JSON.parse(result?.content?.[0]?.text ?? "{}");
    } catch (err) {
      return { error: err.message ?? String(err) };
    }
  });
}

async function startMessagingBridge() {
  if (messagingBridge) {
    try {
      await messagingBridge.disconnect();
    } catch {}
    messagingBridge = null;
  }
  const messaging = appConfig?.messaging ?? {};
  const botToken = getMessagingBotToken(messaging);
  if (!messaging.enabled || !messaging.channel) {
    return;
  }
  if (messaging.channel === "telegram" && !botToken) {
    return;
  }
  if (messaging.channel === "whatsapp" && !messaging.wahaApiKey) {
    return;
  }

  const channelConfig = messaging.channel === "whatsapp"
    ? {
        wahaUrl: messaging.wahaUrl || "http://localhost:3000",
        apiKey: messaging.wahaApiKey || "",
        hmacSecret: messaging.wahaHmacSecret || "",
        session: messaging.wahaSession || "default",
        allowedChatIds: normalizeAllowedChatIds(messaging.allowedChatIds)
      }
    : {
        botToken,
        allowedChatIds: normalizeAllowedChatIds(messaging.allowedChatIds)
      };
  messagingBridge = createChannel(messaging.channel, channelConfig);
  try {
    await messagingBridge.connect(async (cmd) => {
      logStartup(`Remote command received (${cmd.channel}:${cmd.id})`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("assistant:remoteCommand", { commandId: cmd.id, text: cmd.text });
      }
      const trimmedText = String(cmd.text ?? "").trim();
      if (trimmedText === "/start" || trimmedText === "/help") {
        if (messagingBridge) {
          await messagingBridge.replyToCommand(
            cmd.id,
            [
              "WCJR Assistant remote commander is online.",
              "",
              "Send any normal message to give me a task.",
              "Useful commands:",
              "/status - confirm the bot and desktop app are online",
              "/help - show this help message"
            ].join("\n")
          );
        }
        return;
      }
      if (trimmedText === "/status") {
        if (messagingBridge) {
          await messagingBridge.replyToCommand(
            cmd.id,
            "WCJR Assistant is online and ready. Send me a task to begin."
          );
        }
        return;
      }

      // ── Plan approval via Telegram ──────────────────────────────────────────
      if (trimmedText === "/approve" || trimmedText === "/reject") {
        const pending = pendingTelegramPlans.get(cmd.chatId);
        if (!pending) {
          if (messagingBridge) {
            await messagingBridge.replyToCommand(cmd.id, "No pending plan to approve. Send a task first.");
          }
          return;
        }
        pendingTelegramPlans.delete(cmd.chatId);

        if (trimmedText === "/reject") {
          if (messagingBridge) {
            await messagingBridge.replyToCommand(cmd.id, "Plan rejected. Send a new task when ready.");
          }
          return;
        }

        // /approve — execute the approved plan
        if (messagingBridge) {
          messagingBridge.sendUpdate({
            taskId: pending.taskId,
            commandId: cmd.id,
            chatId: cmd.chatId,
            type: "progress",
            summary: "Plan approved. Executing now — I\'ll update you when done."
          }).catch(() => {});
        }

        try {
          const store = getTaskStore();
          const planTask = store.get(pending.taskId);
          if (!planTask?.pendingExecutionPlan) {
            await messagingBridge?.replyToCommand(cmd.id, "Plan no longer available. Please send a new task.");
            return;
          }
          // Inline the plan execution (same as approvePlan IPC handler)
          const approvePayload = {
            taskId: pending.taskId,
            conversationId: pending.conversationId
          };
          // Trigger via internal IPC equivalent — reuse the ipcMain handler
          const approveResult = await (async () => {
            const { taskId, conversationId } = approvePayload;
            const taskStore2 = getTaskStore();
            const conversationStoreRef = getConversationStore();
            const memoryStoreRef = getMemoryStore();
            const planTask2 = taskStore2.get(taskId);
            const rawPlan = planTask2?.pendingExecutionPlan;
            const normalized = normalizeExecutionPlan(rawPlan);
            if (!normalized?.phases?.length) return { error: "No pending plan." };
            const session = conversationStoreRef.getSession(conversationId);
            if (!session) return { error: "Conversation not found." };
            // Mark as running
            taskStore2.update(taskId, {
              pendingExecutionPlan: null,
              status: TASK_STATUS.RUNNING,
              progress: { current: 0, total: normalized.phases.length, message: "Workflow approved via Telegram." }
            });
            await taskStore2.save();
            // Re-run using the approval IPC handler logic directly
            // (This calls the same internal function that the desktop UI uses)
            return { taskId, conversationId, approved: true };
          })();

          if (approveResult?.error) {
            await messagingBridge?.replyToCommand(cmd.id, "Error: " + approveResult.error);
            return;
          }

          // Now trigger the actual plan execution by calling the registered handler logic
          // We simulate what ipcMain "assistant:approvePlan" does
          const approvalResult = await new Promise((resolve) => {
            // Use a fake event to call the registered handler
            const handler = ipcMain._events?.["assistant:approvePlan"]?.[0]
              ?? ipcMain._events?.["assistant:approvePlan"];
            if (typeof handler === "function") {
              handler({}, { taskId: pending.taskId, conversationId: pending.conversationId })
                .then(resolve).catch(e => resolve({ error: e.message }));
            } else {
              // Fallback: import the handler inline
              resolve({ error: "Cannot invoke approvePlan handler" });
            }
          });

          if (approvalResult?.error) {
            await messagingBridge?.replyToCommand(cmd.id, "Plan execution error: " + approvalResult.error);
          }
          // The approvePlan handler will call sendTelegramTaskManagerUpdate when done
        } catch (approveErr) {
          await messagingBridge?.replyToCommand(cmd.id, "Failed to execute plan: " + (approveErr.message ?? String(approveErr)));
        }
        return;
      }
      // ── End plan approval ───────────────────────────────────────────────────
      try {
        if (messagingBridge) {
          messagingBridge
            .sendUpdate({
              taskId: cmd.id,
              commandId: cmd.id,
              chatId: cmd.chatId,
              type: "progress",
              summary: "Working on it. I’ll come back with the outcome, any blocker, and the next step."
            })
            .catch(() => {});
        }
        const summary = await runAssistantTaskRequest(
          {
            prompt: trimmedText,
            executionMode: appConfig?.executionMode ?? "plan_first"
          },
          {
            remoteOrigin: {
              channel: "telegram",
              chatId: cmd.chatId,
              commandId: cmd.id,
              from: cmd.from
            }
          }
        );
        if (summary?.pendingApproval && summary?.taskId && summary?.conversationId) {
          // Store pending plan keyed by chatId so /approve can resume it
          pendingTelegramPlans.set(cmd.chatId, {
            taskId: summary.taskId,
            conversationId: summary.conversationId
          });
          // Build plan preview text
          const planSummary = summary?.content
            ? String(summary.content).slice(0, 1200)
            : "A multi-phase workflow has been planned.";
          const approvalMsg = [
            "📋 *Plan ready for approval*",
            "",
            planSummary,
            "",
            "Reply */approve* to run this plan, or */reject* to cancel."
          ].join("\n");
          if (messagingBridge) {
            await messagingBridge.replyToCommand(cmd.id, approvalMsg);
          }
        } else {
          const resultText = await buildTelegramManagerReply({
            requestText: trimmedText,
            summary
          });
          if (messagingBridge) {
            await messagingBridge.replyToCommand(cmd.id, resultText);
          }
        }
      } catch (err) {
        const errMsg = err.message ?? String(err);
        if (messagingBridge) {
          await messagingBridge.replyToCommand(
            cmd.id,
            buildTelegramManagerFallback({
              requestText: trimmedText,
              summary: { error: errMsg }
            })
          );
        }
      }
    });
    logStartup("Messaging bridge connected");
  } catch (err) {
    logStartup("Messaging bridge failed", err);
    messagingBridge = null;
  }
}

// ── Webhook HTTP server for WhatsApp (WAHA) and n8n triggers ───────────────
let webhookServer = null;

function startWebhookServer() {
  const messaging = appConfig?.messaging ?? {};
  const isWhatsApp = messaging.enabled && messaging.channel === "whatsapp";
  const n8nEnabled = appConfig?.n8nIntegration !== false;

  // Always start — serves MCP tool API for n8n, WhatsApp webhooks, and health check
  const port = parseInt(process.env.APP_PORT ?? "4000", 10);

  webhookServer = http.createServer((req, res) => {
    let body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(body);

      // --- WhatsApp webhook ---
      if (req.method === "POST" && req.url === "/api/whatsapp/webhook") {
        logStartup(`Webhook received: ${rawBody.toString().slice(0, 200)}`);
        if (!messagingBridge?.handleWebhook) {
          logStartup("Webhook rejected: bridge not active");
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "WhatsApp bridge not active" }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString());
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        logStartup(`Webhook event: ${parsed.event}, from: ${parsed.payload?.from ?? "?"}, body: ${(parsed.payload?.body ?? "").slice(0, 80)}`);
        const signature = req.headers["x-webhook-hmac"] ?? "";
        const result = messagingBridge.handleWebhook(rawBody, parsed, signature);
        logStartup(`Webhook result: ${JSON.stringify(result.body)}`);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }

      // --- n8n trigger ---
      if (req.method === "POST" && req.url === "/api/n8n/trigger") {
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString());
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("assistant:n8nTrigger", parsed);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // --- MCP tools listing (for n8n MCP Client Tool) ---
      if (req.method === "GET" && req.url === "/api/mcp/tools") {
        try {
          const summary = orchestrator?.mcpHub?.getToolSummary?.() ?? [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ tools: summary }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // --- MCP tool call (for n8n MCP Client Tool) ---
      if (req.method === "POST" && req.url === "/api/mcp/call") {
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString());
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const { server, tool, arguments: args } = parsed;
        if (!server || !tool) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing server or tool" }));
          return;
        }
        try {
          const result = await orchestrator.mcpHub.callTool(server, tool, args ?? {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // --- Health check ---
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
  });

  webhookServer.listen(port, () => {
    logStartup(`Webhook HTTP server listening on port ${port}`);
  });
  webhookServer.on("error", (err) => {
    logStartup("Webhook server failed to start", err);
    webhookServer = null;
  });
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    logStartup("App ready");
    appConfig = await loadConfig();
    await migrateMailCalendarConfig();
    await saveConfig();
    taskStore = getTaskStore();
    await taskStore.load();
    conversationStore = getConversationStore();
    await conversationStore.load();
    policyEngine = new PolicyEngine(appConfig?.policy ?? {});
    createOrchestrator();
    await orchestrator.connectMcp();
    registerIpcHandlers();
    createWindow();
    await startMessagingBridge();
    startWebhookServer();
  });
}

app.on("window-all-closed", () => {
  logStartup("All windows closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (error) => {
  logStartup("Uncaught exception", error);
});

process.on("unhandledRejection", (error) => {
  logStartup("Unhandled rejection", error instanceof Error ? error : new Error(String(error)));
});
