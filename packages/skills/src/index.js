import fs from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem-backed SKILL.md loader + registry.
 *
 * Matches the frontmatter contract used by Claude Code, Cursor superpowers,
 * and the Compound engineering skill library so existing skill authoring
 * tools produce files that load here without modification.
 *
 * Expected file layout:
 *   <root>/
 *     <skill-id>/SKILL.md          -- primary
 *     <skill-id>/scripts/*         -- optional helper scripts
 *
 * A SKILL.md begins with YAML-ish frontmatter delimited by `---`:
 *
 *   ---
 *   name: writing-plans
 *   description: Turn a spec into a bite-sized implementation plan.
 *   triggers: ["/plan", "/writing-plans", "plan this", "create a plan"]
 *   tags: [process, plan]
 *   allowedTools: ["filesystem_*", "git_*"]
 *   internalOnly: false
 *   ---
 *
 *   # Writing Plans
 *   ...
 *
 * Everything after the closing `---` becomes `skill.body`.
 */

const MAX_SCAN_DEPTH = 4;
const MAX_BODY_CHARS = 32 * 1024;

/**
 * Minimal YAML-ish parser for the frontmatter subset skills actually use:
 *   key: scalar
 *   key: "quoted scalar"
 *   key: [inline, list, of, scalars]
 *   key: true|false|<number>
 *
 * This is deliberately not a general YAML parser — nested mappings, multiline
 * scalars, and anchors are out of scope.
 */
function parseFrontmatter(raw) {
  const out = {};
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      out[key] = "";
      continue;
    }
    if (/^\[.*\]$/.test(value)) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        out[key] = [];
        continue;
      }
      // Split on commas that aren't inside quoted strings.
      const items = [];
      let buf = "";
      let inQuote = null;
      for (const ch of inner) {
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
          else buf += ch;
          continue;
        }
        if (ch === '"' || ch === "'") { inQuote = ch; continue; }
        if (ch === ",") {
          const item = buf.trim();
          if (item) items.push(stripQuotes(item));
          buf = "";
          continue;
        }
        buf += ch;
      }
      const tail = buf.trim();
      if (tail) items.push(stripQuotes(tail));
      out[key] = items;
      continue;
    }
    if (value === "true" || value === "false") {
      out[key] = value === "true";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value);
      continue;
    }
    out[key] = stripQuotes(value);
  }
  return out;
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitFrontmatter(raw) {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    return { frontmatter: {}, body: raw };
  }
  const header = raw.slice(4, end).replace(/^---\s*/, "");
  const body = raw.slice(end + 4).replace(/^\s*\r?\n/, "");
  return { frontmatter: parseFrontmatter(header), body };
}

function normaliseSkillId(candidate, fallback) {
  const value = typeof candidate === "string" ? candidate : fallback;
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateSkill(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.name || typeof raw.name !== "string") return null;
  if (!raw.description || typeof raw.description !== "string") return null;
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.map((t) => String(t))
    : [];
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.map((t) => String(t))
    : [];
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [];
  return {
    id: raw.id,
    name: raw.name.trim(),
    description: raw.description.trim(),
    version: raw.version ? String(raw.version) : "0.1.0",
    triggers,
    allowedTools,
    tags,
    internalOnly: raw.internalOnly === true,
    body: typeof raw.body === "string" ? raw.body.slice(0, MAX_BODY_CHARS) : ""
  };
}

async function* walkSkillFiles(root, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkSkillFiles(full, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name !== "SKILL.md") continue;
    yield full;
  }
}

/**
 * Load all skills under each root directory. Returns the registry as a Map
 * keyed by skill id. Later roots override earlier roots for the same id
 * (last-wins) so a user config root can shadow bundled skills.
 */
export async function loadSkills(rootPaths = []) {
  const registry = new Map();
  const diagnostics = [];

  for (const root of rootPaths) {
    if (!root) continue;
    const resolved = path.resolve(root);
    for await (const file of walkSkillFiles(resolved)) {
      try {
        const raw = await fs.readFile(file, "utf-8");
        const { frontmatter, body } = splitFrontmatter(raw);
        const dirname = path.basename(path.dirname(file));
        const id = normaliseSkillId(frontmatter.id ?? frontmatter.name ?? dirname, dirname);
        if (!id) {
          diagnostics.push({ file, level: "warn", message: "skipped — could not derive id" });
          continue;
        }
        const skill = validateSkill({ ...frontmatter, id, body });
        if (!skill) {
          diagnostics.push({ file, level: "warn", message: "skipped — missing name or description" });
          continue;
        }
        if (registry.has(id)) {
          diagnostics.push({
            file,
            level: "info",
            message: `overriding previously loaded skill '${id}'`
          });
        }
        skill.sourcePath = file;
        registry.set(id, skill);
      } catch (err) {
        diagnostics.push({ file, level: "error", message: err?.message ?? String(err) });
      }
    }
  }

  return { registry, diagnostics };
}

export function listSkills(registry, { includeInternal = true, tag, trigger } = {}) {
  const all = [...registry.values()];
  return all.filter((skill) => {
    if (!includeInternal && skill.internalOnly) return false;
    if (tag && !skill.tags.includes(tag)) return false;
    if (trigger) {
      const needle = trigger.toLowerCase();
      return skill.triggers.some((t) => t.toLowerCase().includes(needle));
    }
    return true;
  });
}

export function getSkill(registry, id) {
  return registry.get(normaliseSkillId(id, id)) ?? null;
}

/**
 * Look up a skill by a slash command or inline trigger. Matches the
 * existing `parseSkillCommand` behaviour so the desktop app's /brainstorming
 * chip continues to work after the switch to the real loader.
 */
export function findSkillByTrigger(registry, text) {
  const normalised = String(text ?? "").trim().toLowerCase();
  if (!normalised) return null;
  for (const skill of registry.values()) {
    for (const trigger of skill.triggers) {
      if (!trigger) continue;
      const key = trigger.toLowerCase();
      if (normalised === key || normalised.startsWith(`${key} `) || normalised.startsWith(`${key}:`)) {
        return skill;
      }
    }
    if (normalised === `/${skill.id}` || normalised.startsWith(`/${skill.id} `)) {
      return skill;
    }
  }
  return null;
}

export const __test = {
  parseFrontmatter,
  splitFrontmatter,
  validateSkill,
  normaliseSkillId
};
