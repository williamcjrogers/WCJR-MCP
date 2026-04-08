#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureCollection, ingest, search, deleteBySource, listCollections, deleteByFilter, deleteCollection } from "@wcjr/rag";
import { chunkDocument } from "@wcjr/rag/chunker";
import { extractDocumentText, extractEmailMetadata } from "@wcjr/document-ingestion";
import { formatCitation } from "@wcjr/rag/citation";
import fs from "node:fs/promises";
import path from "node:path";

const server = new McpServer({
  name: "wcjr-qdrant-rag",
  version: "0.1.0"
});

server.registerTool(
  "rag_search",
  {
    description: "Search documents by semantic similarity. Returns the top matching chunks from the Qdrant vector store.",
    inputSchema: {
      query: z.string().min(2).describe("Natural language search query"),
      collection: z.string().default("documents").describe("Qdrant collection name"),
      limit: z.number().min(1).max(20).default(5).describe("Maximum number of results to return")
    }
  },
  async ({ query, collection, limit }) => {
    await ensureCollection(collection);
    const results = await search(collection, query, { limit });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
    };
  }
);

server.registerTool(
  "rag_ingest",
  {
    description: "Ingest a text document into the Qdrant RAG vector store. The document is split into overlapping chunks and embedded locally via Ollama.",
    inputSchema: {
      text: z.string().min(1).describe("Full document text to ingest"),
      source: z.string().min(1).describe("Document filename or identifier"),
      collection: z.string().default("documents").describe("Qdrant collection name"),
      documentType: z.string().default("general").describe("Document type (general, legal, technical, etc.)")
    }
  },
  async ({ text, source, collection, documentType }) => {
    await ensureCollection(collection);
    const chunks = chunkDocument(text, { source, documentType });
    const count = await ingest(collection, chunks);
    return {
      content: [{ type: "text", text: `Ingested ${count} chunks from "${source}"` }]
    };
  }
);

server.registerTool(
  "rag_delete",
  {
    description: "Delete all chunks for a given source document from the Qdrant vector store.",
    inputSchema: {
      source: z.string().min(1).describe("Source document identifier to delete"),
      collection: z.string().default("documents").describe("Qdrant collection name")
    }
  },
  async ({ source, collection }) => {
    await ensureCollection(collection);
    await deleteBySource(collection, source);
    return {
      content: [{ type: "text", text: `Deleted all chunks for "${source}"` }]
    };
  }
);

/* ── Helper ─────────────────────────────────────────────────────────── */

function buildQdrantFilter(filters) {
  if (!filters) return undefined;
  const must = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value) must.push({ key, match: { value } });
  }
  return must.length ? { must } : undefined;
}

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

/* ── Knowledge tools ────────────────────────────────────────────────── */

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

server.registerTool(
  "knowledge_query",
  {
    description: "Semantic search across one or more Qdrant collections with optional metadata filters.",
    inputSchema: {
      query: z.string().min(2).describe("Natural language search query"),
      collections: z.array(z.string()).default(["documents"]).describe("Collections to search"),
      filters: z.object({
        matter: z.string().optional(),
        documentType: z.string().optional(),
        custodian: z.string().optional(),
        assessmentWindow: z.string().optional()
      }).optional().describe("Metadata filters to narrow results"),
      limit: z.number().min(1).max(50).default(10).describe("Maximum results per collection"),
      threshold: z.number().optional().describe("Minimum similarity score (0-1)")
    }
  },
  async ({ query, collections, filters, limit, threshold }) => {
    const qdrantFilter = buildQdrantFilter(filters);
    const allResults = [];

    for (const col of collections) {
      try {
        await ensureCollection(col);
        const results = await search(col, query, { limit, filter: qdrantFilter });
        for (const r of results) {
          if (threshold != null && r.score < threshold) continue;
          allResults.push({ ...r, collection: col, citation: formatCitation(r) });
        }
      } catch (err) {
        allResults.push({ collection: col, error: err.message ?? String(err) });
      }
    }

    allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return {
      content: [{ type: "text", text: JSON.stringify(allResults, null, 2) }]
    };
  }
);

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

server.registerTool(
  "knowledge_list",
  {
    description: "List Qdrant collections with point and vector counts.",
    inputSchema: {
      collection: z.string().optional().describe("Filter to a specific collection name")
    }
  },
  async ({ collection }) => {
    const all = await listCollections();
    const filtered = collection ? all.filter((c) => c.name === collection) : all;
    return {
      content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }]
    };
  }
);

server.registerTool(
  "knowledge_delete",
  {
    description: "Delete chunks or an entire collection from Qdrant.",
    inputSchema: {
      collection: z.string().min(1).describe("Qdrant collection name"),
      source: z.string().optional().describe("Delete all chunks matching this source path"),
      filter: z.object({
        matter: z.string().optional(),
        documentType: z.string().optional(),
        custodian: z.string().optional()
      }).optional().describe("Delete chunks matching these metadata filters"),
      deleteEntireCollection: z.boolean().default(false).describe("If true, delete the entire collection")
    }
  },
  async ({ collection, source, filter, deleteEntireCollection: deleteAll }) => {
    if (deleteAll) {
      await deleteCollection(collection);
      return {
        content: [{ type: "text", text: `Deleted entire collection "${collection}"` }]
      };
    }
    if (source) {
      await ensureCollection(collection);
      await deleteBySource(collection, source);
      return {
        content: [{ type: "text", text: `Deleted all chunks for source "${source}" from "${collection}"` }]
      };
    }
    if (filter) {
      const qdrantFilter = buildQdrantFilter(filter);
      if (!qdrantFilter) {
        return {
          content: [{ type: "text", text: "No valid filter fields provided. Nothing deleted." }]
        };
      }
      await ensureCollection(collection);
      await deleteByFilter(collection, qdrantFilter);
      return {
        content: [{ type: "text", text: `Deleted chunks matching filter from "${collection}"` }]
      };
    }
    return {
      content: [{ type: "text", text: "No deletion criteria provided. Specify source, filter, or deleteEntireCollection." }]
    };
  }
);

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

const transport = new StdioServerTransport();
await server.connect(transport);
