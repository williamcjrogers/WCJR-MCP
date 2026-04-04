#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function getConfigPath() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (configIndex === -1 || !args[configIndex + 1]) {
    throw new Error("Desktop Commander requires --config <path>.");
  }
  return path.resolve(args[configIndex + 1]);
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    return JSON.parse(raw).desktopCommander ?? {};
  } catch {
    return {};
  }
}

function runPowerShell(command, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Desktop Commander command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function resolveConfiguredApp(config = {}, alias) {
  const apps = config.apps ?? {};
  if (apps[alias]?.path) {
    return {
      alias,
      path: apps[alias].path,
      displayName: apps[alias].displayName ?? alias
    };
  }
  throw new Error(`Application '${alias}' is not a configured desktop alias.`);
}

async function resolveApp(aliasOrPath) {
  const config = await loadConfig();
  return resolveConfiguredApp(config, aliasOrPath);
}

const server = new McpServer({
  name: "wcjr-desktop-commander",
  version: "0.1.0"
});

server.registerTool(
  "list_processes",
  {
    description: "List running Windows processes, optionally filtering by process name or title.",
    inputSchema: {
      filter: z.string().optional().describe("Optional filter text for process name or window title.")
    }
  },
  async ({ filter }) => {
    const script = `
      $items = Get-Process | Select-Object ProcessName, Id, MainWindowTitle, Path
      ${filter ? `$items = $items | Where-Object { $_.ProcessName -match ${quotePs(filter)} -or $_.MainWindowTitle -match ${quotePs(filter)} }` : ""}
      $items | ConvertTo-Json -Depth 3
    `;
    const result = await runPowerShell(script);
    if (result.code !== 0) {
      throw new Error(result.stderr || "Failed to list processes.");
    }
    return {
      content: [{ type: "text", text: result.stdout || "[]" }]
    };
  }
);

server.registerTool(
  "launch_application",
  {
    description: "Launch a configured Windows application by alias. Supports configured aliases such as 'lookeen' or 'outlook'.",
    inputSchema: {
      app: z.string().describe("Configured application alias."),
      args: z.array(z.string()).optional().describe("Optional command-line arguments.")
    }
  },
  async ({ app, args = [] }) => {
    const resolved = await resolveApp(app);
    await fs.access(resolved.path);
    const quotedArgs = args.map((arg) => quotePs(arg)).join(", ");
    const argPart = args.length ? ` -ArgumentList @(${quotedArgs})` : "";
    const script = `Start-Process -FilePath ${quotePs(resolved.path)}${argPart}`;
    const result = await runPowerShell(script);
    if (result.code !== 0) {
      throw new Error(result.stderr || `Failed to launch ${resolved.displayName}.`);
    }
    return {
      content: [{ type: "text", text: `Launched ${resolved.displayName}.` }]
    };
  }
);

server.registerTool(
  "is_application_running",
  {
    description: "Check whether a configured application is currently running by alias.",
    inputSchema: {
      app: z.string().describe("Configured application alias.")
    }
  },
  async ({ app }) => {
    const resolved = await resolveApp(app);
    const processName = path.basename(resolved.path, path.extname(resolved.path)) || app;
    const script = `
      $items = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -ieq ${quotePs(processName)} }
      $items | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Depth 3
    `;
    const result = await runPowerShell(script);
    if (result.code !== 0) {
      throw new Error(result.stderr || `Failed to check ${resolved.displayName}.`);
    }
    return {
      content: [{ type: "text", text: result.stdout || "[]" }]
    };
  }
);

server.registerTool(
  "open_path_in_explorer",
  {
    description: "Open a file or folder in Windows Explorer.",
    inputSchema: {
      path: z.string().describe("Path to open in Explorer.")
    }
  },
  async ({ path: targetPath }) => {
    const result = await runPowerShell(`Start-Process explorer.exe ${quotePs(targetPath)}`);
    if (result.code !== 0) {
      throw new Error(result.stderr || `Failed to open ${targetPath}.`);
    }
    return {
      content: [{ type: "text", text: `Opened ${targetPath} in Explorer.` }]
    };
  }
);

server.registerTool(
  "read_clipboard",
  {
    description: "Read the current Windows clipboard text.",
    inputSchema: {}
  },
  async () => {
    const result = await runPowerShell("Get-Clipboard");
    if (result.code !== 0) {
      throw new Error(result.stderr || "Failed to read clipboard.");
    }
    return {
      content: [{ type: "text", text: result.stdout || "" }]
    };
  }
);

server.registerTool(
  "write_clipboard",
  {
    description: "Write text to the Windows clipboard.",
    inputSchema: {
      text: z.string().describe("Text to copy to clipboard.")
    }
  },
  async ({ text }) => {
    const result = await runPowerShell(`Set-Clipboard -Value ${quotePs(text)}`);
    if (result.code !== 0) {
      throw new Error(result.stderr || "Failed to write clipboard.");
    }
    return {
      content: [{ type: "text", text: "Clipboard updated." }]
    };
  }
);

export async function startDesktopCommanderServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  await startDesktopCommanderServer();
}
