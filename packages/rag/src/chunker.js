import { randomUUID } from "node:crypto";

const DEFAULT_CHUNK_SIZE = 1800; // ~450 tokens at 4 chars/token
const DEFAULT_OVERLAP = 200; // ~50 tokens overlap

const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/**
 * Split a document into overlapping chunks with metadata.
 * Uses section-aware recursive splitting optimised for legal and business documents.
 *
 * @param {string} text - Full document text.
 * @param {{ source?: string, section?: string, page?: number, documentType?: string }} meta
 * @param {{ chunkSize?: number, overlap?: number }} opts
 * @returns {Array<{id: string, text: string, chunkIndex: number, source: string, section: string, page: number, documentType: string}>}
 */
export function chunkDocument(text, meta = {}, opts = {}) {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const chunks = recursiveSplit(text, chunkSize, overlap, SEPARATORS);

  return chunks.map((chunk, i) => ({
    id: randomUUID(),
    text: chunk,
    chunkIndex: i,
    source: meta.source ?? "unknown",
    section: meta.section ?? "",
    page: meta.page ?? 0,
    documentType: meta.documentType ?? "general",
    matter: meta.matter ?? "",
    custodian: meta.custodian ?? "",
    assessmentWindow: meta.assessmentWindow ?? "",
    headingPath: meta.headingPath ?? "",
    dateRange: meta.dateRange ?? ""
  }));
}

function recursiveSplit(text, size, overlap, separators) {
  if (text.length <= size) return [text.trim()].filter(Boolean);

  const sep = separators.find((s) => text.includes(s)) ?? "";
  const parts = text.split(sep);
  const chunks = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length > size && current) {
      chunks.push(current.trim());
      // Overlap: keep the tail of the previous chunk
      const tail = current.slice(-overlap);
      current = tail + sep + part;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
