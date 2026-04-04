/**
 * Patches the latest fully working release-fresh build in-place
 * with all our source improvements. This avoids the new-unsigned-binary issue.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// Find the most recent release-fresh that is complete (has WCJR Assistant.exe)
const candidates = fs.readdirSync(ROOT)
  .filter(d => d.match(/^release-fresh\d*$/))
  .sort((a, b) => {
    const na = parseInt(a.replace("release-fresh", "") || "0");
    const nb = parseInt(b.replace("release-fresh", "") || "0");
    return nb - na;
  });

let targetRelease = null;
for (const c of candidates) {
  const exe = path.join(ROOT, c, "win-unpacked", "WCJR Assistant.exe");
  const appPath = path.join(ROOT, c, "win-unpacked", "resources", "app");
  if (fs.existsSync(exe) && fs.existsSync(appPath)) {
    targetRelease = path.join(ROOT, c, "win-unpacked", "resources", "app");
    console.log(`Using: ${c}`);
    break;
  }
}

if (!targetRelease) {
  console.error("No suitable release found");
  process.exit(1);
}

function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`✓ ${path.relative(ROOT, dest)}`);
}

function patchFile(filePath, patchFn) {
  if (!fs.existsSync(filePath)) { console.log("skip (not found):", filePath); return; }
  const src = fs.readFileSync(filePath, "utf-8");
  const result = patchFn(src);
  if (result === src) { console.log(`~ ${path.basename(filePath)} (no change)`); return; }
  fs.writeFileSync(filePath, result, "utf-8");
  console.log(`✓ patched: ${path.basename(filePath)}`);
}

// The key files to update in the release
const appSrc = ROOT; // source root

// 1. Copy improved package source files
const filesToCopy = [
  ["packages/providers/src/anthropic.js", "packages/providers/src/anthropic.js"],
  ["packages/providers/src/gemini.js", "packages/providers/src/gemini.js"],
  ["packages/providers/src/openai-compat.js", "packages/providers/src/openai-compat.js"],
  ["packages/providers/src/index.js", "packages/providers/src/index.js"],
  ["packages/filesystem-mcp/src/server.js", "packages/filesystem-mcp/src/server.js"],
  ["packages/mcp-hub/src/index.js", "packages/mcp-hub/src/index.js"],
  ["packages/policy-engine/src/index.js", "packages/policy-engine/src/index.js"],
  ["packages/tool-loop/src/index.js", "packages/tool-loop/src/index.js"],
  ["packages/orchestrator/src/index.js", "packages/orchestrator/src/index.js"],
  ["packages/activity-profiles/src/index.js", "packages/activity-profiles/src/index.js"],
  ["apps/desktop/renderer.js", "apps/desktop/renderer.js"],
];

for (const [srcRel, destRel] of filesToCopy) {
  const srcFile = path.join(appSrc, srcRel);
  const destFile = path.join(targetRelease, destRel);
  if (fs.existsSync(srcFile)) {
    copyFile(srcFile, destFile);
  }
}

// 2. Copy new packages (shell-exec, git-ops)
for (const pkg of ["shell-exec", "git-ops"]) {
  for (const f of ["package.json", "src/server.js"]) {
    const src = path.join(appSrc, "packages", pkg, f);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(targetRelease, "packages", pkg, f));
    }
  }
}

// 3. Fix main.js - copy our improved version but fix the electron import
const mainSrc = path.join(appSrc, "apps/desktop/main.js");
const mainDest = path.join(targetRelease, "apps/desktop/main.js");
let mainContent = fs.readFileSync(mainSrc, "utf-8");
// Ensure named import from "electron"
const lines = mainContent.split("\n");
if (lines[0].includes("electron")) {
  lines[0] = 'import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";';
  if (lines[1].includes("= electron;")) lines.splice(1, 1);
}
mainContent = lines.join("\n");
fs.writeFileSync(mainDest, mainContent, "utf-8");
console.log(`✓ apps/desktop/main.js (with electron import fix)`);

// 4. Fix preload.js
const preloadDest = path.join(targetRelease, "apps/desktop/preload.js");
patchFile(preloadDest, (s) => {
  const l = s.split("\n");
  if (l[0].includes("electron/renderer") || l[0].includes("createRequire")) {
    l[0] = 'import { contextBridge, ipcRenderer } from "electron";';
    if (l[1] && l[1].includes("= electron;")) l.splice(1, 1);
  }
  return l.join("\n");
});

// 5. Print the target dir
const targetExe = path.join(path.dirname(targetRelease), "..", "WCJR Assistant.exe");
const actualExe = path.join(ROOT, candidates[0], "win-unpacked", "WCJR Assistant.exe");
console.log("\n✅ Done. Launch:");
console.log(actualExe);
