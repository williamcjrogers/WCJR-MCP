const $ = (sel) => document.querySelector(sel);
const api = window.assistantApi;

const els = {
  statusDot: $("#status-dot"),
  topbarSummary: $("#topbar-summary"),
  errorBanner: $("#error-banner"),
  errorBannerMessage: $("#error-banner-message"),
  errorBannerDismiss: $("#error-banner-dismiss"),
  errorBannerToggle: $("#error-banner-toggle"),
  errorBannerLog: $("#error-banner-log"),
  routingStatusRow: $("#routing-status-row"),
  routingStatusText: $("#routing-status-text"),
  runtimeDiagnostics: $("#runtime-diagnostics"),
  setupPanel: $("#setup-panel"),
  advancedSetupBody: $("#advanced-setup-body"),
  themeSelect: $("#theme-select"),
  themeSelectSetup: $("#theme-select-setup"),
  themePalette: $("#theme-palette"),
  btnSetup: $("#btn-setup"),
  btnCloseSetup: $("#btn-close-setup"),
  btnSaveKeys: $("#btn-save-keys"),
  btnRefreshModels: $("#btn-refresh-models"),
  btnSaveProfiles: $("#btn-save-profiles"),
  btnSaveTools: $("#btn-save-tools"),
  btnConnectMcp: $("#btn-connect-mcp"),
  btnAddMcp: $("#btn-add-mcp"),
  btnToggleSidebar: $("#btn-toggle-sidebar"),
  btnToggleAdvanced: $("#btn-toggle-advanced"),
  advancedOptions: $("#advanced-options"),
  btnToggleActivityDetail: $("#btn-toggle-activity-detail"),
  activityProfileDetail: $("#activity-profile-detail"),
  filesystemRoots: $("#filesystem-roots"),
  btnAddFilesystemRoot: $("#btn-add-filesystem-root"),
  documentOpsEnabled: $("#document-ops-enabled"),
  documentOpsRoot: $("#document-ops-root"),
  btnPickDocumentOpsDir: $("#btn-pick-document-ops-dir"),
  browserOpsEnabled: $("#browser-ops-enabled"),
  desktopCommanderMcpEnabled: $("#desktop-commander-mcp-enabled"),
  desktopCommanderEnabled: $("#desktop-commander-enabled"),
  lookeenPath: $("#lookeen-path"),
  btnPickLookeen: $("#btn-pick-lookeen"),
  btnSaveDesktopCommander: $("#btn-save-desktop-commander"),
  filesystemFullAccess: $("#filesystem-full-access"),
  memoryMcpEnabled: $("#memory-mcp-enabled"),
  fileOpsEnabled: $("#file-ops-enabled"),
  fileOpsFullAccess: $("#file-ops-full-access"),
  fileOpsRoots: $("#file-ops-roots"),
  btnAddFileOpsRoot: $("#btn-add-file-ops-root"),
  mailCalendarEnabled: $("#mail-calendar-enabled"),
  mailCalendarClientId: $("#mail-calendar-client-id"),
  mailCalendarTenantId: $("#mail-calendar-tenant-id"),
  btnMailCalendarSignin: $("#btn-mail-calendar-signin"),
  mailCalendarStatus: $("#mail-calendar-status"),
  mailCalendarDeviceMessage: $("#mail-calendar-device-message"),
  btnRun: $("#btn-run"),
  keyFields: $("#key-fields"),
  modelFetchStatus: $("#model-fetch-status"),
  profileEditor: $("#profile-editor"),
  filesystemEnabled: $("#filesystem-enabled"),
  mcpName: $("#mcp-name"),
  mcpTransport: $("#mcp-transport"),
  mcpTarget: $("#mcp-target"),
  mcpArgs: $("#mcp-args"),
  mcpServerList: $("#mcp-server-list"),
  mcpConnectStatus: $("#mcp-connect-status"),
  activeConversationTitle: $("#active-conversation-title"),
  btnNewConversation: $("#btn-new-conversation"),
  conversationList: $("#conversation-list"),
  conversationFilter: $("#conversation-filter"),
  activityProfileTitle: $("#activity-profile-title"),
  activityProfileDefaultModel: $("#activity-profile-default-model"),
  activityProfileDescription: $("#activity-profile-description"),
  activityProfileMcps: $("#activity-profile-mcps"),
  activityProfileSkills: $("#activity-profile-skills"),
  activityProfileAgents: $("#activity-profile-agents"),
  quickActions: $("#quick-actions"),
  taskPrompt: $("#task-prompt"),
  executionMode: $("#execution-mode"),
  taskType: $("#task-type"),
  modelOverride: $("#model-override"),
  runMode: $("#run-mode"),
  planApprovalBanner: $("#plan-approval-banner"),
  btnApprovePlan: $("#btn-approve-plan"),
  btnDismissPlan: $("#btn-dismiss-plan"),
  sandboxPreference: $("#sandbox-preference"),
  sandboxStatus: $("#sandbox-status"),
  toolStatus: $("#tool-status"),
  runBadges: $("#run-badges"),
  runSummary: $("#run-summary"),
  timeline: $("#timeline"),
  toolActivity: $("#tool-activity"),
  taskList: $("#task-list"),
  outputStatus: $("#output-status"),
  output: $("#output"),
  workspaceGrid: $(".workspace-grid"),
  memoryCount: $("#memory-count"),
  memoryFilter: $("#memory-filter"),
  memoryList: $("#memory-list"),
  policyProfile: $("#policy-profile"),
  btnSavePolicy: $("#btn-save-policy"),
  messagingEnabled: $("#messaging-enabled"),
  messagingBotToken: $("#messaging-bot-token"),
  messagingChatIds: $("#messaging-chat-ids"),
  btnSaveMessaging: $("#btn-save-messaging"),
  memoryEnabled: $("#memory-enabled"),
  memoryAutoCapture: $("#memory-autocapture"),
  btnSaveMemory: $("#btn-save-memory"),
  selectedTaskMeta: $("#selected-task-meta"),
  auditCount: $("#audit-count"),
  auditTrail: $("#audit-trail"),
  runLedgerContainer: $("#run-ledger-container"),
  artifactsContainer: $("#artifacts-container"),
  artifactsCount: $("#artifacts-count"),
  taskFilter: $("#task-filter"),
  taskStatusFilter: $("#task-status-filter")
};

const THEME_OPTIONS = [
  { value: "midnight", label: "Midnight" },
  { value: "charcoal", label: "Charcoal" },
  { value: "slate", label: "Slate" },
  { value: "ocean", label: "Ocean" },
  { value: "lavender", label: "Lavender" },
  { value: "meritus-via", label: "Meritus Via" },
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
  { value: "high-contrast", label: "High contrast" }
];

const DEFAULT_PROVIDER_LABELS = Object.freeze({
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
  grok: "xAI (Grok)",
  perplexity: "Perplexity (Sonar)"
});

const DEFAULT_THEME_IDS = THEME_OPTIONS.map((option) => option.value);

const WORKSPACE_STATE_DEFAULTS = Object.freeze({
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

function mergeAssistantState(bootstrapState, workspaceState = {}) {
  return {
    ...WORKSPACE_STATE_DEFAULTS,
    ...workspaceState,
    memory: {
      ...WORKSPACE_STATE_DEFAULTS.memory,
      ...(workspaceState.memory ?? {})
    },
    desktopCommander: {
      ...WORKSPACE_STATE_DEFAULTS.desktopCommander,
      ...(workspaceState.desktopCommander ?? {})
    },
    messaging: {
      ...WORKSPACE_STATE_DEFAULTS.messaging,
      ...(workspaceState.messaging ?? {})
    },
    ...(bootstrapState ?? {})
  };
}

function getProviderEntries() {
  const entries = Object.entries(state?.providers ?? {});
  return entries.length ? entries : Object.entries(DEFAULT_PROVIDER_LABELS);
}

function formatRuntimeDiagnostics(runtime) {
  if (!runtime) return "";
  const modeLabel = runtime.launchMode === "packaged" ? "Packaged app" : "Source app";
  const location = runtime.appPath ? ` from ${runtime.appPath}` : "";
  const config = runtime.configPath ? ` | Config: ${runtime.configPath}` : "";
  return `Runtime: ${modeLabel}${location}${config}`;
}

function getLocalThemePreference() {
  try {
    const savedTheme = window.localStorage.getItem("wcjr.theme");
    if (savedTheme && DEFAULT_THEME_IDS.includes(savedTheme)) {
      return savedTheme;
    }
  } catch {
    // Ignore local storage failures.
  }
  return "midnight";
}

function buildFallbackBootstrapState() {
  return {
    providers: { ...DEFAULT_PROVIDER_LABELS },
    keyStatus: Object.fromEntries(Object.keys(DEFAULT_PROVIDER_LABELS).map((id) => [id, false])),
    modelProfiles: {},
    taskTypes: ["orchestrator"],
    activityProfiles: [
      {
        id: "orchestrator",
        label: "Automatic orchestration",
        description: "Describe the outcome you want. The workflow engine will infer the steps.",
        mcpPresets: [],
        recommendedSkills: [],
        specialistAgents: [],
        defaultModel: ""
      }
    ],
    executionMode: "plan_first",
    sandboxPreference: "manual",
    theme: getLocalThemePreference(),
    themeIds: [...DEFAULT_THEME_IDS],
    runtime: null
  };
}

function populateThemeSelects() {
  const html = THEME_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
  const s1 = document.getElementById("theme-select");
  const s2 = document.getElementById("theme-select-setup");
  if (s1) s1.innerHTML = html;
  if (s2) s2.innerHTML = html;
}

populateThemeSelects();

let state = mergeAssistantState(buildFallbackBootstrapState(), {});
let allModels = {};
let activeConversation = null;
let activeConversationTasks = new Map();
let streamingConversationId = null;
let streamingAssistantText = "";
let streamingToolCalls = [];
let streamingStatusText = "";
let recentTasks = [];
let selectedTaskId = null;
let selectedTask = null;
let selectedTaskAudit = [];

function setAdvancedSetupVisibility(visible) {
  if (!els.advancedSetupBody || !els.btnSetup) return;
  els.advancedSetupBody.classList.toggle("hidden", !visible);
  els.btnSetup.textContent = visible ? "Hide setup" : "Setup & tools";
  if (els.btnCloseSetup) {
    els.btnCloseSetup.classList.toggle("hidden", !visible);
  }
}

// ── Persistent error surface ──────────────────────────────────────────────
// showError no longer auto-hides; the user dismisses manually, and every
// error is appended to an in-memory log that can be reviewed from the banner.
const MAX_ERROR_LOG_ENTRIES = 50;
const MAX_ERROR_MESSAGE_CHARS = 300;
const errorLog = [];

function truncateErrorMessage(msg) {
  const text = String(msg ?? "").trim();
  if (text.length <= MAX_ERROR_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`;
}

function normalizeErrorMessage(err) {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || err.name || "Error";
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function renderErrorLog() {
  if (!els.errorBannerLog) return;
  const entries = errorLog.slice(-MAX_ERROR_LOG_ENTRIES);
  if (!entries.length) {
    els.errorBannerLog.innerHTML = "";
    return;
  }
  els.errorBannerLog.innerHTML = entries
    .map((entry) => {
      const cls = entry.level === "warn" ? "error-banner-log-warn" : "";
      const ts = new Date(entry.at).toLocaleTimeString();
      const context = entry.context ? `${escapeHtml(entry.context)}: ` : "";
      return `<li class="${cls}"><span>${escapeHtml(ts)}</span> ${context}${escapeHtml(entry.message)}</li>`;
    })
    .join("");
}

function showError(msg) {
  if (!els.errorBanner) return;
  const text = truncateErrorMessage(msg);
  if (els.errorBannerMessage) {
    els.errorBannerMessage.textContent = text;
  } else {
    els.errorBanner.textContent = text;
  }
  els.errorBanner.classList.remove("hidden");
}

function pushErrorEntry(level, context, message) {
  const entry = {
    level,
    context: context ?? "",
    message: truncateErrorMessage(message),
    at: Date.now()
  };
  errorLog.push(entry);
  if (errorLog.length > MAX_ERROR_LOG_ENTRIES * 2) {
    errorLog.splice(0, errorLog.length - MAX_ERROR_LOG_ENTRIES);
  }
  renderErrorLog();
  return entry;
}

function logError(context, err) {
  const message = normalizeErrorMessage(err);
  const label = context ? `[${context}]` : "";
  console.error(`${label} ${message}`.trim(), err);
  const entry = pushErrorEntry("error", context, message);
  showError(entry.context ? `${entry.context}: ${entry.message}` : entry.message);
}

function logWarn(context, err) {
  const message = normalizeErrorMessage(err);
  const label = context ? `[${context}]` : "";
  console.warn(`${label} ${message}`.trim(), err);
  pushErrorEntry("warn", context, message);
}

// ── Routing status row ────────────────────────────────────────────────────
// One-line status strip that shows live provider/model/tool state during a
// streaming turn. Clears to "Idle" on completion or error.
let routingStatusTimer = null;
let routingActiveToolCount = 0;

function setRoutingStatus(text, { active = true, ttlMs = 0 } = {}) {
  if (!els.routingStatusRow || !els.routingStatusText) return;
  if (routingStatusTimer) {
    clearTimeout(routingStatusTimer);
    routingStatusTimer = null;
  }
  els.routingStatusText.textContent = text;
  els.routingStatusRow.classList.toggle("active", active);
  if (ttlMs > 0) {
    routingStatusTimer = setTimeout(() => {
      resetRoutingStatus();
    }, ttlMs);
  }
}

function resetRoutingStatus() {
  if (!els.routingStatusRow || !els.routingStatusText) return;
  if (routingStatusTimer) {
    clearTimeout(routingStatusTimer);
    routingStatusTimer = null;
  }
  routingActiveToolCount = 0;
  els.routingStatusText.textContent = "Idle";
  els.routingStatusRow.classList.remove("active");
}

function routingStatusFromChunk(chunk) {
  if (!chunk) return;
  if (chunk.type === "status") {
    const text = String(chunk.text ?? "").trim();
    if (text) setRoutingStatus(text);
    return;
  }
  if (chunk.type === "tool_call") {
    routingActiveToolCount += 1;
    setRoutingStatus(
      `${chunk.server ?? "?"}.${chunk.tool ?? "?"} running (${routingActiveToolCount} in flight)`
    );
    return;
  }
  if (chunk.type === "tool_result") {
    routingActiveToolCount = Math.max(0, routingActiveToolCount - 1);
    const verdict = chunk.status === "error" ? "failed" : "completed";
    setRoutingStatus(`${chunk.tool ?? "tool"} ${verdict}`);
    return;
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeCssToken(value = "", fallback = "unknown") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function compactWhitespace(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function persistThemePreference(themeId) {
  try {
    window.localStorage.setItem("wcjr.theme", themeId);
  } catch {
    // Ignore local storage failures.
  }
}

function matchesQuery(values, query) {
  const normalizedQuery = compactWhitespace(query).toLowerCase();
  if (!normalizedQuery) return true;
  return values
    .filter(Boolean)
    .some((value) => compactWhitespace(value).toLowerCase().includes(normalizedQuery));
}

const AUDIT_ACTION_LABELS = {
  task_created: "Task started",
  task_status: "Status update",
  task_progress: "Progress",
  task_classified: "Category",
  task_completed: "Completed",
  task_failed: "Failed",
  task_cancelled: "Cancelled",
  subagent_completed: "Step completed",
  tool_call: "Tool used",
  tool_result: "Tool result",
  retrieval_started: "Gathering context",
  retrieval_completed: "Context ready",
  critic_verdict: "Quality check",
  lesson_written: "Lesson recorded",
  phase_started: "Phase started",
  phase_completed: "Phase completed"
};

const TASK_TYPE_LABELS = {
  project_mgmt: "Planning & workflow",
  orchestrator: "Orchestration",
  research: "Research",
  coding: "Code & repositories",
  documents: "Documents",
  automation: "Files & desktop",
  data_analysis: "Data & spreadsheets",
  communication: "Email & calendar",
  creative: "Creative",
  disputes: "Disputes & claims",
  aws_cloud: "Cloud infrastructure"
};

function humanizeAuditAction(action) {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function formatAuditDetail(detail = {}) {
  if (!detail || typeof detail !== "object") return "";

  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null || value === "") continue;

    // Skip internal IDs and noisy fields
    if (key === "taskId" || key === "pendingApproval") continue;

    // Humanize known keys
    if (key === "taskType") {
      parts.push(TASK_TYPE_LABELS[value] ?? value);
      continue;
    }
    if (key === "status") {
      const statusLabels = { running: "Running", completed: "Done", failed: "Failed", cancelled: "Cancelled", pending: "Waiting" };
      parts.push(statusLabels[value] ?? value);
      continue;
    }
    if (key === "model") {
      parts.push(`Model: ${value}`);
      continue;
    }
    if (key === "agentName") {
      parts.push(`${value} finished`);
      continue;
    }
    if (key === "prompt") {
      const short = String(value).length > 80 ? `${String(value).slice(0, 80)}...` : String(value);
      parts.push(short);
      continue;
    }
    if (key === "progress" && typeof value === "object") {
      if (value.message) parts.push(value.message);
      continue;
    }
    if (key === "progress" && typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed.message) { parts.push(parsed.message); continue; }
      } catch { /* not JSON, fall through */ }
    }

    // Generic fallback — skip if it looks like an internal object
    if (typeof value === "object") continue;
    parts.push(String(value));
  }
  return parts.join(" · ");
}

function parseFallbackChainFromTimeline(timeline = []) {
  const modelMatches = [];
  for (const item of timeline) {
    const matches = String(item?.detail ?? "").match(/'([^']+)'/g) ?? [];
    for (const match of matches) {
      const candidate = match.slice(1, -1).trim();
      if (candidate && !modelMatches.includes(candidate)) {
        modelMatches.push(candidate);
      }
    }
  }
  return modelMatches;
}

function renderInlineMarkdown(text = "") {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(text = "") {
  const source = String(text ?? "");
  const codeBlockRegex = /```([\w-]+)?\n([\s\S]*?)```/g;
  let html = "";
  let lastIndex = 0;

  for (const match of source.matchAll(codeBlockRegex)) {
    const [fullMatch, language = "", code = ""] = match;
    const startIndex = match.index ?? 0;
    html += renderMarkdownParagraphs(source.slice(lastIndex, startIndex));
    html += `<pre class="message-code-block"><code data-language="${escapeHtml(language)}">${escapeHtml(code.trimEnd())}</code></pre>`;
    lastIndex = startIndex + fullMatch.length;
  }

  html += renderMarkdownParagraphs(source.slice(lastIndex));
  return html || "<p></p>";
}

function renderMarkdownParagraphs(text = "") {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const blocks = [];
  let index = 0;

  const isOrderedLine = (line) => /^\d+\.\s+/.test(line);
  const isUnorderedLine = (line) => /^[-*]\s+/.test(line);
  const isHrLine = (line) => /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line);
  const isTableSeparator = (line) => /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
  const isTableRow = (line) => line.includes("|");

  while (index < lines.length) {
    const line = lines[index];
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      index += 1;
      continue;
    }

    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isHrLine(trimmedLine)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (trimmedLine.startsWith(">")) {
      const quoteLines = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${quoteLines.map((quote) => renderInlineMarkdown(quote)).join("<br>")}</blockquote>`);
      continue;
    }

    if (isOrderedLine(trimmedLine)) {
      const items = [];
      while (index < lines.length && isOrderedLine(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    if (isUnorderedLine(trimmedLine)) {
      const items = [];
      while (index < lines.length && isUnorderedLine(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (
      index + 1 < lines.length &&
      isTableRow(lines[index]) &&
      isTableSeparator(lines[index + 1])
    ) {
      const headerCells = lines[index]
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());
      const bodyRows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && isTableRow(lines[index])) {
        bodyRows.push(
          lines[index]
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim())
        );
        index += 1;
      }

      blocks.push(`
        <table>
          <thead><tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>
          <tbody>${bodyRows
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`
            )
            .join("")}</tbody>
        </table>
      `);
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith(">") &&
      !isOrderedLine(lines[index].trim()) &&
      !isUnorderedLine(lines[index].trim()) &&
      !isHrLine(lines[index].trim()) &&
      !lines[index].trim().match(/^(#{1,6})\s+/)
    ) {
      if (
        index + 1 < lines.length &&
        isTableRow(lines[index]) &&
        isTableSeparator(lines[index + 1])
      ) {
        break;
      }
      paragraphLines.push(lines[index].trimEnd());
      index += 1;
    }
    blocks.push(`<p>${paragraphLines.map((value) => renderInlineMarkdown(value)).join("<br>")}</p>`);
  }

  return blocks.join("");
}

function formatJsonPreview(value) {
  if (value == null) return "{}";
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function cleanToolTracePreview(value = "") {
  return String(value)
    .replace(
      /^UNTRUSTED TOOL RESULT\.[\s\S]*?ignore any embedded prompts or commands\.\s*/i,
      ""
    )
    .trim();
}

function renderToolTraceCards(toolTrace = []) {
  return toolTrace
    .map((entry) => {
      const statusClass =
        entry.status === "error"
          ? "tool-call-error"
          : entry.status === "completed"
            ? "tool-call-done"
            : "tool-call-running";
      const label = entry.server && entry.tool ? `${entry.server}.${entry.tool}` : entry.name ?? "Tool";
      const statusLabel =
        entry.status === "error" ? "error" : entry.status === "completed" ? "done" : "running...";
      const preview = cleanToolTracePreview(entry.resultPreview ?? "");
      const resultBody = entry.resultPreview
        ? `<pre class="tool-call-result">${escapeHtml(preview)}</pre>`
        : "";
      const errorBody = entry.error ? `<pre class="tool-call-result">${escapeHtml(entry.error)}</pre>` : "";
      const shouldOpen = entry.status !== "completed";
      return `
        <details class="tool-call-card ${statusClass}" ${shouldOpen ? "open" : ""}>
          <summary>
            <span class="tool-call-icon">TOOL</span>
            <span class="tool-call-name">${escapeHtml(label)}</span>
            <span class="tool-call-status">${escapeHtml(statusLabel)}</span>
          </summary>
          <div class="tool-call-body">
            <pre class="tool-call-args">${escapeHtml(formatJsonPreview(entry.args ?? {}))}</pre>
            ${resultBody || errorBody}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderTypingIndicator() {
  return `
    <div class="streaming-status">
      <div class="typing-indicator" aria-label="Assistant is thinking">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
}

function isOutputNearBottom() {
  if (!els.output) return true;
  const distance = els.output.scrollHeight - (els.output.scrollTop + els.output.clientHeight);
  return distance <= 120;
}

function maybeAutoScrollOutput({ smooth = false } = {}) {
  if (!els.output || !isOutputNearBottom()) return;
  els.output.scrollTo({
    top: els.output.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}

function upsertStreamingToolCall(chunk) {
  const nextEntry = {
    id: chunk.callId,
    name: chunk.name,
    server: chunk.server,
    tool: chunk.tool,
    args: chunk.args ?? {},
    status: chunk.status ?? "running",
    resultPreview: chunk.result ?? "",
    error: chunk.error ?? undefined
  };

  const existingIndex = streamingToolCalls.findIndex((entry) => entry.id === chunk.callId);
  if (existingIndex === -1) {
    streamingToolCalls = [...streamingToolCalls, nextEntry];
    return;
  }

  streamingToolCalls = streamingToolCalls.map((entry, index) =>
    index === existingIndex
      ? {
          ...entry,
          ...nextEntry,
          resultPreview: chunk.result ?? entry.resultPreview,
          error: chunk.error ?? entry.error
        }
      : entry
  );
}

function resetStreamingState() {
  streamingAssistantText = "";
  streamingConversationId = null;
  streamingToolCalls = [];
  streamingStatusText = "";
}

function handleExecutionError(source, err) {
  logError(source, err);
  if (els && els.btnRun) els.btnRun.disabled = false;
  if (els && els.btnApprovePlan) els.btnApprovePlan.disabled = false;
  if (typeof resetRoutingStatus === "function") resetRoutingStatus();
  if (typeof resetStreamingState === "function") resetStreamingState();
  if (typeof refreshActiveConversation === "function") refreshActiveConversation();
  if (typeof refreshTaskList === "function") refreshTaskList();
}

function formatMessageDate(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function formatMessageTimestamp(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function clearError() {
  if (!els.errorBanner) return;
  els.errorBanner.classList.add("hidden");
  if (els.errorBannerLog) {
    els.errorBannerLog.classList.add("hidden");
  }
  if (els.errorBannerToggle) {
    els.errorBannerToggle.setAttribute("aria-expanded", "false");
  }
}

function toggleErrorLog() {
  if (!els.errorBannerLog || !els.errorBannerToggle) return;
  const expanded = els.errorBannerToggle.getAttribute("aria-expanded") === "true";
  const next = !expanded;
  els.errorBannerToggle.setAttribute("aria-expanded", next ? "true" : "false");
  els.errorBannerLog.classList.toggle("hidden", !next);
  if (next) renderErrorLog();
}

if (els.errorBannerDismiss) {
  els.errorBannerDismiss.addEventListener("click", clearError);
}
if (els.errorBannerToggle) {
  els.errorBannerToggle.addEventListener("click", toggleErrorLog);
}

function setConnected(count) {
  if (count > 0) {
    els.statusDot.className = "dot dot-on";
    els.statusDot.title = `${count} provider(s) configured`;
  } else {
    els.statusDot.className = "dot dot-off";
    els.statusDot.title = "No providers configured";
  }
}

function setTopbarSummary() {
  const providerCount = Object.values(state.keyStatus ?? {}).filter(Boolean).length;
  const connectedServers = (state.mcpStatuses ?? []).filter((status) => status.status === "connected");
  const toolCount = connectedServers.reduce((sum, status) => sum + (status.tools?.length ?? 0), 0);
  els.topbarSummary.textContent = `${providerCount} provider(s) ready, ${connectedServers.length} MCP server(s) connected, ${toolCount} tool(s) available.`;
}

function renderRuntimeDiagnostics() {
  if (!els.runtimeDiagnostics) return;
  const diagnostics = formatRuntimeDiagnostics(state?.runtime);
  els.runtimeDiagnostics.textContent = diagnostics;
  els.runtimeDiagnostics.classList.toggle("hidden", !diagnostics);
}

function renderKeyFields() {
  els.keyFields.innerHTML = "";
  const providerEntries = getProviderEntries();
  for (const [id, label] of providerEntries) {
    const row = document.createElement("div");
    row.className = "key-row";

    const lbl = document.createElement("label");
    lbl.textContent = label;
    const dot = document.createElement("span");
    const hasKey = state?.keyStatus?.[id];
    const hasModels = allModels?.[id]?.models?.length > 0;
    const hasError = allModels?.[id]?.error;
    dot.className = hasKey && hasModels ? "dot dot-on dot-sm"
      : hasKey && hasError ? "dot dot-err dot-sm"
      : hasKey ? "dot dot-warn dot-sm"
      : "dot dot-off dot-sm";
    dot.title = hasKey && hasModels ? `${allModels[id].models.length} models available`
      : hasKey && hasError ? `Error: ${allModels[id].error}`
      : hasKey ? "Key saved — click Refresh Models to connect"
      : "No API key";
    lbl.prepend(dot);

    const modelCount = hasModels ? ` (${allModels[id].models.length} models)` : "";
    const input = document.createElement("input");
    input.type = "password";
    input.dataset.provider = id;
    input.placeholder = hasKey ? `key saved${modelCount} (leave blank to keep)` : "paste API key";
    input.className = "key-input";

    row.append(lbl, input);
    els.keyFields.appendChild(row);
  }
}

function getAllModelsList() {
  const list = [];
  for (const [providerId, data] of Object.entries(allModels)) {
    if (data.models) {
      for (const model of data.models) {
        list.push({ id: model.id, name: model.name, provider: providerId });
      }
    }
  }

  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function getActivityProfileById(activityId) {
  return (state?.activityProfiles ?? []).find((profile) => profile.id === activityId) ?? null;
}

function getActivityLabel(activityId) {
  return getActivityProfileById(activityId)?.label ?? activityId ?? "Unknown";
}

function stripWorkflowPlanBlock(text = "") {
  return String(text ?? "")
    .replace(/```wcjr-plan\s*[\s\S]*?```/gi, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseWorkflowPlanFromText(text = "") {
  const match = String(text ?? "").match(/```wcjr-plan\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

function normalizeWorkflowPreview(preview) {
  const phases = Array.isArray(preview?.phases) ? preview.phases : [];
  if (!phases.length) return null;
  return {
    summary: preview.summary ?? "",
    runMode: preview.runMode ?? "direct",
    phaseCount: preview.phaseCount ?? phases.length,
    status: preview.status ?? null,
    phases: phases.map((phase, index) => ({
      id: phase.id ?? `p${index + 1}`,
      title: compactWhitespace(phase.title) || getActivityLabel(phase.activity),
      activity: phase.activity ?? null,
      activityLabel: phase.activityLabel ?? getActivityLabel(phase.activity),
      depth: phase.depth ?? "standard",
      model: phase.model ?? phase.modelUsed ?? null,
      parallelGroup: phase.parallelGroup ?? 0,
      dependsOn: Array.isArray(phase.dependsOn) ? phase.dependsOn : [],
      approvalRequired: phase.approvalRequired === true,
      attempts: phase.attempts ?? 1,
      promptPreview: compactWhitespace(phase.promptPreview ?? phase.prompt ?? ""),
      status: phase.status ?? null
    }))
  };
}

function getWorkflowPreviewFromMessage(message) {
  return normalizeWorkflowPreview(message?.workflowPreview ?? parseWorkflowPlanFromText(message?.content ?? ""));
}

function renderWorkflowPreviewCard(preview, { compact = false } = {}) {
  const workflow = normalizeWorkflowPreview(preview);
  if (!workflow) return "";

  const byId = new Map(workflow.phases.map((phase) => [phase.id, phase]));
  const parallelCounts = workflow.phases.reduce((counts, phase) => {
    const group = phase.parallelGroup ?? 0;
    counts.set(group, (counts.get(group) ?? 0) + 1);
    return counts;
  }, new Map());
  const heading = workflow.summary
    ? escapeHtml(workflow.summary)
    : `Workflow (${workflow.phaseCount} phase${workflow.phaseCount === 1 ? "" : "s"})`;

  const rows = workflow.phases
    .map((phase, index) => {
      const dependsOn = (phase.dependsOn ?? [])
        .map((phaseId) => byId.get(phaseId)?.title ?? phaseId)
        .filter(Boolean);
      const runsInParallel = (parallelCounts.get(phase.parallelGroup ?? 0) ?? 0) > 1;
      const meta = [
        phase.status ? phase.status.replace(/_/g, " ") : "",
        phase.activityLabel,
        phase.model ? phase.model : `${phase.depth} tier`,
        phase.attempts > 1 ? `attempt ${phase.attempts}` : "",
        dependsOn.length ? `after ${dependsOn.join(", ")}` : "",
        runsInParallel ? "runs in parallel" : "",
        phase.approvalRequired ? "approval required" : ""
      ]
        .filter(Boolean)
        .join(" · ");
      const promptPreview = compact
        ? phase.promptPreview.slice(0, 120)
        : phase.promptPreview;
      return `
        <div class="plan-phase-row">
          <span class="plan-phase-idx">${index + 1}</span>
          <div class="plan-phase-body">
            <span class="plan-phase-title">${escapeHtml(phase.title)}</span>
            <span class="plan-phase-meta">${escapeHtml(meta)}</span>
            ${promptPreview ? `<span class="plan-phase-prompt">${escapeHtml(promptPreview)}</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="workflow-preview-card ${compact ? "compact" : ""}">
      <div class="plan-phase-heading">${heading}</div>
      ${rows}
    </div>
  `;
}

function renderModelOverride() {
  const currentValue = els.modelOverride?.value ?? "";
  els.modelOverride.innerHTML = '<option value="">Auto (use profile)</option>';
  for (const model of getAllModelsList()) {
    const opt = document.createElement("option");
    opt.value = model.id;
    opt.textContent = `${model.name} (${model.provider})`;
    els.modelOverride.appendChild(opt);
  }
  if (els.modelOverride) {
    els.modelOverride.value = currentValue && [...els.modelOverride.options].some((option) => option.value === currentValue)
      ? currentValue
      : "";
  }
}

function renderTaskTypes() {
  const currentValue = els.taskType?.value ?? "";
  els.taskType.innerHTML = "";
  for (const profile of state.activityProfiles ?? []) {
    const opt = document.createElement("option");
    opt.value = profile.id;
    opt.textContent = profile.label;
    els.taskType.appendChild(opt);
  }
  if (els.taskType) {
    const nextValue =
      currentValue && [...els.taskType.options].some((option) => option.value === currentValue)
        ? currentValue
        : state?.taskTypes?.[0] ?? state?.activityProfiles?.[0]?.id ?? "";
    els.taskType.value = nextValue;
  }
}

function renderProfiles() {
  els.profileEditor.innerHTML = "";
  const modelList = getAllModelsList();

  for (const profile of state.activityProfiles ?? []) {
    const taskType = profile.id;
    const row = document.createElement("div");
    row.className = "profile-row";

    const label = document.createElement("label");
    label.textContent = profile.label;

    const select = document.createElement("select");
    select.dataset.taskType = taskType;
    select.className = "profile-select";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "-- select model --";
    select.appendChild(empty);

    for (const model of modelList) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = `${model.name} (${model.provider})`;
      if (state.modelProfiles[taskType] === model.id) opt.selected = true;
      select.appendChild(opt);
    }

    const currentValue = state.modelProfiles[taskType] ?? "";
    if (currentValue && !modelList.find((model) => model.id === currentValue)) {
      const opt = document.createElement("option");
      opt.value = currentValue;
      opt.textContent = `${currentValue} (cached)`;
      opt.selected = true;
      select.appendChild(opt);
    }

    row.append(label, select);
    els.profileEditor.appendChild(row);
  }
}

function getFilesystemServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-filesystem");
}

function getDocumentOpsServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-document-ops");
}

function getBrowserOpsServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-browser-ops");
}

function getDesktopCommanderServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-desktop-commander");
}

function getMemoryMcpServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-memory");
}

function getFileOpsServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-file-ops");
}

function getMailCalendarServer() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-mail-calendar");
}

function getCustomServers() {
  return (state.mcpServers ?? []).filter(
    (server) =>
      server.kind !== "builtin-filesystem" &&
      server.kind !== "builtin-document-ops" &&
      server.kind !== "builtin-file-ops" &&
      server.kind !== "builtin-mail-calendar" &&
      server.kind !== "builtin-browser-ops" &&
      server.kind !== "builtin-desktop-commander" &&
      server.kind !== "builtin-memory"
  );
}

function splitArgs(input) {
  const matches = input.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return matches.map((arg) => arg.replace(/^['"]|['"]$/g, ""));
}

function getStatusMap() {
  return new Map((state.mcpStatuses ?? []).map((status) => [status.name, status]));
}

function isServerEnabled(server) {
  return !!server && server.enabled !== false;
}

function renderRootList(container, roots = [], kind) {
  if (!container) return;
  const normalizedRoots = roots.length ? roots : [state.suggestedFilesystemRoot ?? ""];
  container.innerHTML = normalizedRoots
    .map(
      (root, index) => `
        <div class="root-row" data-root-kind="${kind}" data-root-index="${index}">
          <input class="text-input root-input" type="text" value="${escapeHtml(root)}" placeholder="Folder path or drive root (e.g. C:\\ or D:\\Projects)" />
          <button class="btn secondary btn-root-browse" type="button">Browse</button>
          <button class="btn secondary btn-root-remove" type="button">Remove</button>
        </div>
      `
    )
    .join("");
}

function collectRootValues(container) {
  if (!container) return [];
  return [...container.querySelectorAll(".root-input")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function renderMcpServers() {
  const filesystemServer = getFilesystemServer();
  const documentOpsServer = getDocumentOpsServer();
  els.filesystemEnabled.checked = isServerEnabled(filesystemServer);
  renderRootList(
    els.filesystemRoots,
    filesystemServer?.roots ?? [filesystemServer?.rootPath ?? state.suggestedFilesystemRoot ?? ""],
    "filesystem"
  );
  if (els.filesystemFullAccess) {
    els.filesystemFullAccess.checked = filesystemServer?.allowAnyPath === true;
  }
  if (els.documentOpsEnabled) els.documentOpsEnabled.checked = isServerEnabled(documentOpsServer);
  if (els.documentOpsRoot) {
    els.documentOpsRoot.value = documentOpsServer?.rootPath ?? state.suggestedDocumentOpsRoot ?? "";
  }
  const browserOpsServer = getBrowserOpsServer();
  if (els.browserOpsEnabled) els.browserOpsEnabled.checked = isServerEnabled(browserOpsServer);
  const desktopCommanderServer = getDesktopCommanderServer();
  if (els.desktopCommanderMcpEnabled) els.desktopCommanderMcpEnabled.checked = isServerEnabled(desktopCommanderServer);
  const memoryMcpServer = getMemoryMcpServer();
  if (els.memoryMcpEnabled) els.memoryMcpEnabled.checked = isServerEnabled(memoryMcpServer);
  const fileOpsServer = getFileOpsServer();
  if (els.fileOpsEnabled) els.fileOpsEnabled.checked = isServerEnabled(fileOpsServer);
  if (els.fileOpsFullAccess) {
    els.fileOpsFullAccess.checked = fileOpsServer?.allowAnyPath === true;
  }
  renderRootList(
    els.fileOpsRoots,
    fileOpsServer?.roots ?? [fileOpsServer?.rootPath ?? state.suggestedFilesystemRoot ?? ""],
    "file-ops"
  );
  const mailCalendarServer = getMailCalendarServer();
  if (els.mailCalendarEnabled) els.mailCalendarEnabled.checked = isServerEnabled(mailCalendarServer);
  els.mcpServerList.innerHTML = "";

  const statusMap = getStatusMap();
  const servers = [...getCustomServers()];
  if (mailCalendarServer) servers.unshift(mailCalendarServer);
  if (fileOpsServer) servers.unshift(fileOpsServer);
  if (memoryMcpServer) servers.unshift(memoryMcpServer);
  if (desktopCommanderServer) servers.unshift(desktopCommanderServer);
  if (browserOpsServer) servers.unshift(browserOpsServer);
  if (documentOpsServer) servers.unshift(documentOpsServer);
  if (filesystemServer) servers.unshift(filesystemServer);

  if (servers.length === 0) {
    els.mcpServerList.innerHTML = '<div class="empty-state">No MCP servers configured yet.</div>';
    return;
  }

  for (const server of servers) {
    const status = statusMap.get(server.name) ?? {
      status: server.enabled === false ? "disabled" : "not_connected",
      tools: []
    };

    const card = document.createElement("div");
    card.className = "server-card";
    if (status.status === "error") {
      card.classList.add("server-card--error");
    }
    const rootSummary = (server.roots ?? [server.rootPath]).filter(Boolean).join(", ");

    const meta = server.kind === "builtin-filesystem"
      ? `Locations: ${rootSummary || "(not set)"}${server.allowAnyPath ? " | Full access enabled" : ""}`
      : server.kind === "builtin-document-ops"
        ? `Output: ${server.rootPath ?? "(not set)"}`
        : server.kind === "builtin-file-ops"
          ? `Locations: ${rootSummary || "(not set)"}${server.allowAnyPath ? " | Full access enabled" : ""}`
          : server.kind === "builtin-desktop-commander"
            ? `Lookeen: ${state?.desktopCommander?.lookeenPath || "(not configured)"}`
          : server.kind === "builtin-memory"
            ? "Long-term memory and preference retrieval"
          : server.kind === "builtin-browser-ops"
            ? "Fetch web pages (no JS)"
            : server.kind === "builtin-mail-calendar"
            ? "Microsoft 365 (Mail, Calendar)"
            : server.transport === "streamable-http"
        ? `URL: ${server.url ?? ""}`
        : `Command: ${server.command ?? ""}${server.args?.length ? ` ${server.args.join(" ")}` : ""}`;
    const statusClass = sanitizeCssToken(status.status, "not_connected");

    const isBuiltin =
      server.kind === "builtin-filesystem" ||
      server.kind === "builtin-document-ops" ||
      server.kind === "builtin-file-ops" ||
      server.kind === "builtin-desktop-commander" ||
      server.kind === "builtin-memory" ||
      server.kind === "builtin-mail-calendar" ||
      server.kind === "builtin-browser-ops";
    const isCatalog = (server.kind ?? "").startsWith("catalog-") || server.kind === "builtin-qdrant-rag" || server.kind === "builtin-shell-exec" || server.kind === "builtin-git-ops";
    const envEntries = Object.entries(server.env ?? {});
    const hasEnv = isCatalog && envEntries.length > 0;
    const hasAuthToken = isCatalog && server.transport === "streamable-http";
    const envHtml = (hasEnv || hasAuthToken)
      ? `<div class="server-card-env">${hasAuthToken
          ? `<div class="env-row"><label class="env-label">Auth Token</label><input class="text-input auth-token-input" type="password" data-server="${escapeHtml(server.name)}" value="${escapeHtml(server.authToken ?? "")}" placeholder="Bearer token or PAT" /></div>`
          : ""}${envEntries.map(([key, val]) =>
          `<div class="env-row"><label class="env-label">${escapeHtml(key)}</label><input class="text-input env-input" type="text" data-server="${escapeHtml(server.name)}" data-env-key="${escapeHtml(key)}" value="${escapeHtml(val)}" placeholder="Enter ${escapeHtml(key)}" /></div>`
        ).join("")}</div>`
      : "";
    const toggleHtml = isCatalog
      ? `<label class="toggle-label"><input type="checkbox" class="server-enable-toggle" data-server="${escapeHtml(server.name)}" ${server.enabled !== false ? "checked" : ""} /> Enabled</label>`
      : "";
    card.innerHTML = `
      <div class="server-card-header">
        <strong>${escapeHtml(server.name)}</strong>
        <div class="server-card-actions">
          ${toggleHtml}
          ${isBuiltin ? "" : `<button class="btn secondary btn-remove-server" data-name="${escapeHtml(server.name)}">Remove</button>`}
        </div>
      </div>
      <div class="server-card-meta">${escapeHtml(meta)}</div>
      ${envHtml}
      <div class="server-status-row">
        <span class="status-pill ${statusClass}">${escapeHtml(String(status.status ?? "not_connected").replace(/_/g, " "))}</span>
        <span>${(status.tools ?? []).length} tool(s)</span>
      </div>
    `;
    if (status.error) {
      const errorEl = document.createElement("div");
      errorEl.className = "server-card-error";
      errorEl.textContent = status.error;
      card.appendChild(errorEl);
    }
    els.mcpServerList.appendChild(card);
  }
}

function renderSandboxStatus() {
  const sandboxStatus = state.sandboxStatus;
  if (!sandboxStatus) {
    els.sandboxStatus.textContent = "Sandbox status unavailable.";
    return;
  }

  if (sandboxStatus.available) {
    els.sandboxStatus.textContent = `Sandbox ready: ${sandboxStatus.sandboxName} (${sandboxStatus.detail ?? "available"})`;
  } else {
    els.sandboxStatus.textContent = `Sandbox unavailable: ${sandboxStatus.reason ?? "not detected"}`;
  }
}

function renderToolStatus() {
  const connectedServers = (state.mcpStatuses ?? []).filter((server) => server.status === "connected");
  const toolCount = connectedServers.reduce((sum, server) => sum + (server.tools?.length ?? 0), 0);
  els.toolStatus.textContent = connectedServers.length
    ? `Tools connected: ${connectedServers.length} server(s), ${toolCount} tool(s).`
    : "No MCP tools connected yet.";
}

function renderSummary(result) {
  if (!result) {
    els.runBadges.innerHTML = "";
    els.runSummary.className = "summary-list empty-state";
    els.runSummary.textContent = "Select a task to inspect its execution summary.";
    return;
  }

  const fallbackChain = result.fallbackChain ?? parseFallbackChainFromTimeline(result.timeline ?? []);
  const workflow = normalizeWorkflowPreview(result.workflow);
  const summaryItems = [
    ["Status", result.status ?? "unknown"],
    ["Task type", workflow ? "Workflow" : getActivityLabel(result.taskType)],
    workflow ? ["Workflow phases", String(workflow.phaseCount)] : null,
    ["Run mode", result.runMode ?? "direct"],
    ["Provider", result.provider ?? "n/a"],
    ["Model", result.model ?? "n/a"],
    ["Updated", result.updatedAt ? new Date(result.updatedAt).toLocaleString() : "n/a"],
    ["Fallback chain", fallbackChain.join(" -> ") || "n/a"]
  ].filter(Boolean);

  els.runBadges.innerHTML = "";
  for (const value of [result.provider, result.model, result.runMode]) {
    if (!value) continue;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = value;
    els.runBadges.appendChild(badge);
  }

  els.runSummary.classList.remove("empty-state");
  els.runSummary.className = "summary-list";
  els.runSummary.innerHTML = summaryItems
    .map(
      ([label, value]) => `
        <div class="summary-item">
          <span class="summary-item-label">${escapeHtml(label)}</span>
          <span class="summary-item-value">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

function renderTimeline(timeline) {
  if (!timeline?.length) {
    els.timeline.className = "timeline-list empty-state";
    els.timeline.textContent = "Select a task to inspect its execution timeline.";
    return;
  }

  els.timeline.className = "timeline-list";
  els.timeline.innerHTML = timeline
    .map(
      (item) => `
        <div class="timeline-item">
          <span class="timeline-stage">${escapeHtml(item.stage)}</span>
          <div class="timeline-detail">${escapeHtml(item.detail)}</div>
        </div>
      `
    )
    .join("");
}

function renderToolActivity(result) {
  const activity = result.toolActivity ?? [];
  if (!activity.length) {
    els.toolActivity.className = "summary-list empty-state";
    els.toolActivity.textContent = result ? "No MCP tools were invoked during this run." : "Select a task to inspect tool activity.";
    return;
  }

  els.toolActivity.className = "summary-list";
  els.toolActivity.innerHTML = activity
    .map(
      (item) => `
        <div class="summary-item">
          <span class="summary-item-label">${escapeHtml(`${item.server}.${item.tool}`)}</span>
          <span class="summary-item-value">${escapeHtml(item.detail)}</span>
        </div>
      `
    )
    .join("");
}

function renderAuditTrail() {
  if (!els.auditTrail || !els.auditCount) return;
  els.auditCount.textContent = `${selectedTaskAudit.length} event${selectedTaskAudit.length === 1 ? "" : "s"}`;

  if (!selectedTask) {
    els.auditTrail.className = "summary-list empty-state";
    els.auditTrail.textContent = "Select a task to inspect task-level events.";
    return;
  }

  if (!selectedTaskAudit.length) {
    els.auditTrail.className = "summary-list empty-state";
    els.auditTrail.textContent = "No audit events recorded for this task.";
    return;
  }

  els.auditTrail.className = "summary-list";
  els.auditTrail.innerHTML = selectedTaskAudit
    .map(
      (entry) => `
        <div class="audit-item">
          <div class="audit-item-header">
            <span class="audit-item-action">${escapeHtml(humanizeAuditAction(entry.action ?? "event"))}</span>
            <span class="audit-item-time">${escapeHtml(formatMessageTimestamp(entry.at))}</span>
          </div>
          <div class="audit-item-detail">${escapeHtml(formatAuditDetail(entry.detail ?? {}))}</div>
        </div>
      `
    )
    .join("");
}

function buildTaskRenderResult(task) {
  return {
    ...task,
    provider: task.result?.provider ?? null,
    model: task.result?.model ?? null,
    fallbackChain: parseFallbackChainFromTimeline(task.timeline ?? [])
  };
}

function renderRunLedger(task) {
  const container = els.runLedgerContainer;
  if (!container) return;

  // Clear existing contents
  container.innerHTML = "";

  const ledger = task?.runLedger;
  if (!ledger) {
    container.className = "run-ledger-container empty-state";
    container.textContent = task
      ? "No iterative run ledger for this task."
      : "Select a task to inspect its run ledger.";
    return;
  }

  container.className = "run-ledger-container";

  const outcome = ledger.outcome ?? "unknown";
  const phaseCount = ledger.budget?.phasesUsed ?? (ledger.phases?.length ?? 0);
  const wallSecs = ledger.budget?.wallClockMs
    ? Math.round(ledger.budget.wallClockMs / 100) / 10
    : 0;

  const ledgerSection = document.createElement("details");
  ledgerSection.className = "run-ledger-section";
  ledgerSection.open = false;

  const summary = document.createElement("summary");
  summary.innerHTML = `<strong>Run Ledger</strong> <span class="hint">(${escapeHtml(outcome)} &mdash; ${phaseCount} phase${phaseCount === 1 ? "" : "s"}, ${wallSecs}s)</span>`;
  ledgerSection.appendChild(summary);

  const pre = document.createElement("pre");
  pre.className = "run-ledger-json";
  pre.textContent = JSON.stringify(ledger, null, 2);
  ledgerSection.appendChild(pre);

  container.appendChild(ledgerSection);
}

function formatArtifactSize(bytes) {
  if (bytes == null) return "?B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function renderArtifacts(task) {
  if (!els.artifactsContainer) return;
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  if (els.artifactsCount) {
    els.artifactsCount.textContent = `${artifacts.length} file${artifacts.length === 1 ? "" : "s"}`;
  }
  if (!artifacts.length) {
    els.artifactsContainer.className = "artifacts-container empty-state";
    els.artifactsContainer.textContent = "No artifacts produced by this task.";
    return;
  }

  els.artifactsContainer.className = "artifacts-container";
  els.artifactsContainer.innerHTML = "";

  const sorted = [...artifacts].sort((a, b) => {
    const aTime = new Date(a.lastProducedAt ?? 0).getTime();
    const bTime = new Date(b.lastProducedAt ?? 0).getTime();
    return bTime - aTime;
  });

  for (const art of sorted) {
    const row = document.createElement("div");
    row.className = "artifact-row";

    const head = document.createElement("div");
    head.className = "artifact-row-head";

    const kindBadge = document.createElement("span");
    kindBadge.className = "artifact-kind-badge";
    kindBadge.textContent = art.kind ?? "other";
    head.appendChild(kindBadge);

    const basename = (art.path ?? "").split(/[\\/]/).pop() ?? "(unnamed)";
    const name = document.createElement("span");
    name.className = "artifact-name";
    name.textContent = basename;
    name.title = art.path ?? "";
    head.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "artifact-meta";
    const phaseLabel = art.producedBy?.[art.producedBy.length - 1]?.phaseId ?? "?";
    meta.textContent = `${formatArtifactSize(art.sizeBytes)} · ${phaseLabel}`;
    head.appendChild(meta);

    if (api.revealArtifact && art.path) {
      const btn = document.createElement("button");
      btn.className = "artifact-reveal-btn";
      btn.type = "button";
      btn.textContent = "Reveal";
      btn.addEventListener("click", async () => {
        try {
          await api.revealArtifact(art.path);
        } catch (err) {
          if (typeof logWarn === "function") {
            logWarn("revealArtifact", err);
          } else {
            console.warn("[revealArtifact]", err);
          }
        }
      });
      head.appendChild(btn);
    }

    row.appendChild(head);

    if (art.previewKind === "text" && art.preview) {
      const pre = document.createElement("div");
      pre.className = "artifact-preview";
      pre.textContent = art.preview;
      row.appendChild(pre);
    } else if (art.previewKind === "skipped-binary") {
      const hint = document.createElement("div");
      hint.className = "artifact-preview-hint";
      hint.textContent = "Binary file — preview unavailable";
      row.appendChild(hint);
    } else if (art.previewKind === "skipped-large") {
      const hint = document.createElement("div");
      hint.className = "artifact-preview-hint";
      hint.textContent = "Large file — preview unavailable";
      row.appendChild(hint);
    } else if (art.previewKind === "skipped-error" || art.previewKind === "skipped-timeout") {
      const hint = document.createElement("div");
      hint.className = "artifact-preview-hint";
      hint.textContent = "Preview unavailable";
      row.appendChild(hint);
    }

    els.artifactsContainer.appendChild(row);
  }
}

function renderSelectedTaskDetails() {
  if (els.selectedTaskMeta) {
    els.selectedTaskMeta.textContent = selectedTask
      ? `${selectedTask.status ?? "unknown"} · ${selectedTask.updatedAt ? new Date(selectedTask.updatedAt).toLocaleString() : "no timestamp"}`
      : "No task selected";
  }

  if (!selectedTask) {
    renderSummary(null);
    renderTimeline(null);
    renderToolActivity(null);
    renderAuditTrail();
    renderRunLedger(null);
    renderArtifacts(null);
    return;
  }

  renderSummary(buildTaskRenderResult(selectedTask));
  renderTimeline(selectedTask.timeline ?? []);
  renderToolActivity(selectedTask);
  renderAuditTrail();
  renderRunLedger(selectedTask);
  renderArtifacts(selectedTask);
}

async function refreshSelectedTask() {
  if (!selectedTaskId) {
    selectedTask = null;
    selectedTaskAudit = [];
    renderSelectedTaskDetails();
    return;
  }

  try {
    selectedTask = await api.getTask(selectedTaskId);
    selectedTaskAudit = await api.getAuditTrail({ taskId: selectedTaskId, limit: 80 });
  } catch (err) {
    logWarn("refreshSelectedTask", err);
    selectedTask = null;
    selectedTaskAudit = [];
  }
  renderSelectedTaskDetails();
}

async function selectTask(taskId) {
  selectedTaskId = taskId ?? null;
  await refreshSelectedTask();
  renderTaskList();
}

function getVisibleRecentTasks(tasks = []) {
  const rootTasks = tasks.filter((task) => !task.parentTaskId);
  return rootTasks.length ? rootTasks : tasks;
}

function buildTaskListTitle(task) {
  const workflow = normalizeWorkflowPreview(task.workflow);
  const phaseTitle = compactWhitespace(task.phase?.title ?? "");
  const workflowTitle = compactWhitespace(workflow?.summary ?? "");
  const promptPreview = compactWhitespace(task.prompt ?? "");
  return workflowTitle || phaseTitle || promptPreview || "Untitled task";
}

function buildTaskListMeta(task) {
  const workflow = normalizeWorkflowPreview(task.workflow);
  const parts = [];

  if (workflow) {
    parts.push("Workflow");
    parts.push(`${workflow.phaseCount} phase${workflow.phaseCount === 1 ? "" : "s"}`);
  } else if (task.phase?.index && task.phase?.total) {
    parts.push(`Phase ${task.phase.index}/${task.phase.total}`);
  } else {
    parts.push(getActivityLabel(task.taskType));
  }

  if (task.result?.provider) {
    parts.push(task.result.provider);
  }

  return parts.filter(Boolean).join(" · ");
}

function renderTaskList() {
  if (!els.taskList) return;
  const query = els.taskFilter?.value ?? "";
  const statusFilter = els.taskStatusFilter?.value ?? "";
  const visibleTasks = getVisibleRecentTasks(recentTasks);
  const filteredTasks = visibleTasks.filter((task) => {
    if (statusFilter && task.status !== statusFilter) return false;
    return matchesQuery(
      [
        task.prompt,
        task.status,
        task.taskType,
        task.result?.provider,
        task.result?.model,
        task.workflow?.summary,
        ...(task.workflow?.phases ?? []).map((phase) => phase.title),
        task.phase?.title
      ],
      query
    );
  });

  if (!recentTasks.length) {
    els.taskList.className = "task-list empty-state";
    els.taskList.textContent = "No tasks yet.";
    return;
  }

  if (!filteredTasks.length) {
    els.taskList.className = "task-list empty-state";
    els.taskList.textContent = "No tasks match the current filter.";
    return;
  }

  els.taskList.className = "task-list";
  els.taskList.innerHTML = filteredTasks
    .map((task) => {
      const title = buildTaskListTitle(task);
      const meta = buildTaskListMeta(task);
      const updatedAt = task.updatedAt ? new Date(task.updatedAt).toLocaleString() : "";
      const statusClass = sanitizeCssToken(task.status, "unknown");
      // Surface degraded completions (critic failed but the phase went
      // through) so the operator can tell them apart from clean successes.
      const degradedCount = Number(task.summary?.runLedger?.degradedPhases ?? 0);
      const outcome = task.summary?.runLedger?.outcome;
      const isDegraded = degradedCount > 0 || outcome === "completed_with_warnings";
      return `
        <button class="task-list-item ${task.id === selectedTaskId ? "active" : ""}" type="button" data-task-id="${escapeHtml(task.id)}">
          <span class="task-status ${statusClass}">${escapeHtml(task.status ?? "unknown")}</span>
          ${isDegraded ? `<span class="task-status-degraded" title="${degradedCount} phase(s) accepted without a critic verdict">DEGRADED</span>` : ""}
          <span class="task-prompt-preview" title="${escapeHtml(title)}">${escapeHtml(title.slice(0, 72))}${title.length > 72 ? "…" : ""}</span>
          ${meta ? `<span class="task-list-submeta">${escapeHtml(meta)}</span>` : ""}
          <span class="task-meta">${escapeHtml(updatedAt)}</span>
        </button>
      `;
    })
    .join("");
}

async function refreshTaskList(preferredTaskId = null) {
  try {
    recentTasks = await api.taskList({ limit: 40 });
    renderTaskList();
    const visibleTasks = getVisibleRecentTasks(recentTasks);
    const nextSelectedTaskId =
      preferredTaskId ??
      (selectedTaskId && visibleTasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : visibleTasks[0]?.id ?? null);
    if (nextSelectedTaskId !== selectedTaskId) {
      await selectTask(nextSelectedTaskId);
      return;
    }
    await refreshSelectedTask();
  } catch (err) {
    logError("refreshTaskList", err);
    recentTasks = [];
    selectedTask = null;
    selectedTaskAudit = [];
    els.taskList.className = "task-list empty-state";
    els.taskList.textContent = "Could not load tasks.";
    renderSelectedTaskDetails();
  }
}

function renderTaskOperations(task) {
  if (!task) return "";
  const timeline = task.timeline ?? [];
  const toolActivity = task.toolActivity ?? [];
  const toolTrace = task.toolTrace ?? [];
  const agentRuns = task.agentRuns ?? [];
  const provider = task.result?.provider ?? task.result?.model ?? "";
  const model = task.result?.model ?? "";
  const workflow = normalizeWorkflowPreview(task.workflow);

  return `
    <details class="message-ops-details">
      <summary>Run details</summary>
      ${workflow ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Workflow</span>
          ${renderWorkflowPreviewCard(workflow, { compact: true })}
        </div>
      ` : ""}
      ${task.phase?.title ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Phase</span>
          <span>${escapeHtml(`${task.phase.title} (${task.phase.index}/${task.phase.total})`)}</span>
        </div>
      ` : ""}
      <div class="message-ops-section">
        <span class="message-ops-label">Status</span>
        <span>${escapeHtml(task.status ?? "unknown")}</span>
        <button type="button" class="btn secondary btn-replay-task" data-task-id="${escapeHtml(task.id)}">Replay…</button>
      </div>
      ${provider || model ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Model</span>
          <span>${escapeHtml([provider, model].filter(Boolean).join(" / "))}</span>
        </div>
      ` : ""}
      ${agentRuns.length ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Specialists</span>
          <div class="message-ops-list">
            ${agentRuns.map((run) => `
              <div class="message-ops-item">
                <strong>${escapeHtml(run.agentName)}</strong>
                <div>${renderMarkdown(run.content)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      ${timeline.length ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Timeline</span>
          <div class="message-ops-list">
            ${timeline.map((item) => `
              <div class="message-ops-item">
                <strong>${escapeHtml(item.stage)}</strong>
                <div>${escapeHtml(item.detail)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      ${toolActivity.length ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Tools</span>
          <div class="message-ops-list">
            ${toolActivity.map((item) => `
              <div class="message-ops-item">
                <strong>${escapeHtml(`${item.server}.${item.tool}`)}</strong>
                <div>${escapeHtml(item.detail ?? "")}</div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
      ${toolTrace.length ? `
        <div class="message-ops-section">
          <span class="message-ops-label">Tool trace</span>
          <div class="message-ops-list">${renderToolTraceCards(toolTrace)}</div>
        </div>
      ` : ""}
    </details>
  `;
}

function buildConversationMessagesHtml(
  messages,
  pendingAssistantText = "",
  pendingToolCalls = [],
  pendingStatusText = ""
) {
  const htmlParts = [];
  let lastDate = null;

  for (const message of messages ?? []) {
    const currentDate = formatMessageDate(message.createdAt);
    if (currentDate && currentDate !== lastDate) {
      htmlParts.push(`<div class="message-date-separator">${escapeHtml(currentDate)}</div>`);
      lastDate = currentDate;
    }
    const task = message.taskId ? activeConversationTasks.get(message.taskId) : null;
    const roleLabel = message.role === "assistant" ? "Assistant" : "You";
    const workflowPreview = getWorkflowPreviewFromMessage(message);
    const displayContent = message.role === "assistant"
      ? stripWorkflowPlanBlock(message.content ?? "")
      : (message.content ?? "");
    htmlParts.push(`
      <article class="message-card message-${message.role}">
        <header class="message-header">
          <strong class="message-name">${roleLabel}</strong>
          <time class="message-time">${escapeHtml(formatMessageTimestamp(message.createdAt))}</time>
        </header>
        ${workflowPreview ? renderWorkflowPreviewCard(workflowPreview) : ""}
        ${displayContent ? `<div class="message-body">${renderMarkdown(displayContent)}</div>` : ""}
        ${message.role === "assistant" && message.toolTrace?.length ? renderToolTraceCards(message.toolTrace) : ""}
        ${message.role === "assistant" ? renderTaskOperations(task) : ""}
      </article>
    `);
  }

  if (pendingAssistantText || pendingToolCalls.length || pendingStatusText) {
    const pendingWorkflowPreview = normalizeWorkflowPreview(parseWorkflowPlanFromText(pendingAssistantText));
    const pendingDisplayContent = stripWorkflowPlanBlock(pendingAssistantText);
    htmlParts.push(`
      <article class="message-card message-assistant">
        <header class="message-header">
          <strong class="message-name">Assistant</strong>
          <time class="message-time">Streaming…</time>
        </header>
        ${pendingWorkflowPreview ? renderWorkflowPreviewCard(pendingWorkflowPreview) : ""}
        ${pendingDisplayContent ? `<div class="message-body">${renderMarkdown(pendingDisplayContent)}</div>` : ""}
        ${!pendingDisplayContent && !pendingWorkflowPreview && !pendingToolCalls.length ? renderTypingIndicator() : ""}
        ${pendingStatusText ? `<div class="streaming-status">${escapeHtml(pendingStatusText)}</div>` : ""}
        ${pendingToolCalls.length ? renderToolTraceCards(pendingToolCalls) : ""}
      </article>
    `);
  }

  return htmlParts.join("");
}

function renderActiveConversation() {
  const title = activeConversation?.title ?? "New conversation";
  if (els.activeConversationTitle) {
    els.activeConversationTitle.textContent = title;
  }
  const shouldStick = isOutputNearBottom();
  const transcriptHtml = buildConversationMessagesHtml(
    activeConversation?.messages ?? [],
    streamingConversationId && streamingConversationId === state?.activeConversationId
      ? streamingAssistantText
      : "",
    streamingConversationId && streamingConversationId === state?.activeConversationId ? streamingToolCalls : [],
    streamingConversationId && streamingConversationId === state?.activeConversationId ? streamingStatusText : ""
  );
  els.output.innerHTML = transcriptHtml || `<div class="empty-state">Start the conversation by asking the assistant something.</div>`;
  if (shouldStick) {
    els.output.scrollTo({
      top: els.output.scrollHeight,
      behavior: streamingConversationId && streamingConversationId === state?.activeConversationId ? "smooth" : "auto"
    });
  }
}

function renderConversationList() {
  const conversations = state?.conversations ?? [];
  if (!els.conversationList) return;
  const query = els.conversationFilter?.value ?? "";
  if (!conversations.length) {
    els.conversationList.className = "task-list empty-state";
    els.conversationList.textContent = "No conversations yet.";
    return;
  }

  const filteredConversations = conversations.filter((conversation) =>
    matchesQuery([conversation.title, conversation.preview], query)
  );

  if (!filteredConversations.length) {
    els.conversationList.className = "task-list empty-state";
    els.conversationList.textContent = "No conversations match the current filter.";
    return;
  }

  els.conversationList.className = "task-list";
  els.conversationList.innerHTML = filteredConversations
    .map((conversation) => {
      const isActive = conversation.id === state.activeConversationId;
      return `
        <button class="conversation-list-item ${isActive ? "active" : ""}" data-conversation-id="${escapeHtml(conversation.id)}">
          <span class="conversation-title">${escapeHtml(conversation.title)}</span>
          <span class="conversation-preview">${escapeHtml(conversation.preview || "No messages yet.")}</span>
          <span class="task-meta">${escapeHtml(conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleString() : "")}</span>
        </button>
      `;
    })
    .join("");
}

async function refreshActiveConversation() {
  if (!state?.activeConversationId) {
    activeConversation = null;
    activeConversationTasks = new Map();
    renderActiveConversation();
    return;
  }

  try {
    activeConversation = await api.getConversation(state.activeConversationId);
    const taskIds = [...new Set((activeConversation?.messages ?? []).map((message) => message.taskId).filter(Boolean))];
    const taskResults = await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          return await api.getTask(taskId);
        } catch (err) {
          logWarn("refreshActiveConversation:getTask", `${taskId}: ${normalizeErrorMessage(err)}`);
          return null;
        }
      })
    );
    activeConversationTasks = new Map(
      taskResults
        .filter(Boolean)
        .map((task) => [task.id, task])
    );
    renderActiveConversation();
  } catch (err) {
    logError("refreshActiveConversation", err);
    activeConversation = null;
    activeConversationTasks = new Map();
    renderActiveConversation();
  }
}

function renderPolicy() {
  if (!els.policyProfile) return;
  const profile = state?.policyProfile ?? "assist";
  els.policyProfile.value = profile;
}

function renderMessaging() {
  if (!state?.messaging) return;
  if (els.messagingEnabled) els.messagingEnabled.checked = state.messaging.enabled;
  if (els.messagingBotToken) els.messagingBotToken.value = state.messaging.hasToken ? "••••••••" : "";
  if (els.messagingChatIds) {
    els.messagingChatIds.value = (state.messaging.allowedChatIds ?? []).join(", ");
  }
}

function renderDesktopCommander() {
  const commander = state?.desktopCommander ?? {};
  if (els.desktopCommanderEnabled) {
    els.desktopCommanderEnabled.checked = commander.enabled !== false;
  }
  if (els.lookeenPath) {
    els.lookeenPath.value = commander.lookeenPath ?? "";
  }
}

function renderMemory() {
  const memory = state?.memory ?? {};
  if (els.memoryEnabled) els.memoryEnabled.checked = memory.enabled !== false;
  if (els.memoryAutoCapture) els.memoryAutoCapture.checked = memory.autoCapture !== false;
  if (els.memoryCount) {
    els.memoryCount.textContent = `${memory.count ?? 0} saved`;
  }
  if (!els.memoryList) return;

  const query = els.memoryFilter?.value ?? "";
  const recent = (memory.recent ?? []).filter((entry) =>
    matchesQuery([entry.content, entry.category, ...(entry.tags ?? [])], query)
  );
  if (!recent.length) {
    els.memoryList.className = "task-list empty-state";
    els.memoryList.textContent = (memory.recent ?? []).length ? "No memories match the current filter." : "No memories saved yet.";
    return;
  }

  els.memoryList.className = "task-list";
  els.memoryList.innerHTML = recent
    .map(
      (entry) => `
        <div class="task-list-item">
          <span class="task-status">${escapeHtml(entry.category)}</span>
          <span class="conversation-title">${escapeHtml(entry.content)}</span>
          <span class="task-meta">${escapeHtml(entry.tags?.length ? entry.tags.join(", ") : "")}</span>
        </div>
      `
    )
    .join("");
}

function renderChipRow(container, items = [], type) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<span class="chip chip-muted">None</span>`;
    return;
  }
  container.innerHTML = items
    .map((item) => {
      if (type === "skill") {
        return `<button type="button" class="chip chip-action" data-skill-id="${escapeHtml(item.id)}" data-slash-command="${escapeHtml(item.slashCommand)}">${escapeHtml(item.label)}</button>`;
      }
      return `<span class="chip">${escapeHtml(item.label ?? item)}</span>`;
    })
    .join("");
}

function renderActivityProfilePanel() {
  const activityId = els.taskType?.value || state?.taskTypes?.[0];
  const profile = getActivityProfileById(activityId);
  if (!profile) return;
  const manualOverride = profile.id !== "orchestrator";

  if (els.activityProfileTitle) {
    els.activityProfileTitle.textContent = manualOverride ? `Manual override: ${profile.label}` : "Automatic orchestration";
  }
  if (els.activityProfileDefaultModel) {
    const activeModel = state?.modelProfiles?.[profile.id] ?? profile.defaultModel;
    els.activityProfileDefaultModel.textContent = manualOverride
      ? `Pinned capability: ${activeModel}`
      : "Models: chosen per workflow phase";
  }
  if (els.activityProfileDescription) {
    els.activityProfileDescription.textContent = manualOverride
      ? `Automatic orchestration is bypassed for this run. ${profile.description ?? ""}`.trim()
      : "Describe the outcome you want in plain English. The workflow engine will infer the steps, choose the capability packs, route tools, and decide what can run in parallel.";
  }

  if (!manualOverride) {
    renderChipRow(
      els.activityProfileMcps,
      (state?.activityProfiles ?? [])
        .filter((item) => item.id !== "orchestrator")
        .map((item) => ({ label: item.label })),
      "capability"
    );
    renderChipRow(
      els.activityProfileSkills,
      [
        { label: "Plain-English goals" },
        { label: "Workflow preview" },
        { label: "Policy-gated actions" }
      ],
      "hint"
    );
    renderChipRow(
      els.activityProfileAgents,
      [
        { label: "Planner" },
        { label: "Retrieval" },
        { label: "Authoring" },
        { label: "Verification" }
      ],
      "agent"
    );
    return;
  }

  renderChipRow(els.activityProfileMcps, profile.mcpPresets ?? [], "mcp");
  renderChipRow(els.activityProfileSkills, profile.recommendedSkills ?? [], "skill");
  renderChipRow(
    els.activityProfileAgents,
    (profile.specialistAgents ?? []).map((agent) => ({ label: agent })),
    "agent"
  );
}

function applySkillCommandToPrompt(slashCommand) {
  if (!els.taskPrompt || !slashCommand) return;
  const existing = els.taskPrompt.value.trim();
  const withoutExistingCommand = existing.replace(/^\/[a-z0-9-]+\s*/i, "").trim();
  els.taskPrompt.value = withoutExistingCommand
    ? `${slashCommand} ${withoutExistingCommand}`
    : `${slashCommand} `;
  autoResizeTaskPrompt();
  els.taskPrompt.focus();
}

function autoResizeTaskPrompt() {
  if (!els.taskPrompt) return;
  els.taskPrompt.style.height = "auto";
  els.taskPrompt.style.height = `${Math.min(els.taskPrompt.scrollHeight, 200)}px`;
}

function toggleAdvancedOptions(forceValue) {
  if (!els.advancedOptions || !els.btnToggleAdvanced) return;
  const shouldShow =
    typeof forceValue === "boolean"
      ? forceValue
      : els.advancedOptions.classList.contains("hidden");
  els.advancedOptions.classList.toggle("hidden", !shouldShow);
  els.btnToggleAdvanced.textContent = shouldShow ? "Hide options" : "Options";
}

function toggleActivityProfileDetail(forceValue) {
  if (!els.activityProfileDetail || !els.btnToggleActivityDetail) return;
  const shouldShow =
    typeof forceValue === "boolean"
      ? forceValue
      : els.activityProfileDetail.classList.contains("hidden");
  els.activityProfileDetail.classList.toggle("hidden", !shouldShow);
  els.btnToggleActivityDetail.textContent = shouldShow ? "Hide" : "How it routes";
}

function toggleSidebar(forceValue) {
  if (!els.workspaceGrid || !els.btnToggleSidebar) return;
  const shouldCollapse =
    typeof forceValue === "boolean"
      ? forceValue
      : !els.workspaceGrid.classList.contains("sidebar-collapsed");
  els.workspaceGrid.classList.toggle("sidebar-collapsed", shouldCollapse);
  els.btnToggleSidebar.textContent = shouldCollapse ? "Show sidebar" : "Sidebar";
}

function applyTheme(themeId) {
  const ids = state?.themeIds ?? THEME_OPTIONS.map((o) => o.value);
  const valid = themeId && ids.includes(themeId) ? themeId : "midnight";
  document.documentElement.setAttribute("data-theme", valid);
  persistThemePreference(valid);
  if (els.themeSelect) els.themeSelect.value = valid;
  if (els.themeSelectSetup) els.themeSelectSetup.value = valid;
  if (els.themePalette) {
    for (const button of els.themePalette.querySelectorAll("[data-theme-id]")) {
      button.classList.toggle("active", button.dataset.themeId === valid);
    }
  }
}

function renderThemePalette() {
  if (!els.themePalette) return;
  const themeIds = state?.themeIds ?? THEME_OPTIONS.map((option) => option.value);
  const options = THEME_OPTIONS.filter((option) => themeIds.includes(option.value));
  els.themePalette.innerHTML = options.map(
    (option) =>
      `<button type="button" class="chip chip-action theme-palette-chip" data-theme-id="${option.value}">${option.label}</button>`
  ).join("");
  applyTheme(state?.theme ?? "midnight");
}

async function saveThemeFromUi(themeId) {
  const previousTheme = state?.theme ?? document.documentElement.getAttribute("data-theme") ?? "midnight";
  state = state ?? {};
  state.theme = themeId;
  applyTheme(themeId);
  if (!api.setTheme) {
    return;
  }
  try {
    await api.setTheme(themeId);
  } catch (err) {
    showError("Failed to save theme: " + err.message);
    state.theme = previousTheme;
    applyTheme(previousTheme);
  }
}

function syncBootstrapControls() {
  const connectedCount = Object.values(state?.keyStatus ?? {}).filter(Boolean).length;
  setConnected(connectedCount);
  renderRuntimeDiagnostics();
  renderThemePalette();
  renderKeyFields();
  renderTaskTypes();
  renderModelOverride();
  renderProfiles();
  renderActivityProfilePanel();
  renderMcpServers();
  renderSandboxStatus();
  renderToolStatus();
  renderConversationList();
  renderPolicy();
  renderMessaging();
  renderDesktopCommander();
  renderMemory();
  if (els.taskType && !els.taskType.value) {
    els.taskType.value = state?.taskTypes?.[0] ?? state?.activityProfiles?.[0]?.id ?? "";
  }
  if (els.executionMode) {
    els.executionMode.value = state?.executionMode ?? "plan_first";
  }
  if (els.sandboxPreference) {
    els.sandboxPreference.value = state?.sandboxPreference ?? "manual";
  }
  toggleAdvancedOptions(false);
  toggleActivityProfileDetail(false);
  toggleSidebar(false);
  setAdvancedSetupVisibility(false);
  setTopbarSummary();
}

function syncWorkspaceState() {
  allModels = {};
  for (const [id, models] of Object.entries(state?.modelCache ?? {})) {
    allModels[id] = { models };
  }
  renderModelOverride();
  renderProfiles();
  renderMcpServers();
  renderSandboxStatus();
  renderToolStatus();
  renderConversationList();
  renderPolicy();
  renderMessaging();
  renderDesktopCommander();
  renderMemory();
  setTopbarSummary();
}

async function getWorkspaceSnapshot() {
  return api.getWorkspaceState ? api.getWorkspaceState() : api.getState();
}

async function getNormalizedBootstrapState() {
  const bootstrapState = api.getBootstrapState ? await api.getBootstrapState() : await api.getState();
  const providers = Object.keys(bootstrapState?.providers ?? {}).length
    ? bootstrapState.providers
    : { ...DEFAULT_PROVIDER_LABELS };
  let keyStatus = bootstrapState?.keyStatus ?? {};

  const keyStatusMissing = !Object.keys(keyStatus).length;
  const keyStatusAllFalse = Object.keys(providers).length > 0 && Object.values(keyStatus).every((value) => !value);
  if ((keyStatusMissing || keyStatusAllFalse) && api.getKeyStatus) {
    try {
      keyStatus = await api.getKeyStatus();
    } catch (err) {
      logWarn("getNormalizedBootstrapState:getKeyStatus", err);
      keyStatus = keyStatusMissing ? Object.fromEntries(Object.keys(providers).map((id) => [id, false])) : keyStatus;
    }
  }

  return {
    ...bootstrapState,
    providers,
    keyStatus
  };
}

// Guards against racing refreshState() calls. If a refresh is already running,
// subsequent callers await the in-flight promise; if multiple requests arrive
// while one is running, we queue a single follow-up refresh so the caller is
// guaranteed to observe a refresh that started after their request.
let inFlightRefresh = null;
let pendingRefresh = false;

async function doRefreshState() {
  let bootstrapState = null;
  try {
    bootstrapState = await getNormalizedBootstrapState();
    state = mergeAssistantState(bootstrapState, {});
    syncBootstrapControls();
  } catch (err) {
    logError("refreshState:bootstrap", err);
    return;
  }

  try {
    const workspaceState = await getWorkspaceSnapshot();
    state = mergeAssistantState(bootstrapState, workspaceState);
    if (!(state.conversations ?? []).length && api.newConversation) {
      const created = await api.newConversation({});
      state.conversations = created.conversations ?? [];
      state.activeConversationId = created.activeConversationId ?? null;
    }
    syncBootstrapControls();
    syncWorkspaceState();
    await refreshTaskList();
    await refreshActiveConversation();
    await refreshMailCalendarStatus();
  } catch (err) {
    logError("refreshState:workspace", err);
  }
}

async function refreshState() {
  if (inFlightRefresh) {
    pendingRefresh = true;
    await inFlightRefresh;
    if (!pendingRefresh) return;
    pendingRefresh = false;
  }
  inFlightRefresh = (async () => {
    try {
      await doRefreshState();
      // If additional refresh requests arrived while we were running, run
      // one more time so the latest caller sees state that was fetched after
      // their call — but collapse the storm to a single follow-up pass.
      if (pendingRefresh) {
        pendingRefresh = false;
        await doRefreshState();
      }
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

function bindThemeSelect(el) {
  if (!el) return;
  el.addEventListener("change", async () => {
    const themeId = el.value;
    if (els.themeSelect && el !== els.themeSelect) els.themeSelect.value = themeId;
    if (els.themeSelectSetup && el !== els.themeSelectSetup) els.themeSelectSetup.value = themeId;
    await saveThemeFromUi(themeId);
  });
}

bindThemeSelect(els.themeSelect);
bindThemeSelect(els.themeSelectSetup);

if (els.taskPrompt) {
  els.taskPrompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!els.btnRun.disabled) {
        els.btnRun.click();
      }
    }
  });
  els.taskPrompt.addEventListener("input", () => {
    autoResizeTaskPrompt();
  });
  autoResizeTaskPrompt();
}

if (els.btnToggleAdvanced) {
  els.btnToggleAdvanced.addEventListener("click", () => {
    toggleAdvancedOptions();
  });
}

if (els.btnToggleActivityDetail) {
  els.btnToggleActivityDetail.addEventListener("click", () => {
    toggleActivityProfileDetail();
  });
}

if (els.btnToggleSidebar) {
  els.btnToggleSidebar.addEventListener("click", () => {
    toggleSidebar();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "/") {
    event.preventDefault();
    toggleSidebar();
    return;
  }

  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    els.btnNewConversation?.click();
    return;
  }

  // Ctrl+N = new conversation
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    els.btnNewConversation?.click();
    return;
  }

  // Ctrl+K = focus prompt input
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    els.taskPrompt?.focus();
    return;
  }

  if (event.key === "Escape") {
    hidePlanApprovalBanner();
  }
});

if (els.btnSetup) {
  els.btnSetup.addEventListener("click", () => {
    const nextVisible = els.advancedSetupBody?.classList.contains("hidden");
    setAdvancedSetupVisibility(nextVisible);
    if (nextVisible) {
      renderProfiles();
      renderMcpServers();
    }
  });
}

if (els.btnCloseSetup) {
  els.btnCloseSetup.addEventListener("click", () => {
    setAdvancedSetupVisibility(false);
  });
}

if (els.themePalette) {
  els.themePalette.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-theme-id]");
    if (!button) return;
    await saveThemeFromUi(button.dataset.themeId);
  });
}

els.btnSaveKeys.addEventListener("click", async () => {
  els.btnSaveKeys.disabled = true;
  const inputs = [...document.querySelectorAll(".key-input")];
  const keys = {};
  for (const input of inputs) {
    if (input.value.trim()) {
      keys[input.dataset.provider] = input.value.trim();
    }
  }

  if (Object.keys(keys).length === 0) {
    showError("Enter at least one API key");
    els.btnSaveKeys.disabled = false;
    return;
  }

  try {
    const keyStatus = await api.saveApiKeys(keys);
    state.keyStatus = keyStatus;
    const count = Object.values(keyStatus).filter(Boolean).length;
    setConnected(count);
    setTopbarSummary();
    renderKeyFields();
    clearError();
    els.modelFetchStatus.textContent = "Keys saved. Click 'Refresh Models' to fetch available models.";
  } catch (err) {
    showError("Failed to save keys: " + err.message);
  }
  els.btnSaveKeys.disabled = false;
});

els.btnRefreshModels.addEventListener("click", async () => {
  els.btnRefreshModels.disabled = true;
  els.modelFetchStatus.textContent = "Fetching models from all configured providers...";
  try {
    allModels = await api.listAllModels();
    const successes = Object.entries(allModels).filter(([, data]) => data.models?.length > 0);
    const failures = Object.entries(allModels).filter(([, data]) => data.error && !data.models?.length);
    const successNames = successes.map(([id]) => id).join(", ");
    const failureDetails = failures.map(([id, data]) => `${id}: ${data.error}`).join(" | ");
    els.modelFetchStatus.textContent = `${successes.length} provider(s) OK (${successNames}).` +
      (failures.length ? ` ${failures.length} failed: ${failureDetails}` : "");
    renderModelOverride();
    renderProfiles();
  } catch (err) {
    showError("Failed to fetch models: " + err.message);
  }
  els.btnRefreshModels.disabled = false;
});

els.btnSaveProfiles.addEventListener("click", async () => {
  const selects = [...document.querySelectorAll(".profile-select")];
  const profiles = {};
  for (const select of selects) {
    if (select.value) profiles[select.dataset.taskType] = select.value;
  }
  try {
    state.modelProfiles = await api.updateModelProfiles(profiles);
    clearError();
  } catch (err) {
    showError("Failed to save profiles: " + err.message);
  }
});

if (els.taskType) {
  els.taskType.addEventListener("change", () => {
    renderActivityProfilePanel();
  });
}

if (els.btnAddFilesystemRoot) {
  els.btnAddFilesystemRoot.addEventListener("click", () => {
    const roots = collectRootValues(els.filesystemRoots);
    roots.push("");
    renderRootList(els.filesystemRoots, roots, "filesystem");
  });
}

if (els.btnPickDocumentOpsDir) {
  els.btnPickDocumentOpsDir.addEventListener("click", async () => {
    try {
      const selectedPath = await api.pickDirectory();
      if (selectedPath && els.documentOpsRoot) {
        els.documentOpsRoot.value = selectedPath;
      }
    } catch (err) {
      showError("Failed to open folder picker: " + err.message);
    }
  });
}
if (els.btnAddFileOpsRoot) {
  els.btnAddFileOpsRoot.addEventListener("click", () => {
    const roots = collectRootValues(els.fileOpsRoots);
    roots.push("");
    renderRootList(els.fileOpsRoots, roots, "file-ops");
  });
}
if (els.btnPickLookeen) {
  els.btnPickLookeen.addEventListener("click", async () => {
    try {
      const selectedPath = await api.pickExecutable();
      if (selectedPath && els.lookeenPath) {
        els.lookeenPath.value = selectedPath;
      }
    } catch (err) {
      showError("Failed to open executable picker: " + err.message);
    }
  });
}

for (const rootContainer of [els.filesystemRoots, els.fileOpsRoots]) {
  if (!rootContainer) continue;
  rootContainer.addEventListener("click", async (event) => {
    const row = event.target.closest(".root-row");
    if (!row) return;
    const kind = row.dataset.rootKind;
    const index = Number.parseInt(row.dataset.rootIndex ?? "-1", 10);
    if (event.target.closest(".btn-root-remove")) {
      const container = kind === "filesystem" ? els.filesystemRoots : els.fileOpsRoots;
      const roots = collectRootValues(container);
      const nextRoots = roots.filter((_, currentIndex) => currentIndex !== index);
      renderRootList(container, nextRoots.length ? nextRoots : [""], kind);
      return;
    }
    if (event.target.closest(".btn-root-browse")) {
      try {
        const selectedPath = await api.pickDirectory();
        if (!selectedPath) return;
        const input = row.querySelector(".root-input");
        if (input) {
          input.value = selectedPath;
        }
      } catch (err) {
        showError("Failed to open folder picker: " + err.message);
      }
    }
  });
}

els.btnAddMcp.addEventListener("click", () => {
  const name = els.mcpName.value.trim();
  const transport = els.mcpTransport.value;
  const target = els.mcpTarget.value.trim();
  const args = splitArgs(els.mcpArgs.value.trim());

  if (!name || !target) {
    showError("Enter a server name and command/URL.");
    return;
  }

  const nextServer = transport === "streamable-http"
    ? { name, kind: "custom", enabled: true, transport, url: target }
    : { name, kind: "custom", enabled: true, transport, command: target, args };

  const builtinServers = [
    getFilesystemServer(),
    getDocumentOpsServer(),
    getBrowserOpsServer(),
    getDesktopCommanderServer(),
    getMemoryMcpServer(),
    getFileOpsServer(),
    getMailCalendarServer()
  ].filter(Boolean);
  const remainingCustomServers = getCustomServers().filter((server) => server.name !== name);
  state.mcpServers = [
    ...builtinServers,
    ...remainingCustomServers,
    nextServer
  ];

  els.mcpName.value = "";
  els.mcpTarget.value = "";
  els.mcpArgs.value = "";
  renderMcpServers();
  els.mcpConnectStatus.textContent = "Custom server added. Save Tool Config to persist it.";
});

els.mcpServerList.addEventListener("click", (event) => {
  const button = event.target.closest(".btn-remove-server");
  if (!button) return;

  const serverName = button.dataset.name;
  state.mcpServers = (state.mcpServers ?? []).filter((server) => server.name !== serverName);
  renderMcpServers();
  els.mcpConnectStatus.textContent = "Server removed locally. Save Tool Config to persist the change.";
});

els.mcpServerList.addEventListener("change", (event) => {
  const toggle = event.target.closest(".server-enable-toggle");
  if (toggle) {
    const serverName = toggle.dataset.server;
    const server = (state.mcpServers ?? []).find((s) => s.name === serverName);
    if (server) {
      server.enabled = toggle.checked;
      els.mcpConnectStatus.textContent = `${serverName} ${toggle.checked ? "enabled" : "disabled"}. Save Tool Config to persist.`;
    }
    return;
  }

  const authInput = event.target.closest(".auth-token-input");
  if (authInput) {
    const serverName = authInput.dataset.server;
    const server = (state.mcpServers ?? []).find((s) => s.name === serverName);
    if (server) {
      server.authToken = authInput.value.trim();
      els.mcpConnectStatus.textContent = `Auth token updated for ${serverName}. Save Tool Config to persist.`;
    }
    return;
  }

  const envInput = event.target.closest(".env-input");
  if (envInput) {
    const serverName = envInput.dataset.server;
    const envKey = envInput.dataset.envKey;
    const server = (state.mcpServers ?? []).find((s) => s.name === serverName);
    if (server && server.env) {
      server.env[envKey] = envInput.value.trim();
      els.mcpConnectStatus.textContent = `${envKey} updated for ${serverName}. Save Tool Config to persist.`;
    }
  }
});

function serializeMcpServersFromUi() {
  const nextServers = getCustomServers().map((server) => ({ ...server }));
  if (els.desktopCommanderMcpEnabled?.checked) {
    nextServers.unshift({
      name: "Desktop Commander",
      kind: "builtin-desktop-commander",
      enabled: true
    });
  }
  if (els.memoryMcpEnabled?.checked) {
    nextServers.unshift({
      name: "Persistent Memory",
      kind: "builtin-memory",
      enabled: true
    });
  }
  if (els.browserOpsEnabled?.checked) {
    nextServers.unshift({
      name: "Browser / Web fetch",
      kind: "builtin-browser-ops",
      enabled: true
    });
  }
  const fileOpsRoots = collectRootValues(els.fileOpsRoots);
  if (els.fileOpsEnabled?.checked && fileOpsRoots.length > 0) {
    nextServers.unshift({
      name: "File organization",
      kind: "builtin-file-ops",
      enabled: true,
      rootPath: fileOpsRoots[0],
      roots: fileOpsRoots,
      allowAnyPath: els.fileOpsFullAccess?.checked === true
    });
  }
  if (els.mailCalendarEnabled?.checked) {
    nextServers.unshift({
      name: "Mail & Calendar (Microsoft 365)",
      kind: "builtin-mail-calendar",
      enabled: true
    });
  }
  if (els.documentOpsEnabled?.checked && els.documentOpsRoot?.value.trim()) {
    nextServers.unshift({
      name: "Documents & Reports",
      kind: "builtin-document-ops",
      enabled: true,
      rootPath: els.documentOpsRoot.value.trim()
    });
  }
  const filesystemRoots = collectRootValues(els.filesystemRoots);
  if (els.filesystemEnabled.checked && filesystemRoots.length > 0) {
    nextServers.unshift({
      name: "Local Filesystem",
      kind: "builtin-filesystem",
      enabled: true,
      rootPath: filesystemRoots[0],
      roots: filesystemRoots,
      allowAnyPath: els.filesystemFullAccess?.checked === true
    });
  }
  return nextServers;
}

async function persistMcpServers() {
  const servers = serializeMcpServersFromUi();
  const result = await api.setMcpServers(servers);
  state.mcpServers = result.mcpServers;
  state.mcpStatuses = result.mcpStatuses;
  renderMcpServers();
  renderToolStatus();
  setTopbarSummary();
}

els.btnSaveTools.addEventListener("click", async () => {
  try {
    await persistMcpServers();
    clearError();
    els.mcpConnectStatus.textContent = "Tool configuration saved.";
    await refreshMailCalendarStatus();
  } catch (err) {
    showError("Failed to save MCP server configuration: " + err.message);
  }
});

els.btnConnectMcp.addEventListener("click", async () => {
  els.btnConnectMcp.disabled = true;
  els.mcpConnectStatus.textContent = "Connecting MCP servers...";
  try {
    await persistMcpServers();
    state.mcpStatuses = await api.connectMcp();
    renderMcpServers();
    renderToolStatus();
    setTopbarSummary();
    clearError();
    const connected = state.mcpStatuses.filter((status) => status.status === "connected").length;
    els.mcpConnectStatus.textContent = `Connected ${connected} MCP server(s).`;
    await refreshMailCalendarStatus();
  } catch (err) {
    showError("Failed to connect MCP servers: " + err.message);
  }
  els.btnConnectMcp.disabled = false;
});

if (api.onTaskUpdated) {
  api.onTaskUpdated(() => refreshTaskList());
}

const btnClearTasks = document.getElementById("btn-clear-tasks");
if (btnClearTasks && api.clearTasks) {
  btnClearTasks.addEventListener("click", async () => {
    const result = await api.clearTasks();
    await refreshTaskList();
  });
}

if (api.onConversationUpdated) {
  api.onConversationUpdated(async ({ conversationId }) => {
    if (!conversationId) return;
    state = state ?? {};
    state.activeConversationId = state.activeConversationId ?? conversationId;
    const freshState = await getWorkspaceSnapshot();
    state.conversations = freshState.conversations ?? state.conversations ?? [];
    renderConversationList();
    if (conversationId === state.activeConversationId) {
      await refreshActiveConversation();
    }
  });
}

if (api.onMemoryUpdated) {
  api.onMemoryUpdated(async () => {
    const freshState = await getWorkspaceSnapshot();
    state.memory = freshState.memory;
    renderMemory();
  });
}

if (api.onN8nTrigger) {
  api.onN8nTrigger((data) => {
    const title = data?.title ?? "n8n Workflow";
    const action = data?.action ?? "notify";
    const payload = data?.payload;

    // Record the n8n trigger in the persistent log surface. We no longer
    // reuse the error banner as a flash toast — it's reserved for errors.
    const msg = payload?.message ?? payload?.summary ?? title;
    logWarn("n8n", `${title}: ${msg}`);

    // If it includes a task prompt, inject it
    if (action === "run_task" && payload?.prompt && els.taskPrompt) {
      els.taskPrompt.value = payload.prompt;
    }
  });
}

if (els.btnNewConversation) {
  els.btnNewConversation.addEventListener("click", async () => {
    try {
      resetStreamingState();
      const result = await api.newConversation({});
      state.conversations = result.conversations ?? [];
      state.activeConversationId = result.activeConversationId ?? null;
      renderConversationList();
      await refreshActiveConversation();
      if (els.taskPrompt) {
        els.taskPrompt.value = "";
        autoResizeTaskPrompt();
        els.taskPrompt.focus();
      }
      clearError();
    } catch (err) {
      showError("Failed to create a new conversation: " + err.message);
    }
  });
}

if (els.conversationList) {
  els.conversationList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-conversation-id]");
    if (!button) return;
    const conversationId = button.dataset.conversationId;
    if (!conversationId || conversationId === state?.activeConversationId) return;
    try {
      await api.setActiveConversation(conversationId);
      state.activeConversationId = conversationId;
      resetStreamingState();
      renderConversationList();
      await refreshActiveConversation();
      clearError();
    } catch (err) {
      showError("Failed to open conversation: " + err.message);
    }
  });
}

if (els.taskList) {
  els.taskList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-task-id]");
    if (!button) return;
    const taskId = button.dataset.taskId;
    if (!taskId) return;
    await selectTask(taskId);
  });
}

if (els.conversationFilter) {
  els.conversationFilter.addEventListener("input", () => {
    renderConversationList();
  });
}

if (els.memoryFilter) {
  els.memoryFilter.addEventListener("input", () => {
    renderMemory();
  });
}

if (els.taskFilter) {
  els.taskFilter.addEventListener("input", () => {
    renderTaskList();
  });
}

if (els.taskStatusFilter) {
  els.taskStatusFilter.addEventListener("change", () => {
    renderTaskList();
  });
}

if (els.quickActions) {
  els.quickActions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt-template]");
    if (!button || !els.taskPrompt) return;
    const promptTemplate = button.dataset.promptTemplate ?? "";
    const taskType = button.dataset.taskType ?? "";
    els.taskPrompt.value = promptTemplate;
    if (taskType && els.taskType) {
      els.taskType.value = taskType;
      renderActivityProfilePanel();
    }
    autoResizeTaskPrompt();
    els.taskPrompt.focus();
    els.taskPrompt.setSelectionRange(els.taskPrompt.value.length, els.taskPrompt.value.length);
  });
}

if (els.activityProfileSkills) {
  els.activityProfileSkills.addEventListener("click", (event) => {
    const button = event.target.closest("[data-slash-command]");
    if (!button) return;
    applySkillCommandToPrompt(button.dataset.slashCommand);
  });
}

function getMailCalendarServerFromState() {
  return (state.mcpServers ?? []).find((server) => server.kind === "builtin-mail-calendar");
}

function getMailCalendarMcpStatus() {
  const mailServer = getMailCalendarServerFromState();
  if (!mailServer?.name) return null;
  return (state.mcpStatuses ?? []).find((entry) => entry.name === mailServer.name) ?? null;
}

async function refreshMailCalendarStatus() {
  if (!els.mailCalendarStatus) return;
  try {
    const hasConfig = await api.hasMailCalendarConfig();
    if (!hasConfig) {
      els.mailCalendarStatus.textContent = "Sign in with device code first.";
      return;
    }

    const mailServer = getMailCalendarServerFromState();
    const mailStatus = getMailCalendarMcpStatus();

    if (!mailServer || mailServer.enabled === false) {
      els.mailCalendarStatus.textContent =
        "Signed in, but Mail & Calendar is disabled in tool config. Turn on Enabled and click Save Tool Config.";
      return;
    }

    if (mailStatus?.status === "connected") {
      els.mailCalendarStatus.textContent = "Mail & Calendar MCP connected.";
      return;
    }
    if (mailStatus?.status === "error") {
      els.mailCalendarStatus.textContent = `MCP error: ${mailStatus.error ?? "connection failed"}`;
      return;
    }
    if (mailStatus?.status === "disabled") {
      els.mailCalendarStatus.textContent = "Server disabled in config. Enable and save again.";
      return;
    }

    els.mailCalendarStatus.textContent =
      "Mail & Calendar is saved. Click Connect Tools below to start the MCP server.";
  } catch (err) {
    logWarn("mailCalendarStatus", err);
    els.mailCalendarStatus.textContent = "";
  }
}

if (els.btnMailCalendarSignin) {
  els.btnMailCalendarSignin.addEventListener("click", async () => {
    const clientId = els.mailCalendarClientId?.value?.trim();
    const tenantId = els.mailCalendarTenantId?.value?.trim();
    if (!clientId || !tenantId) {
      showError("Enter Application (client) ID and Directory (tenant) ID from your Azure app registration.");
      return;
    }
    els.btnMailCalendarSignin.disabled = true;
    if (els.mailCalendarDeviceMessage) {
      els.mailCalendarDeviceMessage.classList.remove("hidden");
      els.mailCalendarDeviceMessage.textContent = "Starting device code flow...";
    }
    const unsub = api.onDeviceCodeMessage?.((message) => {
      if (els.mailCalendarDeviceMessage) {
        els.mailCalendarDeviceMessage.textContent = message;
      }
    });
    try {
      const result = await api.runMicrosoft365DeviceCode({ clientId, tenantId });
      if (result?.success) {
        els.mailCalendarStatus.textContent = "Signed in successfully.";
        if (els.mailCalendarDeviceMessage) {
          els.mailCalendarDeviceMessage.classList.add("hidden");
        }
        refreshMailCalendarStatus();
      } else {
        showError(result?.error ?? "Sign-in failed.");
        if (els.mailCalendarDeviceMessage) {
          els.mailCalendarDeviceMessage.textContent = result?.error ?? "Failed.";
        }
      }
    } catch (err) {
      showError("Device code flow failed: " + err.message);
      if (els.mailCalendarDeviceMessage) {
        els.mailCalendarDeviceMessage.textContent = err.message;
      }
    }
    unsub?.();
    els.btnMailCalendarSignin.disabled = false;
  });
}

if (els.btnSaveMessaging) {
  els.btnSaveMessaging.addEventListener("click", async () => {
    try {
      const chatIdsStr = els.messagingChatIds?.value?.trim() ?? "";
      const allowedChatIds = chatIdsStr
        ? chatIdsStr.split(/[\s,]+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n))
        : [];
      const tokenValue = els.messagingBotToken?.value?.trim();
      await api.setMessagingConfig({
        enabled: els.messagingEnabled?.checked ?? false,
        channel: "telegram",
        botToken: tokenValue === "••••••••" ? undefined : tokenValue,
        allowedChatIds
      });
      if (tokenValue && tokenValue !== "••••••••") {
        els.messagingBotToken.value = "••••••••";
      }
      state.messaging = await getWorkspaceSnapshot().then((s) => s.messaging);
      renderMessaging();
      clearError();
    } catch (err) {
      showError("Failed to save messaging config: " + err.message);
    }
  });
}

if (els.btnSaveMemory) {
  els.btnSaveMemory.addEventListener("click", async () => {
    try {
      const result = await api.setMemorySettings({
        enabled: els.memoryEnabled?.checked ?? true,
        autoCapture: els.memoryAutoCapture?.checked ?? true
      });
      state.memory = {
        ...(state.memory ?? {}),
        ...result,
        recent: state.memory?.recent ?? []
      };
      renderMemory();
      clearError();
    } catch (err) {
      showError("Failed to save memory settings: " + err.message);
    }
  });
}

if (els.btnSaveDesktopCommander) {
  els.btnSaveDesktopCommander.addEventListener("click", async () => {
    try {
      const result = await api.setDesktopCommanderConfig({
        enabled: els.desktopCommanderEnabled?.checked ?? true,
        lookeenPath: els.lookeenPath?.value?.trim() ?? ""
      });
      state.desktopCommander = result;
      renderDesktopCommander();
      renderMcpServers();
      clearError();
    } catch (err) {
      showError("Failed to save Desktop Commander settings: " + err.message);
    }
  });
}

if (els.sandboxPreference) {
  els.sandboxPreference.addEventListener("change", async () => {
    try {
      await api.setSandboxPreference(els.sandboxPreference.value);
      state.sandboxPreference = els.sandboxPreference.value;
    } catch (err) {
      logError("setSandboxPreference", err);
    }
  });
}

if (els.btnSavePolicy) {
  els.btnSavePolicy.addEventListener("click", async () => {
    try {
      await api.setPolicy({ profile: els.policyProfile.value });
      state.policyProfile = els.policyProfile.value;
      clearError();
    } catch (err) {
      showError("Failed to save policy: " + err.message);
    }
  });
}

let unsubChunk = null;
let unsubDone = null;
let unsubError = null;
let pendingPlanTaskId = null;
let pendingPlanPreview = null;

function renderPlanPhaseList(executionPlan) {
  const container = document.getElementById("plan-phase-list");
  if (!container) return;
  const workflowPreview = normalizeWorkflowPreview(executionPlan);
  if (!workflowPreview?.phases?.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = renderWorkflowPreviewCard(workflowPreview);
}

function showPlanApprovalBanner(taskId, executionPlan) {
  pendingPlanTaskId = taskId;
  pendingPlanPreview = executionPlan ?? null;
  renderPlanPhaseList(executionPlan);
  if (els.planApprovalBanner) els.planApprovalBanner.classList.remove("hidden");
}

function hidePlanApprovalBanner() {
  pendingPlanTaskId = null;
  pendingPlanPreview = null;
  renderPlanPhaseList(null);
  if (els.planApprovalBanner) els.planApprovalBanner.classList.add("hidden");
}

function attachAssistantStreamHandlers() {
  if (unsubChunk) unsubChunk();
  if (unsubDone) unsubDone();
  if (unsubError) unsubError();

  unsubChunk = api.onStreamChunk((chunk) => {
    routingStatusFromChunk(chunk);
    if (chunk.type === "text") {
      streamingAssistantText += chunk.text;
      if (streamingAssistantText.trim()) {
        streamingStatusText = "";
      }
      renderActiveConversation();
    } else if (chunk.type === "status") {
      streamingStatusText = chunk.text.trim() || "Thinking...";
      renderActiveConversation();
    } else if (chunk.type === "tool_call") {
      upsertStreamingToolCall({
        ...chunk,
        status: "running"
      });
      streamingStatusText = `Running ${chunk.tool}...`;
      renderActiveConversation();
    } else if (chunk.type === "tool_result") {
      upsertStreamingToolCall(chunk);
      streamingStatusText =
        chunk.status === "error"
          ? `${chunk.tool} failed`
          : `${chunk.tool} completed`;
      renderActiveConversation();
    }
  });

  unsubDone = api.onStreamDone(async (result) => {
    els.btnRun.disabled = false;
    if (els.btnApprovePlan) els.btnApprovePlan.disabled = false;
    resetRoutingStatus();
    if (result.pendingApproval && result.taskId) {
      showPlanApprovalBanner(result.taskId, result.workflowPreview ?? result.executionPlan);
    }
    if (result.conversationId) {
      state.activeConversationId = result.conversationId;
      const freshState = await getWorkspaceSnapshot();
      state.conversations = freshState.conversations ?? state.conversations ?? [];
      renderConversationList();
      resetStreamingState();
      await refreshActiveConversation();
    }
    await refreshTaskList(result.taskId ?? result.parentTaskId ?? null);
    els.taskPrompt.value = "";
    autoResizeTaskPrompt();
  });

  unsubError = api.onStreamError((err) => {
    handleExecutionError("assistant-stream", err?.error ?? err);
  });
}

els.btnRun.addEventListener("click", async () => {
  const prompt = els.taskPrompt.value.trim();
  if (!prompt) {
    showError("Enter a prompt");
    return;
  }

  els.btnRun.disabled = true;
  if (els.btnApprovePlan) els.btnApprovePlan.disabled = true;
  resetStreamingState();
  streamingConversationId = state?.activeConversationId ?? "pending";
  streamingStatusText = "Thinking...";
  renderActiveConversation();
  clearError();
  hidePlanApprovalBanner();
  setRoutingStatus("Planning — selecting model...");

  attachAssistantStreamHandlers();

  try {
    const result = await api.runTask({
      prompt,
      taskType: els.taskType.value,
      modelOverride: els.modelOverride.value || undefined,
      runMode: els.runMode.value,
      conversationId: state?.activeConversationId ?? undefined,
      executionMode: els.executionMode?.value ?? "plan_first"
    });
    if (result?.error) {
      handleExecutionError("runTask", result.error);
    }
  } catch (err) {
    handleExecutionError("runTask", err);
  }
});

if (els.btnApprovePlan) {
  els.btnApprovePlan.addEventListener("click", async () => {
    if (!pendingPlanTaskId || !state?.activeConversationId) {
      showError("No pending plan to approve.");
      return;
    }
    const taskIdToApprove = pendingPlanTaskId;
    els.btnRun.disabled = true;
    els.btnApprovePlan.disabled = true;
    hidePlanApprovalBanner();
    resetStreamingState();
    streamingConversationId = state.activeConversationId ?? "pending";
    streamingStatusText = "Executing approved plan...";
    renderActiveConversation();
    clearError();
    setRoutingStatus("Executing approved plan...");

    attachAssistantStreamHandlers();

    try {
      const result = await api.approvePlan({
        taskId: taskIdToApprove,
        conversationId: state.activeConversationId,
        modelOverride: els.modelOverride.value || undefined
      });
      if (result?.error) {
        handleExecutionError("approvePlan", result.error);
      }
    } catch (err) {
      handleExecutionError("approvePlan", err);
    }
  });
}

if (els.btnDismissPlan) {
  els.btnDismissPlan.addEventListener("click", () => {
    hidePlanApprovalBanner();
  });
}

syncBootstrapControls();
refreshState();

// ═══════════════════════════════════════════════════════════
// Skills tab — browse / reload filesystem-backed SKILL.md files.
// The IPC (assistant:getSkills / getSkill / reloadSkills) was wired in
// main.js. This block is pure UI.
// ═══════════════════════════════════════════════════════════
const skillsTabEls = {
  list: document.getElementById("skills-list"),
  detail: document.getElementById("skills-detail"),
  reload: document.getElementById("btn-skills-reload"),
  tabBtn: document.querySelector('.tab-btn[data-tab="skills"]')
};

let skillsTabState = {
  loaded: false,
  loading: false,
  skills: [],
  activeId: null
};

function formatSkillTriggers(triggers) {
  const list = Array.isArray(triggers) ? triggers.filter(Boolean) : [];
  if (!list.length) return "";
  return `Triggers: ${list.join(", ")}`;
}

function renderSkillsList() {
  if (!skillsTabEls.list) return;
  if (skillsTabState.loading) {
    skillsTabEls.list.innerHTML = '<p class="hint">Loading skills…</p>';
    return;
  }
  if (!skillsTabState.skills.length) {
    skillsTabEls.list.innerHTML = `
      <p class="hint">No skills installed. Drop a SKILL.md into the bundled <code>skills/</code> folder or into <code>%APPDATA%\\WCJR Assistant\\skills\\</code> and click Reload.</p>`;
    return;
  }
  skillsTabEls.list.innerHTML = "";
  for (const skill of skillsTabState.skills) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "skill-card";
    card.dataset.skillId = skill.id;
    if (skill.id === skillsTabState.activeId) card.classList.add("active");
    card.innerHTML = `
      <div class="skill-name"></div>
      <div class="skill-triggers"></div>
    `;
    card.querySelector(".skill-name").textContent = skill.name;
    card.querySelector(".skill-triggers").textContent =
      formatSkillTriggers(skill.triggers) || skill.description.slice(0, 80);
    card.addEventListener("click", () => {
      skillsTabState.activeId = skill.id;
      renderSkillsList();
      loadSkillDetail(skill.id);
    });
    skillsTabEls.list.appendChild(card);
  }
}

function renderSkillDetail(skill) {
  if (!skillsTabEls.detail) return;
  if (!skill) {
    skillsTabEls.detail.innerHTML =
      '<p class="hint">Select a skill on the left to see its full SKILL.md body.</p>';
    return;
  }
  const chips = [];
  if (skill.version) chips.push(`v${skill.version}`);
  if (skill.internalOnly) chips.push("internal");
  if (Array.isArray(skill.tags)) {
    for (const tag of skill.tags) chips.push(`#${tag}`);
  }
  skillsTabEls.detail.innerHTML = `
    <h3></h3>
    <p class="hint skill-description"></p>
    <div class="skill-meta"></div>
    <div class="skill-triggers hint"></div>
    <pre class="skill-body"></pre>
    <p class="hint skill-source"></p>
  `;
  skillsTabEls.detail.querySelector("h3").textContent = skill.name;
  skillsTabEls.detail.querySelector(".skill-description").textContent = skill.description;
  const metaEl = skillsTabEls.detail.querySelector(".skill-meta");
  for (const chip of chips) {
    const span = document.createElement("span");
    span.className = "skill-chip";
    span.textContent = chip;
    metaEl.appendChild(span);
  }
  skillsTabEls.detail.querySelector(".skill-triggers").textContent =
    formatSkillTriggers(skill.triggers) || "";
  skillsTabEls.detail.querySelector(".skill-body").textContent = skill.body ?? "";
  const sourceEl = skillsTabEls.detail.querySelector(".skill-source");
  sourceEl.textContent = skill.sourcePath ? `Loaded from ${skill.sourcePath}` : "";
}

async function loadSkillsTab({ force = false } = {}) {
  if (!api?.getSkills || !skillsTabEls.list) return;
  if (skillsTabState.loading) return;
  if (skillsTabState.loaded && !force) return;
  skillsTabState.loading = true;
  renderSkillsList();
  try {
    const skills = await api.getSkills({ includeInternal: false });
    skillsTabState.skills = Array.isArray(skills) ? skills : [];
    skillsTabState.loaded = true;
    skillsTabState.loading = false;
    if (!skillsTabState.skills.some((s) => s.id === skillsTabState.activeId)) {
      skillsTabState.activeId = skillsTabState.skills[0]?.id ?? null;
    }
    renderSkillsList();
    if (skillsTabState.activeId) {
      await loadSkillDetail(skillsTabState.activeId);
    } else {
      renderSkillDetail(null);
    }
  } catch (err) {
    skillsTabState.loading = false;
    skillsTabEls.list.innerHTML = `<p class="hint">Failed to load skills: ${err?.message ?? err}</p>`;
  }
}

async function loadSkillDetail(skillId) {
  if (!api?.getSkill || !skillsTabEls.detail) return;
  try {
    const full = await api.getSkill(skillId);
    renderSkillDetail(full);
  } catch (err) {
    skillsTabEls.detail.innerHTML = `<p class="hint">Failed to load ${skillId}: ${err?.message ?? err}</p>`;
  }
}

if (skillsTabEls.reload) {
  skillsTabEls.reload.addEventListener("click", async () => {
    if (!api?.reloadSkills) return;
    skillsTabEls.reload.disabled = true;
    try {
      await api.reloadSkills();
    } finally {
      skillsTabEls.reload.disabled = false;
      await loadSkillsTab({ force: true });
    }
  });
}

if (skillsTabEls.tabBtn) {
  skillsTabEls.tabBtn.addEventListener("click", () => {
    loadSkillsTab();
  });
}

// Create-skill form. Renders inline below the detail pane. When the user
// opts in to "generate from conversation" we pass the active conversation id
// to the IPC and let the backend drive the model.
const skillsFormEls = {
  open: document.getElementById("btn-skills-new"),
  form: document.getElementById("skills-new-form"),
  cancel: document.getElementById("btn-skills-cancel"),
  save: document.getElementById("btn-skills-save"),
  status: document.getElementById("skills-new-status"),
  id: document.getElementById("skills-new-id"),
  name: document.getElementById("skills-new-name"),
  description: document.getElementById("skills-new-description"),
  triggers: document.getElementById("skills-new-triggers"),
  body: document.getElementById("skills-new-body"),
  generate: document.getElementById("skills-new-generate")
};

function toggleSkillForm(visible) {
  if (!skillsFormEls.form) return;
  skillsFormEls.form.classList.toggle("hidden", !visible);
  if (visible) {
    if (skillsFormEls.status) skillsFormEls.status.textContent = "";
    skillsFormEls.id?.focus?.();
  }
}

if (skillsFormEls.open) {
  skillsFormEls.open.addEventListener("click", () => toggleSkillForm(true));
}
if (skillsFormEls.cancel) {
  skillsFormEls.cancel.addEventListener("click", () => toggleSkillForm(false));
}

// ═══════════════════════════════════════════════════════════
// Scheduled tasks (ambient jobs)
// ═══════════════════════════════════════════════════════════
const schedulerEls = {
  prompt: document.getElementById("scheduled-prompt"),
  kind: document.getElementById("scheduled-kind"),
  intervalRow: document.getElementById("scheduled-interval-row"),
  interval: document.getElementById("scheduled-interval"),
  submit: document.getElementById("btn-schedule-task"),
  cronRow: document.getElementById("scheduled-cron-row"),
  cron: document.getElementById("scheduled-cron"),
  submitCron: document.getElementById("btn-schedule-task-cron"),
  list: document.getElementById("scheduled-tasks-list"),
  settingsTabBtn: document.querySelector('.tab-btn[data-tab="settings"]')
};

if (schedulerEls.kind) {
  schedulerEls.kind.addEventListener("change", () => {
    const cron = schedulerEls.kind.value === "cron";
    schedulerEls.intervalRow?.classList.toggle("hidden", cron);
    schedulerEls.cronRow?.classList.toggle("hidden", !cron);
  });
}

function renderScheduledTasks(tasks) {
  if (!schedulerEls.list) return;
  if (!tasks.length) {
    schedulerEls.list.innerHTML = '<p class="hint">No scheduled tasks yet.</p>';
    return;
  }
  schedulerEls.list.innerHTML = "";
  for (const task of tasks) {
    const schedule = task.schedule ?? {};
    const nextRunAt = schedule.nextRunAt
      ? new Date(schedule.nextRunAt).toLocaleString()
      : "(paused)";
    let cadence;
    if (schedule.type === "cron" && schedule.expr) {
      cadence = `cron \`${schedule.expr}\``;
    } else if (schedule.intervalMs) {
      cadence = `every ${Math.round(schedule.intervalMs / 60000)}m`;
    } else {
      cadence = "?";
    }
    const item = document.createElement("div");
    item.className = `scheduled-task-item ${schedule.enabled === false ? "disabled" : ""}`;
    item.innerHTML = `
      <div>
        <div class="scheduled-task-prompt" title="${escapeHtml(task.prompt)}">${escapeHtml(task.prompt)}</div>
        <div class="scheduled-task-meta">${escapeHtml(cadence)} · next ${escapeHtml(nextRunAt)}</div>
      </div>
      <button type="button" class="btn secondary btn-scheduled-run" data-id="${escapeHtml(task.id)}">Run now</button>
      <button type="button" class="btn secondary btn-scheduled-toggle" data-id="${escapeHtml(task.id)}">${schedule.enabled === false ? "Enable" : "Pause"}</button>
      <button type="button" class="btn secondary btn-scheduled-delete" data-id="${escapeHtml(task.id)}">Delete</button>
    `;
    schedulerEls.list.appendChild(item);
  }
}

async function refreshScheduledTasks() {
  if (!api?.listScheduledTasks) return;
  try {
    const tasks = await api.listScheduledTasks();
    renderScheduledTasks(Array.isArray(tasks) ? tasks : []);
  } catch (err) {
    if (schedulerEls.list) {
      schedulerEls.list.innerHTML = `<p class="hint">Failed to load scheduled tasks: ${escapeHtml(err?.message ?? String(err))}</p>`;
    }
  }
}

if (schedulerEls.settingsTabBtn) {
  schedulerEls.settingsTabBtn.addEventListener("click", () => refreshScheduledTasks());
}

async function submitSchedule(payload, button) {
  if (!api?.createScheduledTask) return;
  if (!payload.prompt) return;
  if (button) button.disabled = true;
  try {
    const result = await api.createScheduledTask(payload);
    if (result?.error) {
      alert(`Could not schedule: ${result.error}`);
    } else {
      if (schedulerEls.prompt) schedulerEls.prompt.value = "";
      if (schedulerEls.cron) schedulerEls.cron.value = "";
      await refreshScheduledTasks();
    }
  } finally {
    if (button) button.disabled = false;
  }
}

if (schedulerEls.submit) {
  schedulerEls.submit.addEventListener("click", async () => {
    const prompt = (schedulerEls.prompt?.value ?? "").trim();
    const intervalMinutes = Number(schedulerEls.interval?.value ?? "60");
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) return;
    await submitSchedule({ prompt, intervalMinutes }, schedulerEls.submit);
  });
}

if (schedulerEls.submitCron) {
  schedulerEls.submitCron.addEventListener("click", async () => {
    const prompt = (schedulerEls.prompt?.value ?? "").trim();
    const cronExpr = (schedulerEls.cron?.value ?? "").trim();
    if (!cronExpr) return;
    await submitSchedule({ prompt, cronExpr }, schedulerEls.submitCron);
  });
}

document.addEventListener("click", async (event) => {
  const target = event.target?.closest?.(".btn-scheduled-run, .btn-scheduled-toggle, .btn-scheduled-delete");
  if (!target) return;
  const taskId = target.dataset.id;
  if (!taskId || !api) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    if (target.classList.contains("btn-scheduled-run")) {
      await api.runScheduledTaskNow?.(taskId);
    } else if (target.classList.contains("btn-scheduled-toggle")) {
      const current = await api.listScheduledTasks?.();
      const entry = (Array.isArray(current) ? current : []).find((t) => t.id === taskId);
      const enabled = entry?.schedule?.enabled !== false;
      await api.setScheduledTaskEnabled?.({ taskId, enabled: !enabled });
    } else if (target.classList.contains("btn-scheduled-delete")) {
      if (window.confirm("Delete this scheduled task?")) {
        await api.deleteScheduledTask?.(taskId);
      }
    }
  } finally {
    refreshScheduledTasks();
  }
});

// Kick one refresh at boot so the list is populated before the user clicks
// into Settings.
setTimeout(() => refreshScheduledTasks(), 500);

if (skillsFormEls.form) {
  skillsFormEls.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!api?.createSkill) return;
    const id = skillsFormEls.id.value.trim();
    const name = skillsFormEls.name.value.trim();
    const description = skillsFormEls.description.value.trim();
    const triggers = skillsFormEls.triggers.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const generate = skillsFormEls.generate.checked;
    const body = generate ? "" : skillsFormEls.body.value.trim();
    if (!id || !name || !description) {
      skillsFormEls.status.textContent = "ID, name, and description are required.";
      return;
    }
    if (!generate && !body) {
      skillsFormEls.status.textContent = "Enter a body or tick 'Generate body from the active conversation'.";
      return;
    }
    skillsFormEls.save.disabled = true;
    skillsFormEls.status.textContent = generate ? "Generating body…" : "Saving…";
    try {
      const result = await api.createSkill({
        id,
        name,
        description,
        triggers,
        body: body || undefined,
        generateFromConversationId: generate ? state?.activeConversationId ?? null : undefined
      });
      if (result?.error) {
        skillsFormEls.status.textContent = `Failed: ${result.error}`;
        return;
      }
      skillsFormEls.status.textContent = `Saved → ${result?.sourcePath ?? id}`;
      skillsFormEls.body.value = "";
      await loadSkillsTab({ force: true });
    } catch (err) {
      skillsFormEls.status.textContent = `Failed: ${err?.message ?? err}`;
    } finally {
      skillsFormEls.save.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Logs tab — tail the structured JSONL written by @wcjr/logger.
// ═══════════════════════════════════════════════════════════
const logsTabEls = {
  output: document.getElementById("logs-output"),
  meta: document.getElementById("logs-meta"),
  levelFilter: document.getElementById("logs-level-filter"),
  moduleFilter: document.getElementById("logs-module-filter"),
  refresh: document.getElementById("btn-logs-refresh"),
  tabBtn: document.querySelector('.tab-btn[data-tab="logs"]')
};

const LOG_LEVEL_ORDER = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function renderLogLines(records) {
  if (!logsTabEls.output) return;
  if (!records.length) {
    logsTabEls.output.textContent = "(no matching log lines)";
    return;
  }
  logsTabEls.output.innerHTML = "";
  for (const record of records) {
    const row = document.createElement("div");
    row.className = `log-line ${record.level ?? "info"}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = record.time ?? "";
    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = (record.level ?? "info").toUpperCase().padEnd(5);
    const module = document.createElement("span");
    module.className = "log-module";
    module.textContent = record.module ? `[${record.module}]` : "";
    const msg = document.createElement("span");
    msg.className = "log-msg";
    const extras = Object.entries(record)
      .filter(([k]) => !["time", "level", "module", "msg"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    msg.textContent = ` ${record.msg ?? ""}${extras ? ` ${extras}` : ""}`;
    row.append(time, document.createTextNode(" "), level, module, msg);
    logsTabEls.output.appendChild(row);
  }
}

async function loadLogsTab() {
  if (!api?.getLogs || !logsTabEls.output) return;
  logsTabEls.output.textContent = "Loading…";
  const level = logsTabEls.levelFilter?.value ?? "info";
  const moduleFilter = (logsTabEls.moduleFilter?.value ?? "").trim().toLowerCase();
  try {
    const result = await api.getLogs({ limit: 400 });
    const threshold = LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info;
    const filtered = (result?.lines ?? []).filter((record) => {
      const recordLevel = LOG_LEVEL_ORDER[record.level] ?? LOG_LEVEL_ORDER.info;
      if (recordLevel < threshold) return false;
      if (moduleFilter && !(record.module ?? "").toLowerCase().includes(moduleFilter)) {
        return false;
      }
      return true;
    });
    renderLogLines(filtered.reverse()); // most recent first
    if (logsTabEls.meta) {
      logsTabEls.meta.textContent = `${filtered.length} of ${result?.total ?? 0} entries · ${result?.file ?? ""}`;
    }
  } catch (err) {
    logsTabEls.output.textContent = `Failed to load logs: ${err?.message ?? err}`;
  }
}

if (logsTabEls.refresh) {
  logsTabEls.refresh.addEventListener("click", () => loadLogsTab());
}
if (logsTabEls.levelFilter) {
  logsTabEls.levelFilter.addEventListener("change", () => loadLogsTab());
}
if (logsTabEls.moduleFilter) {
  logsTabEls.moduleFilter.addEventListener("input", () => {
    clearTimeout(logsTabEls.moduleFilter._debounce);
    logsTabEls.moduleFilter._debounce = setTimeout(() => loadLogsTab(), 250);
  });
}
if (logsTabEls.tabBtn) {
  logsTabEls.tabBtn.addEventListener("click", () => loadLogsTab());
}

// ═══════════════════════════════════════════════════════════
// Replay button — prompts for an optional model override and re-runs the
// task via the persisted run-<taskId>.jsonl trace. Delegated click handler
// so we don't need to re-wire after every task-list rerender.
// ═══════════════════════════════════════════════════════════
document.addEventListener("click", async (event) => {
  const btn = event.target?.closest?.(".btn-replay-task");
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();
  const taskId = btn.dataset.taskId;
  if (!taskId || !api?.replayRun) return;
  const modelOverride = window.prompt(
    "Replay this run with which model? (empty = original model)",
    ""
  );
  if (modelOverride === null) return; // cancelled
  btn.disabled = true;
  try {
    const result = await api.replayRun({
      taskId,
      modelOverride: modelOverride.trim() || undefined
    });
    if (result?.error) {
      setRoutingStatus(`Replay failed: ${result.error}`);
    } else if (result?.taskId) {
      setRoutingStatus(`Replay started as task ${result.taskId}.`);
    }
  } catch (err) {
    setRoutingStatus(`Replay failed: ${err?.message ?? err}`);
  } finally {
    btn.disabled = false;
  }
});
