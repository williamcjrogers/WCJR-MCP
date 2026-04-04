#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next"]);

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
    throw new Error("File-ops MCP server requires a --root argument.");
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

function ensureAllowedPath(requestedPath) {
  const baseRoot = rootPaths[0];
  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(baseRoot, requestedPath);
  if (!allowAnyPath && !getOwningRoot(resolved)) {
    throw new Error("Path is outside the allowed root.");
  }
  return resolved;
}

function toRelative(absolutePath) {
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
  return path.relative(owningRoot, absolutePath) || ".";
}

const server = new McpServer({
  name: "wcjr-file-ops",
  version: "0.1.0"
});

server.registerTool(
  "create_directory",
  {
    description: "Create a directory (and parents) under the configured root, or anywhere when full access is enabled. Use dryRun to preview.",
    inputSchema: {
      path: z.string().describe("Relative path for the new directory."),
      dryRun: z.boolean().optional().default(false)
    }
  },
  async ({ path: relativePath, dryRun }) => {
    const absolutePath = ensureAllowedPath(relativePath);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `[Dry run] Would create directory: ${toRelative(absolutePath)}` }]
      };
    }
    await fs.mkdir(absolutePath, { recursive: true });
    return {
      content: [{ type: "text", text: `Created directory: ${toRelative(absolutePath)}` }]
    };
  }
);

server.registerTool(
  "move_file",
  {
    description: "Move a file or directory under the configured root, or anywhere when full access is enabled. Use dryRun to preview.",
    inputSchema: {
      from: z.string().describe("Current relative path."),
      to: z.string().describe("Destination relative path."),
      dryRun: z.boolean().optional().default(false)
    }
  },
  async ({ from, to, dryRun }) => {
    const fromAbs = ensureAllowedPath(from);
    const toAbs = ensureAllowedPath(to);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `[Dry run] Would move ${toRelative(fromAbs)} -> ${toRelative(toAbs)}` }]
      };
    }
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    return {
      content: [{ type: "text", text: `Moved ${toRelative(fromAbs)} to ${toRelative(toAbs)}` }]
    };
  }
);

server.registerTool(
  "rename_file",
  {
    description: "Rename a file or directory (same parent). Works anywhere when full access is enabled. Use dryRun to preview.",
    inputSchema: {
      path: z.string().describe("Current relative path."),
      newName: z.string().describe("New name (no path)."),
      dryRun: z.boolean().optional().default(false)
    }
  },
  async ({ path: relativePath, newName, dryRun }) => {
    const dir = path.dirname(relativePath);
    const toPath = dir ? path.join(dir, newName) : newName;
    const fromAbs = ensureAllowedPath(relativePath);
    const toAbs = ensureAllowedPath(toPath);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `[Dry run] Would rename ${toRelative(fromAbs)} to ${newName}` }]
      };
    }
    await fs.rename(fromAbs, toAbs);
    return {
      content: [{ type: "text", text: `Renamed to ${toRelative(toAbs)}` }]
    };
  }
);

server.registerTool(
  "delete_file",
  {
    description: "Delete a file or empty directory. Works anywhere when full access is enabled. Use dryRun to preview. Use with caution.",
    inputSchema: {
      path: z.string().describe("Relative path to delete."),
      dryRun: z.boolean().optional().default(false)
    }
  },
  async ({ path: relativePath, dryRun }) => {
    const absolutePath = ensureAllowedPath(relativePath);
    if (dryRun) {
      return {
        content: [{ type: "text", text: `[Dry run] Would delete: ${toRelative(absolutePath)}` }]
      };
    }
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolutePath);
      if (entries.length > 0) {
        throw new Error("Directory is not empty. Delete contents first or use archive instead.");
      }
    }
    await fs.rm(absolutePath);
    return {
      content: [{ type: "text", text: `Deleted: ${toRelative(absolutePath)}` }]
    };
  }
);

async function listFilesRecursive(dirPath, baseDir, maxEntries = 200) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (result.length >= maxEntries) break;
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      result.push({ path: relativePath.replace(/\\/g, "/"), type: "dir" });
      const sub = await listFilesRecursive(fullPath, baseDir, maxEntries - result.length);
      result.push(...sub);
    } else {
      result.push({
        path: relativePath.replace(/\\/g, "/"),
        type: "file",
        ext: path.extname(entry.name).toLowerCase()
      });
    }
  }
  return result;
}

server.registerTool(
  "propose_organization",
  {
    description: "Analyze a folder and propose an organization plan (group by extension or flat). Can inspect any absolute path when full access is enabled.",
    inputSchema: {
      path: z.string().optional().describe("Relative path to analyze (default: root)."),
      strategy: z.enum(["by_extension", "by_month", "flat"]).optional().default("by_extension").describe("Grouping: by_extension, by_month, or flat (list only)."),
      maxEntries: z.number().int().min(10).max(500).optional().default(100)
    }
  },
  async ({ path: relativePath = ".", strategy, maxEntries }) => {
    const baseAbs = ensureAllowedPath(relativePath);
    const stat = await fs.stat(baseAbs);
    if (!stat.isDirectory()) {
      return { content: [{ type: "text", text: "Path is not a directory." }] };
    }
    const files = await listFilesRecursive(baseAbs, baseAbs, maxEntries);
    const fileList = files.filter((f) => f.type === "file");
    if (fileList.length === 0) {
      return {
        content: [{ type: "text", text: `Directory ${toRelative(baseAbs)} is empty or has no files.` }]
      };
    }
    const lines = [`Organization plan for ${toRelative(baseAbs)} (strategy: ${strategy})\n`];
    if (strategy === "by_extension") {
      const byExt = {};
      for (const f of fileList) {
        const ext = f.ext || "(no extension)";
        if (!byExt[ext]) byExt[ext] = [];
        byExt[ext].push(f.path);
      }
      for (const [ext, paths] of Object.entries(byExt).sort()) {
        lines.push(`\n## ${ext}`);
        for (const p of paths.slice(0, 20)) lines.push(`  - ${p}`);
        if (paths.length > 20) lines.push(`  ... and ${paths.length - 20} more`);
      }
      lines.push("\nSuggested: create folders per extension (e.g. pdf/, images/) and use move_file to relocate. Run with dryRun first.");
    } else if (strategy === "by_month") {
      const byMonth = {};
      for (const f of fileList) {
        const name = f.path;
        const match = name.match(/(\d{4})-(\d{2})/);
        const key = match ? `${match[1]}-${match[2]}` : "other";
        if (!byMonth[key]) byMonth[key] = [];
        byMonth[key].push(name);
      }
      for (const [month, paths] of Object.entries(byMonth).sort()) {
        lines.push(`\n## ${month}`);
        for (const p of paths.slice(0, 15)) lines.push(`  - ${p}`);
        if (paths.length > 15) lines.push(`  ... and ${paths.length - 15} more`);
      }
      lines.push("\nSuggested: create folders per month and use move_file. Run with dryRun first.");
    } else {
      lines.push("Files (flat list):");
      for (const f of fileList.slice(0, 50)) lines.push(`  - ${f.path}`);
      if (fileList.length > 50) lines.push(`  ... and ${fileList.length - 50} more`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }]
    };
  }
);

server.registerTool(
  "archive_to_subfolder",
  {
    description: "Move all items in a folder into an Archive subfolder (e.g. Archive/YYYY-MM). Can operate on any absolute path when full access is enabled. Use dryRun to preview.",
    inputSchema: {
      path: z.string().describe("Relative path of the folder to archive."),
      archiveName: z.string().optional().describe("Subfolder name (default: Archive/YYYY-MM)."),
      dryRun: z.boolean().optional().default(false)
    }
  },
  async ({ path: relativePath, archiveName, dryRun }) => {
    const baseAbs = ensureAllowedPath(relativePath);
    const stat = await fs.stat(baseAbs);
    if (!stat.isDirectory()) {
      throw new Error("Path is not a directory.");
    }
    const name = archiveName ?? `Archive/${new Date().toISOString().slice(0, 7)}`;
    const archiveAbs = path.join(baseAbs, name);
    const entries = await fs.readdir(baseAbs, { withFileTypes: true });
    const toMove = entries.filter((e) => e.name !== "Archive" && !e.name.startsWith("."));
    if (toMove.length === 0) {
      return {
        content: [{ type: "text", text: "No items to archive." }]
      };
    }
    if (dryRun) {
      const list = toMove.map((e) => e.name).join(", ");
      return {
        content: [{ type: "text", text: `[Dry run] Would create ${toRelative(archiveAbs)} and move: ${list}` }]
      };
    }
    await fs.mkdir(archiveAbs, { recursive: true });
    for (const entry of toMove) {
      const from = path.join(baseAbs, entry.name);
      const to = path.join(archiveAbs, entry.name);
      await fs.rename(from, to);
    }
    return {
      content: [{ type: "text", text: `Archived ${toMove.length} item(s) to ${toRelative(archiveAbs)}` }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
