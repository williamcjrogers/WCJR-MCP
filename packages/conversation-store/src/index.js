const DEFAULT_SESSION = {
  id: null,
  title: "New conversation",
  messages: [],
  createdAt: null,
  updatedAt: null
};

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function deriveTitle(text = "") {
  const cleaned = String(text)
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "New conversation";
  }

  return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57)}...`;
}

function buildSummary(session) {
  const lastMessage = session.messages.at(-1);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    lastRole: lastMessage?.role ?? null,
    preview: lastMessage?.content?.slice(0, 120) ?? ""
  };
}

export class ConversationStore {
  constructor(options = {}) {
    this.storagePath = options.storagePath ?? null;
    this.sessions = new Map();
    this.maxSessions = options.maxSessions ?? 100;
    this.maxMessagesPerSession = options.maxMessagesPerSession ?? 200;
    this.saveQueue = Promise.resolve();
  }

  createSession(payload = {}) {
    const id = createId("conv");
    const timestamp = nowIso();
    const session = {
      ...DEFAULT_SESSION,
      id,
      title: payload.title?.trim() || "New conversation",
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.sessions.set(id, session);
    this.prune();
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  listSessions(filters = {}) {
    let sessions = [...this.sessions.values()];
    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (filters.limit != null) {
      sessions = sessions.slice(0, filters.limit);
    }
    return sessions.map(buildSummary);
  }

  setActiveTitle(sessionId, title) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const next = {
      ...session,
      title: title?.trim() || session.title,
      updatedAt: nowIso()
    };
    this.sessions.set(sessionId, next);
    return next;
  }

  appendMessage(sessionId, payload) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const message = {
      id: createId("msg"),
      role: payload.role,
      content: payload.content ?? "",
      createdAt: nowIso(),
      taskId: payload.taskId ?? null,
      toolTrace: Array.isArray(payload.toolTrace) ? payload.toolTrace : [],
      workflowPreview: payload.workflowPreview ?? null
    };

    const messages = [...session.messages, message].slice(-this.maxMessagesPerSession);
    let title = session.title;
    if ((!title || title === "New conversation") && message.role === "user") {
      title = deriveTitle(message.content);
    }

    const next = {
      ...session,
      title,
      messages,
      updatedAt: message.createdAt
    };

    this.sessions.set(sessionId, next);
    return message;
  }

  prune() {
    if (this.sessions.size <= this.maxSessions) return;
    const oldest = [...this.sessions.entries()].sort(
      (a, b) => new Date(a[1].updatedAt) - new Date(b[1].updatedAt)
    );
    const toDelete = oldest.slice(0, this.sessions.size - this.maxSessions);
    for (const [id] of toDelete) {
      this.sessions.delete(id);
    }
  }

  async load() {
    if (!this.storagePath) return;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.storagePath, "utf-8");
      const data = JSON.parse(raw);
      this.sessions = new Map((data.sessions ?? []).map((session) => [session.id, session]));
    } catch {
      // Keep empty in-memory state if file is missing/invalid.
    }
  }

  async save() {
    if (!this.storagePath) return;
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const { writeFile, mkdir } = await import("node:fs/promises");
          const dir = this.storagePath.replace(/[/\\][^/\\]+$/, "");
          await mkdir(dir, { recursive: true });
          const data = {
            sessions: [...this.sessions.values()]
          };
          await writeFile(this.storagePath, JSON.stringify(data, null, 2), "utf-8");
        } catch (error) {
          console.error("[ConversationStore] save failed:", error.message);
        }
      });
    return this.saveQueue;
  }
}
