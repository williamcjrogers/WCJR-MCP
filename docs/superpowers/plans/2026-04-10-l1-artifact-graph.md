# L1 — Per-Run Workspace & Artifact Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class tracking of files produced during iterative runs — per-run workspace dir, artifact extractor, critic + lesson-writer integration, desktop Artifacts panel — so the critic can judge against ground truth and future runs can reference prior outputs.

**Architecture:** One new pure module (`artifact-extractor.js`) with a three-layer extraction strategy (tool whitelist, regex fallback, universal mtime scan of the workspace directory). The planner invokes it after each phase, attaches results to the runLedger, and passes them into the critic. The lesson-writer and `collectToolContext` gain artifact awareness. Desktop adds an Artifacts panel next to the L0 Run Ledger panel. L1 is convention-only — sandboxing is L4.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, `fs.promises`, existing L0 critic/planner/lesson-writer modules, Electron `shell.showItemInFolder` via new IPC handler.

**Spec:** [docs/superpowers/specs/2026-04-10-l1-artifact-graph-design.md](../specs/2026-04-10-l1-artifact-graph-design.md)

---

## File structure overview

**New:**
- `packages/orchestrator/src/artifact-extractor.js` — pure module: extractor + helpers + merge
- `packages/orchestrator/src/artifact-extractor.test.js` — 8 unit tests

**Modified:**
- `packages/orchestrator/src/planner.js` — `workspaceDir` param, per-phase extract, pass to critic, merge at end
- `packages/orchestrator/src/planner.test.js` — +1 test
- `packages/orchestrator/src/critic.js` — `artifacts` in prompt + runCritic
- `packages/orchestrator/src/critic.test.js` — +1 test
- `packages/orchestrator/src/lesson-writer.js` — `artifacts_produced` in schema
- `packages/orchestrator/src/lesson-writer.test.js` — +1 test
- `packages/orchestrator/src/index.js` — `runsDir` option, workspace setup, PRIOR ARTIFACTS, flatten artifacts
- `packages/task-store/src/index.js` — `artifacts: []` default, `listByType` helper
- `packages/task-store/src/index.test.js` — +2 tests
- `apps/desktop/main.js` — runsDir, IPC handler, persist artifacts
- `apps/desktop/preload.js` — `revealArtifact` bridge
- `apps/desktop/renderer.js` — `renderArtifacts`
- `apps/desktop/index.html` — Artifacts panel markup
- `apps/desktop/styles.css` — Artifacts panel styles

---

### Task 1: Artifact extractor — schema, whitelist, pure helpers

**Files:**
- Create: `packages/orchestrator/src/artifact-extractor.js`
- Create: `packages/orchestrator/src/artifact-extractor.test.js`

This first task creates the pure data-transformation parts of the extractor — whitelist mapping, kind-from-extension inference, ID hashing, `mergeArtifactHistory`. No filesystem I/O yet; those come in Task 2. Splitting this way keeps Task 1 purely synchronous and easy to test.

- [ ] **Step 1: Write the failing tests**

Create `packages/orchestrator/src/artifact-extractor.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCER_WHITELIST,
  inferKind,
  computeArtifactId,
  extractCandidatePathsFromResult,
  mergeArtifactHistory,
  isPlausibleAbsolutePath,
  isBlacklistedPath
} from "./artifact-extractor.js";

test("PRODUCER_WHITELIST covers the known file-producing tools", () => {
  assert.ok(PRODUCER_WHITELIST.create_workbook);
  assert.ok(PRODUCER_WHITELIST.create_document);
  assert.ok(PRODUCER_WHITELIST.export_workbook);
  assert.ok(PRODUCER_WHITELIST.export_document);
  assert.ok(PRODUCER_WHITELIST.merge_documents);
  assert.ok(PRODUCER_WHITELIST.update_workbook);
});

test("inferKind recognizes common extensions", () => {
  assert.equal(inferKind("/a/b/c.xlsx"), "xlsx");
  assert.equal(inferKind("/a/b/c.docx"), "docx");
  assert.equal(inferKind("/a/b/c.pdf"), "pdf");
  assert.equal(inferKind("/a/b/c.md"), "md");
  assert.equal(inferKind("/a/b/c.txt"), "txt");
  assert.equal(inferKind("/a/b/c.json"), "json");
  assert.equal(inferKind("/a/b/c.csv"), "csv");
  assert.equal(inferKind("/a/b/c.html"), "html");
  assert.equal(inferKind("/a/b/c.weird"), "other");
  assert.equal(inferKind("no-extension"), "other");
});

test("computeArtifactId is stable for same runId + relPath", () => {
  const id1 = computeArtifactId("task_123", "matter.xlsx");
  const id2 = computeArtifactId("task_123", "matter.xlsx");
  assert.equal(id1, id2);
  assert.match(id1, /^art_/);
});

test("computeArtifactId differs for different runIds", () => {
  const id1 = computeArtifactId("task_123", "matter.xlsx");
  const id2 = computeArtifactId("task_456", "matter.xlsx");
  assert.notEqual(id1, id2);
});

test("extractCandidatePathsFromResult uses whitelist for known tools", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "create_workbook",
    args: { outputPath: "/tmp/in.xlsx" },
    result: { outputPath: "/tmp/out.xlsx", sheets: ["S1"] }
  });
  assert.deepEqual(paths, ["/tmp/out.xlsx"]);
});

test("extractCandidatePathsFromResult excludes paths that appear in args", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "merge_documents",
    args: { files: ["/tmp/a.docx", "/tmp/b.docx"], outputPath: "/tmp/merged.docx" },
    result: { outputPath: "/tmp/merged.docx", mergedFiles: ["/tmp/a.docx", "/tmp/b.docx"] }
  });
  assert.deepEqual(paths, ["/tmp/merged.docx"]);
});

test("extractCandidatePathsFromResult falls back to regex for unknown tools", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "unknown_tool",
    args: {},
    result: { savedFile: "/tmp/thing.txt", unrelated: 42 }
  });
  assert.deepEqual(paths, ["/tmp/thing.txt"]);
});

test("extractCandidatePathsFromResult ignores non-absolute paths", () => {
  const paths = extractCandidatePathsFromResult({
    tool: "unknown_tool",
    args: {},
    result: { outputFile: "relative/path.txt" }
  });
  assert.deepEqual(paths, []);
});

test("isPlausibleAbsolutePath accepts POSIX and Windows absolute paths", () => {
  assert.ok(isPlausibleAbsolutePath("/tmp/foo.xlsx"));
  assert.ok(isPlausibleAbsolutePath("C:\\Users\\foo.xlsx"));
  assert.ok(isPlausibleAbsolutePath("D:/Work/foo.xlsx"));
  assert.ok(!isPlausibleAbsolutePath("relative/path.xlsx"));
  assert.ok(!isPlausibleAbsolutePath(""));
  assert.ok(!isPlausibleAbsolutePath(null));
  assert.ok(!isPlausibleAbsolutePath(42));
});

test("isBlacklistedPath rejects OS-sensitive prefixes", () => {
  assert.ok(isBlacklistedPath("C:\\Windows\\System32\\evil.exe"));
  assert.ok(isBlacklistedPath("/etc/passwd"));
  assert.ok(isBlacklistedPath("/proc/self/maps"));
  assert.ok(isBlacklistedPath("/sys/kernel/foo"));
  assert.ok(isBlacklistedPath("/dev/null"));
  assert.ok(!isBlacklistedPath("/tmp/legit.xlsx"));
  assert.ok(!isBlacklistedPath("D:\\work\\matter.xlsx"));
});

test("mergeArtifactHistory combines producedBy across duplicate ids", () => {
  const phase1 = {
    id: "art_abc",
    path: "/tmp/matter.xlsx",
    sizeBytes: 100,
    firstProducedAt: "2026-04-10T10:00:00.000Z",
    lastProducedAt: "2026-04-10T10:00:00.000Z",
    producedBy: [{ phaseId: "p1", tool: "create_workbook", at: "2026-04-10T10:00:00.000Z", sizeBytes: 100 }]
  };
  const phase2 = {
    id: "art_abc",
    path: "/tmp/matter.xlsx",
    sizeBytes: 200,
    firstProducedAt: "2026-04-10T10:05:00.000Z",
    lastProducedAt: "2026-04-10T10:05:00.000Z",
    producedBy: [{ phaseId: "p2", tool: "update_workbook", at: "2026-04-10T10:05:00.000Z", sizeBytes: 200 }]
  };
  const merged = mergeArtifactHistory([phase1, phase2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sizeBytes, 200);
  assert.equal(merged[0].lastProducedAt, "2026-04-10T10:05:00.000Z");
  assert.equal(merged[0].firstProducedAt, "2026-04-10T10:00:00.000Z");
  assert.equal(merged[0].producedBy.length, 2);
  assert.equal(merged[0].producedBy[0].phaseId, "p1");
  assert.equal(merged[0].producedBy[1].phaseId, "p2");
});

test("mergeArtifactHistory preserves distinct ids", () => {
  const a1 = { id: "art_a", path: "/tmp/a.xlsx", sizeBytes: 1, firstProducedAt: "x", lastProducedAt: "x", producedBy: [{ phaseId: "p1" }] };
  const a2 = { id: "art_b", path: "/tmp/b.xlsx", sizeBytes: 1, firstProducedAt: "x", lastProducedAt: "x", producedBy: [{ phaseId: "p1" }] };
  const merged = mergeArtifactHistory([a1, a2]);
  assert.equal(merged.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/orchestrator/src/artifact-extractor.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/orchestrator/src/artifact-extractor.js`:

```js
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
  const normalized = absPath;
  return BLACKLIST_PREFIXES.some((prefix) => {
    // Case-insensitive compare on Windows-style prefixes, exact on POSIX
    if (prefix.includes("\\")) {
      return normalized.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return normalized.startsWith(prefix);
  });
}

/**
 * Collect all string values from an object that look like absolute paths,
 * recursing one level into arrays. Returns unique paths in insertion order.
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

  // Layer 1: whitelist
  const whitelistFields = PRODUCER_WHITELIST[tool];
  if (whitelistFields) {
    for (const field of whitelistFields) {
      const value = result[field];
      if (isPlausibleAbsolutePath(value) && !inputPaths.has(value)) {
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/orchestrator/src/artifact-extractor.test.js
```

Expected: 12 tests, 12 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/artifact-extractor.js packages/orchestrator/src/artifact-extractor.test.js
git commit -m "feat(orchestrator): add artifact-extractor pure helpers and whitelist"
```

---

### Task 2: Filesystem helpers — buildArtifactRecord + scanWorkspaceForNewFiles

**Files:**
- Modify: `packages/orchestrator/src/artifact-extractor.js` (append)
- Modify: `packages/orchestrator/src/artifact-extractor.test.js` (append)

Adds the filesystem-touching parts: `buildArtifactRecord` (lstat + preview + safety defenses) and `scanWorkspaceForNewFiles` (recursive mtime scan). Tests use `fs.mkdtemp` to create real temp directories.

- [ ] **Step 1: Append the failing tests**

Append to `packages/orchestrator/src/artifact-extractor.test.js`:

```js
import fs from "node:fs/promises";
import os from "node:os";
import {
  buildArtifactRecord,
  scanWorkspaceForNewFiles,
  extractArtifactsFromPhase
} from "./artifact-extractor.js";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wcjr-l1-test-"));
}

test("buildArtifactRecord returns a full record for a small text file", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "matter.md");
  await fs.writeFile(filePath, "# Test\nSome markdown content here.", "utf-8");

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "write_markdown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.runId, "task_t1");
  assert.equal(record.path, filePath);
  assert.equal(record.relPath, "matter.md");
  assert.equal(record.workspaceHit, true);
  assert.equal(record.kind, "md");
  assert.ok(record.sizeBytes > 0);
  assert.equal(record.previewKind, "text");
  assert.ok(record.preview.includes("# Test"));
  assert.equal(record.producedBy.length, 1);
  assert.equal(record.producedBy[0].phaseId, "p1");
  await fs.rm(dir, { recursive: true, force: true });
});

test("buildArtifactRecord flags binary files with skipped-binary preview", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "image.bin");
  const binaryBuffer = Buffer.from([0, 1, 2, 3, 0, 255, 128, 0]);
  await fs.writeFile(filePath, binaryBuffer);

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.previewKind, "skipped-binary");
  assert.equal(record.preview, null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("buildArtifactRecord flags large files with skipped-large preview", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "big.txt");
  const big = Buffer.alloc(70 * 1024, 0x61); // 70 KB of 'a'
  await fs.writeFile(filePath, big);

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.previewKind, "skipped-large");
  assert.equal(record.preview, null);
  await fs.rm(dir, { recursive: true, force: true });
});

test("buildArtifactRecord rejects blacklisted paths", async () => {
  const record = await buildArtifactRecord("/etc/passwd", {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: "/tmp"
  });
  assert.equal(record, null);
});

test("buildArtifactRecord sets workspaceHit=false for paths outside workspaceDir", async () => {
  const dir = await makeTempDir();
  const outsideDir = await makeTempDir();
  const filePath = path.join(outsideDir, "outside.txt");
  await fs.writeFile(filePath, "outside");

  const record = await buildArtifactRecord(filePath, {
    phaseId: "p1",
    runId: "task_t1",
    tool: "unknown",
    toolArgs: {},
    workspaceDir: dir
  });

  assert.ok(record);
  assert.equal(record.workspaceHit, false);
  assert.equal(record.relPath, null);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

test("scanWorkspaceForNewFiles finds files whose mtime is within the time window", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "new.md");
  const since = Date.now() - 1000;
  await fs.writeFile(filePath, "fresh");
  const until = Date.now() + 2000;

  const found = await scanWorkspaceForNewFiles(dir, since, until);
  assert.ok(found.includes(filePath));
  await fs.rm(dir, { recursive: true, force: true });
});

test("scanWorkspaceForNewFiles ignores files outside the time window", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "old.md");
  await fs.writeFile(filePath, "old");
  // Backdate mtime by 1 hour
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(filePath, past, past);

  const sinceRecent = Date.now() - 1000;
  const untilRecent = Date.now() + 1000;
  const found = await scanWorkspaceForNewFiles(dir, sinceRecent, untilRecent);
  assert.ok(!found.includes(filePath));
  await fs.rm(dir, { recursive: true, force: true });
});

test("scanWorkspaceForNewFiles recurses into subdirectories up to depth 3", async () => {
  const dir = await makeTempDir();
  const sub = path.join(dir, "a", "b");
  await fs.mkdir(sub, { recursive: true });
  const filePath = path.join(sub, "deep.txt");
  const since = Date.now() - 1000;
  await fs.writeFile(filePath, "deep");
  const until = Date.now() + 2000;

  const found = await scanWorkspaceForNewFiles(dir, since, until);
  assert.ok(found.some((p) => p.endsWith("deep.txt")));
  await fs.rm(dir, { recursive: true, force: true });
});

test("extractArtifactsFromPhase combines whitelist and mtime scan", async () => {
  const dir = await makeTempDir();
  const whitelistPath = path.join(dir, "from-tool.xlsx");
  const mtimePath = path.join(dir, "from-scan.md");

  const phaseStartedAt = Date.now() - 500;
  await fs.writeFile(whitelistPath, "fake xlsx");
  await fs.writeFile(mtimePath, "# scanned");
  const phaseEndedAt = Date.now() + 500;

  const phaseToolTrace = [
    {
      tool: "create_workbook",
      args: {},
      // Simulate tool result being the JSON shape — some traces store it as
      // an object under `result`, others inside a content array; the extractor
      // should handle the object-on-trace shape.
      result: { outputPath: whitelistPath, sheets: ["S1"] }
    }
  ];

  const artifacts = await extractArtifactsFromPhase({
    phaseToolTrace,
    workspaceDir: dir,
    phaseId: "p1",
    runId: "task_abc",
    phaseStartedAt,
    phaseEndedAt
  });

  const paths = artifacts.map((a) => a.path).sort();
  assert.ok(paths.includes(whitelistPath));
  assert.ok(paths.includes(mtimePath));
  assert.equal(new Set(paths).size, paths.length, "no duplicates");
  await fs.rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/orchestrator/src/artifact-extractor.test.js
```

Expected: FAIL on the new tests — `buildArtifactRecord` / `scanWorkspaceForNewFiles` / `extractArtifactsFromPhase` not exported.

- [ ] **Step 3: Append the implementation**

Append to the end of `packages/orchestrator/src/artifact-extractor.js`:

```js
import fs from "node:fs/promises";

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
    // Tool result may be stored either as `entry.result` (object) or as part
    // of a serialized preview string. For L1, we only handle the object shape.
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/orchestrator/src/artifact-extractor.test.js
```

Expected: All 21 tests (12 from Task 1 + 9 new) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/artifact-extractor.js packages/orchestrator/src/artifact-extractor.test.js
git commit -m "feat(orchestrator): add buildArtifactRecord and workspace mtime scan"
```

---

### Task 3: Critic accepts artifacts in its prompt

**Files:**
- Modify: `packages/orchestrator/src/critic.js`
- Modify: `packages/orchestrator/src/critic.test.js`

- [ ] **Step 1: Append the failing test**

Append to `packages/orchestrator/src/critic.test.js`:

```js
test("buildCriticPrompt includes ARTIFACTS PRODUCED section when artifacts provided", () => {
  const prompt = buildCriticPrompt({
    originalGoal: "Make a workbook",
    taskType: "disputes",
    planSummary: "Phase 1: make workbook",
    phaseId: "p1",
    phaseIntent: "Create matter.xlsx",
    phaseResult: "Created workbook with 3 sheets",
    toolTraceSummary: "create_workbook: completed",
    artifacts: [
      { path: "/tmp/matter.xlsx", kind: "xlsx", sizeBytes: 12345 }
    ]
  });
  assert.ok(prompt.includes("ARTIFACTS PRODUCED"));
  assert.ok(prompt.includes("/tmp/matter.xlsx"));
  assert.ok(prompt.includes("xlsx"));
});

test("buildCriticPrompt omits ARTIFACTS PRODUCED when artifacts empty", () => {
  const prompt = buildCriticPrompt({
    originalGoal: "Goal",
    taskType: "disputes",
    planSummary: "plan",
    phaseId: "p1",
    phaseIntent: "intent",
    phaseResult: "result",
    toolTraceSummary: "",
    artifacts: []
  });
  assert.ok(!prompt.includes("ARTIFACTS PRODUCED"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/orchestrator/src/critic.test.js
```

Expected: FAIL — `buildCriticPrompt` does not produce an `ARTIFACTS PRODUCED` section.

- [ ] **Step 3: Update the implementation**

In `packages/orchestrator/src/critic.js`, replace the existing `buildCriticPrompt` function with:

```js
export function buildCriticPrompt({
  originalGoal,
  taskType,
  planSummary,
  phaseId,
  phaseIntent,
  phaseResult,
  toolTraceSummary,
  artifacts
}) {
  const artifactSummary = Array.isArray(artifacts) && artifacts.length > 0
    ? artifacts
        .map((a) => `- ${a.path} (${a.kind}, ${a.sizeBytes ?? 0}B)`)
        .join("\n")
    : "";

  return [
    `ORIGINAL GOAL: ${originalGoal}`,
    `ACTIVITY PROFILE: ${taskType}`,
    `PLAN SO FAR:\n${planSummary}`,
    `PHASE JUST RUN: ${phaseId} — ${phaseIntent}`,
    `PHASE RESULT:\n${phaseResult}`,
    toolTraceSummary ? `TOOL TRACE:\n${toolTraceSummary}` : "",
    artifactSummary ? `ARTIFACTS PRODUCED:\n${artifactSummary}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}
```

Also update `runCritic` to accept and forward `artifacts`. Find the existing `runCritic` signature (params destructure) and add `artifacts` to it, then include it in the `userMessage = buildCriticPrompt({...})` call. The full patched `runCritic`:

```js
export async function runCritic({
  invokeModel,
  criticModel,
  criticProvider,
  originalGoal,
  taskType,
  planSummary,
  phaseId,
  phaseIntent,
  phaseResult,
  toolTraceSummary,
  artifacts
}) {
  const userMessage = buildCriticPrompt({
    originalGoal,
    taskType,
    planSummary,
    phaseId,
    phaseIntent,
    phaseResult,
    toolTraceSummary,
    artifacts
  });

  try {
    const result = await invokeModel({
      providerId: criticProvider,
      model: criticModel,
      prompt: userMessage,
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: userMessage }
      ],
      taskType,
      skipTools: true,
      suppressStream: true
    });
    return parseVerdict(result.content);
  } catch (err) {
    console.error("[critic] invocation failed, degrading to accept:", err?.message ?? err);
    return { decision: "accept", reasoning: `critic failed: ${err?.message ?? err}`, confidence: 0, _parseError: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/orchestrator/src/critic.test.js
```

Expected: All tests (10 from L0 + 2 new) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/critic.js packages/orchestrator/src/critic.test.js
git commit -m "feat(orchestrator/critic): include ARTIFACTS PRODUCED section in verdict prompt"
```

---

### Task 4: Lesson-writer accepts artifacts

**Files:**
- Modify: `packages/orchestrator/src/lesson-writer.js`
- Modify: `packages/orchestrator/src/lesson-writer.test.js`

- [ ] **Step 1: Append the failing test**

Append to `packages/orchestrator/src/lesson-writer.test.js`:

```js
test("buildLessonPrompt includes ARTIFACTS section when provided", () => {
  const prompt = buildLessonPrompt({
    taskType: "disputes",
    originalGoal: "Summarize exhibits",
    outcome: "success",
    toolsUsed: ["create_workbook"],
    criticVerdicts: [],
    artifacts: [
      { path: "/tmp/matter.xlsx", kind: "xlsx", sizeBytes: 12345 }
    ]
  });
  assert.ok(prompt.includes("ARTIFACTS"));
  assert.ok(prompt.includes("matter.xlsx"));
});

test("parseLesson accepts artifacts_produced array", () => {
  const lesson = parseLesson(JSON.stringify({
    taskType: "disputes",
    prompt_gist: "summarize",
    tools_used: ["create_workbook"],
    outcome: "success",
    what_worked: [],
    what_failed: [],
    generalization: "ok",
    confidence: 0.8,
    artifacts_produced: ["/tmp/matter.xlsx"]
  }));
  assert.ok(Array.isArray(lesson.artifacts_produced));
  assert.equal(lesson.artifacts_produced[0], "/tmp/matter.xlsx");
});

test("writeLesson stores artifacts in memory content", async () => {
  let written = null;
  await writeLesson({
    memoryStore: {
      upsert(entry) { written = entry; return { ...entry, id: "mem_test" }; }
    },
    lesson: {
      taskType: "disputes",
      prompt_gist: "summarize",
      tools_used: ["create_workbook"],
      outcome: "success",
      what_worked: [],
      what_failed: [],
      generalization: "ok",
      artifacts_produced: ["/tmp/matter.xlsx", "/tmp/matter.docx"]
    }
  });
  assert.ok(written);
  assert.ok(written.content.includes("Artifacts: /tmp/matter.xlsx, /tmp/matter.docx"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/orchestrator/src/lesson-writer.test.js
```

Expected: 3 new tests fail — missing artifacts support in buildLessonPrompt, parseLesson, and writeLesson.

- [ ] **Step 3: Update the implementation**

In `packages/orchestrator/src/lesson-writer.js`, update the `LESSON_SYSTEM` constant to mention `artifacts_produced`:

```js
const LESSON_SYSTEM = `You are summarizing a completed agent run into a structured lesson for future runs of the same task type.

Return strict JSON:
{
  "taskType": "string",
  "prompt_gist": "short paraphrase of what was asked",
  "tools_used": ["tool_name", ...],
  "outcome": "success" | "escalated" | "budget_exhausted" | "failed",
  "what_worked": ["bullet", ...],
  "what_failed": ["bullet", ...],
  "generalization": "one sentence an operator could read and believe",
  "artifacts_produced": ["/absolute/path", ...],
  "confidence": 0.0-1.0
}
No prose outside JSON.`;
```

Replace the existing `buildLessonPrompt` function body with this version that adds an `ARTIFACTS` section:

```js
export function buildLessonPrompt({
  taskType,
  originalGoal,
  outcome,
  toolsUsed,
  criticVerdicts,
  planSummary,
  artifacts
}) {
  const verdictSummary = (criticVerdicts ?? [])
    .map((v, i) => `Phase ${i + 1}: ${v.decision} (${v.reasoning})`)
    .join("\n");

  const artifactSummary = Array.isArray(artifacts) && artifacts.length > 0
    ? artifacts.map((a) => `- ${a.path} (${a.kind})`).join("\n")
    : "";

  return [
    `TASK TYPE: ${taskType}`,
    `GOAL: ${originalGoal}`,
    `OUTCOME: ${outcome}`,
    `TOOLS USED: ${(toolsUsed ?? []).join(", ") || "none"}`,
    planSummary ? `PLAN:\n${planSummary}` : "",
    verdictSummary ? `CRITIC VERDICTS:\n${verdictSummary}` : "",
    artifactSummary ? `ARTIFACTS:\n${artifactSummary}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}
```

Replace the existing `parseLesson` return block to include `artifacts_produced`:

```js
    return {
      taskType: String(parsed.taskType),
      prompt_gist: String(parsed.prompt_gist ?? ""),
      tools_used: Array.isArray(parsed.tools_used) ? parsed.tools_used.map(String) : [],
      outcome: String(parsed.outcome ?? "unknown"),
      what_worked: Array.isArray(parsed.what_worked) ? parsed.what_worked.map(String) : [],
      what_failed: Array.isArray(parsed.what_failed) ? parsed.what_failed.map(String) : [],
      generalization: String(parsed.generalization ?? ""),
      artifacts_produced: Array.isArray(parsed.artifacts_produced) ? parsed.artifacts_produced.map(String) : [],
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5
    };
```

Replace the `writeLesson` function's `content` construction to include an `Artifacts:` line. Find the existing `content: [...]` array inside `writeLesson` and update it to:

```js
    const artifactsLine = Array.isArray(lesson.artifacts_produced) && lesson.artifacts_produced.length
      ? `Artifacts: ${lesson.artifacts_produced.join(", ")}`
      : "";

    const entry = memoryStore.upsert({
      category: "run_lesson",
      content: [
        `[${lesson.taskType}] ${lesson.prompt_gist ?? ""}`,
        `Outcome: ${lesson.outcome ?? "unknown"}`,
        workedLine,
        failedLine,
        artifactsLine,
        lesson.generalization ? `Generalization: ${lesson.generalization}` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      tags: [lesson.taskType, ...(Array.isArray(lesson.tools_used) ? lesson.tools_used : [])],
      pinned: false
    });
```

Finally, update `generateAndWriteLesson` to accept and forward `artifacts`:

```js
export async function generateAndWriteLesson({
  invokeModel,
  lessonModel,
  lessonProvider,
  memoryStore,
  taskType,
  originalGoal,
  outcome,
  toolsUsed,
  criticVerdicts,
  planSummary,
  artifacts
}) {
  try {
    const userMessage = buildLessonPrompt({
      taskType,
      originalGoal,
      outcome,
      toolsUsed,
      criticVerdicts,
      planSummary,
      artifacts
    });

    const result = await invokeModel({
      providerId: lessonProvider,
      model: lessonModel,
      prompt: userMessage,
      messages: [
        { role: "system", content: LESSON_SYSTEM },
        { role: "user", content: userMessage }
      ],
      taskType,
      skipTools: true,
      suppressStream: true
    });

    const lesson = parseLesson(result?.content);
    if (!lesson) {
      console.warn("[lesson-writer] could not parse lesson from model output");
      return null;
    }

    return await writeLesson({ memoryStore, lesson });
  } catch (err) {
    console.warn("[lesson-writer] failed, skipping:", err?.message ?? err);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/orchestrator/src/lesson-writer.test.js
```

Expected: All tests (7 from L0 + 3 new) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/lesson-writer.js packages/orchestrator/src/lesson-writer.test.js
git commit -m "feat(orchestrator/lesson-writer): track artifacts_produced in run lessons"
```

---

### Task 5: Planner invokes extractor and passes artifacts to critic

**Files:**
- Modify: `packages/orchestrator/src/planner.js`
- Modify: `packages/orchestrator/src/planner.test.js`

- [ ] **Step 1: Append the failing test**

Append to `packages/orchestrator/src/planner.test.js`:

```js
test("planner attaches artifacts from the extractor and forwards them to the critic", async () => {
  const criticCalls = [];

  const result = await runIterativePlan({
    plan: makePlan([{ id: "p1" }]),
    originalGoal: "Test goal",
    taskType: "research",
    workspaceDir: "/fake/workspace",
    extractArtifacts: async () => [
      { id: "art_1", path: "/fake/workspace/out.xlsx", kind: "xlsx", sizeBytes: 123, producedBy: [{ phaseId: "p1" }] }
    ],
    invokeModel: async (opts) => {
      // Executor call vs critic call: distinguish by the presence of "auditing" in system message
      const isCriticCall = (opts.messages?.[0]?.content ?? "").includes("auditing");
      if (isCriticCall) {
        criticCalls.push(opts.messages[1]?.content ?? "");
        return { content: JSON.stringify({ decision: "accept", reasoning: "ok", confidence: 0.9 }) };
      }
      return { content: "phase 1 done" };
    },
    resolveProvider: () => "openai",
    hasApiKey: () => true,
    getCriticModel: () => ({ model: "claude-sonnet-4-6-20250514", provider: "anthropic" }),
    emitStatus: () => {},
    onChunk: () => {},
    budget: { maxCriticRoundsPerPhase: 2, maxTotalPhases: 12, maxWallClockMs: 60000, maxTokensTotal: 400000 }
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.ledger.phases[0].artifacts.length, 1);
  assert.equal(result.ledger.phases[0].artifacts[0].kind, "xlsx");
  assert.equal(result.ledger.artifacts.length, 1);
  // Critic should have been given the artifacts section
  assert.equal(criticCalls.length, 1);
  assert.ok(criticCalls[0].includes("ARTIFACTS PRODUCED"));
  assert.ok(criticCalls[0].includes("/fake/workspace/out.xlsx"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/orchestrator/src/planner.test.js
```

Expected: FAIL — planner doesn't accept `extractArtifacts`, doesn't populate `phaseEntry.artifacts`, doesn't pass artifacts to critic.

- [ ] **Step 3: Update the implementation**

In `packages/orchestrator/src/planner.js`, update imports at the top of the file. After the existing `import { runCritic } from "./critic.js";`, add:

```js
import { extractArtifactsFromPhase as defaultExtractArtifacts, mergeArtifactHistory } from "./artifact-extractor.js";
```

Then update the `runIterativePlan` destructured params to accept `workspaceDir` and `extractArtifacts`:

```js
export async function runIterativePlan({
  plan,
  originalGoal,
  taskType,
  executorModel,
  workspaceDir,
  extractArtifacts,
  invokeModel,
  resolveProvider,
  hasApiKey,
  getCriticModel,
  emitStatus,
  onChunk,
  budget,
  systemMessage,
  conversationMessages,
  enrichedPrompt
}) {
```

Inside the function body, just after that destructure (before the `const startedAt = Date.now();` line if present, or wherever appropriate), add:

```js
  const extractArtifactsFn = extractArtifacts ?? defaultExtractArtifacts;
```

Find the line `phaseEntry.toolTrace = phaseToolTrace;` (inside the inner phase execution try-block). Directly after it, insert the artifact extraction:

```js
        phaseEntry.toolTrace = phaseToolTrace;

        // ── L1: extract artifacts produced by this phase ──
        const phaseEndedAt = Date.now();
        try {
          phaseEntry.artifacts = await extractArtifactsFn({
            phaseToolTrace,
            workspaceDir,
            phaseId: phase.id,
            runId: plan.taskId ?? "adhoc",
            phaseStartedAt,
            phaseEndedAt
          });
        } catch (extractErr) {
          console.warn(`[planner] artifact extraction failed for ${phase.id}:`, extractErr?.message ?? extractErr);
          phaseEntry.artifacts = [];
        }
```

Next, find the `runCritic({ ... })` call and add `artifacts: phaseEntry.artifacts` to the destructured argument object:

```js
          const verdict = await runCritic({
            invokeModel,
            criticModel: criticSelection.model,
            criticProvider: criticSelection.provider,
            originalGoal,
            taskType,
            planSummary: summarizePlan(phases, phaseIndex),
            phaseId: phase.id,
            phaseIntent: phase.title ?? phase.prompt,
            phaseResult: lastContent.slice(0, 3000),
            toolTraceSummary: summarizeToolTrace(phaseToolTrace),
            artifacts: phaseEntry.artifacts
          });
```

Finally, find the final return block (the `success`/`ledger` return at the bottom of `runIterativePlan` after the while loop). Before the return, add run-level artifact merging:

```js
  if (!ledger.outcome) {
    ledger.outcome = "success";
  }
  ledger.endedAt = Date.now();
  ledger.budget.wallClockMs = Date.now() - startedAt;
  ledger.budget.phasesUsed = totalPhasesExecuted;

  // ── L1: merge phase-level artifacts into a run-level list ──
  const allArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
  ledger.artifacts = mergeArtifactHistory(allArtifacts);

  return {
    outcome: ledger.outcome,
    content: lastContent,
    pendingApproval: ledger.outcome === "escalated",
    ledger
  };
}
```

Apply the same `mergeArtifactHistory` line just before EACH early return in the function (the `escalated`, `failed`, and `budget_exhausted` returns earlier in the function). For consistency, in each of those early-return branches, replace `ledger.budget.phasesUsed = totalPhasesExecuted;` with:

```js
      ledger.budget.wallClockMs = Date.now() - startedAt;
      ledger.budget.phasesUsed = totalPhasesExecuted;
      const earlyAllArtifacts = ledger.phases.flatMap((p) => p.artifacts ?? []);
      ledger.artifacts = mergeArtifactHistory(earlyAllArtifacts);
```

This ensures `ledger.artifacts` is always populated regardless of terminal state.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/orchestrator/src/planner.test.js
```

Expected: All tests (8 from L0 + 1 new) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/planner.js packages/orchestrator/src/planner.test.js
git commit -m "feat(orchestrator/planner): extract and pass artifacts per phase + run"
```

---

### Task 6: Task-store adds artifacts default and listByType helper

**Files:**
- Modify: `packages/task-store/src/index.js`
- Modify: `packages/task-store/src/index.test.js`

- [ ] **Step 1: Append the failing tests**

Append to `packages/task-store/src/index.test.js`:

```js
test("TaskStore.create initializes artifacts as an empty array", () => {
  const store = new TaskStore();
  const task = store.create({ prompt: "test", taskType: "disputes" });
  assert.deepEqual(task.artifacts, []);
});

test("TaskStore.update persists artifacts field", () => {
  const store = new TaskStore();
  const task = store.create({ prompt: "test", taskType: "disputes" });
  const artifacts = [{ id: "art_1", path: "/tmp/matter.xlsx", kind: "xlsx", sizeBytes: 100 }];
  const updated = store.update(task.id, { artifacts });
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].path, "/tmp/matter.xlsx");
  const fetched = store.get(task.id);
  assert.equal(fetched.artifacts.length, 1);
});

test("TaskStore.listByType filters by taskType and artifact presence", () => {
  const store = new TaskStore();
  const a = store.create({ prompt: "a", taskType: "disputes" });
  store.update(a.id, { status: "completed", artifacts: [{ id: "x", path: "/tmp/a.xlsx" }] });
  const b = store.create({ prompt: "b", taskType: "disputes" });
  store.update(b.id, { status: "completed" }); // no artifacts
  const c = store.create({ prompt: "c", taskType: "coding" });
  store.update(c.id, { status: "completed", artifacts: [{ id: "y", path: "/tmp/c.xlsx" }] });

  const disputesWithArtifacts = store.listByType("disputes", { withArtifacts: true, status: "completed" });
  assert.equal(disputesWithArtifacts.length, 1);
  assert.equal(disputesWithArtifacts[0].id, a.id);
});

test("TaskStore.listByType respects limit and sorts by updatedAt desc", () => {
  const store = new TaskStore();
  const first = store.create({ prompt: "first", taskType: "research" });
  store.update(first.id, { status: "completed", artifacts: [{ id: "1" }] });
  const second = store.create({ prompt: "second", taskType: "research" });
  store.update(second.id, { status: "completed", artifacts: [{ id: "2" }] });

  const list = store.listByType("research", { withArtifacts: true, limit: 1 });
  assert.equal(list.length, 1);
  // Second task was updated later, so it comes first
  assert.equal(list[0].id, second.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test packages/task-store/src/index.test.js
```

Expected: FAIL — `DEFAULT_TASK` lacks `artifacts`, and `listByType` method does not exist.

- [ ] **Step 3: Update the implementation**

In `packages/task-store/src/index.js`, find the `DEFAULT_TASK` object and add the `artifacts: []` field near `toolTrace`:

```js
const DEFAULT_TASK = {
  id: null,
  parentTaskId: null,
  status: "pending",
  prompt: "",
  taskType: null,
  runMode: "direct",
  remoteOrigin: null,
  phase: null,
  workflow: null,
  steps: [],
  progress: { current: 0, total: 0, message: null },
  pendingExecutionPlan: null,
  result: null,
  error: null,
  timeline: [],
  agentRuns: [],
  toolActivity: [],
  toolTrace: [],
  artifacts: [],
  audit: [],
  createdAt: null,
  updatedAt: null,
  completedAt: null
};
```

Then, inside the `TaskStore` class, after the existing `list(filters)` method (around line 86), add the new `listByType` method:

```js
  listByType(taskType, filters = {}) {
    let list = [...this.tasks.values()].filter((t) => t.taskType === taskType);
    if (filters.status) {
      list = list.filter((t) => t.status === filters.status);
    }
    if (filters.withArtifacts) {
      list = list.filter((t) => Array.isArray(t.artifacts) && t.artifacts.length > 0);
    }
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (filters.limit != null) {
      list = list.slice(0, filters.limit);
    }
    return list;
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test packages/task-store/src/index.test.js
```

Expected: All existing tests plus 4 new pass.

- [ ] **Step 5: Commit**

```bash
git add packages/task-store/src/index.js packages/task-store/src/index.test.js
git commit -m "feat(task-store): add artifacts default and listByType helper"
```

---

### Task 7: Orchestrator wires workspaceDir, extractor, and PRIOR ARTIFACTS retrieval

**Files:**
- Modify: `packages/orchestrator/src/index.js`

- [ ] **Step 1: Add imports and wire the iterative branch**

In `packages/orchestrator/src/index.js`, ensure these imports exist at the top of the file:

```js
import path from "node:path";
import fs from "node:fs/promises";
```

(If one or both are already imported, skip the duplicate.)

Find the iterative branch inside `executeTask` — it starts around line 1475 with `if (runMode === "iterative" && taskContext?.executionPlan) {`. Near the top of that block, after `const providerId = this.options.resolveProvider?.(selectedModel) ?? "openai";`, add workspace directory setup:

```js
      // ── L1: create per-run scratch workspace ──
      let workspaceDir = null;
      if (this.options.runsDir) {
        const runId = taskContext?.taskId ?? `adhoc-${Date.now()}`;
        workspaceDir = path.join(this.options.runsDir, runId);
        try {
          await fs.mkdir(workspaceDir, { recursive: true });
        } catch (err) {
          console.warn(`[orchestrator] failed to create workspace ${workspaceDir}:`, err?.message ?? err);
          workspaceDir = null;
        }
      }
```

Find the `systemMessage` construction inside that same block. Append the workspace hint when present. Replace:

```js
        systemMessage: [
          "You are a highly capable personal assistant. Be concise, accurate, and actionable.",
          getSkillInstruction(skillId),
          memoryContext ? `Remembered user context:\n${memoryContext}` : ""
        ]
          .filter(Boolean)
          .join("\n\n"),
```

with:

```js
        systemMessage: [
          "You are a highly capable personal assistant. Be concise, accurate, and actionable.",
          getSkillInstruction(skillId),
          memoryContext ? `Remembered user context:\n${memoryContext}` : "",
          workspaceDir
            ? `Your scratch workspace for this run is at ${workspaceDir}. Save intermediate files there by default, for example ${workspaceDir}${path.sep}matter-summary.xlsx, unless the user specified a specific location.`
            : ""
        ]
          .filter(Boolean)
          .join("\n\n"),
```

Find the `runIterativePlan({ ... })` call inside the iterative branch. Add `workspaceDir` right after `executorModel: selectedModel,`:

```js
      const iterativeResult = await runIterativePlan({
        plan: taskContext.executionPlan,
        originalGoal: prompt,
        taskType: resolvedTaskType,
        executorModel: selectedModel,
        workspaceDir,
        invokeModel: this.options.invokeModel,
        ...
```

Find the final return of the iterative branch. Locate the `return {` block that includes `runLedger: iterativeResult.ledger`. Add `artifacts: iterativeResult.ledger?.artifacts ?? []` alongside it:

```js
      return {
        taskType: resolvedTaskType,
        model: selectedModel,
        provider: providerId,
        content: iterativeResult.content,
        agentRuns,
        timeline,
        toolSummary,
        toolActivity: mergedToolActivity,
        toolTrace: mergedToolTrace,
        runMode,
        fallbackChain,
        pendingApproval: iterativeResult.pendingApproval ?? false,
        runLedger: iterativeResult.ledger,
        artifacts: iterativeResult.ledger?.artifacts ?? [],
        ...(iterativeResult.escalationReason ? { escalationReason: iterativeResult.escalationReason } : {}),
        ...(iterativeResult.error ? { error: iterativeResult.error } : {})
      };
```

Also, add `artifacts: (iterativeResult.ledger?.artifacts ?? []).map((a) => a.path)` to the `generateAndWriteLesson` call in that same branch, just before the closing `);`:

```js
        await generateAndWriteLesson({
          invokeModel: this.options.invokeModel,
          lessonModel,
          lessonProvider,
          memoryStore: this.options.memoryStore,
          taskType: resolvedTaskType,
          originalGoal: prompt,
          outcome: iterativeResult.outcome,
          toolsUsed: (iterativeResult.ledger?.phases ?? []).flatMap(
            (p) => (p.toolTrace ?? []).map((t) => t.tool)
          ),
          criticVerdicts: (iterativeResult.ledger?.phases ?? []).flatMap(
            (p) => p.criticVerdicts ?? []
          ),
          planSummary: (iterativeResult.ledger?.phases ?? [])
            .map((p) => `${p.id}: ${p.status}`)
            .join(", "),
          artifacts: iterativeResult.ledger?.artifacts ?? []
        });
```

- [ ] **Step 2: Add PRIOR ARTIFACTS retrieval to collectToolContext**

Find the `collectToolContext` method (around line 944). Locate the L0-added `PRIOR LESSONS` block. Immediately after that block's closing brace (before the final `return { toolSummary, toolActivity, contextSections };`), add:

```js
    // ── L1: Prior artifacts from task store (same task type, recent, still on disk) ──
    if (this.options.taskStore && typeof this.options.taskStore.listByType === "function") {
      try {
        const priorTasks = this.options.taskStore.listByType(resolvedTaskType, {
          withArtifacts: true,
          status: "completed",
          limit: 5
        });
        const candidateArtifacts = priorTasks
          .flatMap((t) => (t.artifacts ?? []).slice(-3))
          .slice(-5);
        const livingArtifacts = [];
        for (const art of candidateArtifacts) {
          if (!art?.path) continue;
          try {
            await Promise.race([
              fs.lstat(art.path),
              new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 500))
            ]);
            livingArtifacts.push(art);
          } catch {
            // Stale — skip
          }
        }
        if (livingArtifacts.length) {
          const block = livingArtifacts
            .map((a, i) => `${i + 1}. ${a.path} (${a.kind ?? "other"}, ${a.sizeBytes ?? 0}B, phase: ${a.producedBy?.[0]?.phaseId ?? "?"})`)
            .join("\n");
          contextSections.push(
            `PRIOR ARTIFACTS (from previous ${resolvedTaskType} runs):\n${block}`
          );
          timeline.push({
            stage: "artifacts",
            detail: `Injected ${livingArtifacts.length} prior artifact(s) from task store`
          });
        }
      } catch (err) {
        console.warn("[orchestrator] prior artifacts lookup failed:", err?.message ?? err);
      }
    }
```

- [ ] **Step 3: Run existing tests to verify no regression**

```bash
node --test packages/orchestrator/src/workflow.test.js packages/orchestrator/src/retrieval.test.js packages/orchestrator/src/planner.test.js packages/orchestrator/src/critic.test.js packages/orchestrator/src/lesson-writer.test.js packages/orchestrator/src/artifact-extractor.test.js
```

Expected: All tests pass.

- [ ] **Step 4: Syntax check**

```bash
node --check packages/orchestrator/src/index.js
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/index.js
git commit -m "feat(orchestrator): workspaceDir + PRIOR ARTIFACTS + artifact flatten"
```

---

### Task 8: Desktop main process — runsDir, shell IPC, persist artifacts

**Files:**
- Modify: `apps/desktop/main.js`

- [ ] **Step 1: Add runsDir setup at startup**

In `apps/desktop/main.js`, find the app-ready block (around line 3890 — where `loadConfig`, `createOrchestrator()`, `orchestrator.connectMcp()` are called). Before `createOrchestrator()`, add:

```js
    const runsDir = path.join(app.getPath("userData"), "runs");
    try {
      await fs.promises.mkdir(runsDir, { recursive: true });
    } catch (err) {
      logStartup("failed to create runs dir", err);
    }
```

If `fs` is not imported, add it at the top of main.js: `import fs from "node:fs";`. If `path` is not imported, add: `import path from "node:path";`. (Both are likely already imported — verify first.)

Make `runsDir` available to `createOrchestrator`. Update the `createOrchestrator` function signature and body:

```js
function createOrchestrator(runsDir) {
  orchestrator = new Orchestrator(appConfig, {
    resolveProvider,
    hasApiKey: async (providerId) => providerId === "ollama" || !!getDecryptedKey(providerId),
    hasApiKeySync: (providerId) => providerId === "ollama" || !!getDecryptedKey(providerId),
    invokeModel: invokeAgenticModel,
    runsDir,
    taskStore: getTaskStore(),
    memoryStore: getMemoryStore(),
    emitStatus: (text) => {
      emitStream({ type: "status", text: `${text}\n\n` });
      emitProgressDetail(parseStatusToDetail(text));
    },
    emitText: (text) => emitStream({ type: "text", text }),
    detectSandboxStatus,
    runSandboxedTask
  });
}
```

And update the call site in the app-ready block from `createOrchestrator();` to `createOrchestrator(runsDir);`.

- [ ] **Step 2: Add the shell:revealArtifact IPC handler**

At the top of `apps/desktop/main.js`, find the existing Electron import line. Ensure `shell` is imported:

```js
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
```

(If `shell` is already imported, skip.)

Find `registerIpcHandlers()` (or whichever function registers `ipcMain.handle` calls — search for the first `ipcMain.handle("assistant:` pattern). Add a new handler inside that function (or at module scope if handlers are registered there):

```js
  ipcMain.handle("shell:revealArtifact", async (_evt, absolutePath) => {
    if (!absolutePath || typeof absolutePath !== "string") {
      return { ok: false, error: "invalid path" };
    }
    try {
      shell.showItemInFolder(absolutePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
```

- [ ] **Step 3: Persist artifacts in task update call sites**

Search for the existing task-store update call sites where `runLedger` is persisted (they were added in L0 at roughly lines 2463 and 3102). In each one, add `artifacts: summary?.artifacts ?? finalTask?.artifacts ?? []` alongside the existing `runLedger` field. Example:

```js
    const updates = {
      status: summary.error ? "failed" : "completed",
      result: summary,
      runLedger: summary?.runLedger ?? finalTask?.runLedger ?? null,
      artifacts: summary?.artifacts ?? finalTask?.artifacts ?? [],
      timeline: summary?.timeline ?? task.timeline,
      ...
    };
```

Do this at BOTH call sites. The exact surrounding context varies — search for `runLedger:` occurrences in `main.js` and add `artifacts:` next to each one.

- [ ] **Step 4: Syntax check**

```bash
node --check apps/desktop/main.js
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): runsDir setup, shell:revealArtifact IPC, persist artifacts"
```

---

### Task 9: Preload bridge exposes revealArtifact

**Files:**
- Modify: `apps/desktop/preload.js`

- [ ] **Step 1: Add the new IPC exposure**

Read `apps/desktop/preload.js` first to find the existing `contextBridge.exposeInMainWorld("assistantApi", { ... })` block. Inside that object, add:

```js
revealArtifact: (absolutePath) => ipcRenderer.invoke("shell:revealArtifact", absolutePath),
```

Place it alongside the other `ipcRenderer.invoke` methods (the exact location will be obvious — look for similar lines like `getTask: (id) => ipcRenderer.invoke("assistant:getTask", id)`).

- [ ] **Step 2: Syntax check**

```bash
node --check apps/desktop/preload.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/preload.js
git commit -m "feat(desktop/preload): expose revealArtifact IPC bridge"
```

---

### Task 10: Desktop renderer — Artifacts panel

**Files:**
- Modify: `apps/desktop/index.html`
- Modify: `apps/desktop/renderer.js`
- Modify: `apps/desktop/styles.css`

- [ ] **Step 1: Add the Artifacts panel to index.html**

In `apps/desktop/index.html`, find the Run Ledger panel (added in L0) around line 274–277. Immediately after the closing `</section>` of that panel, add the new Artifacts panel:

```html
              <section class="panel sidebar-panel">
                <div class="sidebar-panel-header">
                  <h3>Artifacts</h3>
                  <span id="artifacts-count" class="task-meta">0 files</span>
                </div>
                <div id="artifacts-container" class="artifacts-container empty-state">
                  No artifacts produced by this task.
                </div>
              </section>
```

- [ ] **Step 2: Add Artifacts panel styles to styles.css**

Append to `apps/desktop/styles.css`:

```css
.artifacts-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
  max-height: 360px;
  overflow-y: auto;
}

.artifacts-container.empty-state {
  padding: 10px 12px;
  color: var(--muted);
  font-size: 0.75rem;
  font-style: italic;
}

.artifact-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

.artifact-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.artifact-kind-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(100, 150, 200, 0.15);
  color: var(--accent, #64748b);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.artifact-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-meta {
  color: var(--muted);
  font-size: 0.65rem;
}

.artifact-reveal-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--fg);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 0.65rem;
  cursor: pointer;
}

.artifact-reveal-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.artifact-preview {
  margin-top: 4px;
  padding: 4px 6px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 3px;
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.68rem;
  color: var(--fg);
}

.artifact-preview-hint {
  color: var(--muted);
  font-style: italic;
}
```

- [ ] **Step 3: Add renderArtifacts to renderer.js**

In `apps/desktop/renderer.js`, add two new element refs to the top-of-file `els` object alongside the existing refs (search for `errorBannerLog:` and add nearby):

```js
  artifactsContainer: $("#artifacts-container"),
  artifactsCount: $("#artifacts-count"),
```

Add a new `renderArtifacts(task)` function. Place it near the existing `renderRunLedger` function (search for `renderRunLedger`; place `renderArtifacts` next to it):

```js
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
          logWarn("revealArtifact", err);
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
    } else if (art.previewKind === "skipped-timeout") {
      const hint = document.createElement("div");
      hint.className = "artifact-preview-hint";
      hint.textContent = "Stat timed out — preview unavailable";
      row.appendChild(hint);
    }

    els.artifactsContainer.appendChild(row);
  }
}
```

Finally, call `renderArtifacts(selectedTask)` from `renderSelectedTaskDetails`. Search for the existing call to `renderRunLedger(selectedTask)` (or equivalent) inside `renderSelectedTaskDetails`; add `renderArtifacts(selectedTask);` right after it. If no such call exists, add the call at the end of `renderSelectedTaskDetails`.

- [ ] **Step 4: Syntax checks**

```bash
node --check apps/desktop/renderer.js
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/index.html apps/desktop/renderer.js apps/desktop/styles.css
git commit -m "feat(desktop): Artifacts panel with reveal-in-folder"
```

---

### Task 11: Full regression + end-to-end sanity check

**Files:** None modified — verification only.

- [ ] **Step 1: Run the full workspace test suite**

```bash
node --test $(find packages -name '*.test.js' -type f)
```

Expected: All tests pass. Baseline was 74 after L0; L1 adds ~14 new tests (12 artifact-extractor + 1 planner + 2 critic + 3 lesson-writer + 4 task-store - 8 overlap with existing counts = ~88 total depending on counting).

- [ ] **Step 2: Syntax-check every modified file**

```bash
for f in \
  packages/orchestrator/src/artifact-extractor.js \
  packages/orchestrator/src/planner.js \
  packages/orchestrator/src/critic.js \
  packages/orchestrator/src/lesson-writer.js \
  packages/orchestrator/src/index.js \
  packages/task-store/src/index.js \
  apps/desktop/main.js \
  apps/desktop/preload.js \
  apps/desktop/renderer.js; do
  node --check "$f" && echo "OK: $f" || echo "FAIL: $f"
done
```

Expected: All OK.

- [ ] **Step 3: Commit the verification checkpoint**

If any file needs a touch-up, fix and commit with `fix(l1): ...`. Otherwise no commit is needed — the implementation stands at the previous commit.

- [ ] **Step 4 (optional, manual): Live app smoke test**

Launch the Electron app, trigger an iterative task that produces a file, confirm:
1. Run Ledger panel populates (L0 regression check).
2. Artifacts panel shows the file with correct name, kind, and size.
3. Clicking "Reveal" opens the OS file browser at the workspace directory.
4. Running a second same-type task shows a `PRIOR ARTIFACTS` section in the logs/trace (via a temporary console.log if needed).

Fix anything that fails the smoke test with `fix(l1): ...` commits before declaring L1 shipped.
