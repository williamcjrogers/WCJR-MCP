import { QdrantClient } from "@qdrant/js-client-rest";
import { embed } from "../../providers/src/ollama-embed.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const VECTOR_SIZE = 768;

const qdrant = new QdrantClient({ url: QDRANT_URL });

/**
 * Ensure a Qdrant collection exists with the correct vector config and indexes.
 * @param {string} name - Collection name.
 */
export async function ensureCollection(name) {
  const { collections } = await qdrant.getCollections();
  if (collections.some((c) => c.name === name)) return;

  await qdrant.createCollection(name, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" }
  });

  const indexFields = ["source", "documentType", "matter", "custodian", "assessmentWindow"];
  for (const field_name of indexFields) {
    await qdrant.createPayloadIndex(name, {
      field_name,
      field_schema: "keyword"
    });
  }
}

/**
 * Embed and upsert document chunks into a Qdrant collection.
 * @param {string} collection - Collection name.
 * @param {Array<{id: string, text: string, source: string, section?: string, page?: number, documentType?: string, chunkIndex?: number}>} chunks
 * @returns {Promise<number>} Number of points upserted.
 */
export async function ingest(collection, chunks) {
  const texts = chunks.map((c) => c.text);
  const embeddings = await embed(texts);

  const points = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: embeddings[i],
    payload: {
      text: chunk.text,
      source: chunk.source,
      section: chunk.section ?? "",
      page: chunk.page ?? 0,
      documentType: chunk.documentType ?? "general",
      chunkIndex: chunk.chunkIndex ?? i,
      matter: chunk.matter ?? "",
      custodian: chunk.custodian ?? "",
      assessmentWindow: chunk.assessmentWindow ?? "",
      headingPath: chunk.headingPath ?? "",
      dateRange: chunk.dateRange ?? ""
    }
  }));

  // Batch upsert in groups of 100
  for (let i = 0; i < points.length; i += 100) {
    await qdrant.upsert(collection, {
      wait: true,
      points: points.slice(i, i + 100)
    });
  }
  return points.length;
}

/**
 * Semantic search over a Qdrant collection.
 * @param {string} collection - Collection name.
 * @param {string} query - Natural language search query.
 * @param {{ limit?: number, filter?: object }} options
 * @returns {Promise<Array<{score: number, text: string, source: string, section: string, page: number}>>}
 */
export async function search(collection, query, { limit = 5, filter } = {}) {
  const [queryVector] = await embed(query);
  const result = await qdrant.query(collection, {
    query: queryVector,
    limit,
    with_payload: true,
    ...(filter && { filter })
  });

  return result.points.map((p) => ({
    score: p.score,
    text: p.payload.text,
    source: p.payload.source,
    section: p.payload.section,
    page: p.payload.page,
    documentType: p.payload.documentType ?? "",
    matter: p.payload.matter ?? "",
    custodian: p.payload.custodian ?? "",
    assessmentWindow: p.payload.assessmentWindow ?? "",
    headingPath: p.payload.headingPath ?? ""
  }));
}

/**
 * Delete all chunks for a given source document.
 * @param {string} collection - Collection name.
 * @param {string} source - Source document identifier.
 */
export async function deleteBySource(collection, source) {
  await qdrant.delete(collection, {
    filter: { must: [{ key: "source", match: { value: source } }] }
  });
}

/**
 * List all Qdrant collections with point/vector counts.
 * @returns {Promise<Array<{name: string, pointsCount: number, vectorsCount: number}>>}
 */
export async function listCollections() {
  const { collections } = await qdrant.getCollections();
  const result = [];
  for (const col of collections) {
    const info = await qdrant.getCollection(col.name);
    result.push({ name: col.name, pointsCount: info.points_count ?? 0, vectorsCount: info.vectors_count ?? 0 });
  }
  return result;
}

/**
 * Delete points from a collection using a Qdrant filter.
 * @param {string} collection - Collection name.
 * @param {object} filter - Qdrant filter object.
 */
export async function deleteByFilter(collection, filter) {
  await qdrant.delete(collection, { filter });
}

/**
 * Delete an entire Qdrant collection.
 * @param {string} collection - Collection name.
 */
export async function deleteCollection(collection) {
  await qdrant.deleteCollection(collection);
}
