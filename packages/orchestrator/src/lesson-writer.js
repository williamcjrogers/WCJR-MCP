// packages/orchestrator/src/lesson-writer.js

const LESSON_SYSTEM = `You are summarizing a completed agent run into a structured lesson for future runs of the same task type.

Return strict JSON:
{
  "taskType": "string",
  "prompt_gist": "short paraphrase of what was asked",
  "tools_used": ["tool_name", ...],
  "outcome": "success" | "escalated" | "budget_exhausted" | "failed",
  "what_worked": ["bullet", ...],
  "what_failed": ["bullet", ...],
  "generalization": "one sentence an operator could read and believe",
  "confidence": 0.0-1.0
}
No prose outside JSON.`;

export function buildLessonPrompt({
  taskType,
  originalGoal,
  outcome,
  toolsUsed,
  criticVerdicts,
  planSummary
}) {
  const verdictSummary = (criticVerdicts ?? [])
    .map((v, i) => `Phase ${i + 1}: ${v.decision} (${v.reasoning})`)
    .join("\n");

  return [
    `TASK TYPE: ${taskType}`,
    `GOAL: ${originalGoal}`,
    `OUTCOME: ${outcome}`,
    `TOOLS USED: ${(toolsUsed ?? []).join(", ") || "none"}`,
    planSummary ? `PLAN:\n${planSummary}` : "",
    verdictSummary ? `CRITIC VERDICTS:\n${verdictSummary}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseLesson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  // Extract fenced JSON if present, otherwise use the trimmed raw string.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const cleaned = fenceMatch ? fenceMatch[1].trim() : raw.trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || !parsed.taskType) return null;
    return {
      taskType: String(parsed.taskType),
      prompt_gist: String(parsed.prompt_gist ?? ""),
      tools_used: Array.isArray(parsed.tools_used) ? parsed.tools_used.map(String) : [],
      outcome: String(parsed.outcome ?? "unknown"),
      what_worked: Array.isArray(parsed.what_worked) ? parsed.what_worked.map(String) : [],
      what_failed: Array.isArray(parsed.what_failed) ? parsed.what_failed.map(String) : [],
      generalization: String(parsed.generalization ?? ""),
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5
    };
  } catch {
    return null;
  }
}

export async function writeLesson({ memoryStore, lesson }) {
  if (!memoryStore || !lesson) return null;
  const entry = memoryStore.upsert({
    category: "run_lesson",
    content: [
      `[${lesson.taskType}] ${lesson.prompt_gist}`,
      `Outcome: ${lesson.outcome}`,
      lesson.what_worked.length ? `Worked: ${lesson.what_worked.join("; ")}` : "",
      lesson.what_failed.length ? `Failed: ${lesson.what_failed.join("; ")}` : "",
      `Generalization: ${lesson.generalization}`
    ]
      .filter(Boolean)
      .join("\n"),
    tags: [lesson.taskType, ...lesson.tools_used],
    pinned: false
  });
  if (typeof memoryStore.save === "function") {
    await memoryStore.save();
  }
  return entry;
}

/**
 * Run the lesson-writer model call and persist the result.
 * On failure, logs and returns null — never blocks the task.
 */
export async function generateAndWriteLesson({
  invokeModel,
  lessonModel,
  lessonProvider,
  memoryStore,
  taskType,
  originalGoal,
  outcome,
  toolsUsed,
  criticVerdicts,
  planSummary
}) {
  try {
    const userMessage = buildLessonPrompt({
      taskType,
      originalGoal,
      outcome,
      toolsUsed,
      criticVerdicts,
      planSummary
    });

    const result = await invokeModel({
      providerId: lessonProvider,
      model: lessonModel,
      prompt: userMessage,
      messages: [
        { role: "system", content: LESSON_SYSTEM },
        { role: "user", content: userMessage }
      ],
      taskType,
      skipTools: true,
      suppressStream: true
    });

    const lesson = parseLesson(result?.content);
    if (!lesson) {
      console.warn("[lesson-writer] could not parse lesson from model output");
      return null;
    }

    return await writeLesson({ memoryStore, lesson });
  } catch (err) {
    console.warn("[lesson-writer] failed, skipping:", err?.message ?? err);
    return null;
  }
}
