import fs from "node:fs";
import path from "node:path";

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeChunk(chunk, fallbackId = "") {
  const chunkId = String(chunk?.chunk_id ?? fallbackId).trim();
  return {
    chunk_id: chunkId,
    source_uri: String(chunk?.source_uri ?? ""),
    title: String(chunk?.title ?? ""),
    candidate_places: asList(chunk?.candidate_places).map(String),
    candidate_cities: asList(chunk?.candidate_cities).map(String),
    text: String(chunk?.text ?? ""),
  };
}

function readJsonOrJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) throw new Error(`Evidence source is empty: ${filePath}`);
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    return asList(parsed.chunks).map((chunk, index) => normalizeChunk(chunk, `chunk-${index + 1}`));
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => normalizeChunk(JSON.parse(line), `chunk-${index + 1}`));
}

function readRetrievalWorkspace(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Object.entries(parsed.chunks_by_id ?? {}).map(([chunkId, chunk]) => normalizeChunk(chunk, chunkId));
}

export function loadEvidenceIndex(options = {}) {
  const chunks = [];
  const sources = [];

  if (options.ragIndexPath) {
    chunks.push(...readJsonOrJsonl(options.ragIndexPath));
    sources.push({ type: "rag_index", path: path.resolve(options.ragIndexPath) });
  }
  if (options.retrievalWorkspacePath) {
    chunks.push(...readRetrievalWorkspace(options.retrievalWorkspacePath));
    sources.push({ type: "retrieval_workspace", path: path.resolve(options.retrievalWorkspacePath) });
  }
  if (!sources.length) throw new Error("At least one evidence source is required.");

  const byId = new Map();
  for (const chunk of chunks) {
    if (chunk.chunk_id && !byId.has(chunk.chunk_id)) byId.set(chunk.chunk_id, chunk);
  }
  return {
    schema_version: 1,
    sources,
    chunk_count: byId.size,
    by_id: byId,
  };
}

export function getEvidenceByChunkIds(index, chunkIds) {
  return asList(chunkIds)
    .map((chunkId) => index.by_id.get(String(chunkId)))
    .filter(Boolean);
}

export function verifyEvidenceRefs(checklist, index) {
  const missing = [];
  for (const item of asList(checklist?.items)) {
    for (const chunkId of asList(item.source_chunk_ids)) {
      if (!index.by_id.has(chunkId)) missing.push({ item_id: item.id, chunk_id: chunkId });
    }
    for (const chunkId of asList(item.evidence_ref?.chunk_ids)) {
      if (!index.by_id.has(chunkId)) missing.push({ item_id: item.id, chunk_id: chunkId });
    }
  }
  return missing;
}
