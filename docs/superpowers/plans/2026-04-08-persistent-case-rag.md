# Persistent Case RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing RAG infrastructure into a forensic-grade knowledge system with progress-tracked ingestion, citation formatting, on-demand artefact generation, and disputes-aware orchestrator prompts.

**Architecture:** Four components: (1) enhanced ingestion pipeline with progress files and batched embeddings, (2) citation formatter producing standard reference strings from chunk metadata, (3) `matter_analyse` tool for on-demand artefact evidence gathering, (4) orchestrator prompt enhancements for the disputes activity profile.

**Tech Stack:** Qdrant, Ollama nomic-embed-text, ExcelJS, docx, MCP SDK, Zod — all already installed.

---

## File Structure

### New files

```
packages/rag/src/citation.js          # formatCitation(), formatDateDDMonthYYYY()
```

### Modified files

```
packages/rag/package.json             # Add ./citation export
packages/rag/src/index.js             # Batch embeddings, email metadata in payload/indexes/search
packages/rag/src/chunker.js           # Email metadata passthrough
packages/document-ingestion/src/index.js  # extractEmailMetadata() export
packages/qdrant-rag-mcp/src/server.js     # Progress tracking, email-aware promote, matter_analyse, citations in query results
packages/orchestrator/src/index.js        # Disputes system prompt, retrieval strategy
```

---

### Task 1: Citation Formatter

**Files:**
- Create: `packages/rag/src/citation.js`
- Modify: `packages/rag/package.json`

- [ ] **Step 1: Create `packages/rag/src/citation.js`**

```javascript
import path from "node:path";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Format an ISO date string as DD Month YYYY.
 * @param {string} isoDate - ISO 8601 date string.
 * @returns {string} Formatted date or the original string if parsing fails.
 */
export function formatDateDDMonthYYYY(isoDate) {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return String(isoDate);
    const day = d.getDate();
    const month = MONTHS[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  } catch {
    return String(isoDate);
  }
}

/**
 * Format a citation string from a Qdrant chunk payload.
 * @param {object} payload - Chunk payload with source, documentType, email fields, etc.
 * @returns {string} Formatted citation in square brackets.
 */
export function formatCitation(payload) {
  const type = (payload.documentType ?? "").toLowerCase();
  const filename = path.basename(payload.source ?? "unknown");

  if (type === "email" || type === "msg" || type === "eml") {
    const date = formatDateDDMonthYYYY(payload.emailDate);
    const from = payload.emailFrom || "Unknown";
    const to = payload.emailTo || "Unknown";
    const subject = payload.emailSubject || "(no subject)";
    return `[Email: ${from} to ${to}, ${date}, Subject: "${subject}"]`;
  }

  if (type === "contract" || type === "docx" || type === "pdf") {
    const loc = payload.headingPath || payload.section || "";
    const page = payload.page ? `, p.${payload.page}` : "";
    return `[${filename}${loc ? ", " + loc : ""}${page}]`;
  }

  if (type === "drawing") {
    return `[Drawing: ${filename}]`;
  }

  if (type === "xlsx" || type === "valuation") {
    const sheet = payload.section ? `, Sheet: ${payload.section}` : "";
    return `[${filename}${sheet}]`;
  }

  const page = payload.page ? `, p.${payload.page}` : "";
  return `[${filename}${page}]`;
}
```

- [ ] **Step 2: Add export to `packages/rag/package.json`**

Update the `exports` field to include the citation module. The current exports are:

```json
"exports": {
  ".": "./src/index.js",
  "./chunker": "./src/chunker.js"
}
```

Change to:

```json
"exports": {
  ".": "./src/index.js",
  "./chunker": "./src/chunker.js",
  "./citation": "./src/citation.js"
}
```

- [ ] **Step 3: Verify the module loads**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && node -e "import { formatCitation, formatDateDDMonthYYYY } from './packages/rag/src/citation.js'; console.log(formatDateDDMonthYYYY('2024-03-14T10:30:00Z')); console.log(formatCitation({ source: '/path/to/email.msg', documentType: 'email', emailFrom: 'John Smith', emailTo: 'William Rogers', emailDate: '2024-03-14T10:30:00Z', emailSubject: 'RE: S278 Works' })); console.log(formatCitation({ source: '/path/to/NEC3-Main.pdf', documentType: 'contract', headingPath: 'Clause 60.1', page: 42 })); console.log(formatCitation({ source: '/path/to/Drawing-Rev-C.dwg', documentType: 'drawing' })); console.log('PASS');"`

Expected:
```
14 March 2024
[Email: John Smith to William Rogers, 14 March 2024, Subject: "RE: S278 Works"]
[NEC3-Main.pdf, Clause 60.1, p.42]
[Drawing: Drawing-Rev-C.dwg]
PASS
```

- [ ] **Step 4: Commit**

```bash
git add packages/rag/src/citation.js packages/rag/package.json
git commit -m "feat(rag): add citation formatter with DD Month YYYY dates"
```

---

### Task 2: Email Metadata — RAG Package Enhancements

**Files:**
- Modify: `packages/rag/src/index.js`
- Modify: `packages/rag/src/chunker.js`

- [ ] **Step 1: Add email metadata indexes to `ensureCollection`**

In `packages/rag/src/index.js`, update the `indexFields` array in `ensureCollection` (line 21):

```javascript
  const indexFields = ["source", "documentType", "matter", "custodian", "assessmentWindow", "emailFrom", "emailTo", "emailDate", "threadId"];
```

- [ ] **Step 2: Batch embedding calls in `ingest`**

Replace the `ingest` function in `packages/rag/src/index.js` (lines 36-66):

```javascript
export async function ingest(collection, chunks, { batchSize = 50 } = {}) {
  // Batch embeddings to avoid overwhelming Ollama VRAM
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize).map((c) => c.text);
    const batchEmbeddings = await embed(batch);
    embeddings.push(...batchEmbeddings);
  }

  const points = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: embeddings[i],
    payload: {
      text: chunk.text,
      source: chunk.source,
      section: chunk.section ?? "",
      page: chunk.page ?? 0,
      documentType: chunk.documentType ?? "general",
      chunkIndex: chunk.chunkIndex ?? i,
      matter: chunk.matter ?? "",
      custodian: chunk.custodian ?? "",
      assessmentWindow: chunk.assessmentWindow ?? "",
      headingPath: chunk.headingPath ?? "",
      dateRange: chunk.dateRange ?? "",
      emailFrom: chunk.emailFrom ?? "",
      emailTo: chunk.emailTo ?? "",
      emailCc: chunk.emailCc ?? "",
      emailDate: chunk.emailDate ?? "",
      emailSubject: chunk.emailSubject ?? "",
      emailFolder: chunk.emailFolder ?? "",
      threadId: chunk.threadId ?? ""
    }
  }));

  // Batch upsert in groups of 100
  for (let i = 0; i < points.length; i += 100) {
    await qdrant.upsert(collection, {
      wait: true,
      points: points.slice(i, i + 100)
    });
  }
  return points.length;
}
```

- [ ] **Step 3: Return email metadata in `search` results**

Replace the `search` function's return mapping (lines 84-95):

```javascript
  return result.points.map((p) => ({
    score: p.score,
    text: p.payload.text,
    source: p.payload.source,
    section: p.payload.section,
    page: p.payload.page,
    documentType: p.payload.documentType ?? "",
    matter: p.payload.matter ?? "",
    custodian: p.payload.custodian ?? "",
    assessmentWindow: p.payload.assessmentWindow ?? "",
    headingPath: p.payload.headingPath ?? "",
    emailFrom: p.payload.emailFrom ?? "",
    emailTo: p.payload.emailTo ?? "",
    emailCc: p.payload.emailCc ?? "",
    emailDate: p.payload.emailDate ?? "",
    emailSubject: p.payload.emailSubject ?? "",
    emailFolder: p.payload.emailFolder ?? "",
    threadId: p.payload.threadId ?? ""
  }));
```

- [ ] **Step 4: Add email metadata passthrough to chunker**

In `packages/rag/src/chunker.js`, update the return in `chunkDocument` (lines 22-35) to pass through email fields:

```javascript
  return chunks.map((chunk, i) => ({
    id: randomUUID(),
    text: chunk,
    chunkIndex: i,
    source: meta.source ?? "unknown",
    section: meta.section ?? "",
    page: meta.page ?? 0,
    documentType: meta.documentType ?? "general",
    matter: meta.matter ?? "",
    custodian: meta.custodian ?? "",
    assessmentWindow: meta.assessmentWindow ?? "",
    headingPath: meta.headingPath ?? "",
    dateRange: meta.dateRange ?? "",
    emailFrom: meta.emailFrom ?? "",
    emailTo: meta.emailTo ?? "",
    emailCc: meta.emailCc ?? "",
    emailDate: meta.emailDate ?? "",
    emailSubject: meta.emailSubject ?? "",
    emailFolder: meta.emailFolder ?? "",
    threadId: meta.threadId ?? ""
  }));
```

- [ ] **Step 5: Commit**

```bash
git add packages/rag/src/index.js packages/rag/src/chunker.js
git commit -m "feat(rag): batch embeddings, email metadata in payload/indexes/search"
```

---

### Task 3: Email Metadata Extraction in document-ingestion

**Files:**
- Modify: `packages/document-ingestion/src/index.js`

- [ ] **Step 1: Add `extractEmailMetadata` export**

Add this function at the end of `packages/document-ingestion/src/index.js`, before the closing of the file:

```javascript
/**
 * Extract structured email metadata from a .msg or .eml file.
 * @param {{ buffer: Buffer, fileName: string }} params
 * @returns {Promise<{from: string, to: string, cc: string, date: string, subject: string, body: string, threadId: string} | null>}
 */
export async function extractEmailMetadata({ buffer, fileName = "" }) {
  const kind = guessDocumentKind(fileName);
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);

  if (kind === "msg") {
    try {
      const { default: MsgReader } = await import("msgreader");
      const reader = new MsgReader(new Uint8Array(inputBuffer));
      const data = reader.getFileData();
      if (data.error) return null;

      const from = data.senderName || data.senderEmail || "";
      const to = (data.recipients ?? []).map(r => r.name || r.email || "").join(", ");
      const subject = data.subject || "";
      const body = data.body || "";
      let date = "";
      if (data.headers) {
        const dateMatch = String(data.headers).match(/Date:\s*(.+)/i);
        if (dateMatch) date = dateMatch[1].trim();
      }
      const threadId = normaliseSubjectForThreading(subject);

      return { from, to, cc: "", date, subject, body, threadId };
    } catch {
      return null;
    }
  }

  if (kind === "text" && fileName.toLowerCase().endsWith(".eml")) {
    try {
      const text = inputBuffer.toString("utf-8");
      const from = extractHeader(text, "From") ?? "";
      const to = extractHeader(text, "To") ?? "";
      const cc = extractHeader(text, "Cc") ?? "";
      const date = extractHeader(text, "Date") ?? "";
      const subject = extractHeader(text, "Subject") ?? "";
      const bodyStart = text.indexOf("\n\n");
      const body = bodyStart >= 0 ? text.slice(bodyStart + 2) : "";
      const threadId = normaliseSubjectForThreading(subject);

      return { from, to, cc, date, subject, body, threadId };
    } catch {
      return null;
    }
  }

  return null;
}

function extractHeader(text, headerName) {
  const regex = new RegExp(`^${headerName}:\\s*(.+?)$`, "mi");
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function normaliseSubjectForThreading(subject) {
  // Strip RE:, FW:, Fwd: prefixes and hash the normalised subject
  const normalised = (subject ?? "").replace(/^(RE|FW|Fwd):\s*/gi, "").trim().toLowerCase();
  if (!normalised) return "";
  // Simple hash — fnv1a-like
  let hash = 2166136261;
  for (let i = 0; i < normalised.length; i++) {
    hash ^= normalised.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/document-ingestion/src/index.js
git commit -m "feat(document-ingestion): add extractEmailMetadata for .msg and .eml files"
```

---

### Task 4: Enhanced knowledge_ingest with Progress Tracking

**Files:**
- Modify: `packages/qdrant-rag-mcp/src/server.js`

- [ ] **Step 1: Add progress file helpers**

Add after the `buildQdrantFilter` helper function (after line 84) in `packages/qdrant-rag-mcp/src/server.js`:

```javascript
/* ── Ingestion progress tracking ───────────────────────────────────── */

async function getProgressPath(source, collection) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    return path.join(source, ".wcjr-ingest", `${collection.replace(/[:/\\]/g, "_")}.json`);
  }
  const dir = path.dirname(source);
  const name = path.basename(source, path.extname(source));
  return path.join(dir, ".wcjr-ingest", `${name}-${collection.replace(/[:/\\]/g, "_")}.json`);
}

async function loadProgress(progressPath) {
  try {
    const data = await fs.readFile(progressPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveProgress(progressPath, progress) {
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  await fs.writeFile(progressPath, JSON.stringify(progress, null, 2), "utf-8");
}
```

- [ ] **Step 2: Replace `knowledge_ingest` tool registration**

Replace the entire `knowledge_ingest` tool registration (lines 88-162) with:

```javascript
server.registerTool(
  "knowledge_ingest",
  {
    description: "Ingest a file or directory into a Qdrant collection. Supports PDF, DOCX, XLSX, images (OCR), HTML, plain text, PST, and MSG files. Tracks progress for large ingestions and resumes from where it stopped.",
    inputSchema: {
      source: z.string().min(1).describe("File or directory path to ingest"),
      collection: z.string().default("documents").describe("Qdrant collection name"),
      tags: z.object({
        matter: z.string().default(""),
        documentType: z.string().default("general"),
        custodian: z.string().default(""),
        assessmentWindow: z.string().default(""),
        dateRange: z.string().default("")
      }).optional().describe("Metadata tags applied to all ingested chunks"),
      recursive: z.boolean().default(true).describe("Recurse into subdirectories"),
      chunkOverlap: z.number().default(200).describe("Overlap between chunks in characters"),
      batchSize: z.number().default(50).describe("Embedding batch size (chunks per Ollama call)"),
      force: z.boolean().default(false).describe("Force re-ingestion even if a completed progress file exists")
    }
  },
  async ({ source, collection, tags, recursive, chunkOverlap, batchSize, force }) => {
    await ensureCollection(collection);
    const stat = await fs.stat(source);
    const progressPath = await getProgressPath(source, collection);
    let progress = await loadProgress(progressPath);

    // Check for completed ingestion
    if (progress && progress.status === "completed" && !force) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          collection,
          status: "already_completed",
          filesProcessed: progress.processedFiles,
          chunksCreated: progress.chunksCreated,
          message: "Ingestion already completed. Use force=true to re-ingest."
        }, null, 2) }]
      };
    }

    // Initialise or resume progress
    const processedSet = new Set(progress?.processedPaths ?? []);
    if (!progress || progress.status === "completed") {
      progress = {
        source,
        collection,
        totalFiles: 0,
        processedFiles: 0,
        processedPaths: [],
        failedFiles: 0,
        failures: [],
        chunksCreated: 0,
        startedAt: new Date().toISOString(),
        lastProcessedAt: null,
        status: "in_progress"
      };
    }

    const errors = progress.failures;
    let filesProcessed = progress.processedFiles;
    let totalChunks = progress.chunksCreated;

    async function processFile(filePath) {
      if (processedSet.has(filePath)) return; // Skip already processed
      try {
        const buffer = await fs.readFile(filePath);
        const fileName = path.basename(filePath);
        const result = await extractDocumentText({ buffer, fileName });
        if (!result.text) {
          errors.push({ file: filePath, error: result.warnings.join("; ") || "No text extracted" });
          progress.failedFiles++;
          return;
        }
        const meta = {
          source: filePath,
          documentType: tags?.documentType ?? "general",
          matter: tags?.matter ?? "",
          custodian: tags?.custodian ?? "",
          assessmentWindow: tags?.assessmentWindow ?? "",
          dateRange: tags?.dateRange ?? ""
        };
        const chunks = chunkDocument(result.text, meta, { overlap: chunkOverlap });
        const count = await ingest(collection, chunks, { batchSize });
        totalChunks += count;
        filesProcessed++;
        processedSet.add(filePath);
        progress.processedPaths.push(filePath);
        progress.processedFiles = filesProcessed;
        progress.chunksCreated = totalChunks;
        progress.lastProcessedAt = new Date().toISOString();

        // Save progress every 10 files
        if (filesProcessed % 10 === 0) {
          await saveProgress(progressPath, progress);
        }
      } catch (err) {
        errors.push({ file: filePath, error: err.message ?? String(err) });
        progress.failedFiles++;
      }
    }

    // Count total files first for progress reporting
    async function countFiles(dirPath) {
      let count = 0;
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".wcjr-ingest") continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && recursive) {
          count += await countFiles(fullPath);
        } else if (entry.isFile()) {
          count++;
        }
      }
      return count;
    }

    async function walkDir(dirPath) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".wcjr-ingest") continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && recursive) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          await processFile(fullPath);
        }
      }
    }

    if (stat.isDirectory()) {
      progress.totalFiles = await countFiles(source);
      await saveProgress(progressPath, progress);
      await walkDir(source);
    } else {
      progress.totalFiles = 1;
      await processFile(source);
    }

    progress.status = "completed";
    progress.failures = errors;
    await saveProgress(progressPath, progress);

    const output = {
      collection,
      status: "completed",
      totalFiles: progress.totalFiles,
      filesProcessed,
      chunksCreated: totalChunks,
      failedFiles: errors.length,
      errors: errors.length > 0 ? errors : undefined,
      resumed: processedSet.size > filesProcessed ? false : undefined
    };
    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }]
    };
  }
);
```

- [ ] **Step 3: Commit**

```bash
git add packages/qdrant-rag-mcp/src/server.js
git commit -m "feat(qdrant-rag): add progress tracking and resumability to knowledge_ingest"
```

---

### Task 5: Email-Aware knowledge_promote

**Files:**
- Modify: `packages/qdrant-rag-mcp/src/server.js`

- [ ] **Step 1: Add import for extractEmailMetadata**

Update the import line (line 8) to:

```javascript
import { extractDocumentText, extractEmailMetadata } from "@wcjr/document-ingestion";
```

- [ ] **Step 2: Replace `knowledge_promote` tool registration**

Replace the entire `knowledge_promote` registration (lines 205-259) with:

```javascript
server.registerTool(
  "knowledge_promote",
  {
    description: "Promote files from search results (or any file paths) into a Qdrant collection. For .msg and .eml files, automatically extracts email metadata (sender, recipient, date, subject) for citation-grade chunk payloads.",
    inputSchema: {
      filePaths: z.array(z.string().min(1)).min(1).describe("Array of file paths to ingest"),
      collection: z.string().default("documents").describe("Target Qdrant collection"),
      tags: z.object({
        matter: z.string().default(""),
        documentType: z.string().default("general"),
        custodian: z.string().default(""),
        assessmentWindow: z.string().default(""),
        dateRange: z.string().default("")
      }).optional().describe("Metadata tags applied to all ingested chunks")
    }
  },
  async ({ filePaths, collection, tags }) => {
    await ensureCollection(collection);
    const results = [];

    for (const filePath of filePaths) {
      try {
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat || !stat.isFile()) {
          results.push({ file: filePath, status: "skipped", reason: "File not found or not a regular file" });
          continue;
        }
        const buffer = await fs.readFile(filePath);
        const fileName = path.basename(filePath);
        const extracted = await extractDocumentText({ buffer, fileName });
        if (!extracted.text) {
          results.push({ file: filePath, status: "skipped", reason: extracted.warnings.join("; ") || "No text extracted" });
          continue;
        }

        const meta = {
          source: filePath,
          documentType: tags?.documentType ?? "general",
          matter: tags?.matter ?? "",
          custodian: tags?.custodian ?? "",
          assessmentWindow: tags?.assessmentWindow ?? "",
          dateRange: tags?.dateRange ?? ""
        };

        // For .msg and .eml files, extract email metadata for citation-grade payloads
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".msg" || ext === ".eml") {
          const emailMeta = await extractEmailMetadata({ buffer, fileName });
          if (emailMeta) {
            meta.emailFrom = emailMeta.from;
            meta.emailTo = emailMeta.to;
            meta.emailCc = emailMeta.cc;
            meta.emailDate = emailMeta.date;
            meta.emailSubject = emailMeta.subject;
            meta.threadId = emailMeta.threadId;
            meta.documentType = tags?.documentType || "email";
          }
        }

        const chunks = chunkDocument(extracted.text, meta);
        const count = await ingest(collection, chunks);
        results.push({ file: filePath, status: "ingested", chunks: count, emailMetadata: !!meta.emailFrom });
      } catch (err) {
        results.push({ file: filePath, status: "error", error: err.message ?? String(err) });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
    };
  }
);
```

- [ ] **Step 3: Commit**

```bash
git add packages/qdrant-rag-mcp/src/server.js
git commit -m "feat(qdrant-rag): email-aware knowledge_promote with metadata extraction"
```

---

### Task 6: Citations in knowledge_query Results

**Files:**
- Modify: `packages/qdrant-rag-mcp/src/server.js`

- [ ] **Step 1: Add citation import**

Add to the imports at the top of `packages/qdrant-rag-mcp/src/server.js`:

```javascript
import { formatCitation } from "@wcjr/rag/citation";
```

- [ ] **Step 2: Update knowledge_query to include citations**

In the `knowledge_query` handler, update the line that pushes results (currently `allResults.push({ ...r, collection: col });`):

```javascript
          allResults.push({ ...r, collection: col, citation: formatCitation(r) });
```

- [ ] **Step 3: Commit**

```bash
git add packages/qdrant-rag-mcp/src/server.js
git commit -m "feat(qdrant-rag): add pre-formatted citations to knowledge_query results"
```

---

### Task 7: matter_analyse Tool

**Files:**
- Modify: `packages/qdrant-rag-mcp/src/server.js`

- [ ] **Step 1: Add `matter_analyse` tool registration**

Add before the `const transport` line at the end of `packages/qdrant-rag-mcp/src/server.js`:

```javascript
server.registerTool(
  "matter_analyse",
  {
    description:
      "Query a matter's knowledge base and return structured, cited evidence for artefact generation. The tool does NOT produce the artefact — it gathers and formats the evidence. The calling agent uses the results to build chronologies, custodian maps, contested issues analyses, or evidence summaries via the document engines.",
    inputSchema: {
      collection: z.string().min(1).describe("The matter collection to analyse (e.g. 'matter:welbourne')"),
      analysisType: z.enum(["chronology", "custodianMap", "contestedIssues", "evidenceSummary", "custom"]).describe("Type of analysis to gather evidence for"),
      scope: z.object({
        assessmentWindow: z.string().optional(),
        custodian: z.string().optional(),
        documentType: z.string().optional(),
        dateRange: z.string().optional(),
        description: z.string().optional().describe("Free-text scope description for custom analysis")
      }).optional().describe("Metadata filters or free-text description to narrow the evidence scope"),
      limit: z.number().min(10).max(200).default(100).describe("Maximum number of evidence chunks to retrieve")
    }
  },
  async ({ collection, analysisType, scope, limit }) => {
    await ensureCollection(collection);

    // Build query based on analysis type
    const queryMap = {
      chronology: "events, dates, milestones, instructions, notices, delays, completions, extensions of time",
      custodianMap: "correspondence, communications, senders, recipients, key parties, roles",
      contestedIssues: "disputes, claims, disagreements, contested items, positions, arguments, rebuttals",
      evidenceSummary: scope?.description ?? "evidence, facts, contemporaneous records",
      custom: scope?.description ?? "relevant information"
    };

    const query = queryMap[analysisType] ?? queryMap.custom;

    // Build metadata filter from scope
    const filters = {};
    if (scope?.assessmentWindow) filters.assessmentWindow = scope.assessmentWindow;
    if (scope?.custodian) filters.custodian = scope.custodian;
    if (scope?.documentType) filters.documentType = scope.documentType;
    const qdrantFilter = buildQdrantFilter(filters);

    const results = await search(collection, query, { limit, filter: qdrantFilter });

    // Format citations for all results
    const citedResults = results.map((r) => ({
      text: r.text,
      citation: formatCitation(r),
      score: r.score,
      source: r.source,
      documentType: r.documentType,
      matter: r.matter,
      custodian: r.custodian,
      assessmentWindow: r.assessmentWindow,
      emailFrom: r.emailFrom,
      emailTo: r.emailTo,
      emailDate: r.emailDate,
      emailSubject: r.emailSubject
    }));

    // Default output format suggestion
    const formatDefaults = {
      chronology: "xlsx",
      custodianMap: "xlsx",
      contestedIssues: "docx",
      evidenceSummary: "docx",
      custom: "docx"
    };

    return {
      content: [{ type: "text", text: JSON.stringify({
        collection,
        analysisType,
        scope: scope ?? {},
        suggestedFormat: formatDefaults[analysisType],
        resultCount: citedResults.length,
        results: citedResults
      }, null, 2) }]
    };
  }
);
```

- [ ] **Step 2: Commit**

```bash
git add packages/qdrant-rag-mcp/src/server.js
git commit -m "feat(qdrant-rag): add matter_analyse tool for on-demand artefact evidence gathering"
```

---

### Task 8: Orchestrator — Disputes System Prompt and Retrieval Strategy

**Files:**
- Modify: `packages/orchestrator/src/index.js`

- [ ] **Step 1: Add disputes system prompt**

In `packages/orchestrator/src/index.js`, add a new entry to the `ACTIVITY_SYSTEM_PROMPTS` object (after the `project_mgmt` entry, around line 862):

```javascript
  disputes: `You are a forensic disputes analyst and construction claims specialist. Follow this operational sequence:

EVIDENCE GATHERING:
1. CHECK FOR EXPLICIT PATH — if the user provides a file or folder path, read from it directly using filesystem tools. Do not search if a path is given.
2. QUERY KNOWLEDGE BASE — use knowledge_query to search matter collections. Use metadata filters (assessmentWindow, custodian, documentType) to narrow results.
3. SEARCH LOOKEEN — if the knowledge base returns insufficient results, use Lookeen to search across the full 5M+ indexed corpus.
4. PROMOTE RELEVANT FILES — when Lookeen surfaces relevant documents not yet in the knowledge base, use knowledge_promote to ingest them.

EVIDENCE STANDARDS:
5. VERBATIM QUOTES ONLY — every factual assertion must include an exact quote from the source material. Use the citation field from knowledge_query results. Never paraphrase or summarise evidence.
6. CITATION FORMAT — place the citation immediately after every verbatim quote. Example:
   "The delay to the S278 works is acknowledged" [Email: John Smith to William Rogers, 14 March 2024, Subject: "RE: S278 Works"]
7. NO UNSOURCED ASSERTIONS — if you cannot find evidence for a point, say so explicitly. Do not infer or speculate.

ARTEFACT GENERATION:
8. USE MATTER_ANALYSE — when building chronologies, custodian maps, contested issues, or evidence summaries, call matter_analyse first to gather cited evidence.
9. USE DOCUMENT ENGINES — call create_workbook for xlsx artefacts (chronologies, custodian maps) or create_document for docx artefacts (contested issues, evidence summaries).
10. PERSIST SUMMARIES — after generating any artefact, save a structured summary back into the 'artefacts' collection using knowledge_ingest, tagged with the matter name and analysis type.

DATE FORMAT: DD Month YYYY throughout. Never use MM/DD/YYYY or YYYY-MM-DD in user-facing output.

TERMINOLOGY: Use assessment window identifiers (W4, W5a, W5b) exactly as established in the matter. Use contract-defined terms with initial capitals.`
```

- [ ] **Step 2: Update retrieval strategy for disputes**

In `packages/orchestrator/src/index.js`, update the `getRetrievalStrategy` function. Add a check for disputes tasks. In the `default` case (line 101-106), add before the final return:

```javascript
      if (taskType === "disputes" || taskType === "complex") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: true, useRag: true };
```

And in the `case "complex"` block (line 96-99), add before the final return:

```javascript
      if (taskType === "disputes") return { skipRetrieval: false, useWeb: false, useMail: false, useFilesystem: true, useLookeen: true, useRag: true };
```

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/index.js
git commit -m "feat(orchestrator): add disputes system prompt and RAG-aware retrieval strategy"
```

---

### Task 9: Integration Verification

**Files:**
- No new files

- [ ] **Step 1: Verify citation formatter loads via rag package**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && node -e "import { formatCitation } from './packages/rag/src/citation.js'; console.log(formatCitation({ source: 'test.msg', documentType: 'email', emailFrom: 'A', emailTo: 'B', emailDate: '2024-01-01', emailSubject: 'Test' })); console.log('PASS');"`

Expected: `[Email: A to B, 1 January 2024, Subject: "Test"]` then `PASS`.

- [ ] **Step 2: Verify qdrant-rag-mcp server starts**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && timeout 5 node packages/qdrant-rag-mcp/src/server.js 2>&1 || true`

Expected: No output (waiting for stdio), no errors.

- [ ] **Step 3: Verify extractEmailMetadata export**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && node -e "import { extractEmailMetadata } from './packages/document-ingestion/src/index.js'; console.log(typeof extractEmailMetadata); console.log('PASS');"`

Expected: `function` then `PASS`.

- [ ] **Step 4: Verify disputes profile activates in orchestrator**

Run: `cd "d:/WCJR MCP/WCJR-MCP" && node -e "import { getActivityProfile } from './packages/activity-profiles/src/index.js'; const p = getActivityProfile('disputes'); console.log(p.label, p.mcpPresets.includes('qdrantRag'), p.mcpPresets.includes('lookeen')); console.log('PASS');"`

Expected: `Disputes & Forensic true true` then `PASS`.

- [ ] **Step 5: End-to-end test — ingest, query with citations**

Run:
```bash
cd "d:/WCJR MCP/WCJR-MCP" && node -e "
import { ensureCollection, ingest, search, deleteCollection } from './packages/rag/src/index.js';
import { chunkDocument } from './packages/rag/src/chunker.js';
import { formatCitation } from './packages/rag/src/citation.js';

await ensureCollection('test-case-rag');
const chunks = chunkDocument('The delay to the S278 highway works is acknowledged by the Employer.', {
  source: 'test-email.msg',
  documentType: 'email',
  matter: 'welbourne',
  emailFrom: 'John Smith',
  emailTo: 'William Rogers',
  emailDate: '2024-03-14T10:30:00Z',
  emailSubject: 'RE: S278 Works - Programme Update'
});
await ingest('test-case-rag', chunks);
const results = await search('test-case-rag', 'S278 delay');
const r = results[0];
console.log('Citation:', formatCitation(r));
console.log('emailFrom:', r.emailFrom);
console.log('emailDate:', r.emailDate);
await deleteCollection('test-case-rag');
console.log('PASS');
"
```

Expected:
```
Citation: [Email: John Smith to William Rogers, 14 March 2024, Subject: "RE: S278 Works - Programme Update"]
emailFrom: John Smith
emailDate: 2024-03-14T10:30:00Z
PASS
```

- [ ] **Step 6: Commit verification**

```bash
git add -A
git status
```

Expected: No uncommitted changes from our work (only pre-existing unstaged files).

---

## Summary

| Task | Component | What |
|------|-----------|------|
| 1 | Citation formatter | `formatCitation()`, `formatDateDDMonthYYYY()` in `rag/src/citation.js` |
| 2 | RAG enhancements | Batched embeddings, email metadata in payload/indexes/search |
| 3 | Document ingestion | `extractEmailMetadata()` for .msg and .eml files |
| 4 | knowledge_ingest | Progress tracking, resumability, batch size control |
| 5 | knowledge_promote | Email-aware promotion with metadata extraction |
| 6 | knowledge_query | Pre-formatted citations in results |
| 7 | matter_analyse | On-demand artefact evidence gathering tool |
| 8 | Orchestrator | Disputes system prompt, RAG-aware retrieval strategy |
| 9 | Integration | End-to-end verification |
