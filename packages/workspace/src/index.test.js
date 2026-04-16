import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverWorkspaceRoot,
  loadWorkspaceFor,
  readWorkspaceConfig
} from "./index.js";

async function seedWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-ws-"));
  const wcjrDir = path.join(root, ".wcjr");
  await fs.mkdir(wcjrDir, { recursive: true });
  await fs.writeFile(
    path.join(wcjrDir, "config.json"),
    JSON.stringify({
      name: "Test workspace",
      defaultModel: "qwen3:14b",
      skillRoots: ["./local-skills"],
      contextFiles: ["CLAUDE.md"],
      notes: "Keep the default stack."
    }),
    "utf-8"
  );
  await fs.mkdir(path.join(root, "local-skills"), { recursive: true });
  await fs.writeFile(
    path.join(root, "CLAUDE.md"),
    "House style: concise, forensic, no fluff.",
    "utf-8"
  );
  await fs.mkdir(path.join(root, "nested", "deep"), { recursive: true });
  return root;
}

test("discoverWorkspaceRoot walks up from a file path to find .wcjr/", async () => {
  const root = await seedWorkspace();
  const found = await discoverWorkspaceRoot(path.join(root, "nested", "deep", "does-not-exist.txt"));
  assert.equal(found, path.resolve(root));
});

test("discoverWorkspaceRoot returns null when no .wcjr marker exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-ws-none-"));
  const found = await discoverWorkspaceRoot(path.join(dir, "anything.txt"));
  assert.equal(found, null);
});

test("readWorkspaceConfig resolves skillRoots and inlines contextFiles", async () => {
  const root = await seedWorkspace();
  const loaded = await readWorkspaceConfig(root);
  assert.equal(loaded.config.defaultModel, "qwen3:14b");
  assert.equal(loaded.resolvedSkillRoots.length, 1);
  assert.equal(loaded.resolvedSkillRoots[0], path.resolve(root, "local-skills"));
  assert.ok(loaded.contextText.includes("WORKSPACE: Test workspace"));
  assert.ok(loaded.contextText.includes("House style"));
  assert.ok(loaded.contextText.includes("Keep the default stack"));
});

test("loadWorkspaceFor returns null on malformed config and does not throw", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-ws-bad-"));
  await fs.mkdir(path.join(root, ".wcjr"), { recursive: true });
  await fs.writeFile(path.join(root, ".wcjr", "config.json"), "{ not json", "utf-8");
  const loaded = await loadWorkspaceFor(path.join(root, "x.txt"));
  assert.equal(loaded, null);
});
