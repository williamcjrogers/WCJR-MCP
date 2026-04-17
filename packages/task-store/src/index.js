/**
 * Persistent task store for the operations assistant.
 * Supports task records, progress states, resumable work units, and audit trail.
 */

import { parseCronExpression, nextCronRun } from "./cron.js";

async function writeFileAtomic(storagePath, contents) {
  const { writeFile, rename, mkdir, unlink } = await import("node:fs/promises");
  const dir = storagePath.replace(/[/\\][^/\\]+$/, "");
  await mkdir(dir, { recursive: true });
  const tmpPath = `${storagePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, contents, "utf-8");
    await rename(tmpPath, storagePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch {}
    throw err;
  }
}

const DEFAULT_TASK = {
  id: null,
  parentTaskId: null,
  status: "pending",
  prompt: "",
  taskType: null,
  runMode: "direct",
  remoteOrigin: null,
  phase: null,
  workflow: null,
  steps: [],
  progress: { current: 0, total: 0, message: null },
  pendingExecutionPlan: null,
  result: null,
  error: null,
  timeline: [],
  agentRuns: [],
  toolActivity: [],
  toolTrace: [],
  artifacts: [],
  audit: [],
  // Ambient scheduling (optional): when non-null the task is a recurring
  // template rather than a one-shot run. The scheduler polls for templates
  // whose nextRunAt is due and spawns a fresh child task per execution.
  schedule: null,
  createdAt: null,
  updatedAt: null,
  completedAt: null
};

export const TASK_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  AWAITING_APPROVAL: "awaiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  SCHEDULED: "scheduled"
};

/**
 * Given the current time, return the next time a schedule should fire.
 *   { type: "interval", intervalMs }   - simple cadence
 *   { type: "cron", expr: "* * * * *" } - 5-field POSIX cron
 *
 * Returns ISO-8601 string or null when the schedule is disabled / unknown.
 */
export function computeNextRunAt(schedule, now = new Date()) {
  if (!schedule || schedule.enabled === false) return null;
  const base = now instanceof Date ? now : new Date(now);
  if (schedule.type === "interval" && Number.isFinite(schedule.intervalMs)) {
    return new Date(base.getTime() + schedule.intervalMs).toISOString();
  }
  if (schedule.type === "cron" && typeof schedule.expr === "string") {
    try {
      const parsed = parseCronExpression(schedule.expr);
      const next = nextCronRun(parsed, base);
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

export { parseCronExpression, nextCronRun } from "./cron.js";

/**
 * In-memory task store with optional persistence.
 * When storagePath is provided, tasks are persisted to JSON; otherwise in-memory only.
 */
export class TaskStore {
  constructor(options = {}) {
    this.storagePath = options.storagePath ?? null;
    this.tasks = new Map();
    this.auditLog = [];
    this.maxAuditEntries = options.maxAuditEntries ?? 5000;
    this.maxTasks = options.maxTasks ?? 500;
    this.saveQueue = Promise.resolve();
  }

  _generateId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  create(payload) {
    const id = this._generateId();
    const now = new Date().toISOString();
    const task = {
      ...DEFAULT_TASK,
      id,
      parentTaskId: payload.parentTaskId ?? null,
      prompt: payload.prompt ?? "",
      taskType: payload.taskType ?? null,
      runMode: payload.runMode ?? "direct",
      remoteOrigin: payload.remoteOrigin ?? null,
      phase: payload.phase ?? null,
      workflow: payload.workflow ?? null,
      steps: payload.steps ?? [],
      progress: payload.progress ?? { current: 0, total: 0, message: null },
      createdAt: now,
      updatedAt: now
    };
    this.tasks.set(id, task);
    this._appendAudit("task_created", { taskId: id, prompt: task.prompt });
    this._prune();
    return task;
  }

  get(taskId) {
    return this.tasks.get(taskId) ?? null;
  }

  list(filters = {}) {
    let list = [...this.tasks.values()];
    if (filters.status) {
      list = list.filter((t) => t.status === filters.status);
    }
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (filters.limit != null) {
      list = list.slice(0, filters.limit);
    }
    return list;
  }

  listByType(taskType, filters = {}) {
    let list = [...this.tasks.values()].filter((t) => t.taskType === taskType);
    if (filters.status) {
      list = list.filter((t) => t.status === filters.status);
    }
    if (filters.withArtifacts) {
      list = list.filter((t) => Array.isArray(t.artifacts) && t.artifacts.length > 0);
    }
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (filters.limit != null) {
      list = list.slice(0, filters.limit);
    }
    return list;
  }

  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const now = new Date().toISOString();
    const next = {
      ...task,
      ...updates,
      updatedAt: now
    };
    if (updates.status === TASK_STATUS.COMPLETED || updates.status === TASK_STATUS.FAILED) {
      next.completedAt = now;
    }
    this.tasks.set(taskId, next);
    if (updates.status != null) {
      this._appendAudit("task_status", { taskId, status: updates.status });
    }
    if (updates.progress != null) {
      this._appendAudit("task_progress", { taskId, progress: updates.progress });
    }
    return next;
  }

  appendStep(taskId, step) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const steps = [...(task.steps ?? []), { ...step, at: new Date().toISOString() }];
    return this.update(taskId, { steps });
  }

  appendAuditEntry(taskId, action, detail = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const audit = [...(task.audit ?? []), { action, detail, at: new Date().toISOString() }];
    this._appendAudit(action, { taskId, ...detail });
    return this.update(taskId, { audit });
  }

  _appendAudit(action, detail) {
    this.auditLog.push({ action, detail, at: new Date().toISOString() });
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.maxAuditEntries);
    }
  }

  getAuditTrail(filters = {}) {
    let log = [...this.auditLog];
    if (filters.taskId) {
      log = log.filter((e) => e.detail?.taskId === filters.taskId);
    }
    if (filters.action) {
      log = log.filter((e) => e.action === filters.action);
    }
    if (filters.limit != null) {
      log = log.slice(-filters.limit);
    }
    return log;
  }

  _prune() {
    if (this.tasks.size <= this.maxTasks) return;
    const byDate = [...this.tasks.entries()].sort(
      (a, b) => new Date(a[1].updatedAt) - new Date(b[1].updatedAt)
    );
    const toRemove = byDate.slice(0, this.tasks.size - this.maxTasks);
    for (const [id] of toRemove) {
      this.tasks.delete(id);
    }
  }

  async load() {
    if (!this.storagePath) return;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.storagePath, "utf-8");
      const data = JSON.parse(raw);
      this.tasks = new Map((data.tasks ?? []).map((t) => [t.id, t]));
      this.auditLog = data.auditLog ?? [];
    } catch {
      // No file or invalid; keep in-memory state
    }
  }

  async save() {
    if (!this.storagePath) return;
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const data = {
            tasks: [...this.tasks.values()],
            auditLog: this.auditLog
          };
          await writeFileAtomic(this.storagePath, JSON.stringify(data, null, 2));
        } catch (err) {
          console.error("[TaskStore] save failed:", err.message);
        }
      });
    return this.saveQueue;
  }
}
