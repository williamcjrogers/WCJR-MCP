// packages/orchestrator/src/artifact-extractor.js
//
// Pure + filesystem helpers for extracting produced files from tool traces.
// Task 1 covers the pure data-transformation layer. Task 2 adds filesystem
// reads (lstat, preview, workspace scan).

import path from "node:path";
import crypto from "node:crypto";

/**
 * Per-tool whitelist: which fields in a tool result JSON contain produced
 * file paths. Extend as new file-producing tools are added.
 */
export const PRODUCER_WHITELIST = Object.freeze({
  create_workbook:  ["outputPath", "filePath"],
  update_workbook:  ["outputPath", "filePath"],
  export_workbook:  ["outputPath"],
  create_document:  ["outputPath", "filePath"],
  merge_documents:  ["outputPath"],
  export_document:  ["outputPath"]
});

const KIND_BY_EXT = {
  ".xlsx": "xlsx",
  ".xls":  "xlsx",
  ".docx": "docx",
  ".doc":  "docx",
  ".pdf":  "pdf",
  ".md":   "md",
  ".txt":  "txt",
  ".json": "json",
  ".csv":  "csv",
  ".html": "html",
  ".htm":  "html"
};

const BLACKLIST_PREFIXES = [
  "C:\\Windows\\",
  "C:\\Program Files\\",
  "C:\\Program Files (x86)\\",
  "/etc/",
  "/proc/",
  "/sys/",
  "/dev/"
];

const FALLBACK_KEY_REGEX = /^(output|file|result|saved|written)(Path|File)?$/i;

export function inferKind(filePath) {
  if (typeof filePath !== "string") return "other";
  const ext = path.extname(filePath).toLowerCase();
  return KIND_BY_EXT[ext] ?? "other";
}

export function computeArtifactId(runId, relPath) {
  const hash = crypto.createHash("sha1").update(`${runId}::${relPath}`).digest("hex").slice(0, 16);
  return `art_${hash}`;
}

export function isPlausibleAbsolutePath(value) {
  if (typeof value !== "string" || !value) return false;
  // POSIX absolute
  if (value.startsWith("/")) return true;
  // Windows absolute (C:\... or D:/...)
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return false;
}

export function isBlacklistedPath(absPath) {
  if (typeof absPath !== "string") return false;
  return BLACKLIST_PREFIXES.some((prefix) => {
    // Case-insensitive compare on Windows-style prefixes, exact on POSIX
    if (prefix.includes("\\")) {
      return absPath.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return absPath.startsWith(prefix);
  });
}

/**
 * Collect all string values from an object that look like absolute paths,
 * recursing into arrays and nested objects. Mutates the provided Set.
 */
function collectAbsolutePathsFromValue(value, out) {
  if (typeof value === "string") {
    if (isPlausibleAbsolutePath(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePathsFromValue(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectAbsolutePathsFromValue(v, out);
  }
}

/**
 * Given a single tool call trace entry ({ tool, args, result }), return the
 * list of absolute file paths that look like they were produced by this call.
 *
 * Uses three layers:
 *   1. Per-tool whitelist lookup of known output fields.
 *   2. Regex fallback on result JSON top-level keys.
 *   3. Exclude any path that also appears in args (input-path filter).
 *
 * Does NOT touch the filesystem — that's Task 2.
 */
export function extractCandidatePathsFromResult({ tool, args, result }) {
  if (!result || typeof result !== "object") return [];

  // Gather input paths from args for exclusion
  const inputPaths = new Set();
  collectAbsolutePathsFromValue(args, inputPaths);

  const candidates = new Set();

  // Layer 1: whitelist — whitelist fields in result are always outputs; skip
  // input-path exclusion here (the outputPath in args is the intended destination,
  // not a source file to exclude).
  const whitelistFields = PRODUCER_WHITELIST[tool];
  if (whitelistFields) {
    for (const field of whitelistFields) {
      const value = result[field];
      if (isPlausibleAbsolutePath(value)) {
        candidates.add(value);
      }
    }
  } else {
    // Layer 2: regex fallback on top-level keys
    for (const [key, value] of Object.entries(result)) {
      if (FALLBACK_KEY_REGEX.test(key) && isPlausibleAbsolutePath(value) && !inputPaths.has(value)) {
        candidates.add(value);
      }
    }
  }

  return [...candidates];
}

/**
 * Merge artifact records with matching ids. Concatenates producedBy arrays
 * in order, updates lastProducedAt and sizeBytes to the latest entry, and
 * preserves firstProducedAt from the earliest entry.
 */
export function mergeArtifactHistory(artifacts) {
  const merged = new Map();
  for (const art of artifacts) {
    if (!art?.id) continue;
    const existing = merged.get(art.id);
    if (!existing) {
      merged.set(art.id, { ...art, producedBy: [...(art.producedBy ?? [])] });
      continue;
    }
    existing.sizeBytes = art.sizeBytes;
    existing.lastProducedAt = art.lastProducedAt;
    existing.preview = art.preview ?? existing.preview;
    existing.previewKind = art.previewKind ?? existing.previewKind;
    existing.producedBy.push(...(art.producedBy ?? []));
  }
  return [...merged.values()];
}
