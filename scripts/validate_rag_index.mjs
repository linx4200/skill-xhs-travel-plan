#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const REQUIRED_CHUNK_FIELDS = ["chunk_id", "source_uri", "title", "text", "candidate_places", "candidate_cities"];
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]);

function parseArgs(argv) {
  const args = { ragIndex: "" };
  for (const arg of argv) {
    if (!args.ragIndex) args.ragIndex = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.ragIndex) throw new Error("Usage: node scripts/validate_rag_index.mjs <rag-index.json|jsonl>");
  return args;
}

function readIndex(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) throw new Error(`RAG index is empty: ${filePath}`);
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.chunks)) throw new Error("JSON RAG index must contain a chunks array.");
    return { parsed, chunks: parsed.chunks, input_format: "json" };
  }
  const chunks = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
  return { parsed: {}, chunks, input_format: "jsonl" };
}

function countPhotos(resourceRoot) {
  if (!resourceRoot) return { photos_root_exists: false, photo_count: 0 };
  const photosRoot = path.join(resourceRoot, "photos");
  if (!fs.existsSync(photosRoot)) return { photos_root_exists: false, photo_count: 0 };
  let count = 0;
  const stack = [photosRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) count += 1;
    }
  }
  return { photos_root_exists: true, photo_count: count };
}

function validateChunks(chunks) {
  const missingRequiredFields = Object.fromEntries(REQUIRED_CHUNK_FIELDS.map((field) => [field, 0]));
  let chunksWithEmbedding = 0;
  let firstEmbeddingDimensions = 0;
  const candidatePlaces = new Set();
  const candidateCities = new Set();

  for (const chunk of chunks) {
    for (const field of REQUIRED_CHUNK_FIELDS) {
      if (!(field in chunk)) missingRequiredFields[field] += 1;
    }
    if (Array.isArray(chunk.embedding) && chunk.embedding.length) {
      chunksWithEmbedding += 1;
      if (!firstEmbeddingDimensions) firstEmbeddingDimensions = chunk.embedding.length;
    }
    for (const place of Array.isArray(chunk.candidate_places) ? chunk.candidate_places : []) candidatePlaces.add(String(place));
    for (const city of Array.isArray(chunk.candidate_cities) ? chunk.candidate_cities : []) candidateCities.add(String(city));
  }

  return {
    chunk_count: chunks.length,
    chunks_with_embedding: chunksWithEmbedding,
    first_embedding_dimensions: firstEmbeddingDimensions,
    missing_required_fields: missingRequiredFields,
    candidate_place_count: candidatePlaces.size,
    candidate_city_count: candidateCities.size,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.ragIndex);
  const { parsed, chunks, input_format } = readIndex(inputPath);
  const summary = {
    ok: true,
    input_format,
    schema_version: parsed.schema_version ?? null,
    resource_root: parsed.resource_root ?? "",
    embedding_model: parsed.embedding?.model ?? "",
    embedding_dimensions: parsed.embedding?.dimensions ?? null,
    ...validateChunks(chunks),
    ...countPhotos(parsed.resource_root ? String(parsed.resource_root) : ""),
  };
  const missingTotal = Object.values(summary.missing_required_fields).reduce((total, value) => total + value, 0);
  if (missingTotal > 0) summary.ok = false;
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
