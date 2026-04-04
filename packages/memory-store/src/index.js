const DEFAULT_MEMORY = {
  id: null,
  category: "general",
  content: "",
  source: null,
  tags: [],
  pinned: false,
  createdAt: null,
  updatedAt: null,
  lastUsedAt: null
};

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalize(text = "") {
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(text = "") {
  return normalize(text)
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 2);
}

function scoreMemory(memory, queryTokens) {
  const haystack = `${memory.category} ${memory.content} ${(memory.tags ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += token.length;
    }
  }
  if (memory.pinned) score += 10;
  if (memory.lastUsedAt) {
    const ageMs = Date.now() - new Date(memory.lastUsedAt).getTime();
    if (Number.isFinite(ageMs)) {
      score += Math.max(0, 5 - Math.min(5, ageMs / (1000 * 60 * 60 * 24 * 30)));
    }
  }
  return score;
}

export class MemoryStore {
  constructor(options = {}) {
    this.storagePath = options.storagePath ?? null;
    this.memories = new Map();
    this.maxMemories = options.maxMemories ?? 500;
    this.saveQueue = Promise.resolve();
  }

  list(options = {}) {
    let items = [...this.memories.values()];
    if (options.category) {
      items = items.filter((memory) => memory.category === options.category);
    }
    if (options.pinned != null) {
      items = items.filter((memory) => memory.pinned === options.pinned);
    }
    items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (options.limit != null) {
      items = items.slice(0, options.limit);
    }
    return items;
  }

  get(memoryId) {
    return this.memories.get(memoryId) ?? null;
  }

  upsert(memory) {
    const normalizedContent = normalize(memory.content);
    const existing = [...this.memories.values()].find(
      (item) => item.category === (memory.category ?? "general") && normalize(item.content) === normalizedContent
    );

    const timestamp = nowIso();
    const next = {
      ...DEFAULT_MEMORY,
      ...(existing ?? {}),
      ...memory,
      id: existing?.id ?? createId(),
      category: memory.category ?? existing?.category ?? "general",
      content: memory.content ?? existing?.content ?? "",
      tags: [...new Set([...(existing?.tags ?? []), ...(memory.tags ?? [])])],
      updatedAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp
    };

    this.memories.set(next.id, next);
    this.prune();
    return next;
  }

  rememberMany(memories = []) {
    return memories.map((memory) => this.upsert(memory));
  }

  search(query, options = {}) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return this.list({ limit: options.limit ?? 10 });
    }

    const scored = [...this.memories.values()]
      .map((memory) => ({ memory, score: scoreMemory(memory, queryTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, options.limit ?? 10).map(({ memory }) => memory);
  }

  markUsed(memoryIds = []) {
    const timestamp = nowIso();
    for (const id of memoryIds) {
      const existing = this.memories.get(id);
      if (!existing) continue;
      this.memories.set(id, {
        ...existing,
        lastUsedAt: timestamp,
        updatedAt: timestamp
      });
    }
  }

  delete(memoryId) {
    return this.memories.delete(memoryId);
  }

  getStats() {
    const memories = [...this.memories.values()];
    const pinned = memories.filter((memory) => memory.pinned).length;
    return {
      count: memories.length,
      pinned
    };
  }

  prune() {
    if (this.memories.size <= this.maxMemories) return;
    const sorted = [...this.memories.entries()].sort(
      (a, b) => new Date(a[1].updatedAt) - new Date(b[1].updatedAt)
    );
    for (const [id] of sorted.slice(0, this.memories.size - this.maxMemories)) {
      this.memories.delete(id);
    }
  }

  async load() {
    if (!this.storagePath) return;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.storagePath, "utf-8");
      const data = JSON.parse(raw);
      this.memories = new Map((data.memories ?? []).map((memory) => [memory.id, memory]));
    } catch {
      // Keep empty state if the file does not exist.
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
          await writeFile(
            this.storagePath,
            JSON.stringify({ memories: [...this.memories.values()] }, null, 2),
            "utf-8"
          );
        } catch (error) {
          console.error("[MemoryStore] save failed:", error.message);
        }
      });
    return this.saveQueue;
  }
}
