import { MCPHub } from "@wcjr/mcp-hub";
import { ModelRouter, TASK_TYPES } from "@wcjr/model-router";
import {
  ACTIVITY_PROFILES,
  getMcpPresetDefinitions,
  resolveSkillDefinition
} from "@wcjr/activity-profiles";
import { buildRetrievalContext } from "./retrieval.js";

// ── Model Council: route each specialist agent to the best provider ────────
const SPECIALIST_MODEL_MAP = {
  // Research — Perplexity has built-in web search
  QuestionFramer:     { provider: "perplexity", model: "sonar-pro" },
  ContextRetriever:   { provider: "perplexity", model: "sonar-pro" },

  // Analysis — Claude has best reasoning
  DocumentReviewer:   { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  Analyst:            { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  PolicyChecker:      { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  RiskChecker:        { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  Validator:          { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  SequentialThinker:  { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  Reviewer:           { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },
  InfraReviewer:      { provider: "anthropic", model: "claude-sonnet-4-6-20250514" },

  // Execution — GPT-5.4 for best tool calling
  Implementer:        { provider: "openai", model: "gpt-5.4" },
  Executor:           { provider: "openai", model: "gpt-5.4" },
  ToolRunner:         { provider: "openai", model: "gpt-5.4" },
  OutlookExecutor:    { provider: "openai", model: "gpt-5.4" },
  ExportCoordinator:  { provider: "openai", model: "gpt-5.4" },

  // Documents — Gemini for 1M context window
  Outliner:           { provider: "gemini", model: "gemini-2.5-pro" },
  DraftWriter:        { provider: "gemini", model: "gemini-2.5-pro" },

  // Creative — Grok for diversity
  IdeaGenerator:      { provider: "grok", model: "grok-3-beta" },
  ConceptShaper:      { provider: "grok", model: "grok-3-beta" },

  // Data — GPT-5.4 for structured analysis
  DataProfiler:       { provider: "openai", model: "gpt-5.4" },

  // Planning
  Planner:            { provider: "openai", model: "gpt-5.4" },
  Architect:          { provider: "openai", model: "gpt-5.4" },
  CloudPlanner:       { provider: "openai", model: "gpt-5.4" },
  DependencyMapper:   { provider: "openai", model: "gpt-5.4" },
  WorkflowDesigner:   { provider: "openai", model: "gpt-5.4" },

  // Triage — fast model
  InboxTriage:        { provider: "openai", model: "gpt-5.4-mini" },
  DraftComposer:      { provider: "openai", model: "gpt-5.4" },

  // Synthesis — reliable final output
  Synthesizer:        { provider: "openai", model: "gpt-5.4" },
  StatusSynthesizer:  { provider: "openai", model: "gpt-5.4" },
};

// ── Task Intelligence: complexity + tool routing ──────────────────────────
function assessTaskComplexity(prompt) {
  const p = (prompt ?? "").toLowerCase();
  const wordCount = p.split(/\s+/).length;
  const hasFilePath = /[A-Za-z]:\\/.test(prompt) || /\/\w+\/\w+/.test(prompt);
  const hasFileRef = /\.(xlsx|csv|pdf|docx|doc|txt|json)\b/i.test(prompt);

  // Truly trivial: greetings, single-word commands
  if (wordCount <= 3 && /^(hi|hello|hey|thanks|ok|yes|no|test|ping|status)\b/.test(p)) return "trivial";

  // Complex: multi-step analytical work
  if (/\b(forensic|reconcile|compare|cross.?reference|across|between|all.*and.*all|every|audit|review.*and.*amend)\b/.test(p)) return "complex";
  if (wordCount > 50) return "complex";

  // File-focused: has explicit path or file reference
  if (hasFilePath || hasFileRef) return "file-focused";

  // Research: questions that benefit from web search
  if (/\b(what is|what are|best|recommend|latest|compare|find|research|how to|should i|options for|alternatives)\b/.test(p)) return "research";

  return "standard";
}

/**
 * Determine which retrieval collectors to run based on task intelligence.
 * Returns { skipRetrieval, useWeb, useMail, useFilesystem, useLookeen }
 */
function getRetrievalStrategy(complexity, taskType) {
  switch (complexity) {
    case "trivial":
      return { skipRetrieval: true };
    case "research":
      return { skipRetrieval: false, useWeb: true, useMail: false, useFilesystem: false, useLookeen: false };
    case "file-focused":
      return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: false };
    case "complex":
      // Complex tasks get everything relevant to their type
      if (taskType === "communication") return { skipRetrieval: false, useWeb: false, useMail: true, useFilesystem: false, useLookeen: false };
      if (taskType === "coding" || taskType === "data_analysis") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: false };
      if (taskType === "disputes") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: true, useRag: true };
      return { skipRetrieval: false, useWeb: true, useMail: true, useFilesystem: true, useLookeen: true };
    default:
      // Standard: use task type to guide
      if (taskType === "communication") return { skipRetrieval: false, useWeb: false, useMail: true, useFilesystem: false, useLookeen: false };
      if (taskType === "research") return { skipRetrieval: false, useWeb: true, useMail: false, useFilesystem: false, useLookeen: false };
      if (taskType === "documents" || taskType === "data_analysis") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: false };
      if (taskType === "coding" || taskType === "automation") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: false };
      if (taskType === "disputes") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: true, useRag: true };
      return { skipRetrieval: false, useWeb: true, useMail: false, useFilesystem: true, useLookeen: false };
  }
}

/**
 * Format a provider error into a clean, human-readable one-liner.
 * Catches common API error patterns and strips raw JSON.
 */
function formatProviderError(error, model = "") {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  // Quota / rate limit
  if (lower.includes("429") || lower.includes("quota") || lower.includes("rate limit") || lower.includes("resource_exhausted")) {
    return `quota exceeded`;
  }
  // Model not found / not a chat model
  if (lower.includes("404") || lower.includes("not found") || lower.includes("not a chat model") || lower.includes("does not exist")) {
    return `model not available`;
  }
  // Auth errors
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid") && lower.includes("key")) {
    return `invalid API key`;
  }
  // Connection errors
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("fetch failed")) {
    return `provider unreachable`;
  }
  // Truncate long messages (likely raw JSON dumps)
  if (msg.length > 150) {
    return msg.slice(0, 120).replace(/[{"\\\n]/g, " ").trim() + "...";
  }
  return msg;
}

/** Last N fallback timeline entries for user-visible errors when all models fail. */
function summarizeFallbackAttempts(timeline, max = 4) {
  const details = (timeline ?? [])
    .filter((t) => t.stage === "fallback")
    .map((t) => t.detail);
  if (!details.length) return "";
  const tail = details.slice(-max);
  return ` ${tail.join(" | ")}`;
}

function inferTaskType(prompt) {
  const text = prompt.toLowerCase();

  if (text.includes("code") || text.includes("bug") || text.includes("refactor")) {
    return "coding";
  }
  if (
    /\b(agreement|agreements|contract|contracts|docx|pdf|nda|msa|sow|dpa|redline|renewal|termination)\b/.test(text) ||
    (extractPathHints(prompt).length > 0 &&
      /\b(review|summari[sz]e|compare|audit|analy[sz]e|inspect)\b/.test(text))
  ) {
    return "documents";
  }
  if (text.includes("research") || text.includes("compare") || text.includes("find")) {
    return "research";
  }
  if (text.includes("report") || text.includes("document") || text.includes("presentation")) {
    return "documents";
  }
  if (text.includes("aws") || text.includes("cloudformation") || text.includes("terraform")) {
    return "aws_cloud";
  }
  if (text.includes("data") || text.includes("csv") || text.includes("chart") || text.includes("analy")) {
    return "data_analysis";
  }
  if (text.includes("email") || text.includes("message")) {
    return "communication";
  }
  if (text.includes("automate") || text.includes("script") || text.includes("cleanup")) {
    return "automation";
  }
  if (text.includes("creative") || text.includes("brainstorm") || text.includes("idea")) {
    return "creative";
  }
  return "project_mgmt";
}

function shorten(text, maxChars = 12000) {
  if (!text || text.length <= maxChars) {
    return text;
  }

  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${truncatedChars} characters]`;
}

function flattenToolResult(result) {
  if (!result?.content?.length) {
    return "";
  }

  return result.content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "resource") {
        return item.resource?.text ?? `[resource ${item.resource?.uri ?? "unknown"}]`;
      }
      if (item.type === "resource_link") {
        return `${item.name ?? "resource"}: ${item.uri}`;
      }
      return JSON.stringify(item, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractPathHints(prompt) {
  const seen = new Set();
  const patterns = [
    /`([^`]+)`/g,
    /([A-Za-z]:\\[^\s"'`]+)/g,
    /([.]{1,2}[\\/][^\s"'`]+)/g,
    /((?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.[A-Za-z0-9]+)\b/g,
    /(?:^|[\s(])([A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})(?=$|[\s),])/g
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        seen.add(candidate);
      }
    }
  }

  const ordered = [...seen];
  const filtered = ordered.filter((candidate) => {
    const normalizedCandidate = candidate.replace(/\\/g, "/").toLowerCase();
    if (
      /[\\/]/.test(candidate) &&
      ordered.some(
        (other) =>
          other !== candidate &&
          other.replace(/\\/g, "/").toLowerCase().startsWith(`${normalizedCandidate} `)
      )
    ) {
      return false;
    }
    if (/[\\/]/.test(candidate)) {
      return true;
    }
    const lowerCandidate = candidate.toLowerCase();
    return !ordered.some(
      (other) =>
        other !== candidate &&
        /[\\/]/.test(other) &&
        other.replace(/\\/g, "/").toLowerCase().endsWith(`/${lowerCandidate}`)
    );
  });

  return filtered.slice(0, 3);
}

function pickFilesystemAction(pathHint) {
  if (!pathHint) {
    return null;
  }

  const normalized = pathHint.replace(/\\/g, "/");
  if (normalized.endsWith("/")) {
    return "list_directory";
  }

  const lastSegment = normalized.split("/").pop() ?? normalized;
  return lastSegment.includes(".") ? "read_text_file" : "list_directory";
}

function extractSearchHint(prompt) {
  const quotedSearch =
    prompt.match(/search(?: for)? ["“]([^"”]+)["”]/i) ??
    prompt.match(/find (?:mentions of |references to )["“]([^"”]+)["”]/i);

  return quotedSearch?.[1]?.trim() ?? null;
}

function promptLooksLikeFolderBrowse(prompt) {
  return /\b(files?|folders?|directories?|drives?)\b/i.test(prompt);
}

function promptLooksLikeInboxRequest(prompt) {
  return /\b(email|emails|inbox|latest emails|recent emails|messages)\b/i.test(prompt);
}

function promptLooksLikeCalendarRequest(prompt) {
  return /\b(calendar|schedule|meeting|meetings|event|events|appointments?)\b/i.test(prompt);
}

function getCalendarRange(prompt) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (/\btomorrow\b/i.test(prompt)) {
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 1);
  } else if (/\btoday\b/i.test(prompt)) {
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 1);
  } else {
    end.setDate(end.getDate() + 7);
  }
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function promptLooksLikeDocumentationQuery(prompt, activityId) {
  return (
    activityId === "coding" ||
    activityId === "research" ||
    /\b(docs?|documentation|api|sdk|library|framework|package|integration|configure|setup)\b/i.test(prompt)
  );
}

function extractLikelyLibraryName(prompt) {
  const explicit =
    prompt.match(/\b(?:library|framework|package|sdk)\s+([A-Za-z0-9@._/+:-]+)/i)?.[1] ??
    prompt.match(/\b(?:using|with|for)\s+([A-Za-z0-9@._/+:-]+)\b/i)?.[1] ??
    prompt.match(/`([^`]+)`/)?.[1];
  return explicit?.trim() ?? null;
}

function buildServerContexts(configuredServers, toolSummary) {
  return configuredServers.map((server) => ({
    ...server,
    tools: toolSummary.find((item) => item.server === server.name)?.tools ?? []
  }));
}

function summarizeToolTrace(toolTrace = [], agentName = null) {
  return toolTrace.map((entry) => ({
    server: entry.server,
    tool: entry.tool,
    detail:
      entry.status === "error"
        ? `${agentName ? `${agentName}: ` : ""}${entry.error ?? "Tool failed"}`
        : `${agentName ? `${agentName}: ` : ""}${entry.durationMs ?? 0}ms`,
    status: entry.status === "error" ? "error" : "completed"
  }));
}

function hasPreset(activityProfile, presetId) {
  return activityProfile?.mcpPresets?.includes(presetId);
}

function matchesPreset(serverContext, preset) {
  if (!preset) return false;
  if (preset.kind) {
    return serverContext.kind === preset.kind;
  }
  const haystack = `${serverContext.name} ${serverContext.command ?? ""} ${(serverContext.args ?? []).join(" ")}`.toLowerCase();
  return (preset.serverNamePatterns ?? []).every((pattern) => haystack.includes(pattern.toLowerCase()));
}

function getSkillInstruction(skillId) {
  const skill = skillId ? resolveSkillDefinition(skillId) : null;
  if (!skill) return "";
  switch (skill.id) {
    case "brainstorming":
      return [
        "Operate in Brainstorming mode.",
        "Ask clarifying questions when needed, propose 2-3 approaches with trade-offs, and present a concise design before jumping into action."
      ].join(" ");
    case "document-review":
      return [
        "Operate in Document Review mode.",
        "Extract all documents fully before analysis — never work from partial text.",
        "For each document: map its structure, identify the parties and their positions, perform a forensic pass assessing claims vs evidence, flag internal inconsistencies and gaps.",
        "When multiple documents are provided, cross-reference positions across them and trace how arguments evolve.",
        "Synthesize with: bottom line up front, section-by-section findings, gaps/risks, recommended next steps.",
        "For legal documents: track defined terms, identify burden of proof, assess quantum methodology, check delay causation logic."
      ].join(" ");
    case "using-superpowers":
      return [
        "Apply strict workflow discipline.",
        "Choose the most relevant tools and sub-workflows deliberately, avoid impulsive action, and explain the reasoning behind the selected approach."
      ].join(" ");
    default:
      return "";
  }
}

export function parseOrchestratorPlanBlock(content = "") {
  const match = content.match(/```wcjr-plan\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

const VALID_DEPTH = new Set(["quick", "standard", "forensic"]);

function isValidActivityId(act) {
  return Boolean(act && act !== "orchestrator" && ACTIVITY_PROFILES[act]);
}

function compactPromptText(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function deriveWorkflowPhaseTitle(activity, prompt, explicitTitle) {
  const explicit = compactPromptText(explicitTitle);
  if (explicit) {
    return explicit;
  }

  const normalizedPrompt = compactPromptText(prompt);
  const lowerPrompt = normalizedPrompt.toLowerCase();

  if (/\b(test|tests|verify|verification|validate|validation|check|checks|qa)\b/.test(lowerPrompt)) {
    return "Run tests and verify";
  }
  if (/\b(compare|diff|difference|differences|conflict|conflicts)\b/.test(lowerPrompt)) {
    return "Compare findings";
  }
  if (/\b(amend|revise|redraft|rewrite|update draft|mark up|markup)\b/.test(lowerPrompt)) {
    return "Amend the draft";
  }
  if (/\b(draft|write|prepare|produce|create)\b/.test(lowerPrompt)) {
    return activity === "communication" ? "Prepare the response" : "Produce the deliverable";
  }
  if (/\b(search|find|retrieve|gather|collect|review sources|inspect)\b/.test(lowerPrompt)) {
    return "Review sources";
  }
  if (/\b(analy[sz]e|assess|reason|evaluate|triage|summari[sz]e)\b/.test(lowerPrompt)) {
    return "Analyze what matters";
  }
  if (/\b(apply|implement|change|edit|patch|refactor|fix)\b/.test(lowerPrompt)) {
    return activity === "coding" ? "Apply the changes" : "Execute the changes";
  }

  switch (activity) {
    case "research":
      return "Review sources";
    case "coding":
      return "Apply the code changes";
    case "documents":
      return "Produce the document";
    case "automation":
      return "Run the workflow";
    case "data_analysis":
      return "Analyze the data";
    case "communication":
      return "Prepare the communication";
    case "project_mgmt":
      return "Plan the next actions";
    case "creative":
      return "Develop the draft";
    case "aws_cloud":
      return "Review the infrastructure changes";
    default:
      break;
  }

  if (!normalizedPrompt) {
    return "Run workflow phase";
  }

  const trimmed = normalizedPrompt
    .replace(/^(please|kindly|can you|could you|would you|i need you to)\s+/i, "")
    .replace(/[.?!].*$/, "")
    .trim();
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69).trimEnd()}...`;
}

function looksLikeDeterministicWorkflowPrompt(prompt = "") {
  const text = String(prompt ?? "");
  if (extractPathHints(text).length > 0) {
    return true;
  }
  return (
    /\b(review|summari[sz]e|compare|analy[sz]e|inspect|audit|find|search|check)\b/i.test(text) &&
    /\b(file|files|folder|directory|document|documents|agreement|agreements|contract|contracts|pdf|docx|mailbox|inbox|calendar|meeting|screenshot|image)\b/i.test(text)
  );
}

function buildDeterministicExecutionPlan(prompt) {
  const activity = inferTaskType(prompt) || "project_mgmt";
  const compactPrompt = compactPromptText(prompt);
  return {
    planVersion: 2,
    summary:
      compactPrompt.length <= 120
        ? compactPrompt
        : `${compactPrompt.slice(0, 117).trimEnd()}...`,
    runMode: "direct",
    phases: [
      {
        id: "p1",
        activity,
        title: deriveWorkflowPhaseTitle(activity, prompt, ""),
        prompt: prompt.trim(),
        depth: activity === "documents" || activity === "research" ? "forensic" : "standard",
        parallelGroup: 0,
        dependsOn: [],
        approvalRequired: false
      }
    ]
  };
}

/**
 * Normalizes legacy single-activity plans and v2 multi-phase plans into a common shape.
 * @returns { { planVersion: number, summary?: string, runMode?: string, phases: Array<{ id: string, activity: string, prompt: string, depth: string, model?: string, parallelGroup: number, dependsOn: string[] }> } | null }
 */
export function normalizeExecutionPlan(raw) {
  if (!raw || typeof raw !== "object") return null;

  let phases = [];

  if (Array.isArray(raw.phases) && raw.phases.length > 0) {
    phases = raw.phases.map((p, i) => {
      const activity = p.activity ?? p.proposedActivity;
      const prompt = typeof p.prompt === "string" ? p.prompt : p.executablePrompt ?? "";
      const depth =
        typeof p.depth === "string" && VALID_DEPTH.has(p.depth) ? p.depth : "standard";
      const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : `p${i + 1}`;
      const title = deriveWorkflowPhaseTitle(
        activity,
        prompt,
        typeof p.title === "string" ? p.title : ""
      );
      const parallelGroup =
        typeof p.parallelGroup === "number" && Number.isFinite(p.parallelGroup) ? p.parallelGroup : 0;
      const dependsOn = Array.isArray(p.dependsOn)
        ? p.dependsOn.map((d) => String(d).trim()).filter(Boolean)
        : [];
      const model = typeof p.model === "string" && p.model.trim() ? p.model.trim() : undefined;
      const approvalRequired = p.approvalRequired === true || p.requiresApproval === true;
      return {
        id,
        activity,
        prompt: prompt.trim(),
        depth,
        model,
        parallelGroup,
        dependsOn,
        title,
        approvalRequired
      };
    });
  } else if (isValidActivityId(raw.proposedActivity) && typeof raw.executablePrompt === "string") {
    phases = [
      {
        id: "p1",
        activity: raw.proposedActivity,
        prompt: raw.executablePrompt.trim(),
        depth: "standard",
        model: undefined,
        parallelGroup: 0,
        dependsOn: [],
        title: deriveWorkflowPhaseTitle(raw.proposedActivity, raw.executablePrompt, raw.title),
        approvalRequired: raw.approvalRequired === true || raw.requiresApproval === true
      }
    ];
  }

  if (!phases.length) return null;

  for (const ph of phases) {
    if (!isValidActivityId(ph.activity) || !ph.prompt) {
      return null;
    }
  }

  const ids = new Set(phases.map((p) => p.id));
  if (ids.size !== phases.length) {
    return null;
  }
  for (const ph of phases) {
    for (const dep of ph.dependsOn) {
      if (!ids.has(dep)) return null;
    }
  }

  return {
    planVersion: raw.planVersion === 2 || phases.length > 1 || Array.isArray(raw.phases) ? 2 : 1,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    runMode: raw.runMode === "sandboxed" ? "sandboxed" : "direct",
    phases,
    rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
    steps: Array.isArray(raw.steps) ? raw.steps : undefined
  };
}

export function validateExecutionPlan(plan) {
  return normalizeExecutionPlan(plan) !== null;
}

const ORCHESTRATOR_PLAN_SYSTEM = [
  "You are the top-level Orchestrator for WCJR Assistant — the same conceptual layer as the Telegram remote commander.",
  "Have a natural conversation: clarify goals, constraints, and success criteria. Ask questions when information is missing.",
  "Do NOT claim you have already executed file, mail, desktop, or system actions. Real execution happens only after the user approves a plan in the app.",
  "If you still need clarification, respond conversationally and do NOT include a wcjr-plan block.",
  "When you have enough detail to propose execution, end your message with exactly one fenced JSON block using the language tag wcjr-plan.",
  "The JSON inside the wcjr-plan fence must be valid JSON (double-quoted keys/strings, no comments, no trailing commas) so the app can parse it.",
  "The plan is for internal parsing; keep the human-facing explanation above it short and natural.",
  "Prefer multi-phase plans when the work spans several kinds of work (e.g. research then coding then project management).",
  "V2 shape (preferred for multi-step work):",
  "{",
  '  "planVersion": 2,',
  '  "summary": "one short sentence",',
  '  "runMode": "direct",',
  '  "phases": [',
  "    {",
  '      "id": "p1",',
  '      "activity": "research",',
  '      "title": "short human-readable phase title",',
  '      "prompt": "what to do in this phase (paths, names, constraints)",',
  '      "depth": "quick | standard | forensic",',
  '      "model": "optional explicit model id for this phase",',
  '      "parallelGroup": 0,',
  '      "dependsOn": [],',
  '      "approvalRequired": false',
  "    }",
  "  ]",
  "}",
  "Use parallelGroup: same integer for phases that can run in parallel once their dependsOn ids are satisfied; use dependsOn: [\"p1\"] to sequence after phase id p1.",
  'depth "quick" = fast/shallow; "standard" = balanced; "forensic" = deep/thorough.',
  "Legacy single-phase shape (still supported):",
  "{",
  '  "proposedActivity": "coding",',
  '  "summary": "...",',
  '  "title": "short human-readable phase title",',
  '  "executablePrompt": "...",',
  '  "runMode": "direct"',
  "}",
  'Use "runMode": "sandboxed" only if the user explicitly wants sandbox / isolated execution.',
  "Use short plain-English phase titles like 'Review sources', 'Draft amended agreement', 'Apply code changes', or 'Run tests and verify'.",
  "Activity ids: research, coding, documents, automation, data_analysis, communication, project_mgmt, creative, aws_cloud (not orchestrator).",
  "Keep the human-readable part above the plan friendly and concise."
].join("\n");

function getAgentInstruction(activityProfile, agentName) {
  const activityLabel = activityProfile?.label ?? "General";
  const sharedIntro = `You are acting as the ${agentName} specialist for the ${activityLabel} activity.`;
  switch (agentName) {
    case "Orchestrator":
      return `${sharedIntro} Coordinate specialists, clarify intent, and produce a coherent combined result.`;
    case "Architect":
      return `${sharedIntro} Clarify intent, constraints, architecture, and the smallest viable implementation plan.`;
    case "Implementer":
      return `${sharedIntro} Propose the concrete implementation or operational steps based on the architecture and tool context.`;
    case "Reviewer":
      return `${sharedIntro} Critique the proposed implementation for bugs, regressions, missing tests, and oversights.`;
    case "ToolRunner":
      return `${sharedIntro} Interpret the available MCP/tool context and identify what the tools prove, what they do not prove, and what action should be taken next.`;
    case "QuestionFramer":
      return `${sharedIntro} Reframe the user's question into the clearest sub-questions and research objectives.`;
    case "ContextRetriever":
      return `${sharedIntro} Extract the most relevant tool, docs, and prior context and summarize only the useful signal.`;
    case "SequentialThinker":
      return `${sharedIntro} Break the problem into a careful step-by-step reasoning path and identify decision points.`;
    case "Outliner":
      return `${sharedIntro} Produce a crisp structure for the document or deliverable before drafting.`;
    case "DraftWriter":
      return `${sharedIntro} Draft the deliverable in a concise, business-ready form.`;
    case "DocumentReviewer":
      return `${sharedIntro} Review the draft for clarity, unnecessary scope, and missing supporting detail.`;
    case "ExportCoordinator":
      return `${sharedIntro} Identify the most appropriate output format and any follow-up export or filing actions.`;
    case "InboxTriage":
      return `${sharedIntro} Triage the mail/calendar context and identify the most relevant messages or events.`;
    case "DraftComposer":
      return `${sharedIntro} Draft the most appropriate communication response or message content.`;
    case "PolicyChecker":
      return `${sharedIntro} Evaluate whether the proposed communication is safe, appropriate, and aligned with policy/autonomy settings.`;
    case "OutlookExecutor":
      return `${sharedIntro} Determine whether Graph mail/calendar tools or Desktop Commander / Outlook fallback should be used.`;
    case "Planner":
      return `${sharedIntro} Create a structured execution plan with dependencies and priorities.`;
    case "DependencyMapper":
      return `${sharedIntro} Identify dependencies, blockers, and sequencing constraints.`;
    case "StatusSynthesizer":
      return `${sharedIntro} Summarize the current state, risks, and next actions for a business operator.`;
    case "WorkflowDesigner":
      return `${sharedIntro} Design the operational workflow and identify where automation should occur.`;
    case "Executor":
      return `${sharedIntro} Convert the workflow into concrete executable actions.`;
    case "RiskChecker":
      return `${sharedIntro} Identify operational, data, or policy risks in the plan.`;
    case "DataProfiler":
      return `${sharedIntro} Identify the important structure, patterns, and data quality signals.`;
    case "Analyst":
      return `${sharedIntro} Analyze the data and derive the core insight.`;
    case "Validator":
      return `${sharedIntro} Check whether the analysis is sound and where uncertainty remains.`;
    case "IdeaGenerator":
      return `${sharedIntro} Generate several strong idea options, not just one answer.`;
    case "ConceptShaper":
      return `${sharedIntro} Refine the strongest idea into a clear direction with rationale.`;
    case "CloudPlanner":
      return `${sharedIntro} Identify the relevant cloud architecture and operational considerations.`;
    case "InfraReviewer":
      return `${sharedIntro} Review the cloud plan for risk, security, and maintainability issues.`;
    case "Synthesizer":
    default:
      return `${sharedIntro} You are the FINAL output the user sees. Rules:
1. Output ONLY the direct answer to the user's question. No preamble, no methodology, no "I reviewed..." narrative.
2. NEVER repeat or summarize what the specialists did. The user doesn't know specialists exist and doesn't care.
3. Lead with the answer (numbers, dates, findings), then supporting detail if needed.
4. If something couldn't be determined, say what's missing in one line — don't explain the technical reason.
5. Format for scanning: use tables, bullet points, bold key figures. No walls of text.`;
  }
}

function buildSpecialistPrompt(originalPrompt, enrichedPrompt, priorOutputs, agentName) {
  return [
    `Original request:\n${originalPrompt}`,
    enrichedPrompt !== originalPrompt ? `Latest request with tool context:\n${enrichedPrompt}` : "",
    priorOutputs.length
      ? [
          "Prior specialist outputs:",
          ...priorOutputs.map(
            (output) => `## ${output.agentName}\n${output.content}`
          )
        ].join("\n\n")
      : "",
    `Current specialist: ${agentName}`
  ]
    .filter(Boolean)
    .join("\n\n");
}


// ── Richer per-activity system prompts ──────────────────────────────────────
const ACTIVITY_SYSTEM_PROMPTS = {
  coding: `You are an expert software engineer. Follow this operational sequence:

1. UNDERSTAND BEFORE ACTING — read all relevant files, understand the architecture, existing patterns, and conventions before writing anything.
2. PLAN THE CHANGE — identify which files need modification, what the dependencies are, and what could break.
3. IMPLEMENT COMPLETELY — write full, working implementations. Never truncate with "// ...rest" or placeholder code.
4. FOLLOW CONVENTIONS — match the existing code style exactly (indentation, naming, module patterns, error handling style).
5. VERIFY — trace through edge cases mentally. If shell_exec or test tools are available, run them.
6. SAVE AND COMMIT — use write_text_file to save, git tools to commit with descriptive messages.
7. REPORT — summarise what changed, why, and any follow-up needed.

WHEN DEBUGGING:
- Read the error message carefully. Most errors tell you exactly what's wrong.
- Check the most recent change first — it's usually the cause.
- Don't guess — read the actual code at the failing line.
- Fix the root cause, not the symptom.`,

  research: `You are an expert researcher and analyst. Follow this operational sequence:

1. FRAME THE QUESTION — restate what you're investigating. Identify what a good answer looks like.
2. GATHER SYSTEMATICALLY — use all available tools in parallel:
   - search_memory for prior context and user preferences
   - browser fetch for web sources
   - filesystem tools for local documents
   - mail/calendar search for correspondence
   - rag_search for previously ingested documents
3. VERIFY AND CROSS-REFERENCE — never rely on a single source. Cross-check across at least two independent sources. Flag conflicts.
4. ASSESS CONFIDENCE — HIGH (multiple corroborating sources), MEDIUM (single reliable source), LOW (inference/extrapolation).
5. SYNTHESIZE — lead with the answer, then supporting evidence, then caveats and gaps.
6. CITE SOURCES — reference specific documents, URLs, email subjects, or file paths.
7. IDENTIFY NEXT STEPS — what would strengthen this research if the user wants to go deeper.`,

  data_analysis: `You are a skilled data analyst. Follow this operational sequence:

1. INSPECT — read the data source (CSV, XLSX, JSON, database). Identify structure: columns/fields, data types, row count, null rates.
2. PROFILE — compute descriptive statistics (count, min, max, mean, median, std dev, percentiles) for numeric columns. For categorical columns, show value counts and cardinality.
3. CLEAN — identify and flag: missing values, duplicates, outliers (>3 std dev), inconsistent formats, data type mismatches.
4. ANALYSE — state your analytical approach explicitly before executing. Apply the method, show working.
5. VISUALISE — describe what charts would be most informative (the user can request you generate them).
6. REPORT — structured output: Executive Summary → Data Quality Assessment → Key Findings → Anomalies → Recommendations.
7. EXPORT — use write_report or export tools to save results in the requested format (Markdown, CSV, XLSX).

WHEN CODE IS NEEDED (reconciliation, pivot tables, complex transforms):
- Write Python scripts using pandas for data manipulation and analysis.
- Use the run_command or run_script tool to execute scripts and capture output.
- For Excel reconciliation: load both sheets with pandas, merge/compare on key columns, output differences.
- For pivot tables: use pandas.pivot_table() and format results clearly.
- Always show the script you're running before executing it.
- Parse and summarise the output — don't dump raw script output to the user.`,

  documents: `You are a forensic document analyst and professional writer. Follow this operational sequence:

ANALYSIS MODE (when reviewing existing documents):
1. EXTRACT FULLY — use extract_document_text on every document. If a document is large, extract it and confirm you have the complete text before analysis. Never analyse partial extractions.
2. MAP THE STRUCTURE — identify the document type (contract, pleading, report, letter, agreement), its sections, defined terms, and cross-references.
3. IDENTIFY THE PARTIES — who authored it, who is the audience, what are the competing positions.
4. FORENSIC PASS — for each substantive section:
   a. What claim or assertion is being made?
   b. What evidence or authority supports it?
   c. What is missing, weak, or contradicted by other documents?
   d. Are there internal inconsistencies or shifts from earlier positions?
5. CROSS-REFERENCE — when multiple documents are provided, trace how positions evolve across them. Flag material changes between Letter of Claim, Response, Reply etc.
6. SYNTHESIZE — produce a structured analysis: bottom line up front, then section-by-section findings, then gaps/risks, then recommended next steps.

DRAFTING MODE (when creating documents):
1. Match tone and style to the document type (formal legal, executive summary, technical report).
2. Structure with clear headings and numbered paragraphs.
3. Write complete documents — never use placeholder text or "[insert here]".
4. Use write_markdown or write_report tools to save. Confirm file path and word count.

LEGAL DOCUMENT SPECIFICS:
- Always identify the contract/agreement being referenced and the relevant clauses.
- Track defined terms and use them consistently.
- Distinguish between factual assertions and legal submissions.
- Note where burden of proof lies and whether it has been discharged.
- Flag quantum methodology issues (are primary records exhibited? is the build-up auditable?).
- For delay claims: identify the critical path, the alleged cause, and whether float was consumed.`,

  orchestrator: `You are a strategic workflow planner for an AI assistant with access to local files, email, calendar, web search, document analysis, RAG retrieval, code execution, and 30+ MCP tool connectors. Follow this sequence:

1. CLASSIFY THE GOAL — what is the user actually trying to achieve? Is this research, document analysis, code work, communication, or a multi-domain task?
2. IDENTIFY AVAILABLE CAPABILITIES — check which MCP tools are connected and what the user's setup supports (local models via Ollama, cloud providers, file access, mail access, RAG).
3. DESIGN THE WORKFLOW — break the goal into phases:
   - Each phase has ONE clear output (a document, a finding, a code change, a decision).
   - Assign the best activity type: research, documents, coding, automation, communication, data_analysis, creative, project_mgmt, aws_cloud.
   - Use "forensic" depth for critical analysis, "standard" for normal work, "quick" for simple lookups.
   - Phases that don't depend on each other should run in parallel.
4. WRITE ACTIONABLE PROMPTS — each phase prompt must be specific enough that a specialist agent can execute it without guessing. Include:
   - What to do (verb-first: "Extract the full text of...", "Search mail for...", "Compare sections 4.1 and 4.3...")
   - What tools to use (name them explicitly)
   - What output format is expected
5. ANTICIPATE FAILURES — if a document might be large, tell the agent to verify full extraction. If a search might return nothing, specify fallback steps.
6. OUTPUT — produce a valid wcjr-plan block as specified.

COMMON PATTERNS:
- Document review: extract → map structure → forensic analysis → cross-reference → synthesize
- Research: frame question → parallel search (web + local + mail + RAG) → cross-reference → synthesize
- Code task: read codebase → plan changes → implement → test → commit
- Multi-document legal: extract all docs → identify positions → trace evolution → assess strengths/weaknesses → produce advisory note`,

  automation: `You are a systems automation engineer. When building automation:
1. Prefer robust, idempotent scripts over fragile one-liners.
2. Add error handling and meaningful log messages.
3. Test with a dry-run or --help flag before executing destructive operations.
4. Document what the automation does in a comment block at the top.
5. Use shell_exec tools to validate execution, not just write scripts.`,

  aws_cloud: `You are an AWS cloud engineer. When working with cloud infrastructure:
1. Follow the principle of least privilege for all IAM policies.
2. Prefer IaC (CloudFormation, CDK, Terraform) over console click-ops.
3. Always estimate costs before provisioning.
4. Tag resources with environment, owner, and purpose.
5. Document rollback procedures alongside deployment steps.`,

  project_mgmt: `You are an experienced project manager. When managing tasks:
1. Break goals into SMART objectives (Specific, Measurable, Achievable, Relevant, Time-bound).
2. Identify dependencies and critical path items.
3. Surface blockers and risks proactively.
4. Produce structured outputs: action items with owners, deadlines, and priority.`,

  disputes: `You are a forensic disputes analyst and construction claims specialist. Follow this operational sequence:

EVIDENCE GATHERING:
1. CHECK FOR EXPLICIT PATH — if the user provides a file or folder path, read from it directly using filesystem tools. Do not search if a path is given.
2. QUERY KNOWLEDGE BASE — use knowledge_query to search matter collections. Use metadata filters (assessmentWindow, custodian, documentType) to narrow results.
3. SEARCH LOOKEEN — if the knowledge base returns insufficient results, use Lookeen to search across the full 5M+ indexed corpus.
4. PROMOTE RELEVANT FILES — when Lookeen surfaces relevant documents not yet in the knowledge base, use knowledge_promote to ingest them.

EVIDENCE STANDARDS:
5. VERBATIM QUOTES ONLY — every factual assertion must include an exact quote from the source material. Use the citation field from knowledge_query results. Never paraphrase or summarise evidence.
6. CITATION FORMAT — place the citation immediately after every verbatim quote. Example:
   "The delay to the S278 works is acknowledged" [Email: John Smith to William Rogers, 14 March 2024, Subject: "RE: S278 Works"]
7. NO UNSOURCED ASSERTIONS — if you cannot find evidence for a point, say so explicitly. Do not infer or speculate.

ARTEFACT GENERATION:
8. USE MATTER_ANALYSE — when building chronologies, custodian maps, contested issues, or evidence summaries, call matter_analyse first to gather cited evidence.
9. USE DOCUMENT ENGINES — call create_workbook for xlsx artefacts (chronologies, custodian maps) or create_document for docx artefacts (contested issues, evidence summaries).
10. PERSIST SUMMARIES — after generating any artefact, save a structured summary back into the 'artefacts' collection using knowledge_ingest, tagged with the matter name and analysis type.

DATE FORMAT: DD Month YYYY throughout. Never use MM/DD/YYYY or YYYY-MM-DD in user-facing output.

TERMINOLOGY: Use assessment window identifiers (W4, W5a, W5b) exactly as established in the matter. Use contract-defined terms with initial capitals.`
};

function getActivitySystemPrompt(taskType) {
  return ACTIVITY_SYSTEM_PROMPTS[taskType] ?? null;
}

export class Orchestrator {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.modelRouter = new ModelRouter(config);
    this.mcpHub = new MCPHub(config);
  }

  setRuntimeOptions(options) {
    this.options = {
      ...this.options,
      ...options
    };
  }

  async initialize() {
    return this.mcpHub.connectAll();
  }

  getTaskTypes() {
    return TASK_TYPES;
  }

  inferTaskType(prompt) {
    return inferTaskType(prompt);
  }

  getConfigSnapshot() {
    return {
      modelProfiles: this.modelRouter.getProfiles(),
      mcpServers: this.mcpHub.getServers(),
      mcpStatuses: this.mcpHub.getStatuses()
    };
  }

  updateModelProfiles(nextProfiles) {
    return this.modelRouter.updateProfiles(nextProfiles);
  }

  setMcpServers(servers) {
    return this.mcpHub.setServers(servers);
  }

  async connectMcp() {
    return this.mcpHub.connectAll();
  }

  async collectToolContext(prompt, resolvedTaskType, timeline, emitStatus, memoryItems = [], retrievalStrategy = {}) {
    const configuredServers = this.mcpHub.getServers().filter((server) => server.enabled !== false);
    const statuses = this.mcpHub.getStatuses();
    const hasConnectedServer = statuses.some((status) => status.status === "connected");

    if (configuredServers.length > 0 && !hasConnectedServer) {
      emitStatus("Connecting MCP tools...");
      await this.connectMcp();
    }

    const toolSummary = await this.mcpHub.getToolSummary();
    const serverContexts = buildServerContexts(configuredServers, toolSummary);
    const toolActivity = [];
    const contextSections = [];
    const activityProfile = ACTIVITY_PROFILES[resolvedTaskType] ?? ACTIVITY_PROFILES.project_mgmt;
    const presetDefinitions = getMcpPresetDefinitions(activityProfile.mcpPresets);
    const context7Server = serverContexts.find((server) =>
      matchesPreset(server, presetDefinitions.find((preset) => preset.id === "context7"))
    );
    const sequentialThinkingServer = serverContexts.find((server) =>
      matchesPreset(server, presetDefinitions.find((preset) => preset.id === "sequential-thinking"))
    );

    const brokered = await buildRetrievalContext({
      prompt,
      taskType: resolvedTaskType,
      serverContexts,
      mcpHub: this.mcpHub,
      emitStatus,
      memoryItems,
      strategy: retrievalStrategy
    });
    contextSections.push(...(brokered.contextSections ?? []));
    toolActivity.push(...(brokered.toolActivity ?? []));

    if (
      context7Server &&
      promptLooksLikeDocumentationQuery(prompt, resolvedTaskType) &&
      context7Server.tools.includes("resolve-library-id") &&
      context7Server.tools.includes("query-docs")
    ) {
      const libraryName = extractLikelyLibraryName(prompt);
      if (libraryName) {
        emitStatus(`Querying Context7 docs for ${libraryName}...`);
        try {
          const resolvedLibrary = await this.mcpHub.callTool(context7Server.name, "resolve-library-id", {
            query: prompt,
            libraryName
          });
          const resolvedText = flattenToolResult(resolvedLibrary);
          const libraryId = resolvedText.match(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?/)?.[0];
          if (libraryId) {
            const docs = await this.mcpHub.callTool(context7Server.name, "query-docs", {
              libraryId,
              query: prompt
            });
            const docsText = shorten(flattenToolResult(docs), 9000);
            if (docsText) {
              contextSections.push(
                `Tool: ${context7Server.name}.query-docs\nLibrary: ${libraryId}\n${docsText}`
              );
              toolActivity.push({
                server: context7Server.name,
                tool: "query-docs",
                detail: libraryId
              });
            }
          } else {
            toolActivity.push({
              server: context7Server.name,
              tool: "resolve-library-id",
              detail: `No library id found for ${libraryName}`
            });
          }
        } catch (error) {
          toolActivity.push({
            server: context7Server.name,
            tool: "query-docs",
            detail: error instanceof Error ? error.message : String(error),
            status: "error"
          });
        }
      }
    }

    if (sequentialThinkingServer) {
      timeline.push({
        stage: "strategy",
        detail: `Sequential Thinking preset available via '${sequentialThinkingServer.name}'`
      });
    }

    if (toolActivity.length > 0) {
      timeline.push({
        stage: "retrieval",
        detail: `${toolActivity.length} broker/tool action(s) executed`
      });
    }

    return { toolSummary, toolActivity, contextSections };
  }

  async executeOrchestratorPlanPhase({
    prompt,
    taskContext,
    conversationMessages = [],
    memoryContext = "",
    skillId,
    modelOverride,
    runMode = "direct",
    timeline
  }) {
    const sanitizedConversationMessages = (conversationMessages ?? []).filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0
    );
    const systemMessage = [
      ORCHESTRATOR_PLAN_SYSTEM,
      getSkillInstruction(skillId),
      memoryContext
        ? `Remembered user context:\n${memoryContext}\nUse these memories only when they are relevant.`
        : ""
    ]
      .filter(Boolean)
      .join("\n\n");

    timeline.push({
      stage: "orchestrator",
      detail: "Planning / conversation phase (no automatic MCP tools)"
    });

    const selectedModel = this.modelRouter.selectModel("orchestrator", modelOverride);
    const fallbackChain = this.modelRouter.getFallbackChain(selectedModel);
    let lastError = null;

    const emitStatus = (text) => {
      if (this.options.emitStatus) {
        this.options.emitStatus(text);
      }
      if (taskContext?.onProgress) {
        taskContext.onProgress({ current: 0, total: 1, message: text });
      }
    };

    for (const candidateModel of fallbackChain) {
      const providerId = this.options.resolveProvider?.(candidateModel);
      if (!providerId) {
        timeline.push({
          stage: "fallback",
          detail: `Skipped '${candidateModel}' because no provider resolver matched it`
        });
        continue;
      }

      const hasKey = this.options.hasApiKey ? await this.options.hasApiKey(providerId) : false;
      if (!hasKey) {
        timeline.push({
          stage: "fallback",
          detail: `Skipped '${candidateModel}' because ${providerId} has no configured key`
        });
        continue;
      }

      emitStatus(`Orchestrator (${providerId} / ${candidateModel})...`);
      try {
        const result = await this.options.invokeModel({
          providerId,
          model: candidateModel,
          prompt,
          messages: [
            { role: "system", content: systemMessage },
            ...sanitizedConversationMessages,
            { role: "user", content: prompt }
          ],
          taskType: "orchestrator",
          skipTools: true,
          taskContext
        });

        const plan = parseOrchestratorPlanBlock(result.content);
        const normalized = normalizeExecutionPlan(plan);
        const fallbackPlan =
          normalized === null && looksLikeDeterministicWorkflowPrompt(prompt)
            ? normalizeExecutionPlan(buildDeterministicExecutionPlan(prompt))
            : null;
        const executionPlan = normalized ?? fallbackPlan;
        const pendingApproval = executionPlan !== null;
        const content = fallbackPlan
          ? "I can work directly against that local context. I prepared a workflow to inspect it once you approve it."
          : result.content;

        timeline.push({
          stage: "result",
          detail: pendingApproval
            ? fallbackPlan
              ? "Execution plan synthesized from an explicit local-context request"
              : "Execution plan ready — awaiting user approval"
            : "Orchestrator turn (no plan block)"
        });
        if (taskContext?.onAudit) {
          taskContext.onAudit(pendingApproval ? "plan_pending" : "orchestrator_turn", {
            phaseCount: executionPlan?.phases?.length ?? 0,
            firstActivity: executionPlan?.phases?.[0]?.activity ?? null,
            synthesizedPlan: fallbackPlan !== null
          });
        }

        return {
          taskType: "orchestrator",
          model: candidateModel,
          provider: providerId,
          content,
          usage: result.usage ?? null,
          timeline,
          toolSummary: [],
          toolActivity: [],
          runMode,
          pendingApproval,
          executionPlan: pendingApproval ? executionPlan : null,
          fallbackChain
        };
      } catch (error) {
        lastError = error;
        timeline.push({
          stage: "fallback",
          detail: `${candidateModel}: ${formatProviderError(error, candidateModel)}`
        });
      }
    }

    return {
      error: lastError
        ? `Orchestrator planning failed: ${lastError.message ?? String(lastError)}`
        : "No configured model with a usable API key was available for orchestrator planning.",
      taskType: "orchestrator",
      timeline,
      toolSummary: [],
      toolActivity: [],
      runMode,
      pendingApproval: false,
      executionPlan: null,
      fallbackChain
    };
  }

  async executeTask({
    prompt,
    taskType,
    modelOverride,
    runMode = "direct",
    taskContext,
    conversationMessages = [],
    memoryItems = [],
    memoryContext = "",
    skillId = null,
    executionPhase = "execute",
    quietMode = false
  } = {}) {
    const resolvedTaskType = taskType || inferTaskType(prompt);
    const activityProfile = ACTIVITY_PROFILES[resolvedTaskType] ?? ACTIVITY_PROFILES.project_mgmt;
    const timeline = [];
    const emitStatus = (text) => {
      if (!quietMode && this.options.emitStatus) {
        this.options.emitStatus(text);
      }
      if (taskContext?.onProgress) {
        taskContext.onProgress({ current: 0, total: 1, message: text });
      }
    };

    timeline.push({
      stage: "classify",
      detail: `Task classified as '${resolvedTaskType}'`
    });
    if (taskContext?.onAudit) {
      taskContext.onAudit("task_classified", { taskType: resolvedTaskType });
    }
    if (skillId) {
      timeline.push({
        stage: "skill",
        detail: `Skill mode '${skillId}' applied`
      });
      if (taskContext?.onAudit) {
        taskContext.onAudit("skill_applied", { skillId });
      }
    }

    if (resolvedTaskType === "orchestrator" && executionPhase === "plan") {
      return await this.executeOrchestratorPlanPhase({
        prompt,
        taskContext,
        conversationMessages,
        memoryContext,
        skillId,
        modelOverride,
        runMode,
        timeline
      });
    }

    let toolSummary = [];
    let toolActivity = [];
    let contextSections = [];
    let toolTrace = [];
    const complexity = assessTaskComplexity(prompt);

    const retrievalStrategy = getRetrievalStrategy(complexity, resolvedTaskType);
    timeline.push({ stage: "strategy", detail: `Complexity: ${complexity} | Web: ${!!retrievalStrategy.useWeb} | Mail: ${!!retrievalStrategy.useMail} | Files: ${!!retrievalStrategy.useFilesystem}` });

    if (retrievalStrategy.skipRetrieval) {
      timeline.push({ stage: "shortcut", detail: "Trivial task — skipping retrieval" });
    } else if (runMode === "sandboxed") {
      const collected = await this.collectToolContext(
        prompt,
        resolvedTaskType,
        timeline,
        emitStatus,
        memoryItems,
        retrievalStrategy
      );
      toolSummary = collected.toolSummary;
      toolActivity = collected.toolActivity;
      contextSections = collected.contextSections;
    } else {
      const configuredServers = this.mcpHub.getServers().filter((server) => server.enabled !== false);
      const statuses = this.mcpHub.getStatuses();
      const hasConnectedServer = statuses.some((status) => status.status === "connected");

      if (configuredServers.length > 0 && !hasConnectedServer) {
        emitStatus("Connecting MCP tools...");
        await this.connectMcp();
      }

      toolSummary = await this.mcpHub.getToolSummary();

      if (configuredServers.length > 0) {
        const collected = await this.collectToolContext(
          prompt,
          resolvedTaskType,
          timeline,
          emitStatus,
          memoryItems,
          retrievalStrategy
        );
        toolSummary = collected.toolSummary;
        toolActivity = collected.toolActivity;
        contextSections = collected.contextSections;
      }
    }

    if (taskContext?.onToolActivity && toolActivity?.length) {
      taskContext.onToolActivity(toolActivity);
    }
    const toolCount = toolSummary.reduce((sum, item) => sum + item.tools.length, 0);
    const discoveredToolText = `${toolSummary.length} MCP server(s) connected, ${toolCount} tool(s) discovered`;
    timeline.push({
      stage: "tooling",
      detail: discoveredToolText
    });

    const enrichedPrompt = contextSections.length
      ? [
          prompt,
          "",
          "Local tool context:",
          contextSections.join("\n\n---\n\n"),
          "",
          "Use the local tool context above when it is relevant. If it is incomplete, say what is missing."
        ].join("\n")
      : prompt;

    const sanitizedConversationMessages = (conversationMessages ?? []).filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0
    );
    const systemMessage = [
      "You are a highly capable personal assistant. Be concise, accurate, and actionable.",
      getSkillInstruction(skillId),
      memoryContext
        ? `Remembered user context:\n${memoryContext}\nUse these memories only when they are relevant, and ask for clarification if uncertain.`
        : ""
    ]
      .filter(Boolean)
      .join("\n\n");
    const specialistAgents = activityProfile.specialistAgents ?? ["Synthesizer"];

    if (runMode === "sandboxed") {
      const sandboxStatus = this.options.detectSandboxStatus
        ? await this.options.detectSandboxStatus()
        : { available: false, reason: "Sandbox detection not configured" };

      timeline.push({
        stage: "sandbox",
        detail: sandboxStatus.available
          ? `Using NemoClaw/OpenShell sandbox '${sandboxStatus.sandboxName}'`
          : `Sandboxed mode unavailable: ${sandboxStatus.reason}`
      });

      if (!sandboxStatus.available || !this.options.runSandboxedTask) {
        return {
          error: `Sandboxed mode is unavailable: ${sandboxStatus.reason ?? "not configured"}`,
          taskType: resolvedTaskType,
          timeline,
          toolSummary,
          toolActivity,
          toolTrace,
          runMode
        };
      }

      emitStatus(`Routing this run through sandbox '${sandboxStatus.sandboxName}'...`);
      try {
        const sandboxPrompt = sanitizedConversationMessages.length
          ? [
              getSkillInstruction(skillId) ? `${getSkillInstruction(skillId)}\n` : "",
              memoryContext ? `Remembered user context:\n${memoryContext}\n` : "",
              "Conversation so far:",
              ...sanitizedConversationMessages.map((message) =>
                `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`
              ),
              "",
              `Latest user message: ${enrichedPrompt}`
            ].join("\n")
          : [getSkillInstruction(skillId), enrichedPrompt].filter(Boolean).join("\n\n");
        const result = await this.options.runSandboxedTask({
          prompt: sandboxPrompt,
          taskType: resolvedTaskType,
          onChunk: quietMode ? undefined : (chunkText) => {
            if (this.options.emitText) {
              this.options.emitText(chunkText);
            }
          }
        });

        timeline.push({
          stage: "result",
          detail: "Sandboxed execution completed"
        });
        if (taskContext?.onAudit) {
          taskContext.onAudit("sandbox_completed", { model: result.model });
        }

        return {
          taskType: resolvedTaskType,
          model: result.model ?? "nemoclaw/openclaw",
          provider: "nemoclaw",
          content: result.content,
          usage: result.usage ?? null,
          timeline,
          toolSummary,
          toolActivity,
          toolTrace,
          runMode,
          sandboxStatus
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          taskType: resolvedTaskType,
          timeline,
          toolSummary,
          toolActivity,
          toolTrace,
          runMode,
          sandboxStatus
        };
      }
    }

    const selectedModel = this.modelRouter.selectModel(resolvedTaskType, modelOverride);
    const fallbackChain = this.modelRouter.getFallbackChain(selectedModel);

    timeline.push({
      stage: "model",
      detail: `Primary model '${selectedModel}' selected (complexity: ${complexity})`
    });

    let lastError = null;
    const aggregateToolActivity = [...toolActivity];
    const aggregateToolTrace = [...toolTrace];

    for (const candidateModel of fallbackChain) {
      const providerId = this.options.resolveProvider?.(candidateModel);
      if (!providerId) {
        timeline.push({
          stage: "fallback",
          detail: `Skipped '${candidateModel}' because no provider resolver matched it`
        });
        continue;
      }

      const hasKey = this.options.hasApiKey
        ? await this.options.hasApiKey(providerId)
        : false;

      if (!hasKey) {
        timeline.push({
          stage: "fallback",
          detail: `Skipped '${candidateModel}' because ${providerId} has no configured key`
        });
        continue;
      }

      emitStatus(`Using ${providerId} / ${candidateModel} for '${resolvedTaskType}' task...`);
      try {
        // ── Simple tasks: skip specialist agents, single model call ──
        if (complexity === "trivial") {
          timeline.push({ stage: "shortcut", detail: "Simple task — skipping specialist chain" });
          const result = await this.options.invokeModel({
            providerId,
            model: candidateModel,
            prompt: enrichedPrompt,
            messages: [
              { role: "system", content: [systemMessage, getActivitySystemPrompt(resolvedTaskType)].filter(Boolean).join("\n\n") },
              ...sanitizedConversationMessages,
              { role: "user", content: enrichedPrompt }
            ],
            taskType: resolvedTaskType,
            taskContext
          });
          if (result.toolTrace?.length) {
            aggregateToolTrace.push(...result.toolTrace);
            aggregateToolActivity.push(...summarizeToolTrace(result.toolTrace));
          }
          timeline.push({ stage: "result", detail: `Completed with ${providerId} / ${candidateModel}` });
          return {
            taskType: resolvedTaskType,
            model: candidateModel,
            provider: providerId,
            content: result.content,
            agentRuns: [{ agentName: "direct", content: result.content }],
            toolSummary,
            toolActivity: aggregateToolActivity,
            toolTrace: aggregateToolTrace,
            timeline,
            runMode,
            fallbackChain
          };
        }

        // ── Standard/complex tasks: full specialist agent chain ──
        const specialistOutputs = [];
        for (const agentName of specialistAgents.slice(0, -1)) {
          // Model council: pick best provider ONLY for non-tool agents (suppressStream: true skips tools)
          const council = SPECIALIST_MODEL_MAP[agentName];
          let agentProvider = providerId;
          let agentModel = candidateModel;
          if (council && council.provider === providerId) {
            // Same provider — safe to use council model
            agentModel = council.model;
          }
          // Cross-provider routing disabled until tool format conversion is implemented
          // TODO: add tool format conversion per provider to enable full model council

          emitStatus(`${activityProfile.label}: ${agentName} (${agentProvider}/${agentModel})...`);
          const phaseResult = await this.options.invokeModel({
            providerId: agentProvider,
            model: agentModel,
            prompt: enrichedPrompt,
            messages: [
              {
                role: "system",
                content: [systemMessage, getAgentInstruction(activityProfile, agentName)].filter(Boolean).join("\n\n")
              },
              ...sanitizedConversationMessages,
              {
                role: "user",
                content: buildSpecialistPrompt(prompt, enrichedPrompt, specialistOutputs, agentName)
              }
            ],
            taskType: resolvedTaskType,
            suppressStream: true,
            taskContext
          });

          specialistOutputs.push({
            agentName,
            content: phaseResult.content
          });
          if (phaseResult.toolTrace?.length) {
            const tracedItems = phaseResult.toolTrace.map((entry) => ({
              ...entry,
              agentName
            }));
            aggregateToolTrace.push(...tracedItems);
            aggregateToolActivity.push(...summarizeToolTrace(tracedItems, agentName));
            if (taskContext?.onToolTrace) {
              taskContext.onToolTrace(aggregateToolTrace);
            }
            if (taskContext?.onToolActivity) {
              taskContext.onToolActivity(aggregateToolActivity);
            }
          }
          timeline.push({
            stage: "subagent",
            detail: `${agentName} completed`
          });
          if (taskContext?.onAudit) {
            taskContext.onAudit("subagent_completed", { agentName });
          }
        }

        emitStatus(`${activityProfile.label}: Synthesizing (${providerId}/${candidateModel})...`);
        const result = await this.options.invokeModel({
          providerId,
          model: candidateModel,
          prompt: enrichedPrompt,
          messages: [
            {
              role: "system",
              content: [systemMessage, getAgentInstruction(activityProfile, "Synthesizer")].filter(Boolean).join("\n\n")
            },
            ...sanitizedConversationMessages,
            {
              role: "user",
              content: buildSpecialistPrompt(prompt, enrichedPrompt, specialistOutputs, "Synthesizer")
            }
          ],
          taskType: resolvedTaskType,
          suppressStream: quietMode,
          taskContext
        });

        timeline.push({
          stage: "result",
          detail: `Completed with ${providerId} / ${candidateModel}`
        });
        if (result.toolTrace?.length) {
          const tracedItems = result.toolTrace.map((entry) => ({
            ...entry,
            agentName: "Synthesizer"
          }));
          aggregateToolTrace.push(...tracedItems);
          aggregateToolActivity.push(...summarizeToolTrace(tracedItems, "Synthesizer"));
          if (taskContext?.onToolTrace) {
            taskContext.onToolTrace(aggregateToolTrace);
          }
          if (taskContext?.onToolActivity) {
            taskContext.onToolActivity(aggregateToolActivity);
          }
        }
        if (taskContext?.onAudit) {
          taskContext.onAudit("direct_completed", { model: candidateModel, provider: providerId });
        }

        return {
          taskType: resolvedTaskType,
          model: candidateModel,
          provider: providerId,
          content: result.content,
          usage: result.usage ?? null,
          agentRuns: specialistOutputs,
          timeline,
          toolSummary,
          toolActivity: aggregateToolActivity,
          toolTrace: aggregateToolTrace,
          runMode,
          fallbackChain
        };
      } catch (error) {
        lastError = error;
        timeline.push({
          stage: "fallback",
          detail: `${providerId}/${candidateModel}: ${formatProviderError(error, candidateModel)}`
        });
        emitStatus(`${candidateModel} unavailable (${formatProviderError(error, candidateModel)}) — trying next model...`);
      }
    }

    return {
      error: lastError
        ? `All configured direct models failed. Last error: ${lastError.message ?? String(lastError)}.${summarizeFallbackAttempts(timeline)} Check Setup: API keys and model IDs per provider (Refresh Models).`
        : `No configured model with a usable API key was available for this task.${summarizeFallbackAttempts(timeline)}`,
      taskType: resolvedTaskType,
      timeline,
      toolSummary,
      toolActivity: aggregateToolActivity,
      toolTrace: aggregateToolTrace,
      runMode,
      fallbackChain
    };
  }
}

export { buildExecutionBatches } from "./workflow.js";
