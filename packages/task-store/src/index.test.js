import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "./index.js";

function makeTask(id, updatedAt, extra = {}) {
  return {
    id,
    prompt: id,
    status: "completed",
    updatedAt,
    createdAt: updatedAt,
    ...extra
  };
}

test("TaskStore.list sorts tasks before applying limits", () => {
  const store = new TaskStore();
  store.tasks.set("task-old", makeTask("task-old", "2026-03-20T09:00:00.000Z"));
  store.tasks.set("task-new", makeTask("task-new", "2026-03-22T09:00:00.000Z"));
  store.tasks.set("task-mid", makeTask("task-mid", "2026-03-21T09:00:00.000Z"));

  const limited = store.list({ limit: 2 }).map((task) => task.id);

  assert.deepEqual(limited, ["task-new", "task-mid"]);
});

test("TaskStore.getAuditTrail filters by task and returns the newest entries within the limit", () => {
  const store = new TaskStore();
  store.tasks.set("task-a", makeTask("task-a", "2026-03-22T09:00:00.000Z", { audit: [] }));
  store.tasks.set("task-b", makeTask("task-b", "2026-03-22T09:10:00.000Z", { audit: [] }));

  store.appendAuditEntry("task-a", "task_started", { phase: 1 });
  store.appendAuditEntry("task-b", "task_started", { phase: 1 });
  store.appendAuditEntry("task-a", "task_completed", { phase: 2 });

  const audit = store.getAuditTrail({ taskId: "task-a", limit: 2 });

  assert.equal(audit.length, 2);
  assert.equal(audit[0].detail.taskId, "task-a");
  assert.equal(audit[1].action, "task_completed");
});

test("TaskStore.create preserves workflow parent and phase metadata", () => {
  const store = new TaskStore();

  const task = store.create({
    prompt: "Run the workflow",
    taskType: "orchestrator",
    parentTaskId: "task_parent",
    phase: {
      workflowTaskId: "task_parent",
      phaseId: "p2",
      title: "Run tests and verify",
      index: 2,
      total: 3
    },
    workflow: {
      summary: "Review, implement, verify",
      phaseCount: 3,
      phases: [
        { id: "p1", title: "Review sources" },
        { id: "p2", title: "Apply the changes" },
        { id: "p3", title: "Run tests and verify" }
      ]
    }
  });

  assert.equal(task.parentTaskId, "task_parent");
  assert.equal(task.phase.title, "Run tests and verify");
  assert.equal(task.workflow.phaseCount, 3);
});

test("TaskStore.create preserves remote origin metadata", () => {
  const store = new TaskStore();

  const task = store.create({
    prompt: "Review the agreements",
    remoteOrigin: {
      channel: "telegram",
      chatId: 123,
      commandId: "cmd_1"
    }
  });

  assert.deepEqual(task.remoteOrigin, {
    channel: "telegram",
    chatId: 123,
    commandId: "cmd_1"
  });
});

test("TaskStore serializes concurrent saves without corrupting the file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-task-store-"));
  const storagePath = path.join(tempDir, "tasks.json");
  const store = new TaskStore({ storagePath });

  const first = store.create({ prompt: "First task" });
  const second = store.create({ prompt: "Second task" });
  store.update(first.id, { status: "running" });
  store.update(second.id, { status: "completed" });

  await Promise.all([store.save(), store.save(), store.save()]);

  const raw = await fs.readFile(storagePath, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.tasks.length, 2);
  assert.ok(parsed.tasks.some((task) => task.prompt === "First task"));
  assert.ok(parsed.tasks.some((task) => task.prompt === "Second task"));
});

test("TaskStore.create initializes artifacts as an empty array", () => {
  const store = new TaskStore();
  const task = store.create({ prompt: "test", taskType: "disputes" });
  assert.deepEqual(task.artifacts, []);
});

test("TaskStore.update persists artifacts field", () => {
  const store = new TaskStore();
  const task = store.create({ prompt: "test", taskType: "disputes" });
  const artifacts = [{ id: "art_1", path: "/tmp/matter.xlsx", kind: "xlsx", sizeBytes: 100 }];
  const updated = store.update(task.id, { artifacts });
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].path, "/tmp/matter.xlsx");
  const fetched = store.get(task.id);
  assert.equal(fetched.artifacts.length, 1);
});

test("TaskStore.listByType filters by taskType and artifact presence", () => {
  const store = new TaskStore();
  const a = store.create({ prompt: "a", taskType: "disputes" });
  store.update(a.id, { status: "completed", artifacts: [{ id: "x", path: "/tmp/a.xlsx" }] });
  const b = store.create({ prompt: "b", taskType: "disputes" });
  store.update(b.id, { status: "completed" }); // no artifacts
  const c = store.create({ prompt: "c", taskType: "coding" });
  store.update(c.id, { status: "completed", artifacts: [{ id: "y", path: "/tmp/c.xlsx" }] });

  const disputesWithArtifacts = store.listByType("disputes", { withArtifacts: true, status: "completed" });
  assert.equal(disputesWithArtifacts.length, 1);
  assert.equal(disputesWithArtifacts[0].id, a.id);
});

test("TaskStore.listByType respects limit and sorts by updatedAt desc", async () => {
  const store = new TaskStore();
  const first = store.create({ prompt: "first", taskType: "research" });
  store.update(first.id, { status: "completed", artifacts: [{ id: "1" }] });
  // Small delay to ensure updatedAt differs
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = store.create({ prompt: "second", taskType: "research" });
  store.update(second.id, { status: "completed", artifacts: [{ id: "2" }] });

  const list = store.listByType("research", { withArtifacts: true, limit: 1 });
  assert.equal(list.length, 1);
  // Second task was updated later, so it comes first
  assert.equal(list[0].id, second.id);
});
