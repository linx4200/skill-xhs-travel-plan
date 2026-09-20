import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeChunkRetrieval } from "../../scripts/assessment/rag-tuning/lib/attribution.mjs";

function item(overrides = {}) {
  return {
    id: "B1-place-001",
    target_type: "place",
    target_name: "A地方",
    theme: "tickets",
    criticality: "critical",
    ...overrides,
  };
}

function request(chunk, overrides = {}) {
  return {
    target_type: "place",
    target_name: "A地方",
    theme: "tickets",
    top_k: 2,
    chunks: [chunk],
    ...overrides,
  };
}

test("chunk present in target theme is retrieved", () => {
  const result = attributeChunkRetrieval({
    item: item(),
    chunkId: "ticket-1",
    retrievalWorkspace: {
      places: {
        A地方: {
          unique_chunk_ids: ["ticket-1"],
          themes: {
            tickets: [{ chunk_id: "ticket-1" }],
          },
        },
      },
    },
    retrievalLog: null,
  });

  assert.equal(result.retrieved, true);
  assert.equal(result.attribution_code, "theme_selected");
});

test("selected log row outside reading pool maps to quota_dropped when quota recorded it", () => {
  const result = attributeChunkRetrieval({
    item: item(),
    chunkId: "ticket-2",
    retrievalWorkspace: {
      places: {
        A地方: {
          unique_chunk_ids: [],
          retrieval_quota: {
            dropped_by_theme: {
              tickets: 1,
            },
          },
          themes: {
            tickets: [],
          },
        },
      },
    },
    retrievalLog: {
      requests: [
        request({
          chunk_id: "ticket-2",
          recall_status: "selected",
          score: { total: 0.9 },
        }),
      ],
    },
  });

  assert.equal(result.retrieved, false);
  assert.equal(result.attribution_code, "quota_dropped");
});

test("day and global items can be retained by chunks_by_id without direct target themes", () => {
  const result = attributeChunkRetrieval({
    item: item({
      target_type: "day",
      target_name: "day-01",
      theme: "routes",
    }),
    chunkId: "route-1",
    retrievalWorkspace: {
      chunks_by_id: {
        "route-1": {
          text: "当天路线证据。",
        },
      },
    },
    retrievalLog: null,
  });

  assert.equal(result.retrieved, true);
  assert.equal(result.attribution_code, "target_selected");
});

test("rerank-filtered row maps to rerank_drop", () => {
  const result = attributeChunkRetrieval({
    item: item(),
    chunkId: "ticket-3",
    retrievalWorkspace: { places: { A地方: { unique_chunk_ids: [], themes: { tickets: [] } } } },
    retrievalLog: {
      requests: [
        request(
          {
            chunk_id: "ticket-3",
            recall_status: "reranked_filtered",
            score: { total: 0.7 },
          },
          {
            rerank: {
              items: [
                {
                  chunk_id: "ticket-3",
                  passed_threshold: false,
                  rerank_probability: 0.2,
                },
              ],
            },
          },
        ),
      ],
    },
  });

  assert.equal(result.attribution_code, "rerank_drop");
});

test("scored candidate outside top-k maps to topk_cut", () => {
  const result = attributeChunkRetrieval({
    item: item(),
    chunkId: "ticket-4",
    retrievalWorkspace: { places: { A地方: { unique_chunk_ids: [], themes: { tickets: [] } } } },
    retrievalLog: {
      requests: [
        request({
          chunk_id: "ticket-4",
          recall_status: "scored_not_selected",
          candidate_rank: 4,
          score: { total: 0.6 },
        }),
      ],
    },
  });

  assert.equal(result.attribution_code, "topk_cut");
});

test("zero score and entity gate misses map to keyword_miss", () => {
  for (const recallStatus of ["zero_score", "filtered_by_entity_gate"]) {
    const result = attributeChunkRetrieval({
      item: item(),
      chunkId: `chunk-${recallStatus}`,
      retrievalWorkspace: { places: { A地方: { unique_chunk_ids: [], themes: { tickets: [] } } } },
      retrievalLog: {
        requests: [
          request({
            chunk_id: `chunk-${recallStatus}`,
            recall_status: recallStatus,
            score: { total: 0 },
          }),
        ],
      },
    });

    assert.equal(result.attribution_code, "keyword_miss");
  }
});
