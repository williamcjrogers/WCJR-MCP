import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configureLogger, createLogger, flush } from "./index.js";

test("createLogger writes a JSONL line per call to the configured log dir", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-logger-"));
  configureLogger({ logDir: dir, minLevel: "debug", mirrorToConsole: false });
  const log = createLogger("test");
  log.info("hello", { taskId: "t1" });
  log.error("boom", { code: 500 });
  flush();

  const files = await fs.readdir(dir);
  assert.equal(files.length, 1, "should produce one JSONL file");
  const text = await fs.readFile(path.join(dir, files[0]), "utf-8");
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].module, "test");
  assert.equal(lines[0].msg, "hello");
  assert.equal(lines[0].taskId, "t1");
  assert.equal(lines[1].level, "error");
  assert.equal(lines[1].code, 500);
});

test("minLevel filters lower-priority messages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-logger-filter-"));
  configureLogger({ logDir: dir, minLevel: "warn", mirrorToConsole: false });
  const log = createLogger("filter");
  log.debug("below-threshold");
  log.warn("visible");
  flush();

  const files = await fs.readdir(dir);
  const text = await fs.readFile(path.join(dir, files[0]), "utf-8");
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, "visible");
});

test("child logger namespaces the module field", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-logger-child-"));
  configureLogger({ logDir: dir, minLevel: "info", mirrorToConsole: false });
  const root = createLogger("parent");
  const child = root.child("section");
  child.info("hello");
  flush();

  const files = await fs.readdir(dir);
  const text = await fs.readFile(path.join(dir, files[0]), "utf-8");
  const parsed = JSON.parse(text.trim());
  assert.equal(parsed.module, "parent:section");
});
