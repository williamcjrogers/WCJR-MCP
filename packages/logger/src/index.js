import fs from "node:fs";
import path from "node:path";

/**
 * Zero-dependency structured logger.
 *
 * Writes one JSON object per line to `<logDir>/wcjr-YYYY-MM-DD.jsonl` and
 * mirrors a human-readable line to stderr. The JSONL output is the canonical
 * record — grep / jq it when investigating an issue.
 *
 * Why not pino? The Electron portable build already spends effort keeping the
 * dependency tree small, and we only need a handful of fields. A 100-line
 * custom logger gives us structured + atomic + rolled-by-day at the cost of
 * not supporting fancy transports (which we do not need yet).
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL_NAMES = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
};

let currentLogDir = null;
let currentMinLevel = LEVELS.info;
let consoleMirror = true;
let dirEnsured = false;

function dayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ensureDir(dir) {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    dirEnsured = true;
  } catch {
    // Ignore — we'll drop to console-only.
  }
}

function currentLogFile() {
  if (!currentLogDir) return null;
  ensureDir(currentLogDir);
  return path.join(currentLogDir, `wcjr-${dayKey()}.jsonl`);
}

function formatConsole(record) {
  const ts = record.time ?? new Date().toISOString();
  const level = record.level ?? "info";
  const module = record.module ? `[${record.module}] ` : "";
  const msg = record.msg ?? "";
  const extras = Object.entries(record)
    .filter(([key]) => !["time", "level", "module", "msg"].includes(key))
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${ts} ${level.toUpperCase().padEnd(5)} ${module}${msg}${extras ? ` ${extras}` : ""}`;
}

function emit(level, moduleName, msg, meta) {
  if (level < currentMinLevel) return;
  const record = {
    time: new Date().toISOString(),
    level: LEVEL_NAMES[level] ?? "info",
    module: moduleName,
    msg
  };
  if (meta && typeof meta === "object") {
    for (const [key, value] of Object.entries(meta)) {
      if (key === "time" || key === "level" || key === "module" || key === "msg") continue;
      record[key] = value;
    }
  }
  const line = JSON.stringify(record);
  const filePath = currentLogFile();
  if (filePath) {
    // Sync append keeps the test-harness read-after-write contract simple and
    // costs a few microseconds per call — acceptable for a logger used
    // sparingly in the hot path and heavily elsewhere.
    try { fs.appendFileSync(filePath, `${line}\n`, "utf-8"); } catch {}
  }
  if (consoleMirror) {
    const formatted = formatConsole(record);
    if (level >= LEVELS.warn) {
      // eslint-disable-next-line no-console
      console.error(formatted);
    } else {
      // eslint-disable-next-line no-console
      console.log(formatted);
    }
  }
}

export function configureLogger({ logDir, minLevel = "info", mirrorToConsole = true } = {}) {
  currentLogDir = logDir ?? null;
  currentMinLevel = typeof minLevel === "number" ? minLevel : LEVELS[minLevel] ?? LEVELS.info;
  consoleMirror = mirrorToConsole !== false;
  dirEnsured = false;
}

export function createLogger(moduleName) {
  const named = typeof moduleName === "string" && moduleName.trim() ? moduleName.trim() : "app";
  return {
    trace: (msg, meta) => emit(LEVELS.trace, named, msg, meta),
    debug: (msg, meta) => emit(LEVELS.debug, named, msg, meta),
    info: (msg, meta) => emit(LEVELS.info, named, msg, meta),
    warn: (msg, meta) => emit(LEVELS.warn, named, msg, meta),
    error: (msg, meta) => emit(LEVELS.error, named, msg, meta),
    fatal: (msg, meta) => emit(LEVELS.fatal, named, msg, meta),
    child: (subModule) => createLogger(`${named}:${subModule}`)
  };
}

export function flush() {
  // Writes are synchronous under the hood; nothing to flush. Kept for API
  // symmetry with pino-style loggers.
}

export { LEVELS };
