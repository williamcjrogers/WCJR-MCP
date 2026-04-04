import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryStore } from "./index.js";

test("MemoryStore serializes concurrent saves without losing memories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-memory-store-"));
  const storagePath = path.join(tempDir, "memory.json");
  const store = new MemoryStore({ storagePath });

  store.upsert({ category: "workflow", content: "Review agreements first" });
  store.upsert({ category: "preference", content: "Use manager-style updates" });

  await Promise.all([store.save(), store.save(), store.save()]);

  const raw = await fs.readFile(storagePath, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.memories.length, 2);
});
