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
