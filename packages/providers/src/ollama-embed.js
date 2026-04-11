const BASE = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/**
 * Generate embeddings via Ollama's native embed API.
 * @param {string | string[]} texts - Text(s) to embed.
 * @param {string} model - Embedding model name.
 * @returns {Promise<number[][]>} Array of embedding vectors (768-dim for nomic-embed-text).
 */
export async function embed(texts, model = "nomic-embed-text") {
  const input = Array.isArray(texts) ? texts : [texts];
  const res = await fetch(`${BASE}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.embeddings;
}
