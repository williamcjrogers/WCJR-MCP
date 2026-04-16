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

test("MemoryStore.prune keeps pinned entries when capacity is exceeded", () => {
  const store = new MemoryStore({ maxMemories: 3 });
  store.upsert({ content: "pin-1", pinned: true });
  store.upsert({ content: "pin-2", pinned: true });
  // Add 5 unpinned, oldest first.
  for (let i = 0; i < 5; i += 1) {
    store.upsert({ content: `unpinned-${i}` });
  }

  const all = store.list({});
  const pinnedRemaining = all.filter((m) => m.pinned);
  assert.equal(pinnedRemaining.length, 2, "pinned memories should survive pruning");
  assert.ok(all.length <= 3 + pinnedRemaining.length, "prune should not evict pinned entries");
});

test("MemoryStore.save writes atomically and does not leave .tmp files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-memory-atomic-"));
  const storagePath = path.join(tempDir, "memory.json");
  const store = new MemoryStore({ storagePath });
  store.upsert({ content: "hello" });
  await store.save();
  const files = await fs.readdir(tempDir);
  assert.deepEqual(files, ["memory.json"], "no .tmp leftovers");
});
