import { MCPHub } from "@wcjr/mcp-hub";
import { ModelRouter, TASK_TYPES } from "@wcjr/model-router";
import {
  ACTIVITY_PROFILES,
  getMcpPresetDefinitions,
  resolveSkillDefinition
} from "@wcjr/activity-profiles";
import { buildRetrievalContext } from "./retrieval.js";

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
        "Assess clarity, completeness, specificity, and unnecessary scope. Highlight the single most critical improvement and then provide a concise revised recommendation."
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
      return `${sharedIntro} Combine the specialist outputs into one final, concise, user-facing response.`;
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
  coding: `You are an expert software engineer. When given a coding task:
1. Read ALL relevant files before writing any code.
2. Write complete, working implementations — never truncate with "// ...rest of code".
3. Follow the existing code style and conventions precisely.
4. After writing code, verify logic by tracing through edge cases mentally.
5. Use the write_text_file tool to create or update files.
6. Use git tools to commit changes with clear, descriptive messages.
7. Return a concise summary of what was built and why each decision was made.`,

  research: `You are a thorough research analyst. When given a research task:
1. Search broadly using available tools (filesystem, browser, mail) before synthesising.
2. Distinguish between facts, inferences, and opinions clearly.
3. Cite the source of each key claim (file path, URL, or email subject).
4. Structure findings: Executive Summary → Key Facts → Analysis → Recommendations.
5. Flag gaps in information explicitly rather than speculating.
6. Keep the final answer under 1,000 words unless depth is explicitly requested.`,

  data_analysis: `You are a skilled data analyst. When analysing data:
1. First inspect the data structure (headers, sample rows, data types, null counts).
2. State your analytical approach before executing it.
3. Produce clean, correctly-formatted output (CSV, Markdown table, or report as appropriate).
4. Include descriptive statistics where useful (count, min, max, mean, distribution).
5. Highlight anomalies, outliers, or data quality issues.
6. Summarise findings in plain language after technical output.`,

  documents: `You are a professional writer and editor. When creating documents:
1. Match the tone and style requested (formal, casual, technical, executive).
2. Structure documents with clear headings, numbered lists where appropriate.
3. Write complete documents — never use placeholder text.
4. Use the write_markdown or write_report tools to save documents.
5. After writing, confirm file path and word count.`,

  orchestrator: `You are a strategic planning expert. When creating a workflow plan:
1. Break the goal into discrete, testable phases with clear outputs.
2. Assign the most appropriate activity type to each phase.
3. Identify which phases can run in parallel vs. sequentially.
4. For each phase, write a concrete, action-oriented prompt — not vague instructions.
5. Output a valid wcjr-plan block as specified.`,

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
4. Produce structured outputs: action items with owners, deadlines, and priority.`
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

  async collectToolContext(prompt, resolvedTaskType, timeline, emitStatus, memoryItems = []) {
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
      memoryItems
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
          detail: `${candidateModel} failed: ${error instanceof Error ? error.message : String(error)}`
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

    if (runMode === "sandboxed") {
      const collected = await this.collectToolContext(
        prompt,
        resolvedTaskType,
        timeline,
        emitStatus,
        memoryItems
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
          memoryItems
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
      detail: `Primary model '${selectedModel}' selected`
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
        const specialistOutputs = [];
        for (const agentName of specialistAgents.slice(0, -1)) {
          emitStatus(`${activityProfile.label}: ${agentName} working...`);
          const phaseResult = await this.options.invokeModel({
            providerId,
            model: candidateModel,
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

        emitStatus(`${activityProfile.label}: Synthesizing final response...`);
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
          detail: `${providerId} / ${candidateModel} failed: ${error instanceof Error ? error.message : String(error)}`
        });
        emitStatus(`Fallback triggered after ${candidateModel} failed. Trying next configured model...`);
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
