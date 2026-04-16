/**
 * git-ops MCP server
 * Provides: git_status, git_diff, git_log, git_commit, git_branch, git_checkout, git_stash
 *
 * Start: node server.js --repo <repoPath>
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const repoPath = (() => {
  const i = args.indexOf("--repo");
  return i !== -1 ? path.resolve(args[i + 1]) : process.cwd();
})();

function git(gitArgs, cwd = repoPath, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn("git", gitArgs, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); resolve({ ok: false, stdout, stderr: "git command timed out" }); }
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, stdout, stderr: err.message }); }
    });
    child.on("close", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); }
    });
  });
}

function limitOutput(text, maxChars = 40000) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...[truncated, ${text.length - maxChars} chars omitted]`;
}

function result(r) {
  const text = limitOutput([r.stdout, r.stderr].filter(Boolean).join("\n").trim() || "(no output)");
  return { content: [{ type: "text", text }], isError: !r.ok };
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "git-ops", version: "0.1.0" });

server.registerTool("git_status", {
  description: "Show the working tree status of the repository.",
  inputSchema: {
    short: z.boolean().optional().describe("Use short format. Default false.")
  }
}, async ({ short = false }) => {
  const r = await git(short ? ["status", "--short"] : ["status"]);
  return result(r);
});

server.registerTool("git_diff", {
  description: "Show changes between commits, working tree files, or the index.",
  inputSchema: {
    staged: z.boolean().optional().describe("Show staged (index) diff. Default false (working tree)."),
    from: z.string().optional().describe("From commit/branch (optional)."),
    to: z.string().optional().describe("To commit/branch (optional)."),
    path: z.string().optional().describe("Limit diff to this path (optional)."),
    stat: z.boolean().optional().describe("Show diffstat only (no full patch). Default false.")
  }
}, async ({ staged = false, from, to, path: limitPath, stat = false }) => {
  const gitArgs = ["diff"];
  if (stat) gitArgs.push("--stat");
  if (staged) gitArgs.push("--cached");
  if (from) gitArgs.push(from);
  if (to) gitArgs.push(to);
  if (limitPath) gitArgs.push("--", limitPath);
  return result(await git(gitArgs));
});

server.registerTool("git_log", {
  description: "Show commit log.",
  inputSchema: {
    n: z.number().int().positive().max(500).optional().describe("Number of commits to show. Default 20."),
    oneline: z.boolean().optional().describe("Compact one-line format. Default true."),
    branch: z.string().optional().describe("Branch or ref to show log for. Default: current branch."),
    path: z.string().optional().describe("Limit to commits affecting this path.")
  }
}, async ({ n = 20, oneline = true, branch, path: limitPath }) => {
  const gitArgs = ["log", `-${n}`];
  if (oneline) gitArgs.push("--oneline", "--decorate");
  if (branch) gitArgs.push(branch);
  if (limitPath) gitArgs.push("--", limitPath);
  return result(await git(gitArgs));
});

server.registerTool("git_commit", {
  description: "Stage all changes and create a commit.",
  inputSchema: {
    message: z.string().min(1).describe("Commit message (required)."),
    addAll: z.boolean().optional().describe("Run git add -A before committing. Default true."),
    files: z
      .array(z.string())
      .optional()
      .describe("Specific files to stage (if addAll is false).")
  }
}, async ({ message, addAll = true, files = [] }) => {
  if (!message?.trim()) {
    return { content: [{ type: "text", text: "Error: commit message is required." }], isError: true };
  }
  let addResult;
  if (addAll) {
    addResult = await git(["add", "-A"]);
  } else if (files.length) {
    addResult = await git(["add", "--", ...files]);
  }
  if (addResult && !addResult.ok) {
    return result(addResult);
  }
  return result(await git(["commit", "-m", message]));
});

server.registerTool("git_branch", {
  description: "List, create, or delete branches.",
  inputSchema: {
    action: z
      .enum(["list", "create", "delete"])
      .optional()
      .describe("Action to perform. Default 'list'."),
    name: z.string().optional().describe("Branch name (required for create/delete)."),
    force: z.boolean().optional().describe("Force delete. Default false.")
  }
}, async ({ action = "list", name, force = false }) => {
  if (action === "list") return result(await git(["branch", "-a", "--verbose"]));
  if (action === "create") {
    if (!name) return { content: [{ type: "text", text: "Error: branch name required." }], isError: true };
    return result(await git(["checkout", "-b", name]));
  }
  if (action === "delete") {
    if (!name) return { content: [{ type: "text", text: "Error: branch name required." }], isError: true };
    return result(await git(["branch", force ? "-D" : "-d", name]));
  }
  return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
});

server.registerTool("git_checkout", {
  description: "Switch branches or restore working tree files.",
  inputSchema: {
    branch: z.string().min(1).describe("Branch or commit to checkout."),
    createIfMissing: z
      .boolean()
      .optional()
      .describe("Create the branch if it doesn't exist. Default false.")
  }
}, async ({ branch, createIfMissing = false }) => {
  if (!branch) return { content: [{ type: "text", text: "Error: branch/ref required." }], isError: true };
  const gitArgs = createIfMissing ? ["checkout", "-b", branch] : ["checkout", branch];
  return result(await git(gitArgs));
});

server.registerTool("git_stash", {
  description: "Stash or pop working directory changes.",
  inputSchema: {
    action: z
      .enum(["push", "pop", "list", "drop"])
      .optional()
      .describe("Action: push (save), pop (restore), list, drop. Default 'push'."),
    message: z.string().optional().describe("Stash message (for push).")
  }
}, async ({ action = "push", message }) => {
  if (action === "push") {
    const gitArgs = message ? ["stash", "push", "-m", message] : ["stash", "push"];
    return result(await git(gitArgs));
  }
  if (action === "pop") return result(await git(["stash", "pop"]));
  if (action === "list") return result(await git(["stash", "list"]));
  if (action === "drop") return result(await git(["stash", "drop"]));
  return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
