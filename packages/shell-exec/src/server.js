/**
 * shell-exec MCP server
 * Provides: run_command, run_script, kill_process
 *
 * Start: node server.js --cwd <workingDir> [--allowed-cwd <dir1> --allowed-cwd <dir2>]
 * env SHELL_EXEC_ALLOWED_CWD=<dir> can also be used.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cwdArg = (() => {
  const i = args.indexOf("--cwd");
  return i !== -1 ? args[i + 1] : process.cwd();
})();
const allowedCwds = (() => {
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allowed-cwd" && args[i + 1]) dirs.push(path.resolve(args[i + 1]));
  }
  if (process.env.SHELL_EXEC_ALLOWED_CWD) dirs.push(path.resolve(process.env.SHELL_EXEC_ALLOWED_CWD));
  if (cwdArg) dirs.push(path.resolve(cwdArg));
  return dirs.length ? dirs : [path.resolve(cwdArg || process.cwd())];
})();

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_CHARS = 50000;

// ── Running processes registry ────────────────────────────────────────────────
const runningProcesses = new Map(); // pid → child

function isAllowedCwd(requestedCwd) {
  const resolved = path.resolve(requestedCwd);
  return allowedCwds.some((allowed) => resolved === allowed || resolved.startsWith(allowed + path.sep));
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...[truncated, ${text.length - max} chars omitted]`;
}

function runProcess(command, cmdArgs, cwd, timeoutMs, onStdout, { useShell = false } = {}) {
  return new Promise((resolve) => {
    // shell:true routes args through cmd.exe on Windows and a POSIX shell
    // elsewhere, which would let model-supplied args containing `&`, `|`,
    // `>`, `^` execute extra commands. Default to shell:false so the command
    // is resolved and invoked directly via the OS exec call. `run_script`
    // opts in explicitly because it intentionally takes multi-line shell
    // snippets.
    const child = spawn(command, cmdArgs, {
      cwd,
      windowsHide: true,
      shell: useShell
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const pid = child.pid;
    if (pid) runningProcesses.set(pid, child);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        if (pid) runningProcesses.delete(pid);
        resolve({ code: -1, stdout: truncate(stdout), stderr: truncate(stderr), timedOut: true, pid });
      }
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (pid) runningProcesses.delete(pid);
        resolve({ code: -1, stdout: truncate(stdout), stderr: err.message, timedOut: false, pid });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (pid) runningProcesses.delete(pid);
        resolve({ code: code ?? 0, stdout: truncate(stdout), stderr: truncate(stderr), timedOut: false, pid });
      }
    });
  });
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "shell-exec",
  version: "0.1.0"
});

server.registerTool(
  "run_command",
  {
    description: [
      "Execute a shell command in a specified working directory and return stdout + stderr.",
      "The cwd must be within the allowed working directories configured at startup.",
      "Args are passed directly to the executable (no shell interpretation) —",
      "shell metacharacters in `args` are not interpreted. Use run_script for that.",
      "For long-running commands, set timeoutSeconds (default 60, max 300).",
      "Returns: { stdout, stderr, exitCode, timedOut }."
    ].join(" "),
    inputSchema: {
      command: z
        .string()
        .min(1)
        .describe("The executable to run (e.g. 'node', 'npm', 'python')."),
      args: z
        .array(z.string())
        .optional()
        .describe("Arguments to pass to the command."),
      cwd: z
        .string()
        .optional()
        .describe(
          `Working directory for the command. Must be within allowed dirs: ${allowedCwds.join(", ")}.`
        ),
      timeoutSeconds: z
        .number()
        .int()
        .positive()
        .max(300)
        .optional()
        .describe("Timeout in seconds. Default 60, max 300.")
    }
  },
  async ({ command, args: cmdArgs = [], cwd, timeoutSeconds = 60 }) => {
    const workDir = path.resolve(cwd ?? allowedCwds[0]);
    if (!isAllowedCwd(workDir)) {
      return {
        content: [{
          type: "text",
          text: `Error: cwd '${workDir}' is not within allowed directories:\n${allowedCwds.join("\n")}`
        }],
        isError: true
      };
    }
    const timeoutMs = Math.min(Math.max((timeoutSeconds ?? 60) * 1000, 5000), 300000);
    const result = await runProcess(command, cmdArgs, workDir, timeoutMs);
    const summary = [
      `Exit code: ${result.code}${result.timedOut ? " (timed out)" : ""}`,
      result.stdout ? `\nSTDOUT:\n${result.stdout}` : "",
      result.stderr ? `\nSTDERR:\n${result.stderr}` : ""
    ].join("").trim();
    return {
      content: [{ type: "text", text: summary || "(no output)" }],
      isError: result.code !== 0
    };
  }
);

server.registerTool(
  "run_script",
  {
    description: "Run a multi-line shell script. The script runs inside the chosen shell (cmd/pwsh/bash) so shell metacharacters ARE interpreted — use run_command when you need literal argument passing without interpretation.",
    inputSchema: {
      script: z.string().min(1).describe("Multi-line shell script content."),
      cwd: z.string().optional().describe("Working directory."),
      shell: z
        .enum(["cmd", "powershell", "pwsh", "bash", "sh"])
        .optional()
        .describe("Shell to use. Defaults to platform default (cmd on Windows, sh elsewhere)."),
      timeoutSeconds: z
        .number()
        .int()
        .positive()
        .max(300)
        .optional()
        .describe("Timeout in seconds. Default 120, max 300.")
    }
  },
  async ({ script, cwd, shell: shellChoice, timeoutSeconds = 120 }) => {
    const workDir = path.resolve(cwd ?? allowedCwds[0]);
    if (!isAllowedCwd(workDir)) {
      return {
        content: [{ type: "text", text: `Error: cwd '${workDir}' not allowed.` }],
        isError: true
      };
    }
    const timeoutMs = Math.min((timeoutSeconds ?? 120) * 1000, 300000);
    let command, cmdArgs;
    if (process.platform === "win32") {
      if (shellChoice === "powershell" || shellChoice === "pwsh") {
        command = "pwsh";
        cmdArgs = ["-NoProfile", "-NoLogo", "-Command", script];
      } else {
        command = "cmd";
        cmdArgs = ["/C", script];
      }
    } else {
      command = shellChoice === "bash" ? "bash" : "sh";
      cmdArgs = ["-c", script];
    }
    // run_script intentionally runs inside a shell — that's the whole point.
    const result = await runProcess(command, cmdArgs, workDir, timeoutMs, undefined, { useShell: false });
    const summary = [
      `Exit code: ${result.code}${result.timedOut ? " (timed out)" : ""}`,
      result.stdout ? `\nSTDOUT:\n${result.stdout}` : "",
      result.stderr ? `\nSTDERR:\n${result.stderr}` : ""
    ].join("").trim();
    return {
      content: [{ type: "text", text: summary || "(no output)" }],
      isError: result.code !== 0
    };
  }
);

server.registerTool(
  "kill_process",
  {
    description: "Kill a running process by PID. Use to stop a timed-out or runaway command.",
    inputSchema: {
      pid: z.number().int().positive().describe("Process ID to kill.")
    }
  },
  async ({ pid }) => {
    const child = runningProcesses.get(pid);
    if (!child) {
      return { content: [{ type: "text", text: `No tracked process with PID ${pid}.` }] };
    }
    child.kill("SIGTERM");
    runningProcesses.delete(pid);
    return { content: [{ type: "text", text: `Process ${pid} sent SIGTERM.` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
