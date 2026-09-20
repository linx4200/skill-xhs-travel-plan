import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getEvidenceByChunkIds,
  loadEvidenceIndex,
  verifyEvidenceRefs,
} from "../../scripts/assessment/rag-tuning/lib/evidence_access.mjs";

test("evidence access loads rag-index chunks by id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-evidence-test-"));
  const ragIndexPath = path.join(dir, "rag-index.json");
  fs.writeFileSync(
    ragIndexPath,
    JSON.stringify({
      chunks: [
        {
          chunk_id: "chunk-1",
          source_uri: "resources/a.md",
          title: "A",
          text: "证据正文",
          candidate_places: ["A地方"],
          candidate_cities: [],
        },
      ],
    }),
    "utf8",
  );

  const index = loadEvidenceIndex({ ragIndexPath });
  const evidence = getEvidenceByChunkIds(index, ["chunk-1", "missing"]);

  assert.equal(index.chunk_count, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].text, "证据正文");
});

test("evidence access can use retrieval workspace chunks_by_id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-retrieval-evidence-test-"));
  const retrievalWorkspacePath = path.join(dir, "retrieval-workspace.json");
  fs.writeFileSync(
    retrievalWorkspacePath,
    JSON.stringify({
      chunks_by_id: {
        "chunk-1": {
          source_uri: "resources/a.md",
          title: "A",
          text: "证据正文",
          candidate_places: ["A地方"],
          candidate_cities: [],
        },
      },
    }),
    "utf8",
  );

  const index = loadEvidenceIndex({ retrievalWorkspacePath });
  assert.equal(getEvidenceByChunkIds(index, ["chunk-1"])[0].chunk_id, "chunk-1");
});

test("verifyEvidenceRefs reports missing chunk ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-missing-evidence-test-"));
  const retrievalWorkspacePath = path.join(dir, "retrieval-workspace.json");
  fs.writeFileSync(retrievalWorkspacePath, JSON.stringify({ chunks_by_id: {} }), "utf8");
  const index = loadEvidenceIndex({ retrievalWorkspacePath });

  const missing = verifyEvidenceRefs(
    {
      items: [
        {
          id: "B1-place-0001",
          source_chunk_ids: ["missing"],
          evidence_ref: { chunk_ids: ["missing"] },
        },
      ],
    },
    index,
  );

  assert.deepEqual(missing, [
    { item_id: "B1-place-0001", chunk_id: "missing" },
    { item_id: "B1-place-0001", chunk_id: "missing" },
  ]);
});
