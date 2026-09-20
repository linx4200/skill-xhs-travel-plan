import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidAdjudications,
  assertValidChecklist,
  assertValidDeltas,
  assertValidReport,
  assertValidRunManifest,
  validateChecklist,
} from "../../scripts/assessment/rag-tuning/lib/schemas.mjs";

function checklistItem(overrides = {}) {
  return {
    id: "B1-place-001",
    text: "A地方需要保留门票和开放状态确认提醒。",
    domain: "execution_fact",
    target_type: "place",
    target_name: "A地方",
    theme: "tickets",
    criticality: "critical",
    source_chunk_ids: ["chunk-001"],
    evidence_ref: {
      rag_index: "rag-index.json",
      chunk_ids: ["chunk-001"],
    },
    match_hints: ["门票", "开放"],
    added_at: "2026-09-20T00:00:00.000Z",
    source_run: "output/rag-e2e-smoke/",
    ...overrides,
  };
}

function checklist(overrides = {}) {
  return {
    schema_version: 1,
    baseline_id: "B1",
    baseline_name: "rag-e2e-smoke",
    capability: "retrieval_and_facts",
    version: 1,
    created_at: "2026-09-20T00:00:00.000Z",
    source_run: "output/rag-e2e-smoke/",
    items: [checklistItem()],
    ...overrides,
  };
}

test("checklist schema accepts the required baseline shape", () => {
  assert.doesNotThrow(() => assertValidChecklist(checklist()));
});

test("checklist schema rejects items without criticality, chunk ids, or evidence refs", () => {
  const bad = checklist({
    items: [
      checklistItem({
        criticality: undefined,
        source_chunk_ids: [],
        evidence_ref: {},
      }),
    ],
  });

  const errors = validateChecklist(bad);
  assert.ok(errors.some((error) => error.includes("items[0].criticality")));
  assert.ok(errors.some((error) => error.includes("items[0].source_chunk_ids")));
  assert.ok(errors.some((error) => error.includes("items[0].evidence_ref.chunk_ids")));
});

test("run manifest schema validates phase-1 run metadata", () => {
  assert.doesNotThrow(() =>
    assertValidRunManifest({
      schema_version: 1,
      run_id: "20260920-1530-B1-test",
      baseline_id: "B1",
      created_at: "2026-09-20T00:00:00.000Z",
      paths: {
        params: "params.json",
      },
      params: {},
    }),
  );
});

test("deltas schema validates layer and attribution codes", () => {
  assert.doesNotThrow(() =>
    assertValidDeltas({
      schema_version: 1,
      baseline_id: "B1",
      run_id: "20260920-1530-B1-test",
      lost_items: [
        {
          item_id: "B1-place-001",
          target_type: "place",
          target_name: "A地方",
          theme: "tickets",
          criticality: "critical",
          layer: "retrieval",
          attribution_code: "topk_cut",
        },
      ],
      new_items: [],
      misplaced_items: [],
      unsupported_facts: [],
      duplicates: [],
      attribution: [],
    }),
  );
});

test("report schema validates conclusion and required panels", () => {
  assert.doesNotThrow(() =>
    assertValidReport({
      schema_version: 1,
      baseline_id: "B1",
      run_id: "20260920-1530-B1-test",
      conclusion: "PASS_WITH_NOTES",
      gates: {},
      metrics: {},
      semantic_scores: [],
    }),
  );
});

test("adjudication schema enforces 1-5 semantic scores", () => {
  assert.doesNotThrow(() =>
    assertValidAdjudications({
      schema_version: 1,
      run_id: "20260920-1530-B1-test",
      coverage_overrides: [
        {
          item_id: "B1-place-001",
          facts_covered: true,
          render_covered: null,
          reason: "facts 中保留了开放状态确认提醒。",
        },
      ],
      semantic_scores: [
        {
          target_type: "place",
          target_name: "A地方",
          scores: {
            information_coverage: 4,
            travel_value: 3,
            decision_support: 4,
            risk_avoidance: 4,
            evidence_absorption: 4,
            actionability: 4,
          },
          evidence: "资料可支持执行判断。",
          deductions: [],
        },
      ],
    }),
  );
});
