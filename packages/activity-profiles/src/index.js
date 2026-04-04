export const SKILL_REGISTRY = {
  brainstorming: {
    id: "brainstorming",
    label: "Brainstorming",
    slashCommand: "/brainstorming",
    visible: true,
    internalOnly: false,
    description: "Explore approaches, clarify constraints, and shape ideas into a plan before acting."
  },
  "document-review": {
    id: "document-review",
    label: "Document Review",
    slashCommand: "/document-review",
    visible: true,
    internalOnly: false,
    description: "Review a document or draft for clarity, completeness, specificity, and unnecessary scope."
  },
  "using-superpowers": {
    id: "using-superpowers",
    label: "Using Superpowers",
    slashCommand: "/using-superpowers",
    visible: false,
    internalOnly: true,
    description: "Internal routing discipline for choosing the right workflow and tools."
  }
};

const MCP_PRESET_REGISTRY = {
  filesystem: {
    id: "filesystem",
    label: "Local Filesystem",
    kind: "builtin-filesystem"
  },
  documents: {
    id: "documents",
    label: "Documents & Reports",
    kind: "builtin-document-ops"
  },
  fileOps: {
    id: "file-ops",
    label: "File Organization",
    kind: "builtin-file-ops"
  },
  mailCalendar: {
    id: "mail-calendar",
    label: "Mail & Calendar",
    kind: "builtin-mail-calendar"
  },
  browser: {
    id: "browser",
    label: "Browser / Web",
    kind: "builtin-browser-ops"
  },
  desktop: {
    id: "desktop",
    label: "Desktop Commander",
    kind: "builtin-desktop-commander"
  },
  memory: {
    id: "memory",
    label: "Persistent Memory",
    kind: "builtin-memory"
  },
  context7: {
    id: "context7",
    label: "Context7",
    serverNamePatterns: ["context7"]
  },
  sequentialThinking: {
    id: "sequential-thinking",
    label: "Sequential Thinking",
    serverNamePatterns: ["sequential", "thinking"]
  }
};

export const ACTIVITY_PROFILES = {
  orchestrator: {
    id: "orchestrator",
    label: "Automatic Orchestration",
    defaultModel: "gpt-5.4-pro",
    suggestedTaskType: "orchestrator",
    description:
      "Goal-first routing: infer the workflow, choose tools and models per phase, and prepare the execution plan before action.",
    mcpPresets: ["memory", "sequentialThinking", "context7"],
    recommendedSkills: ["brainstorming", "document-review"],
    specialistAgents: ["Orchestrator", "Synthesizer"]
  },
  research: {
    id: "research",
    label: "Research & Sources",
    defaultModel: "grok-4.20-multi-agent-0309",
    suggestedTaskType: "research",
    description: "Search sources, retrieve evidence, compare claims, and synthesize what matters.",
    mcpPresets: ["browser", "filesystem", "memory", "context7", "sequentialThinking"],
    recommendedSkills: ["brainstorming", "document-review"],
    specialistAgents: [
      "QuestionFramer",
      "ContextRetriever",
      "SequentialThinker",
      "Synthesizer"
    ]
  },
  coding: {
    id: "coding",
    label: "Code & Repositories",
    defaultModel: "gpt-5.4-pro",
    suggestedTaskType: "coding",
    description: "Inspect repositories, apply changes, run tests, and prepare review-ready code results.",
    mcpPresets: ["filesystem", "fileOps", "memory", "desktop", "context7", "sequentialThinking", "builtin-shell-exec", "builtin-git-ops"],
    recommendedSkills: ["brainstorming"],
    specialistAgents: [
      "Architect",
      "Implementer",
      "Reviewer",
      "ToolRunner",
      "Synthesizer"
    ]
  },
  documents: {
    id: "documents",
    label: "Documents & Drafts",
    defaultModel: "gemini-3.1-pro-preview-customtools",
    suggestedTaskType: "documents",
    description: "Review packs, amend drafts, compare versions, and produce business-ready documents.",
    mcpPresets: ["documents", "filesystem", "memory", "context7"],
    recommendedSkills: ["document-review", "brainstorming"],
    specialistAgents: [
      "Outliner",
      "DraftWriter",
      "DocumentReviewer",
      "ExportCoordinator"
    ]
  },
  automation: {
    id: "automation",
    label: "Files & Desktop Ops",
    defaultModel: "grok-4.20-multi-agent-0309",
    suggestedTaskType: "automation",
    description: "Run tool-driven file, desktop, and operational actions with validation and controls.",
    mcpPresets: ["filesystem", "fileOps", "desktop", "memory", "sequentialThinking", "builtin-shell-exec", "builtin-git-ops"],
    recommendedSkills: ["brainstorming"],
    specialistAgents: [
      "WorkflowDesigner",
      "Executor",
      "RiskChecker",
      "Synthesizer"
    ]
  },
  data_analysis: {
    id: "data_analysis",
    label: "Data & Spreadsheets",
    defaultModel: "gpt-5.4-pro",
    suggestedTaskType: "data_analysis",
    description: "Inspect structured data, spreadsheets, and outputs with a reproducible reasoning path.",
    mcpPresets: ["filesystem", "documents", "memory", "sequentialThinking"],
    recommendedSkills: ["document-review"],
    specialistAgents: [
      "DataProfiler",
      "Analyst",
      "Validator",
      "Synthesizer"
    ]
  },
  communication: {
    id: "communication",
    label: "Mail & Calendar",
    defaultModel: "gpt-5.4",
    suggestedTaskType: "communication",
    description: "Search mail, draft replies, coordinate calendars, and prepare communications with policy review.",
    mcpPresets: ["mailCalendar", "documents", "memory", "desktop"],
    recommendedSkills: ["document-review"],
    specialistAgents: [
      "InboxTriage",
      "DraftComposer",
      "PolicyChecker",
      "OutlookExecutor"
    ]
  },
  project_mgmt: {
    id: "project_mgmt",
    label: "Workflow & Planning",
    defaultModel: "gpt-5.4-pro",
    suggestedTaskType: "project_mgmt",
    description: "Plan dependencies, track progress, coordinate workflows, and produce concise operator summaries.",
    mcpPresets: ["memory", "documents", "mailCalendar", "sequentialThinking", "context7"],
    recommendedSkills: ["brainstorming", "document-review"],
    specialistAgents: [
      "Planner",
      "DependencyMapper",
      "StatusSynthesizer"
    ]
  },
  creative: {
    id: "creative",
    label: "Writing & Ideation",
    defaultModel: "grok-4.20-multi-agent-0309",
    suggestedTaskType: "creative",
    description: "Develop ideas, concepts, and writing directions when broader option generation is needed.",
    mcpPresets: ["memory", "browser", "context7"],
    recommendedSkills: ["brainstorming"],
    specialistAgents: [
      "IdeaGenerator",
      "ConceptShaper",
      "Synthesizer"
    ]
  },
  aws_cloud: {
    id: "aws_cloud",
    label: "Cloud & Infrastructure",
    defaultModel: "gpt-5.4-pro",
    suggestedTaskType: "aws_cloud",
    description: "Review infrastructure, cloud changes, and deployment-oriented work.",
    mcpPresets: ["memory", "filesystem", "documents", "context7", "sequentialThinking"],
    recommendedSkills: ["document-review", "brainstorming"],
    specialistAgents: [
      "CloudPlanner",
      "InfraReviewer",
      "Synthesizer"
    ]
  }
};

export const ACTIVITY_ORDER = Object.keys(ACTIVITY_PROFILES);

export function getActivityProfile(activityId) {
  return ACTIVITY_PROFILES[activityId] ?? null;
}

export function getActivityProfiles() {
  return ACTIVITY_ORDER.map((activityId) => ACTIVITY_PROFILES[activityId]);
}

export function getVisibleSkillDefinitions(skillIds = []) {
  return skillIds
    .map((skillId) => SKILL_REGISTRY[skillId])
    .filter((skill) => skill && !skill.internalOnly);
}

export function getActivitySelectOptions() {
  return ACTIVITY_ORDER.map((activityId) => ({
    value: activityId,
    label: ACTIVITY_PROFILES[activityId].label
  }));
}

export function getDefaultModelProfiles() {
  return Object.fromEntries(
    ACTIVITY_ORDER.map((activityId) => [activityId, ACTIVITY_PROFILES[activityId].defaultModel])
  );
}

export function resolveSkillDefinition(skillId) {
  return SKILL_REGISTRY[skillId] ?? null;
}

export function getMcpPresetDefinitions(presetIds = []) {
  return presetIds
    .map((presetId) => MCP_PRESET_REGISTRY[presetId])
    .filter(Boolean);
}
