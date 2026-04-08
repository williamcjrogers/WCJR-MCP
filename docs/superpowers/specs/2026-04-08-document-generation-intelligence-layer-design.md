# Document Generation & Intelligence Layer Design

**Date:** 08 April 2026
**Author:** William Rogers / Claude
**Status:** Draft
**Scope:** Sub-project 1 of WCJR MCP expansion — document generation engines and federated intelligence layer

---

## 1. Problem Statement

WCJR MCP has functional AI routing, tool execution, and RAG infrastructure, but cannot produce the documents that constitute the primary output of a construction disputes practice: Defence Schedules, Schedules of Loss, adjudication submissions, witness statements, quantum reports, chronologies, and evidence bundle indices.

The system also lacks a unified intelligence layer. Knowledge is scattered across local drives, multiple OneDrives, Outlook, Gmail, Notion, Egnyte, and 5 million Lookeen-indexed files — with no mechanism to draw from all of these when generating output.

This spec addresses both: flexible document generation engines backed by federated knowledge retrieval.

---

## 2. Design Principles

1. **Explicit path beats search. Always.** When the user provides a folder path, the agent reads from there directly. Federated search is the fallback when no path is given.
2. **The engine is the hands, the AI is the brain.** Document engines are general-purpose rendering tools. The specialist agent decides structure, content, and formatting based on the task and intelligence layer context.
3. **No rigid templates.** Every dispute is different. The engines accept flexible schemas — the agent constructs the appropriate structure per task.
4. **Search everything, reason over what's relevant, generate from what's verified.** The agent queries all available sources in parallel and synthesises results.
5. **DD Month YYYY date format** enforced throughout all generated documents unless explicitly overridden.

---

## 3. Architecture Overview

```
User Request (with optional folder path)
    |
    v
Orchestrator (specialist agent selection)
    |
    v
Intelligence Layer (federated search — only if path not provided)
    |  Sources: Lookeen / Qdrant / Filesystem / OneDrive / Egnyte /
    |           Notion / Gmail / Outlook / Web / Midpage Legal Research
    |
    v
Agent Reasoning (synthesise, structure, decide)
    |
    v
Document Engine (xlsx-engine-mcp / docx-engine-mcp)
    |
    v
Output (.xlsx / .docx / .pdf) --> saved to specified location
```

---

## 4. Component 1: xlsx-engine-mcp

### Purpose

MCP server for forensic-grade Excel workbook generation, reading, updating, and analysis. General-purpose — the agent decides workbook structure per task.

### Tools

#### `create_workbook`
Create a new workbook from a flexible schema.

**Input:**
- `outputPath` (string) — where to save the .xlsx
- `sheets` (array) — each sheet definition:
  - `name` (string)
  - `columns` (array) — column definitions with header, width, format (accounting/date/percentage/text/number)
  - `rows` (array) — row data, each cell can be a value or a formula string (prefixed `=`)
  - `namedRanges` (array, optional) — name, sheet, cell range
  - `conditionalFormatting` (array, optional) — range, rule type, conditions, format
  - `dataValidation` (array, optional) — range, type (list/number/date), values
  - `freezePanes` (object, optional) — row, column
  - `autoFilter` (object, optional) — range
  - `printConfig` (object, optional) — orientation, margins, repeatRows, pageBreaks, headerFooter, fitToPage

**Output:** Path to generated .xlsx, sheet summary (names, row counts, named ranges).

#### `read_workbook`
Read an existing .xlsx with full structural introspection.

**Input:**
- `filePath` (string)
- `sheets` (array, optional) — specific sheet names to read; omit for all
- `includeFormulae` (boolean, default true) — return formulae as-is or computed values
- `range` (string, optional) — specific cell range to read

**Output:** Sheet names, column headers, data (values and/or formulae), named ranges, conditional formatting rules, data validation rules, merged cells, print configuration.

#### `update_workbook`
Modify an existing workbook. Preserves everything not explicitly changed.

**Input:**
- `filePath` (string)
- `operations` (array) — each operation:
  - `type`: addSheet / deleteSheet / insertRows / updateCells / deleteRows / addNamedRange / addConditionalFormatting / addFormula / setColumnWidth / mergeCells / addDataValidation / updatePrintConfig
  - Operation-specific parameters

**Output:** Path to updated .xlsx, summary of changes applied.

#### `analyse_workbook`
Computational analysis of an existing workbook.

**Input:**
- `filePath` (string)
- `analyses` (array) — requested analyses:
  - `variance` — compare columns (e.g., claimed vs admitted), compute differences
  - `sumValidation` — verify totals match detail rows
  - `formulaAudit` — list all formulae, flag circular references or errors
  - `inconsistencyCheck` — flag duplicate rows, mismatched references, data type mismatches
  - `statistical` — min/max/mean/median/distribution per column
  - `custom` — arbitrary computation described in natural language, executed by the agent

**Output:** Structured findings per analysis type, flagged issues with cell references.

#### `export_workbook`
Export workbook or specific sheets to PDF.

**Input:**
- `filePath` (string)
- `outputPath` (string)
- `sheets` (array, optional) — specific sheets; omit for all
- `printConfig` (object, optional) — override print settings for export

**Output:** Path to generated PDF.

### Technical Implementation

- **Library:** ExcelJS (npm `exceljs`)
- **Monetary values:** Stored as numbers, accounting number format applied via cell style
- **Date format:** DD Month YYYY default, configurable per column
- **Formulae:** Written as real Excel formulae (e.g., `=SUM(B2:B50)`), not pre-computed
- **Named ranges:** Used for all cross-sheet references
- **Conditional formatting:** Supports colour scales, data bars, icon sets, and rule-based (formula-driven)
- **Server transport:** stdio (launched by MCP hub as child process)

---

## 5. Component 2: docx-engine-mcp

### Purpose

MCP server for legal-grade Word document generation, reading, updating, merging, and PDF export. General-purpose — the agent decides document structure per task.

### Tools

#### `create_document`
Create a .docx from a flexible content tree.

**Input:**
- `outputPath` (string)
- `metadata` (object, optional) — title, author, subject, matter reference
- `pageSetup` (object, optional) — margins, orientation, size, headerFooter (with matter ref, party names, page numbers, confidentiality marking)
- `styles` (object, optional) — font, size, spacing overrides; defaults to legal standard (12pt, 1.5 line spacing, justified)
- `content` (array) — ordered content elements:
  - `heading` — level (1-4), text, numbering style (legal: 1, 1.1, 1.1.1 / none)
  - `paragraph` — text (with inline formatting: bold, italic, underline), numbering (continue/restart), indent level, alignment
  - `definedTerm` — term, definition; auto-applies bold on first usage, consistent casing throughout
  - `citation` — case name (italic), neutral citation, pinpoint reference, parenthetical
  - `table` — headers, rows, column widths, borders, shading
  - `list` — items, type (bullet/numbered/lettered), indent
  - `pageBreak`
  - `sectionBreak` — type (nextPage/continuous), separate numbering for appendices
  - `image` — path or base64, width, height, caption
  - `footnote` — attached to a paragraph/text span, content
  - `tableOfContents` — heading levels to include
  - `crossReference` — target paragraph number or heading, display text

**Output:** Path to generated .docx, document summary (page count, heading structure, defined terms list).

#### `read_document`
Read an existing .docx with structural introspection.

**Input:**
- `filePath` (string)
- `extractStructure` (boolean, default true) — return heading tree, paragraph numbering, defined terms
- `extractTables` (boolean, default true)
- `extractImages` (boolean, default false)

**Output:** Content tree (headings, paragraphs with numbering, tables, footnotes), styles, headers/footers, metadata, defined terms found, citation list.

#### `update_document`
Modify an existing document. Preserves everything not explicitly changed.

**Input:**
- `filePath` (string)
- `operations` (array) — each operation:
  - `insertAfter` / `insertBefore` — target (heading path or paragraph number), content elements to insert
  - `replace` — target, new content elements
  - `delete` — target or range
  - `updateHeaderFooter` — new header/footer content
  - `updateStyles` — style overrides
  - `addDefinedTerm` — term, definition; retroactively applies formatting to all existing usages
  - `renumber` — restart or adjust numbering from a given point

**Output:** Path to updated .docx, summary of changes.

#### `merge_documents`
Combine multiple .docx files.

**Input:**
- `files` (array) — ordered list of file paths
- `outputPath` (string)
- `sectionBreaks` (boolean, default true) — insert section breaks between documents
- `unifyNumbering` (boolean, default true) — continuous paragraph numbering across merged documents
- `unifyStyles` (boolean, default true) — apply consistent styling throughout
- `tableOfContents` (boolean, default false) — generate TOC for merged output

**Output:** Path to merged .docx, document summary.

#### `export_document`
Export to PDF.

**Input:**
- `filePath` (string)
- `outputPath` (string)
- `generateToc` (boolean, default false) — generate/update table of contents before export
- `resolveCrossRefs` (boolean, default true)

**Output:** Path to generated PDF.

### Technical Implementation

- **Library:** docx (npm `docx`) for generation, mammoth for reading existing .docx structure
- **PDF export:** LibreOffice CLI (`soffice --headless --convert-to pdf`) or pdf-lib for simpler cases
- **Numbering:** Legal hierarchical numbering (1, 1.1, 1.1.1) implemented via docx NumberingConfig
- **Defined terms:** Tracked in a terms registry during generation; bold on first usage, consistent capitalisation enforced
- **Citations:** Italic case name, followed by neutral citation in square brackets, pinpoint in parentheses
- **Server transport:** stdio

---

## 6. Component 3: Intelligence Layer

### Architecture

Federated retrieval across all available sources. No single source is authoritative. The agent decides which sources to query based on the task.

### Source Priority

1. **Explicit path** — user provides a folder/file path → read directly, no search
2. **Partial hint** — user says "it's in the Welbourne folder on OneDrive" → narrow search to that scope
3. **No path given** — agent searches relevant sources in parallel

### Available Sources

| Source | Access Via | Coverage |
|---|---|---|
| Lookeen | Lookeen MCP (existing, `C:\Program Files\Lookeen`) | 5M+ indexed files across C:, D:, multiple OneDrives |
| Qdrant | qdrant-rag-mcp (enhanced) | Curated semantic collections |
| Local filesystem | filesystem-mcp (existing) | Any file on C: or D: not covered by Lookeen |
| OneDrive / SharePoint | ms365 MCP | Cloud documents across multiple tenants |
| Egnyte | Egnyte MCP | Secondary document management |
| Notion | Notion MCP | Knowledge bases, case notes |
| Gmail | Gmail MCP | Email correspondence outside Outlook |
| Outlook | mail-calendar MCP (existing) | Email, calendar, contacts |
| Web | browser-ops (existing) | Public records, Land Registry |
| Legal research | Midpage Legal Research MCP | Case law databases, opinion analysis |

### Qdrant Collections (curated semantic layer)

| Collection | Contents | How Populated |
|---|---|---|
| `contracts` | Full contract documents, amendments, collateral warranties. Clause structure preserved. | Manual ingest — user decides which contracts are active working material |
| `authorities` | Case law, statutes, RICS guidance, SCL Protocol. Tagged by topic. | Manual or agent-suggested when new authority is encountered |
| `prior-work` | Previous schedules, submissions, reports. The system learns formatting patterns and analytical structures. | Manual — ingest completed work product |
| `matter:{name}` | Per-matter curated evidence (e.g., `matter:welbourne`). Correspondence, instructions, valuations promoted from search results. | Promoted from Lookeen/search results during active case work |
| `reference` | Methodology notes, calculation standards, best practices, internal guides. | Manual |

### New Tools (added to qdrant-rag-mcp)

#### `knowledge_ingest`
Ingest a file or directory into a named Qdrant collection.

**Input:**
- `source` (string) — file path or directory path
- `collection` (string) — target collection name
- `tags` (object, optional) — metadata: matter, type, dateRange, assessmentWindow, custodian
- `recursive` (boolean, default true for directories)
- `chunkOverlap` (number, default 200) — character overlap between chunks

**Process:** Uses document-ingestion for extraction (PDF, DOCX, XLSX, images/OCR, PST/MSG, HTML, plain text). Chunks with overlap. Embeds via Ollama nomic-embed-text. Stores in Qdrant with source, page, section, and tag metadata.

**Output:** Documents ingested count, chunks created, collection stats.

#### `knowledge_query`
Semantic search across one or more Qdrant collections.

**Input:**
- `query` (string) — natural language query
- `collections` (array) — collection names to search; omit for all
- `filters` (object, optional) — metadata filters (matter, type, dateRange, custodian, assessmentWindow)
- `limit` (number, default 10)
- `threshold` (number, optional) — minimum similarity score

**Output:** Ranked results with: chunk text, similarity score, source file, page/section, collection name, metadata tags.

#### `knowledge_promote`
Bridge between broad search (Lookeen/filesystem) and curated knowledge (Qdrant). Takes file paths from search results and ingests them into a collection.

**Input:**
- `filePaths` (array) — files to promote
- `collection` (string) — target collection
- `tags` (object, optional) — metadata tags to apply

**Output:** Ingestion results per file.

#### `knowledge_list`
List collections and their contents.

**Input:**
- `collection` (string, optional) — specific collection; omit for all

**Output:** Per collection: name, document count, chunk count, tag summary, total size.

#### `knowledge_delete`
Remove documents from a collection.

**Input:**
- `collection` (string)
- `filter` (object) — by source path, by metadata tags, or all

**Output:** Documents removed count, updated collection stats.

---

## 7. Document Ingestion Enhancements

### New Capabilities Required

| Format | Library | Notes |
|---|---|---|
| PST archives | `pst-extractor` (npm) | Extract emails with metadata (from, to, date, subject, body, attachments). Preserve threading. |
| MSG files | `msg-reader` (npm) | Individual Outlook messages |
| Structural DOCX extraction | Enhanced mammoth / custom parser | Preserve heading hierarchy, paragraph numbering, defined terms — not just raw text. Required for contract ingestion where clause structure matters. |

### Enhanced Extraction Output

Current document-ingestion returns plain text. For the intelligence layer, extraction should return structured output:

```
{
  text: "...",                    // full extracted text
  structure: {                    // optional, for structured formats
    headings: [...],              // heading tree with levels
    numberedParagraphs: [...],    // with their numbers preserved
    tables: [...],                // table data preserved
    metadata: { author, date, title, ... }
  },
  chunks: [                      // pre-chunked with overlap
    { text, page, section, headingPath, index }
  ]
}
```

---

## 8. Orchestrator Changes

### Agent Routing for Document Tasks

The orchestrator's specialist agents chain intelligence queries and document generation:

1. **User request** arrives (e.g., "produce a Defence Schedule for the S278 items")
2. **Orchestrator** classifies as document generation task, selects appropriate agents
3. **Agent** checks for explicit path in the request — if provided, reads directly
4. **Agent** queries intelligence layer for supporting context (contract terms, prior formats, evidence)
5. **Agent** synthesises results and constructs the document schema
6. **Agent** calls the appropriate engine (`create_workbook` or `create_document`)
7. **Output** saved to the location specified by the user (or a sensible default on D:)

### New Activity Profile: `disputes`

```javascript
{
  label: 'Disputes & Forensic',
  defaultModel: 'gpt-5.4-pro',
  suggestedTaskType: 'complex',
  mcpPresets: ['filesystem', 'documents', 'memory', 'xlsxEngine', 'docxEngine', 'qdrantRag', 'lookeen'],
  specialistAgents: ['Analyst', 'DraftWriter', 'DataProfiler', 'DocumentReviewer']
}
```

---

## 9. MCP Hub Registration

### New Servers to Register

| Server | Package | Transport | Launch |
|---|---|---|---|
| xlsx-engine-mcp | `packages/xlsx-engine-mcp` | stdio | MCP hub spawns as child process |
| docx-engine-mcp | `packages/docx-engine-mcp` | stdio | MCP hub spawns as child process |
| Lookeen MCP | External (`C:\Program Files\Lookeen\Desktop\mcp.exe`) | stdio | Configured in MCP hub as external server; launched via `mcp.exe` |

### Enhanced Servers

| Server | Changes |
|---|---|
| qdrant-rag-mcp | Add `knowledge_ingest`, `knowledge_query`, `knowledge_promote`, `knowledge_list`, `knowledge_delete` tools |
| document-ingestion | Add PST/MSG parsing, structural DOCX extraction, enhanced chunk output |

---

## 10. Desktop App Changes

### New IPC Handlers

- `getKnowledgeCollections` — list Qdrant collections and stats
- `ingestToKnowledge` — trigger file/directory ingestion into a collection
- `deleteFromKnowledge` — remove documents from a collection
- `getGeneratedDocuments` — list recently generated documents with paths

### UI Additions

Minimal — this is a power-user tool. The primary interface is the Command tab. Additions:

- **Knowledge section in Activity tab** — list collections, document counts, quick ingest button (pick directory → pick collection → ingest)
- **Generated documents in timeline** — when a document is generated, the timeline shows the output path as a clickable link that opens the file

---

## 11. Dependencies

### New npm Packages

| Package | Purpose | Size |
|---|---|---|
| `exceljs` | xlsx generation, reading, formulae, formatting | ~2MB |
| `docx` | docx generation | ~1MB |
| `mammoth` | docx reading/structural extraction | ~500KB |
| `pst-extractor` | PST archive parsing | ~200KB |
| `msg-reader` | MSG file parsing | ~100KB |

### External Dependencies

| Dependency | Status | Required For |
|---|---|---|
| Qdrant | Already in Docker stack | Intelligence layer semantic storage |
| Ollama + nomic-embed-text | Already configured | Embedding generation |
| LibreOffice (headless) | Needs install | docx → PDF export |
| Lookeen | Already installed | Federated search across 5M+ files |

---

## 12. Out of Scope (for this sub-project)

- Workflow automation / scheduled tasks (future sub-project)
- PPTX generation (add later as pptx-engine-mcp if needed)
- Real-time co-editing (user refines output in Word/Excel after generation)
- UI redesign / polish
- Programme analysis (Asta/P6/XER ingestion — future companion capability)
- WhatsApp integration
