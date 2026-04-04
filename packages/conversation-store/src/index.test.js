import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConversationStore } from "./index.js";

test("ConversationStore persists tool traces on assistant messages", () => {
  const store = new ConversationStore();
  const session = store.createSession({ title: "Investigation" });

  const message = store.appendMessage(session.id, {
    role: "assistant",
    content: "Here is what I found.",
    taskId: "task_123",
    toolTrace: [
      {
        id: "call_1",
        server: "Local Filesystem",
        tool: "read_text_file",
        status: "completed",
        resultPreview: "notes.txt"
      }
    ]
  });

  assert.equal(message.toolTrace.length, 1);
  assert.equal(store.getSession(session.id).messages[0].toolTrace[0].tool, "read_text_file");
});

test("ConversationStore defaults missing tool traces to an empty array", () => {
  const store = new ConversationStore();
  const session = store.createSession();

  const message = store.appendMessage(session.id, {
    role: "user",
    content: "Hello"
  });

  assert.deepEqual(message.toolTrace, []);
});

test("ConversationStore persists workflow previews on assistant messages", () => {
  const store = new ConversationStore();
  const session = store.createSession({ title: "Workflow" });

  const message = store.appendMessage(session.id, {
    role: "assistant",
    content: "Workflow ready.",
    workflowPreview: {
      summary: "Review agreement and draft amendments",
      phaseCount: 2,
      phases: [
        { id: "p1", title: "Review sources", activity: "research" },
        { id: "p2", title: "Amend the draft", activity: "documents", dependsOn: ["p1"] }
      ]
    }
  });

  assert.equal(message.workflowPreview.phaseCount, 2);
  assert.equal(store.getSession(session.id).messages[0].workflowPreview.phases[1].title, "Amend the draft");
});

test("ConversationStore serializes concurrent saves without losing messages", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-conversation-store-"));
  const storagePath = path.join(tempDir, "conversations.json");
  const store = new ConversationStore({ storagePath });
  const session = store.createSession({ title: "Concurrent" });

  store.appendMessage(session.id, { role: "user", content: "Message one" });
  store.appendMessage(session.id, { role: "assistant", content: "Message two" });

  await Promise.all([store.save(), store.save(), store.save()]);

  const raw = await fs.readFile(storagePath, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].messages.length, 2);
});
