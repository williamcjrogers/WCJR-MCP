import test from "node:test";
import assert from "node:assert/strict";
import { buildLessonPrompt, parseLesson, writeLesson } from "./lesson-writer.js";

test("buildLessonPrompt includes task type and outcome", () => {
  const prompt = buildLessonPrompt({
    taskType: "disputes",
    originalGoal: "Summarize exhibits",
    outcome: "success",
    toolsUsed: ["extract_document_text"],
    criticVerdicts: [{ decision: "accept", reasoning: "good" }]
  });
  assert.ok(prompt.includes("disputes"));
  assert.ok(prompt.includes("success"));
  assert.ok(prompt.includes("extract_document_text"));
});

test("parseLesson parses valid JSON", () => {
  const lesson = parseLesson(JSON.stringify({
    taskType: "disputes",
    prompt_gist: "summarize exhibits",
    tools_used: ["extract_document_text"],
    outcome: "success",
    what_worked: ["reading PDFs with maxChars:50000"],
    what_failed: [],
    generalization: "Use maxChars:50000 for exhibit PDFs",
    confidence: 0.8
  }));
  assert.equal(lesson.taskType, "disputes");
  assert.equal(lesson.outcome, "success");
  assert.equal(lesson.confidence, 0.8);
});

test("parseLesson returns null for malformed JSON", () => {
  const lesson = parseLesson("not json");
  assert.equal(lesson, null);
});

test("writeLesson persists to memory store", async () => {
  const written = [];
  const mockMemoryStore = {
    upsert(entry) {
      written.push(entry);
      return { ...entry, id: "mem_test" };
    },
    async save() {}
  };

  await writeLesson({
    memoryStore: mockMemoryStore,
    lesson: {
      taskType: "disputes",
      prompt_gist: "summarize",
      tools_used: ["extract_document_text"],
      outcome: "success",
      what_worked: ["maxChars:50000"],
      what_failed: [],
      generalization: "Use maxChars:50000",
      confidence: 0.8
    }
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].category, "run_lesson");
  assert.ok(written[0].tags.includes("disputes"));
  assert.ok(written[0].tags.includes("extract_document_text"));
  assert.ok(written[0].content.includes("maxChars:50000"));
});

test("writeLesson tolerates lesson missing tools_used", async () => {
  let written = null;
  const mockMemoryStore = {
    upsert(entry) {
      written = entry;
      return { ...entry, id: "mem_test" };
    }
  };

  const result = await writeLesson({
    memoryStore: mockMemoryStore,
    lesson: {
      taskType: "disputes",
      prompt_gist: "summarize",
      // tools_used deliberately omitted
      outcome: "success",
      what_worked: [],
      what_failed: [],
      generalization: "Be concise"
    }
  });

  assert.ok(result, "writeLesson should return an entry");
  assert.deepEqual(written.tags, ["disputes"]);
});

test("writeLesson returns null when memoryStore.upsert throws", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await writeLesson({
      memoryStore: {
        upsert() { throw new Error("store corrupted"); }
      },
      lesson: {
        taskType: "disputes",
        prompt_gist: "summarize",
        tools_used: [],
        outcome: "success",
        what_worked: [],
        what_failed: [],
        generalization: "Be concise"
      }
    });
    assert.equal(result, null);
  } finally {
    console.warn = originalWarn;
  }
});

test("parseLesson returns null when taskType is missing", () => {
  const lesson = parseLesson(JSON.stringify({
    prompt_gist: "summarize",
    outcome: "success"
  }));
  assert.equal(lesson, null);
});

test("buildLessonPrompt includes ARTIFACTS section when provided", () => {
  const prompt = buildLessonPrompt({
    taskType: "disputes",
    originalGoal: "Summarize exhibits",
    outcome: "success",
    toolsUsed: ["create_workbook"],
    criticVerdicts: [],
    artifacts: [
      { path: "/tmp/matter.xlsx", kind: "xlsx", sizeBytes: 12345 }
    ]
  });
  assert.ok(prompt.includes("ARTIFACTS"));
  assert.ok(prompt.includes("matter.xlsx"));
});

test("parseLesson accepts artifacts_produced array", () => {
  const lesson = parseLesson(JSON.stringify({
    taskType: "disputes",
    prompt_gist: "summarize",
    tools_used: ["create_workbook"],
    outcome: "success",
    what_worked: [],
    what_failed: [],
    generalization: "ok",
    confidence: 0.8,
    artifacts_produced: ["/tmp/matter.xlsx"]
  }));
  assert.ok(Array.isArray(lesson.artifacts_produced));
  assert.equal(lesson.artifacts_produced[0], "/tmp/matter.xlsx");
});

test("writeLesson stores artifacts in memory content", async () => {
  let written = null;
  await writeLesson({
    memoryStore: {
      upsert(entry) { written = entry; return { ...entry, id: "mem_test" }; }
    },
    lesson: {
      taskType: "disputes",
      prompt_gist: "summarize",
      tools_used: ["create_workbook"],
      outcome: "success",
      what_worked: [],
      what_failed: [],
      generalization: "ok",
      artifacts_produced: ["/tmp/matter.xlsx", "/tmp/matter.docx"]
    }
  });
  assert.ok(written);
  assert.ok(written.content.includes("Artifacts: /tmp/matter.xlsx, /tmp/matter.docx"));
});
