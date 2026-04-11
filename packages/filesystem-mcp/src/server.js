#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { extractDocumentText } from "@wcjr/document-ingestion";
import { z } from "zod";

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next"
]);
const MAX_WALK_DEPTH = 20;

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cfg",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

function getRootPaths() {
  const args = process.argv.slice(2);
  const roots = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) {
      roots.push(path.resolve(args[index + 1]));
      index += 1;
    }
  }
  if (roots.length === 0) {
    throw new Error("The filesystem MCP server requires a --root argument.");
  }
  return roots;
}

const rootPaths = getRootPaths();
const rootPrefixes = rootPaths.map((rootPath) => ({
  rootPath,
  rootPrefix: rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
}));
const allowAnyPath = process.argv.includes("--allow-any-path");

function getOwningRoot(resolvedPath) {
  return rootPrefixes.find(
    ({ rootPath, rootPrefix }) => resolvedPath === rootPath || resolvedPath.startsWith(rootPrefix)
  )?.rootPath ?? null;
}

function ensureAllowedPath(requestedPath = ".") {
  const baseRoot = rootPaths[0];
  const resolvedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(baseRoot, requestedPath);

  if (!allowAnyPath && !getOwningRoot(resolvedPath)) {
    throw new Error("Requested path is outside the allowed root directory.");
  }

  return resolvedPath;
}

function toRelativePath(absolutePath) {
  if (allowAnyPath) {
    return absolutePath;
  }
  const owningRoot = getOwningRoot(absolutePath);
  if (!owningRoot) {
    return absolutePath;
  }
  if (rootPaths.length > 1) {
    return absolutePath;
  }
  const relativePath = path.relative(owningRoot, absolutePath);
  return relativePath || ".";
}

function formatDirectoryListing(basePath, entries) {
  if (entries.length === 0) {
    return `Directory ${basePath} is empty.`;
  }

  return [
    `Directory: ${basePath}`,
    ...entries.map((entry) => {
      const entryType = entry.isDirectory() ? "DIR " : "FILE";
      return `${entryType} ${entry.name}`;
    })
  ].join("\n");
}

async function readTextFileSafe(filePath, maxChars = 16000) {
  const absolutePath = ensureAllowedPath(filePath);
  const content = await fs.readFile(absolutePath, "utf-8");
  if (content.length <= maxChars) {
    return content;
  }

  const omittedChars = content.length - maxChars;
  return `${content.slice(0, maxChars)}\n\n[truncated ${omittedChars} characters]`;
}

async function walkFiles(startPath, collector, depth = 0) {
  if (depth > MAX_WALK_DEPTH) {
    return false;
  }
  const entries = await fs.readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      const shouldStop = await walkFiles(absolutePath, collector, depth + 1);
      if (shouldStop) {
        return true;
      }
      continue;
    }

    if (entry.isFile()) {
      const shouldStop = await collector(absolutePath);
      if (shouldStop) {
        return true;
      }
    }
  }
  return false;
}

function buildSnippet(text, matchIndex, query) {
  const snippetRadius = 140;
  const start = Math.max(0, matchIndex - snippetRadius);
  const end = Math.min(text.length, matchIndex + query.length + snippetRadius);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

async function searchTextInFiles(startPath, query, maxResults) {
  const loweredQuery = query.toLowerCase();
  const results = [];
  const startRoots =
    startPath === "." && !allowAnyPath
      ? rootPaths
      : [ensureAllowedPath(startPath)];

  for (const absoluteStart of startRoots) {
    const shouldStop = await walkFiles(absoluteStart, async (absolutePath) => {
      if (results.length >= maxResults) {
        return true;
      }

      const extension = path.extname(absolutePath).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) {
        return false;
      }

      try {
        const content = await fs.readFile(absolutePath, "utf-8");
        const matchIndex = content.toLowerCase().indexOf(loweredQuery);
        if (matchIndex === -1) {
          return false;
        }

        results.push({
          path: toRelativePath(absolutePath),
          snippet: buildSnippet(content, matchIndex, query)
        });
        return results.length >= maxResults;
      } catch {
        // Ignore unreadable files while searching.
        return false;
      }
    });
    if (shouldStop || results.length >= maxResults) {
      break;
    }
  }

  if (results.length === 0) {
    const scope = startPath === "." && !allowAnyPath ? rootPaths.join(", ") : startPath;
    return `No matches found for "${query}" under ${scope}.`;
  }

  return [
    `Search query: ${query}`,
    ...results.map((result, index) => `${index + 1}. ${result.path}\n   ${result.snippet}`)
  ].join("\n");
}

async function findFilesByName(startPath, query, maxResults) {
  const loweredQuery = query.toLowerCase();
  const matches = [];
  const startRoots =
    startPath === "." && !allowAnyPath
      ? rootPaths
      : [ensureAllowedPath(startPath)];

  for (const absoluteStart of startRoots) {
    const shouldStop = await walkFiles(absoluteStart, async (absolutePath) => {
      if (matches.length >= maxResults) {
        return true;
      }

      const relativePath = toRelativePath(absolutePath);
      const candidate = relativePath.toLowerCase();
      if (!candidate.includes(loweredQuery)) {
        return false;
      }

      matches.push({
        path: relativePath
      });
      return matches.length >= maxResults;
    });
    if (shouldStop || matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

const server = new McpServer({
  name: "wcjr-filesystem",
  version: "0.1.0"
});

server.registerTool(
  "list_directory",
  {
    description: "List directories and files under the configured root path, or anywhere when full access is enabled.",
    inputSchema: {
      path: z.string().optional().describe("Absolute or relative path inside the allowed root.")
    }
  },
  async ({ path: requestedPath = "." }) => {
    if (requestedPath === "." && rootPaths.length > 1 && !allowAnyPath) {
      return {
        content: [
          {
            type: "text",
            text: [
              "Allowed roots:",
              ...rootPaths.map((root, index) => `${index + 1}. ${root}`)
            ].join("\n")
          }
        ]
      };
    }
    const absolutePath = ensureAllowedPath(requestedPath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    return {
      content: [
        {
          type: "text",
          text: formatDirectoryListing(toRelativePath(absolutePath), entries)
        }
      ]
    };
  }
);

server.registerTool(
  "read_text_file",
  {
    description: "Read a text file within the configured root path, or any absolute path when full access is enabled.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to a text file inside the allowed root."),
      maxChars: z.number().int().min(100).max(50000).optional().describe("Maximum characters to return.")
    }
  },
  async ({ path: requestedPath, maxChars = 16000 }) => {
    const text = await readTextFileSafe(requestedPath, maxChars);
    return {
      content: [
        {
          type: "text",
          text: `File: ${requestedPath}\n\n${text}`
        }
      ]
    };
  }
);

server.registerTool(
  "search_text_in_files",
  {
    description: "Search text files within the configured root path for a query string, or across any absolute path when full access is enabled.",
    inputSchema: {
      query: z.string().min(2).describe("Text to search for."),
      path: z.string().optional().describe("Optional path inside the allowed root to limit the search."),
      maxResults: z.number().int().min(1).max(20).optional().describe("Maximum number of matching files to return.")
    }
  },
  async ({ query, path: requestedPath = ".", maxResults = 8 }) => {
    const text = await searchTextInFiles(requestedPath, query, maxResults);
    return {
      content: [
        {
          type: "text",
          text
        }
      ]
    };
  }
);

server.registerTool(
  "find_files_by_name",
  {
    description: "Search files by filename/path match within the configured root path, including binary documents like PDF and DOCX.",
    inputSchema: {
      query: z.string().min(2).describe("Case-insensitive text to match against filenames and relative paths."),
      path: z.string().optional().describe("Optional path inside the allowed root to limit the search."),
      maxResults: z.number().int().min(1).max(30).optional().describe("Maximum number of matching files to return.")
    }
  },
  async ({ query, path: requestedPath = ".", maxResults = 10 }) => {
    const matches = await findFilesByName(requestedPath, query, maxResults);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              matches
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.registerTool(
  "extract_document_text",
  {
    description: "Extract readable text from a local file. Supports text, XLSX, XLS, DOCX, PDF, CSV, and common image formats via OCR.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path to the file inside the allowed root."),
      maxChars: z.number().int().min(500).max(500000).optional().describe("Maximum characters to return.")
    }
  },
  async ({ path: requestedPath, maxChars = 50000 }) => {
    const absolutePath = ensureAllowedPath(requestedPath);
    const buffer = await fs.readFile(absolutePath);
    const result = await extractDocumentText({
      buffer,
      fileName: absolutePath,
      maxChars
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              path: toRelativePath(absolutePath),
              kind: result.kind,
              method: result.method,
              truncated: result.truncated,
              warnings: result.warnings,
              text: result.text
            },
            null,
            2
          )
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();

// ── write_text_file ───────────────────────────────────────────────────────────
server.registerTool(
  "write_text_file",
  {
    description: "Write or overwrite a UTF-8 text file within the allowed root path. Creates parent directories automatically.",
    inputSchema: {
      path: { type: "string", description: "File path (relative to root or absolute within allowed root)." },
      content: { type: "string", description: "Full text content to write." },
      dryRun: { type: "boolean", description: "If true, validates path but does not write. Default false." }
    }
  },
  async ({ path: requestedPath, content, dryRun }) => {
    const absolutePath = ensureAllowedPath(requestedPath);
    if (dryRun) {
      return { content: [{ type: "text", text: `[Dry run] Would write ${content?.length ?? 0} chars to: ${toRelativePath(absolutePath)}` }] };
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content ?? "", "utf-8");
    return { content: [{ type: "text", text: `Written ${(content ?? "").length} chars to: ${toRelativePath(absolutePath)}` }] };
  }
);

await server.connect(transport);
