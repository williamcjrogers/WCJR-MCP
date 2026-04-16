import fs from "node:fs/promises";
import path from "node:path";

/**
 * Per-project `.wcjr/` workspace discovery + config loader.
 *
 * Purpose: when the user mentions a file path, the assistant should pick up
 * any project-specific configuration rather than making every run behave
 * identically. A project is anywhere an operator has dropped a
 * `.wcjr/config.json` — typically a case folder, a customer folder, or a
 * code repo root. Discovery walks up from the referenced path looking for
 * that marker. Config keys mirror a subset of the top-level app config:
 *
 *   {
 *     "name": "Smith v Jones",        // display label
 *     "defaultModel": "gemini-3.1-pro-preview",
 *     "skillRoots": ["./skills"],     // relative paths resolved from the root
 *     "contextFiles": ["CLAUDE.md", "AGENTS.md"],  // content prepended to the system prompt
 *     "allowedTools": ["filesystem_*", "git_*"],
 *     "notes": "Free-form prose injected into the system prompt."
 *   }
 *
 * Only `.wcjr/config.json` lives inside `.wcjr/`; `skillRoots` point at
 * whatever the operator wants. Skills loaded this way shadow the global
 * registry for the duration of the run (last-wins).
 */

const MARKER_DIRNAME = ".wcjr";
const MARKER_FILENAME = "config.json";
const MAX_WALK_DEPTH = 20;

/** Detect whether a given directory exists. */
async function isDirectory(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk upward from `startPath` looking for a `.wcjr/config.json`. Returns
 * the workspace root (the directory that contains the `.wcjr/` folder) or
 * null when none is found within `MAX_WALK_DEPTH` levels.
 */
export async function discoverWorkspaceRoot(startPath) {
  if (!startPath) return null;
  let current = path.resolve(startPath);
  // If the caller pointed at a file, begin walking from the file's dir.
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    // Path does not exist — walk from the closest existing ancestor.
    while (current && current !== path.dirname(current)) {
      try {
        await fs.stat(current);
        break;
      } catch {
        current = path.dirname(current);
      }
    }
  }
  let depth = 0;
  while (current && depth < MAX_WALK_DEPTH) {
    const markerPath = path.join(current, MARKER_DIRNAME, MARKER_FILENAME);
    try {
      const stat = await fs.stat(markerPath);
      if (stat.isFile()) {
        return current;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    depth += 1;
  }
  return null;
}

/**
 * Read and validate `<root>/.wcjr/config.json`. Returns
 * `{ root, configPath, config, resolvedSkillRoots, contextText }` with
 * everything the orchestrator needs to inject this workspace into a run.
 *
 * Validation is lenient: unknown keys are ignored, malformed arrays fall
 * back to empty. A malformed JSON file raises — callers decide how to
 * surface that to the user (typically a warning + continue without the
 * workspace).
 */
export async function readWorkspaceConfig(root) {
  const configPath = path.join(root, MARKER_DIRNAME, MARKER_FILENAME);
  const raw = await fs.readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  const config = validateConfig(parsed);

  const resolvedSkillRoots = [];
  for (const candidate of config.skillRoots ?? []) {
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, candidate);
    if (await isDirectory(resolved)) {
      resolvedSkillRoots.push(resolved);
    }
  }

  const contextParts = [];
  if (config.name) contextParts.push(`WORKSPACE: ${config.name} (${root})`);
  else contextParts.push(`WORKSPACE: ${root}`);
  if (config.notes) contextParts.push(config.notes);
  for (const fileName of config.contextFiles ?? []) {
    const full = path.isAbsolute(fileName) ? fileName : path.resolve(root, fileName);
    try {
      const body = await fs.readFile(full, "utf-8");
      contextParts.push(`--- ${fileName} ---\n${body.trim().slice(0, 8000)}`);
    } catch {
      // Missing context file — skip silently; caller sees the rest.
    }
  }
  const contextText = contextParts.join("\n\n");

  return { root, configPath, config, resolvedSkillRoots, contextText };
}

function validateConfig(raw) {
  const out = {};
  if (typeof raw?.name === "string") out.name = raw.name.trim();
  if (typeof raw?.defaultModel === "string" && raw.defaultModel.trim()) {
    out.defaultModel = raw.defaultModel.trim();
  }
  if (Array.isArray(raw?.skillRoots)) {
    out.skillRoots = raw.skillRoots.filter((x) => typeof x === "string");
  }
  if (Array.isArray(raw?.contextFiles)) {
    out.contextFiles = raw.contextFiles.filter((x) => typeof x === "string");
  }
  if (Array.isArray(raw?.allowedTools)) {
    out.allowedTools = raw.allowedTools.filter((x) => typeof x === "string");
  }
  if (typeof raw?.notes === "string") out.notes = raw.notes.trim();
  return out;
}

/**
 * Discover and load the workspace matching a given path hint in one call.
 * Returns null when no workspace is found or the config fails to parse —
 * the caller is expected to log and continue.
 */
export async function loadWorkspaceFor(pathHint) {
  const root = await discoverWorkspaceRoot(pathHint);
  if (!root) return null;
  try {
    return await readWorkspaceConfig(root);
  } catch {
    return null;
  }
}
