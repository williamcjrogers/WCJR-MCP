# L1 — Per-Run Workspace & Artifact Graph (Design Spec)

**Date:** 2026-04-10
**Status:** Approved (William, 2026-04-10, same-day continuation of L0)
**Context:** L0 shipped earlier today. This is the next layer in the 7-layer "operator console" roadmap — making files produced during a run into first-class tracked objects so the critic can judge against ground truth and future runs can reference prior outputs.

## Strategic framing

L0 gave us a reason → act → critique → amend loop. L1 gives that loop **eyes**: the critic can now see what was actually produced on disk, not just what the model claimed. Until L1, a phase whose tool call failed silently would still be accepted because the critic only sees text. After L1, "phase intent was 'produce matter.xlsx', no xlsx artifact exists → retry_phase" becomes a reflex.

L1 is **convention, not enforcement.** The model is told where to put files; the extractor captures wherever they actually land. Sandboxing is L4's job.

---

## 1. Goal

After this ships, the orchestrator must:

1. Create a per-run scratch workspace directory (`${userData}/runs/<taskId>/`) and tell the executor model about it.
2. Extract files produced during a run into structured `Artifact` records, via three layers: per-tool whitelist, regex fallback on result JSON, and a universal workspace mtime scan.
3. Pass the per-phase artifact list into the critic so verdicts are grounded in ground truth.
4. Pass the run-level artifact list into the lesson-writer so lessons record file-name patterns.
5. Inject prior successful runs' artifacts into `collectToolContext` as a `PRIOR ARTIFACTS` section, with stale-artifact filtering.
6. Persist artifacts alongside the existing `runLedger` in task-store.
7. Render an Artifacts panel next to the Run Ledger panel in the desktop, with reveal-in-folder support via a new Electron IPC handler.
8. Keep all existing direct/sandboxed/plan-phase modes completely untouched.

## 2. Architecture

One new module, edits across nine existing files:

**New:**
- **`packages/orchestrator/src/artifact-extractor.js`** — pure-ish module. Exports `extractArtifactsFromPhase`, `scanWorkspaceForNewFiles`, `buildArtifactRecord`, `mergeArtifactHistory`, and the per-tool whitelist table.

**Modified:**
- `packages/orchestrator/src/planner.js` — accepts `workspaceDir`, calls extractor after each phase, passes artifacts to critic, accumulates run-level artifacts via `mergeArtifactHistory`.
- `packages/orchestrator/src/critic.js` — `buildCriticPrompt` accepts optional `artifacts`, renders an `ARTIFACTS PRODUCED` section.
- `packages/orchestrator/src/lesson-writer.js` — `buildLessonPrompt` and `parseLesson` handle an `artifacts_produced: string[]` field.
- `packages/orchestrator/src/index.js` — new `runsDir` constructor option, workspace setup in the iterative branch, `PRIOR ARTIFACTS` retrieval in `collectToolContext`, flatten `ledger.artifacts` to top-level.
- `packages/task-store/src/index.js` — add `artifacts: []` to `DEFAULT_TASK`, add `listByType` helper.
- `apps/desktop/main.js` — create `runsDir` at startup, wire into orchestrator, `shell:revealArtifact` IPC handler, persist artifacts on task update.
- `apps/desktop/preload.js` — expose `revealArtifact` to the renderer.
- `apps/desktop/renderer.js` — `renderArtifacts` function, new `els` refs.
- `apps/desktop/index.html` — Artifacts panel next to Run Ledger.
- `apps/desktop/styles.css` — Artifacts panel styles.

## 3. Artifact extractor — three-layer strategy

Each file-producing tool returns its output path differently. The extractor uses three layers that are merged and deduplicated by absolute path:

### Layer 1: Per-tool whitelist

A static map keyed by MCP tool name:

```js
const PRODUCER_WHITELIST = {
  create_workbook:    ["outputPath", "filePath"],
  update_workbook:    ["outputPath", "filePath"],
  export_workbook:    ["outputPath"],
  create_document:    ["outputPath", "filePath"],
  merge_documents:    ["outputPath"],
  export_document:    ["outputPath"],
  // Extend as new producer tools land
};
```

### Layer 2: Regex fallback on tool result JSON

For tools not in the whitelist, scan the top-level keys of the tool result JSON for `/^(output|file|result|saved|written)(Path|File)?$/i`. A plausible-absolute-path value is accepted only if it does NOT appear in the same tool call's `args` (the "input paths" filter, prevents `merge_documents` from emitting its input list).

### Layer 3: Universal mtime scan of workspaceDir

**This is the most important layer.** Some tools (e.g. `document-ops` in [packages/document-ops/src/server.js:55](../../../packages/document-ops/src/server.js#L55)) return their file paths only as English prose in the result `content` text — not as structured JSON. The only reliable way to catch them is to scan the workspace directory after each phase and accept any file whose `mtimeMs` falls inside `[phaseStartedAt − 1000, phaseEndedAt + 2000]`.

Constraints on the scan:
- Recurse at most 3 directory levels.
- Skip files matching blacklist prefixes (see §4).
- Cap at 50 artifacts per phase; log and drop excess.

## 4. Path safety (non-negotiable)

`buildArtifactRecord(path, ctx)` must defend against hostile and accidental inputs:

1. `path.resolve` to normalize.
2. Reject blacklisted prefixes: `C:\Windows\`, `C:\Program Files\`, `/etc/`, `/proc/`, `/sys/`, `/dev/`.
3. `fs.promises.lstat` (not `stat`) — skip if `isSymbolicLink()`.
4. Wrap `lstat` in a 500ms `Promise.race` timeout — treat timeout as `previewKind: "skipped-timeout"`.
5. Binary detection: stream-read first 8 KB, abort on first null byte → `previewKind: "skipped-binary"`, preview=null.
6. Size cap: if `stats.size > 64 * 1024` → `previewKind: "skipped-large"`, preview=null.
7. Text preview: truncate to first 200 characters.
8. Per-phase artifact count cap: 50.

## 5. Artifact schema

```jsonc
{
  "id": "art_<stableHash(runId + relPath)>",
  "runId": "task_...",
  "path": "/absolute/path/to/file.xlsx",
  "relPath": "file.xlsx",             // relative to workspaceDir, or null
  "workspaceHit": true,                // inside workspaceDir?
  "kind": "xlsx" | "docx" | "pdf" | "txt" | "md" | "json" | "csv" | "html" | "other",
  "sizeBytes": 12345,
  "preview": "first 200 chars or sheet names or null",
  "previewKind": "text" | "sheets" | "skipped-binary" | "skipped-large" | "skipped-timeout",
  "firstProducedAt": "ISO",
  "lastProducedAt": "ISO",
  "producedBy": [
    { "phaseId": "p2", "tool": "create_workbook", "at": "ISO", "sizeBytes": 12345 }
  ]
}
```

IDs are stable across overwrites inside a run: same path → same id → `producedBy[]` history grows.

## 6. Critic integration

The critic's `buildCriticPrompt` gains an `ARTIFACTS PRODUCED` section rendered only when `artifacts?.length > 0`:

```
ARTIFACTS PRODUCED:
- /workspace/task_123/matter.xlsx (xlsx, 12KB)
- /workspace/task_123/timeline.docx (docx, 8KB)
```

`runCritic` accepts an optional `artifacts` parameter and passes it through.

## 7. Lesson-writer integration

`buildLessonPrompt` gains an `ARTIFACTS` section. `parseLesson` accepts a new `artifacts_produced: string[]` field. The persisted memory content format becomes:

```
[disputes] summarize exhibits
Outcome: success
Worked: maxChars:50000
Artifacts: matter-summary.xlsx, matter-timeline.docx
Generalization: Matter-summary tasks should produce xlsx + docx artifacts
```

## 8. `PRIOR ARTIFACTS` retrieval in `collectToolContext`

After the existing L0 `PRIOR LESSONS` injection block, query `this.options.taskStore.listByType(resolvedTaskType, { withArtifacts: true, status: "completed", limit: 5 })`, flatten up to 5 artifacts, filter out stale ones with an `lstat` (500ms timeout), and append a `PRIOR ARTIFACTS` context section listing path + kind + size + producing phase id.

## 9. Task-store changes

- `DEFAULT_TASK` gets `artifacts: []` (the `update` method already spreads arbitrary fields, so no code change is required there).
- New `listByType(taskType, filters)` method mirroring the existing `list(filters)` shape but filtering by `taskType`, supporting `{ withArtifacts, status, limit }` options.

## 10. Desktop integration

### Main process

- At startup: `runsDir = path.join(app.getPath("userData"), "runs")`, `mkdir -p`.
- `createOrchestrator()` passes `runsDir` and `taskStore` into orchestrator options.
- New IPC handler `shell:revealArtifact` calls `shell.showItemInFolder(absolutePath)`.
- Task update call sites (the same ones that persist `runLedger` in L0) also include `artifacts: summary?.artifacts ?? []` in the update payload.

### Preload bridge

`revealArtifact: (absolutePath) => ipcRenderer.invoke("shell:revealArtifact", absolutePath)`

### Renderer

- New element refs: `artifactsContainer`, `artifactsCount`.
- New `renderArtifacts(task)` function called from `renderSelectedTaskDetails()`.
- Sorted by `lastProducedAt` desc. Each row: kind badge + basename + size + producer phase + Reveal button.
- Expanding a row reveals the `preview` or the relevant skip-reason hint.
- Empty state: "No artifacts produced by this task."

### HTML + CSS

- New `<section class="panel sidebar-panel">` with `#artifacts-container` inserted after the existing Run Ledger panel in [apps/desktop/index.html](../../../apps/desktop/index.html).
- New `.artifacts-container`, `.artifact-row`, `.artifact-kind-badge`, `.artifact-preview` styles paralleling the existing `.run-ledger-*` styles.

## 11. Out of scope (deferred)

| Deferred | Why | Layer |
|---|---|---|
| Enforcement / write-gating | L1 is convention | L4 |
| Directories as artifacts | Preview + overwrite semantics are hairy | L1.x |
| Content-hash dedupe | Over-engineered for L1 scale | L6 |
| Auto retention / cleanup | Needs policy UI | L4 |
| Artifact content embedding for retrieval | Tag-filter suffices | L6 |
| Consumer-lineage DAG | Producer-only is enough | L2 |
| Rich preview (render xlsx in UI) | Metadata-only for L1 | L5 polish |

## 12. Verification

### Unit tests (new)

- `artifact-extractor.test.js` — 8 tests covering whitelist, regex fallback, input-exclusion, mtime scan (inside/outside window), path safety (symlink, binary, large, blacklisted), ID idempotency, `mergeArtifactHistory`.
- `planner.test.js` — add 1 test confirming the planner passes `workspaceDir` through and attaches `phaseEntry.artifacts` from a mock extractor, and the mock critic receives artifacts.
- `critic.test.js` — add 1 test confirming `buildCriticPrompt` with `artifacts` renders an `ARTIFACTS PRODUCED` section.
- `lesson-writer.test.js` — add 1 test confirming `buildLessonPrompt` handles artifacts and `parseLesson` handles `artifacts_produced`.
- `task-store/src/index.test.js` — add 2 tests: `listByType` with filters, and `update + save + load` round-trip with an `artifacts` field.

### End-to-end manual verification (live app)

1. Create an iterative task "Generate a one-row workbook at matter-summary.xlsx with a 'test' column". Confirm the Artifacts panel shows the xlsx with a Reveal button. Click Reveal → OS file browser opens.
2. Create a document-ops-driven task ("Save a markdown report to report.md"). Confirm the md artifact appears via the mtime scan even though the tool returns only prose.
3. Create a third same-type task. Confirm the first phase's system prompt contains a `PRIOR ARTIFACTS` section referencing the files from the previous runs.
4. Delete one of the previous run's workspace directories from disk. Create a fourth task. Confirm the missing path is filtered out of `PRIOR ARTIFACTS`.
5. `node --test $(find packages -name '*.test.js' -type f)` → full suite green. Baseline 74 → target ~86.

### Critic feedback loop verification

6. Write a prompt where the phase intent is "create matter-summary.xlsx" but the plan deliberately uses an unwritable path. Expect the critic to `retry_phase` with reasoning citing "no xlsx artifact produced" — previously it would have accepted the model's text claim.

Only after all six checks pass is L1 shipped and the L2 brainstorm can begin.
