#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureCollection, ingest, search, deleteBySource, listCollections, deleteByFilter, deleteCollection } from "@wcjr/rag";
import { chunkDocument } from "@wcjr/rag/chunker";
import { extractDocumentText } from "@wcjr/document-ingestion";
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

/* ── Knowledge tools ────────────────────────────────────────────────── */

server.registerTool(
  "knowledge_ingest",
  {
    description: "Ingest a file or directory into a Qdrant collection. Supports PDF, DOCX, XLSX, images (OCR), HTML, plain text, PST, and MSG files.",
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
      chunkOverlap: z.number().default(200).describe("Overlap between chunks in characters")
    }
  },
  async ({ source, collection, tags, recursive, chunkOverlap }) => {
    await ensureCollection(collection);
    const stat = await fs.stat(source);
    const errors = [];
    let filesProcessed = 0;
    let totalChunks = 0;

    async function processFile(filePath) {
      try {
        const buffer = await fs.readFile(filePath);
        const fileName = path.basename(filePath);
        const result = await extractDocumentText({ buffer, fileName });
        if (!result.text) {
          errors.push({ file: filePath, error: result.warnings.join("; ") || "No text extracted" });
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
        const count = await ingest(collection, chunks);
        totalChunks += count;
        filesProcessed++;
      } catch (err) {
        errors.push({ file: filePath, error: err.message ?? String(err) });
      }
    }

    async function walkDir(dirPath) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && recursive) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          await processFile(fullPath);
        }
      }
    }

    if (stat.isDirectory()) {
      await walkDir(source);
    } else {
      await processFile(source);
    }

    const output = { collection, filesProcessed, chunksCreated: totalChunks, errors };
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
          allResults.push({ ...r, collection: col });
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
    description: "Promote files from search results (or any file paths) into a Qdrant collection.",
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
        const chunks = chunkDocument(extracted.text, meta);
        const count = await ingest(collection, chunks);
        results.push({ file: filePath, status: "ingested", chunks: count });
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

const transport = new StdioServerTransport();
await server.connect(transport);
