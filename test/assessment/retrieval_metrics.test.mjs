import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRetrievalLayer } from "../../scripts/assessment/rag-tuning/lib/retrieval_metrics.mjs";

function checklist() {
  return {
    schema_version: 1,
    baseline_id: "B1",
    items: [
      {
        id: "critical-retained",
        text: "门票需确认。",
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        criticality: "critical",
        source_chunk_ids: ["ticket-1"],
      },
      {
        id: "critical-lost",
        text: "停车场在游客中心旁。",
        target_type: "place",
        target_name: "A地方",
        theme: "transport",
        criticality: "critical",
        source_chunk_ids: ["transport-1"],
      },
      {
        id: "core-lost",
        text: "峡谷观景台值得停留。",
        target_type: "place",
        target_name: "A地方",
        theme: "highlights",
        criticality: "core-quality",
        source_chunk_ids: ["highlight-1"],
      },
    ],
  };
}

function retrievalWorkspace() {
  return {
    places: {
      A地方: {
        unique_chunk_ids: ["ticket-1"],
        themes: {
          tickets: [{ chunk_id: "ticket-1" }],
          transport: [],
          highlights: [],
        },
      },
    },
  };
}

function retrievalLog() {
  return {
    requests: [
      {
        target_type: "place",
        target_name: "A地方",
        theme: "transport",
        top_k: 1,
        chunks: [
          {
            chunk_id: "transport-1",
            recall_status: "scored_not_selected",
            candidate_rank: 3,
            score: { total: 0.6 },
          },
        ],
      },
      {
        target_type: "place",
        target_name: "A地方",
        theme: "highlights",
        top_k: 1,
        chunks: [
          {
            chunk_id: "highlight-1",
            recall_status: "zero_score",
            candidate_rank: null,
            score: { total: 0 },
          },
        ],
      },
    ],
  };
}

test("evaluateRetrievalLayer computes CIR, R1, R2, R3, and R4", () => {
  const result = evaluateRetrievalLayer(checklist(), retrievalWorkspace(), retrievalLog());

  assert.equal(result.degraded_attribution, false);
  assert.deepEqual(result.metrics.CIR, {
    critical_items: 2,
    retained: 1,
    lost: 1,
    rate: 0.5,
  });
  assert.deepEqual(result.metrics.R1, {
    critical_source_chunks: 2,
    retrieved: 1,
    lost: 1,
    rate: 0.5,
  });
  assert.deepEqual(result.metrics.R2, {
    source_chunks: 3,
    retrieved: 1,
    lost: 2,
    rate: 0.3333,
  });
  assert.equal(result.metrics.R3.target_theme_count, 3);
  assert.equal(result.metrics.R3.empty_theme_count, 2);
  assert.deepEqual(result.metrics.R4, {
    topk_cut: 1,
    keyword_miss: 1,
  });
  assert.equal(result.lost_items.length, 2);
  assert.equal(result.attribution.length, 2);
});

test("evaluateRetrievalLayer marks attribution as degraded when retrieval log is missing", () => {
  const result = evaluateRetrievalLayer(checklist(), retrievalWorkspace(), null);

  assert.equal(result.degraded_attribution, true);
  assert.equal(result.metrics.R4.unknown, 2);
  assert.equal(result.lost_items.find((item) => item.item_id === "critical-lost").attribution_code, "unknown");
});
