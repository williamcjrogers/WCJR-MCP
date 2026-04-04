#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as XLSX from "xlsx";

function getRootPath() {
  const args = process.argv.slice(2);
  const rootFlagIndex = args.indexOf("--root");
  if (rootFlagIndex === -1 || !args[rootFlagIndex + 1]) {
    throw new Error("The document-ops MCP server requires a --root argument (output directory).");
  }
  return path.resolve(args[rootFlagIndex + 1]);
}

const rootPath = getRootPath();
const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;

function ensureAllowedPath(requestedPath) {
  const normalized = requestedPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const resolvedPath = path.resolve(rootPath, normalized);
  if (resolvedPath !== rootPath && !resolvedPath.startsWith(rootPrefix)) {
    throw new Error("Requested path is outside the allowed output root.");
  }
  return resolvedPath;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

const server = new McpServer({
  name: "wcjr-document-ops",
  version: "0.1.0"
});

server.registerTool(
  "write_markdown",
  {
    description: "Write Markdown content to a file under the document output root. Creates parent directories if needed.",
    inputSchema: {
      path: z.string().describe("Relative path for the .md file (e.g. reports/weekly-summary.md)."),
      content: z.string().describe("Full Markdown content to write.")
    }
  },
  async ({ path: relativePath, content }) => {
    const ext = path.extname(relativePath).toLowerCase();
    const filePath = ext === ".md" ? ensureAllowedPath(relativePath) : ensureAllowedPath(relativePath + ".md");
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, "utf-8");
    return {
      content: [{ type: "text", text: `Wrote Markdown to ${path.relative(rootPath, filePath)}.` }]
    };
  }
);

server.registerTool(
  "write_report",
  {
    description: "Write a structured report as Markdown with optional title and sections. Good for summaries and deliverables.",
    inputSchema: {
      path: z.string().describe("Relative path for the report file (e.g. reports/2025-Q1-summary.md)."),
      title: z.string().optional().describe("Report title."),
      sections: z.array(z.object({
        heading: z.string(),
        content: z.string()
      })).describe("Report sections with heading and content."),
      frontMatter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Optional YAML front matter key-value pairs.")
    }
  },
  async ({ path: relativePath, title, sections, frontMatter }) => {
    const filePath = path.extname(relativePath).toLowerCase() === ".md"
      ? ensureAllowedPath(relativePath)
      : ensureAllowedPath(relativePath + ".md");
    await ensureDir(path.dirname(filePath));

    const parts = [];
    if (frontMatter && Object.keys(frontMatter).length > 0) {
      parts.push("---");
      for (const [k, v] of Object.entries(frontMatter)) {
        parts.push(`${k}: ${typeof v === "string" ? `"${String(v).replace(/"/g, '\\"')}"` : v}`);
      }
      parts.push("---");
      parts.push("");
    }
    if (title) {
      parts.push(`# ${title}`);
      parts.push("");
    }
    for (const { heading, content } of sections || []) {
      parts.push(`## ${heading}`);
      parts.push("");
      parts.push(content.trim());
      parts.push("");
    }
    const content = parts.join("\n").trimEnd() + "\n";
    await fs.writeFile(filePath, content, "utf-8");
    return {
      content: [{ type: "text", text: `Wrote report (${(sections ?? []).length} sections) to ${path.relative(rootPath, filePath)}.` }]
    };
  }
);

server.registerTool(
  "export_csv",
  {
    description: "Export tabular data to a CSV file under the document output root.",
    inputSchema: {
      path: z.string().describe("Relative path for the .csv file (e.g. exports/data.csv)."),
      rows: z.array(z.union([
        z.array(z.union([z.string(), z.number(), z.boolean()])),
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      ])).describe("Array of rows. Each row is either an array of values or an object (keys become headers if first row)."),
      headers: z.array(z.string()).optional().describe("Optional column headers when rows are arrays.")
    }
  },
  async ({ path: relativePath, rows, headers }) => {
    const filePath = path.extname(relativePath).toLowerCase() === ".csv"
      ? ensureAllowedPath(relativePath)
      : ensureAllowedPath(relativePath + ".csv");
    await ensureDir(path.dirname(filePath));

    const isObjectRows = rows.length > 0 && typeof rows[0] === "object" && !Array.isArray(rows[0]);
    let csvLines = [];
    if (isObjectRows) {
      const allKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const headerLine = allKeys.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(",");
      csvLines.push(headerLine);
      for (const row of rows) {
        const values = allKeys.map((k) => {
          const v = row[k];
          if (v == null) return "";
          const s = String(v);
          return `"${s.replace(/"/g, '""')}"`;
        });
        csvLines.push(values.join(","));
      }
    } else {
      if (headers?.length) {
        csvLines.push(headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(","));
      }
      for (const row of rows) {
        const values = (row ?? []).map((v) => `"${String(v).replace(/"/g, '""')}"`);
        csvLines.push(values.join(","));
      }
    }
    await fs.writeFile(filePath, csvLines.join("\n"), "utf-8");
    return {
      content: [{ type: "text", text: `Exported ${rows.length} row(s) to ${path.relative(rootPath, filePath)}.` }]
    };
  }
);

server.registerTool(
  "export_xlsx",
  {
    description: "Export tabular data to an XLSX file under the document output root. Can create multiple sheets.",
    inputSchema: {
      path: z.string().describe("Relative path for the .xlsx file (e.g. exports/data.xlsx)."),
      sheets: z.array(z.object({
        name: z.string().describe("Sheet name."),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("Array of rows; first row can be headers."),
        headers: z.array(z.string()).optional().describe("Optional column headers (if not provided, first row is treated as headers).")
      })).min(1).describe("One or more sheets with name and rows.")
    }
  },
  async ({ path: relativePath, sheets }) => {
    const filePath = path.extname(relativePath).toLowerCase() === ".xlsx"
      ? ensureAllowedPath(relativePath)
      : ensureAllowedPath(relativePath + ".xlsx");
    await ensureDir(path.dirname(filePath));

    const workbook = XLSX.utils.book_new();
    for (const { name, rows, headers } of sheets) {
      const data = headers?.length
        ? [headers, ...rows]
        : rows;
      const worksheet = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, worksheet, name.slice(0, 31));
    }
    XLSX.writeFile(workbook, filePath);
    return {
      content: [{ type: "text", text: `Exported ${sheets.length} sheet(s) to ${path.relative(rootPath, filePath)}.` }]
    };
  }
);

server.registerTool(
  "list_output_dir",
  {
    description: "List files and folders under the document output root (e.g. to see existing reports).",
    inputSchema: {
      path: z.string().optional().describe("Relative path under the output root (default: root).")
    }
  },
  async ({ path: relativePath = "." }) => {
    const dirPath = ensureAllowedPath(relativePath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const lines = entries.map((e) => (e.isDirectory() ? "DIR  " : "FILE ") + e.name);
    return {
      content: [{ type: "text", text: `Directory: ${path.relative(rootPath, dirPath)}\n\n${lines.join("\n")}` }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
