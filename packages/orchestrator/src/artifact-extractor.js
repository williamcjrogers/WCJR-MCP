// packages/orchestrator/src/artifact-extractor.js
//
// Pure + filesystem helpers for extracting produced files from tool traces.
// Task 1 covers the pure data-transformation layer. Task 2 adds filesystem
// reads (lstat, preview, workspace scan).

import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";

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

const LSTAT_TIMEOUT_MS = 500;
const PREVIEW_SIZE_CAP_BYTES = 64 * 1024;
const PREVIEW_TEXT_CHARS = 200;
const BINARY_SNIFF_BYTES = 8 * 1024;
const SCAN_MAX_DEPTH = 3;
const ARTIFACT_CAP_PER_PHASE = 50;

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout());
      }
    );
  });
}

async function safeLstat(absPath) {
  return withTimeout(fs.lstat(absPath), LSTAT_TIMEOUT_MS, () => null);
}

async function sniffBinaryPreview(absPath, sizeBytes) {
  if (sizeBytes > PREVIEW_SIZE_CAP_BYTES) {
    return { previewKind: "skipped-large", preview: null };
  }
  try {
    const handle = await fs.open(absPath, "r");
    try {
      const readSize = Math.min(sizeBytes, BINARY_SNIFF_BYTES);
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 0) {
          return { previewKind: "skipped-binary", preview: null };
        }
      }
      // Not binary — read up to preview char cap
      const text = buffer.slice(0, bytesRead).toString("utf-8");
      const truncated = text.length > PREVIEW_TEXT_CHARS ? text.slice(0, PREVIEW_TEXT_CHARS) : text;
      return { previewKind: "text", preview: truncated };
    } finally {
      await handle.close();
    }
  } catch {
    return { previewKind: "skipped-timeout", preview: null };
  }
}

export async function buildArtifactRecord(absolutePath, ctx) {
  if (!absolutePath || typeof absolutePath !== "string") return null;
  const resolved = path.resolve(absolutePath);

  if (isBlacklistedPath(resolved)) return null;

  const stats = await safeLstat(resolved);
  if (!stats) return null;
  if (stats.isSymbolicLink?.()) return null;
  if (!stats.isFile?.()) return null;

  const sizeBytes = stats.size ?? 0;
  const nowIso = new Date().toISOString();
  const mtimeIso = stats.mtime ? new Date(stats.mtime).toISOString() : nowIso;

  let relPath = null;
  let workspaceHit = false;
  if (ctx?.workspaceDir) {
    const rel = path.relative(ctx.workspaceDir, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      relPath = rel;
      workspaceHit = true;
    }
  }

  const { previewKind, preview } = await sniffBinaryPreview(resolved, sizeBytes);

  return {
    id: computeArtifactId(ctx?.runId ?? "adhoc", relPath ?? resolved),
    runId: ctx?.runId ?? "adhoc",
    path: resolved,
    relPath,
    workspaceHit,
    kind: inferKind(resolved),
    sizeBytes,
    preview,
    previewKind,
    firstProducedAt: mtimeIso,
    lastProducedAt: mtimeIso,
    producedBy: [
      {
        phaseId: ctx?.phaseId ?? "unknown",
        tool: ctx?.tool ?? "unknown",
        at: mtimeIso,
        sizeBytes
      }
    ]
  };
}

export async function scanWorkspaceForNewFiles(workspaceDir, sinceMs, untilMs) {
  if (!workspaceDir) return [];
  const results = [];

  async function recurse(dir, depth) {
    if (depth > SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await recurse(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await safeLstat(full);
      if (!stats) continue;
      const mtimeMs = stats.mtimeMs ?? new Date(stats.mtime ?? 0).getTime();
      if (mtimeMs >= sinceMs && mtimeMs <= untilMs) {
        results.push(full);
      }
    }
  }

  await recurse(workspaceDir, 1);
  return results;
}

export async function extractArtifactsFromPhase({
  phaseToolTrace,
  workspaceDir,
  phaseId,
  runId,
  phaseStartedAt,
  phaseEndedAt
}) {
  const candidatePaths = new Set();

  // Layers 1 + 2: from tool traces
  for (const entry of phaseToolTrace ?? []) {
    const result = entry?.result ?? entry?.resultJson ?? null;
    const args = entry?.args ?? {};
    const tool = entry?.tool ?? entry?.name ?? "unknown";
    if (result && typeof result === "object") {
      const fromTrace = extractCandidatePathsFromResult({ tool, args, result });
      for (const p of fromTrace) candidatePaths.add(p);
    }
  }

  // Layer 3: workspace mtime scan
  if (workspaceDir) {
    const since = (phaseStartedAt ?? Date.now()) - 1000;
    const until = (phaseEndedAt ?? Date.now()) + 2000;
    const scanned = await scanWorkspaceForNewFiles(workspaceDir, since, until);
    for (const p of scanned) candidatePaths.add(p);
  }

  const capped = [...candidatePaths].slice(0, ARTIFACT_CAP_PER_PHASE);
  if (candidatePaths.size > ARTIFACT_CAP_PER_PHASE) {
    console.warn(
      `[artifact-extractor] phase ${phaseId} produced ${candidatePaths.size} candidates, capped at ${ARTIFACT_CAP_PER_PHASE}`
    );
  }

  const records = [];
  for (const absPath of capped) {
    // Find the tool that produced it (best-effort: first trace entry whose
    // result contains this exact path, else the scan fallback).
    let tool = "workspace_scan";
    let toolArgs = {};
    for (const entry of phaseToolTrace ?? []) {
      const result = entry?.result ?? null;
      if (result && JSON.stringify(result).includes(absPath)) {
        tool = entry?.tool ?? entry?.name ?? "unknown";
        toolArgs = entry?.args ?? {};
        break;
      }
    }
    const record = await buildArtifactRecord(absPath, {
      phaseId,
      runId,
      tool,
      toolArgs,
      workspaceDir
    });
    if (record) records.push(record);
  }
  return records;
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
