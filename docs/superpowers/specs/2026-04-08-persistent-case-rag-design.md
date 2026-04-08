# Persistent Case RAG Design

**Date:** 08 April 2026
**Author:** William Rogers / Claude
**Status:** Draft
**Scope:** Sub-project 2 of WCJR MCP expansion — making the intelligence layer useful for forensic disputes work at scale

---

## 1. Problem Statement

Sub-project 1 built the infrastructure: `knowledge_ingest`, `knowledge_query`, `knowledge_promote`, `knowledge_list`, `knowledge_delete` tools, plus xlsx/docx generation engines. The plumbing works — Ollama embeddings, Qdrant storage, and semantic search with metadata filtering are all live and tested.

But the infrastructure alone does not produce forensic-grade output. The system cannot:
- Ingest large document sets reliably with progress tracking and resumability
- Preserve email metadata (sender, recipient, date, subject) in chunk payloads for citation
- Produce verbatim-quoted, cited answers to forensic questions
- Build analytical artefacts (chronologies, custodian maps, contested issues analyses) on demand
- Remember its own prior analysis across sessions

This spec addresses each gap, turning the infrastructure into a working forensic knowledge system.

---

## 2. Design Principles

1. **On demand, not during ingestion.** Artefact generation happens when requested, not as a side effect of ingestion. Ingestion is fast; analysis is deliberate.
2. **Verbatim or nothing.** Every factual assertion in system output must include an exact quote from the source material with a formatted citation. No paraphrasing evidence.
3. **Explicit path beats search.** When the user provides a folder path, the system reads from there directly. Federated search is the fallback.
4. **Files for the user, summaries for the system.** Generated artefacts are saved as xlsx/docx files for the user and as summaries back into Qdrant for cross-session memory.
5. **Resumable by default.** Large ingestion jobs track progress and resume from where they stopped.

---

## 3. Component 1: Enhanced Ingestion Pipeline

### Progress Tracking and Resumability

For large directory ingestions (hundreds of contract documents, drawing packs, valuation files), `knowledge_ingest` writes a progress file to a `.wcjr-ingest` directory alongside the source:

```json
{
  "source": "D:/Welbourne/Contract Documents",
  "collection": "contracts",
  "totalFiles": 347,
  "processedFiles": 142,
  "processedPaths": ["D:/Welbourne/Contract Documents/NEC3-Main.pdf", "..."],
  "failedFiles": 2,
  "failures": [{"file": "...", "error": "..."}],
  "chunksCreated": 8340,
  "startedAt": "2026-04-08T14:00:00Z",
  "lastProcessedAt": "2026-04-08T14:32:00Z",
  "status": "in_progress"
}
```

When `knowledge_ingest` is called on a source + collection combination that has an existing progress file with status `in_progress`, it resumes — skipping already-processed files. Completed ingestions are marked `completed` and skipped entirely on re-invocation unless a `force` parameter is set.

Progress file location: `{source}/.wcjr-ingest/{collection}.json` for directories, or `{source-dir}/.wcjr-ingest/{filename}-{collection}.json` for single files.

### Embedding Batch Size Control

Current code passes all chunk texts to `embed()` in a single call. For large documents producing hundreds of chunks, this can overwhelm Ollama's VRAM.

Change: batch embeddings in groups of 50 chunks (configurable via `batchSize` parameter, default 50). The `ingest()` function in `packages/rag/src/index.js` already batches Qdrant upserts in groups of 100 — the embedding call needs the same treatment.

### Email Metadata from Promoted Files

When files are promoted via `knowledge_promote` and the file is a `.msg` or `.eml`, extract sender, recipient, date, and subject into chunk metadata fields rather than treating them as generic text. This provides citation-grade metadata for individual emails surfaced by Lookeen searches.

New chunk metadata fields (added to Qdrant payload):
- `emailFrom` (string) — sender name/address
- `emailTo` (string) — recipient name/address
- `emailCc` (string) — CC recipients
- `emailDate` (string) — ISO 8601 date
- `emailSubject` (string) — subject line
- `emailFolder` (string) — folder path within PST/mailbox (if available)
- `threadId` (string) — hash of normalised subject line (stripped of RE:/FW: prefixes) for threading

New Qdrant payload indexes: `emailFrom`, `emailTo`, `emailDate`, `threadId`.

### Changes Required

| Package | File | Change |
|---|---|---|
| `packages/rag/src/index.js` | `ensureCollection` | Add payload indexes for `emailFrom`, `emailTo`, `emailDate`, `threadId` |
| `packages/rag/src/index.js` | `ingest` | Batch embedding calls (50 at a time). Add email metadata fields to payload. |
| `packages/rag/src/index.js` | `search` | Return email metadata fields in results |
| `packages/rag/src/chunker.js` | `chunkDocument` | Accept and pass through email metadata fields |
| `packages/qdrant-rag-mcp/src/server.js` | `knowledge_ingest` | Progress file read/write, resume logic, `force` and `batchSize` parameters |
| `packages/qdrant-rag-mcp/src/server.js` | `knowledge_promote` | Detect .msg/.eml files, extract email metadata, pass to chunker |
| `packages/document-ingestion/src/index.js` | New export | `extractEmailMetadata({ buffer, fileName })` — returns structured email object for .msg/.eml files |

---

## 4. Component 2: Citation Formatting

### Citation Templates

Every verbatim quote from the knowledge base must carry a formatted citation. The format depends on the document type stored in the chunk payload.

| documentType | Citation Format |
|---|---|
| `email` / `msg` / `eml` | `[Email: {emailFrom} to {emailTo}, {emailDate as DD Month YYYY}, Subject: "{emailSubject}"]` |
| `contract` / `docx` / `pdf` | `[{source filename}, {headingPath or section}, p.{page}]` |
| `drawing` | `[Drawing: {source filename}]` |
| `xlsx` / `valuation` | `[{source filename}, Sheet: {section}]` |
| generic / unknown | `[{source filename}, p.{page}]` |

### Implementation

A new utility function `formatCitation(chunkPayload)` in `packages/rag/src/citation.js`:

```javascript
export function formatCitation(payload) {
  const type = (payload.documentType ?? "").toLowerCase();

  if (type === "email" || type === "msg" || type === "eml") {
    const date = formatDateDDMonthYYYY(payload.emailDate);
    return `[Email: ${payload.emailFrom} to ${payload.emailTo}, ${date}, Subject: "${payload.emailSubject}"]`;
  }

  if (type === "contract" || type === "docx" || type === "pdf") {
    const loc = payload.headingPath || payload.section || "";
    const page = payload.page ? `, p.${payload.page}` : "";
    return `[${basename(payload.source)}${loc ? ", " + loc : ""}${page}]`;
  }

  if (type === "drawing") {
    return `[Drawing: ${basename(payload.source)}]`;
  }

  if (type === "xlsx" || type === "valuation") {
    const sheet = payload.section ? `, Sheet: ${payload.section}` : "";
    return `[${basename(payload.source)}${sheet}]`;
  }

  const page = payload.page ? `, p.${payload.page}` : "";
  return `[${basename(payload.source)}${page}]`;
}
```

The `knowledge_query` tool response includes a `citation` field for each result, pre-formatted by this function. The orchestrator's specialist agents use the citation directly in their output — they do not construct citations themselves.

### Changes Required

| Package | File | Change |
|---|---|---|
| `packages/rag/src/citation.js` | New file | `formatCitation(payload)` and `formatDateDDMonthYYYY(isoDate)` |
| `packages/rag/package.json` | exports | Add `"./citation": "./src/citation.js"` |
| `packages/qdrant-rag-mcp/src/server.js` | `knowledge_query` | Import `formatCitation`, add `citation` field to each result |

---

## 5. Component 3: On-Demand Artefact Generation

### New Tool: `matter_analyse`

Added to `qdrant-rag-mcp`. This tool queries the knowledge base and returns structured results that the orchestrator agent uses to build artefacts via the document engines.

| Parameter | Type | Description |
|---|---|---|
| `collection` | string | The matter collection (e.g., `matter:welbourne`) |
| `analysisType` | enum | `chronology` / `custodianMap` / `contestedIssues` / `evidenceSummary` / `custom` |
| `scope` | object, optional | Metadata filters: `{ assessmentWindow, custodian, documentType, dateRange }` or `{ description: "free text" }` for custom |
| `outputPath` | string | Where to save the artefact file |
| `outputFormat` | enum, optional | `xlsx` / `docx` — defaults: chronology→xlsx, custodianMap→xlsx, contestedIssues→docx, evidenceSummary→docx |

### How It Works

The tool does NOT generate the artefact itself. It:

1. Queries `knowledge_query` across the specified collection with scope filters, retrieving up to 200 results
2. Formats citations for all results
3. Returns the structured, cited results to the calling agent

The orchestrator agent then:

4. Reasons over the results — builds the artefact structure
5. Calls `create_workbook` or `create_document` to produce the file
6. Calls `knowledge_ingest` to save a summary back into Qdrant (collection: `artefacts`, tagged with matter name and analysis type)

This keeps the tool simple (query + format) and puts the intelligence in the agent where it belongs.

### Artefact Structures

**Chronology** (xlsx):

| Column | Description |
|---|---|
| Date | DD Month YYYY |
| Event | Description of what occurred |
| Verbatim Quote | Exact text from source material |
| Citation | Formatted citation |
| Significance | Why this event matters to the dispute |
| Assessment Window | W4, W5a, W5b, etc. |
| Supporting / Undermining | Whether the event supports or undermines the client's position |

**Custodian Map** (xlsx):

| Column | Description |
|---|---|
| Custodian | Name |
| Role | Role on the project |
| Document Count | Number of indexed documents from this custodian |
| Key Topics | Main subjects discussed |
| Communication Pattern | Who they correspond with most frequently |
| Notable Correspondence | Verbatim quotes with citations from significant communications |

**Contested Issues** (docx):

For each contested issue:
- Issue description
- Claimant's position — with verbatim-quoted evidence and citations
- Respondent's position — with verbatim-quoted evidence and citations
- Key documents — list with citations
- Preliminary assessment — strengths and weaknesses of each position

**Evidence Summary** (docx):

For a specific topic — all relevant evidence with verbatim quotes and citations, organised chronologically. Each entry: date, source citation, verbatim quote, contextual note.

**Custom**: Free-form analysis described in the scope parameter.

### Cross-Session Persistence

After generating an artefact, the agent saves a summary back into Qdrant:

- Collection: `artefacts`
- Tags: `{ matter: "welbourne", documentType: "chronology", dateRange: "2023-2025" }`
- Text: structured summary of key findings, conclusions, and the output file path

Next session, if the user asks "what did we find about the S278 delay?", `knowledge_query` on the `artefacts` collection retrieves the prior analysis. The agent can reference it, build on it, or regenerate with updated evidence.

### Changes Required

| Package | File | Change |
|---|---|---|
| `packages/qdrant-rag-mcp/src/server.js` | New tool | `matter_analyse` — query + format + return results |

---

## 6. Component 4: Orchestrator Integration

### Agent Prompt Enhancement

No new specialist agents. The existing agents (Analyst, DraftWriter, DataProfiler, DocumentReviewer) handle disputes work with enhanced system prompt instructions.

When the orchestrator detects the `disputes` activity profile, specialist agent prompts include:

**Citation rule:**
> "Every factual assertion must include a verbatim quote from the source material. Use the `citation` field from knowledge_query results. Never paraphrase or summarise evidence — reproduce the exact text. Place the citation immediately after the quote."

**Source priority:**
> "When the user provides a file or folder path, read from it directly using filesystem tools. When no path is given, query the knowledge base via knowledge_query. When the knowledge base returns insufficient results, search via Lookeen."

**Artefact persistence:**
> "After generating any analytical artefact (chronology, custodian map, contested issues, evidence summary), save a structured summary back into the 'artefacts' collection using knowledge_ingest, tagged with the matter name and analysis type."

### Retrieval Strategy Update

The orchestrator's `getRetrievalStrategy` function should include `qdrantRag` and `lookeen` sources by default for tasks using the `disputes` activity profile.

### Changes Required

| Package | File | Change |
|---|---|---|
| `packages/orchestrator/src/index.js` | Agent prompt builder | Add citation, source priority, and artefact persistence instructions for disputes profile |
| `packages/orchestrator/src/retrieval.js` | `getRetrievalStrategy` | Include qdrantRag and lookeen for disputes tasks |

---

## 7. Dependencies

### No New npm Packages

All required libraries are already installed:
- `pst-extractor` — in document-ingestion (for future PST work if needed)
- `msgreader` — in document-ingestion (for .msg metadata extraction)
- Qdrant client, Ollama embed, ExcelJS, docx — all present

### External Dependencies (already running)

| Dependency | Status | Verified |
|---|---|---|
| Qdrant | Docker container running | Tested — collection CRUD, search, metadata filtering all working |
| Ollama + nomic-embed-text | Native install, model pulled | Tested — 768-dim embeddings producing correct similarity scores |

---

## 8. Out of Scope

- PST archive bulk ingestion (Lookeen handles email discovery; individual emails promoted on demand)
- Automated ingestion triggers / scheduled re-indexing (future sub-project: workflow automation)
- UI for knowledge collection browsing (existing IPC handlers sufficient; command tab is primary interface)
- Programme analysis (Asta/P6/XER ingestion)
- WhatsApp integration
