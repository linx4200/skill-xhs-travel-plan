import assert from "node:assert/strict";
import { test } from "node:test";
import { buildComparison, renderComparisonMarkdown } from "../../scripts/assessment/rag-tuning/compare_rerank_ab.mjs";

function arm(label, metrics, overrides = {}) {
  return {
    label,
    run_dir: `/tmp/${label}`,
    facts_workspace: `/tmp/${label}/facts-workspace.json`,
    html_dir: "",
    retrieval_workspace: `/tmp/${label}/retrieval-workspace.json`,
    retrieval_log: `/tmp/${label}/retrieval-log.json`,
    report: `/tmp/${label}/report.json`,
    cli_overrides: {},
    conclusion: "PASS",
    gates: {},
    metrics: {
      read_pool_chunks: 80,
      retrieval_R1_rate: 0.8,
      retrieval_R1_lost: 2,
      retrieval_R2_rate: 0.75,
      retrieval_R2_lost: 10,
      empty_theme_count: 1,
      facts_critical_lost: 0,
      facts_noncritical_lost: 2,
      facts_low_confidence_count: 0,
      html_structure_complete: "N/A",
      html_render_drop_count: 0,
      lost_items: 2,
      new_items: 4,
      M3_novel_evidence_chunks: 20,
      M3_novel_pool_chunks: 30,
      M3_raw_candidate_items: 12,
      ...metrics,
    },
    retrieval_R4: {},
    pool: {},
    rerank_log: {
      request_count: 10,
      enabled_requests: 0,
      applied_requests: 0,
      skipped_requests: 10,
      skipped_by_reason: {},
      rerank_items: 0,
      threshold_filtered_items: 0,
    },
    notes: [],
    recommendations: [],
    deltas: {
      lost_items: 2,
      new_items: 4,
      misplaced_items: 0,
      unsupported_facts: 0,
    },
    ...overrides,
  };
}

test("buildComparison computes rerank-minus-no-rerank deltas", () => {
  const comparison = buildComparison({
    comparisonId: "ab-1",
    baselineId: "B1",
    outDir: "/tmp/ab-1",
    independentFacts: true,
    noRerank: arm("no-rerank", { read_pool_chunks: 90, retrieval_R1_rate: 0.75, M3_novel_evidence_chunks: 18 }),
    rerank: arm("rerank", { read_pool_chunks: 82, retrieval_R1_rate: 0.83, M3_novel_evidence_chunks: 21 }),
  });

  assert.equal(comparison.facts_layer_independent, true);
  assert.equal(comparison.metric_deltas.direction, "rerank_minus_no_rerank");
  assert.equal(comparison.metric_deltas.values.read_pool_chunks, -8);
  assert.equal(comparison.metric_deltas.values.retrieval_R1_rate, 0.08);
  assert.equal(comparison.metric_deltas.values.M3_novel_evidence_chunks, 3);
  assert.equal(comparison.verdict, "RERANK_IMPROVED");
  assert.equal(comparison.human_summary.headline, "这组参数下，开 rerank 整体更好。");
  assert.match(comparison.human_summary.recommendation, /倾向开启 rerank/);
});

test("renderComparisonMarkdown marks shared facts as reference-only", () => {
  const comparison = buildComparison({
    comparisonId: "ab-2",
    baselineId: "B1",
    outDir: "/tmp/ab-2",
    independentFacts: false,
    noRerank: arm("no-rerank", {}),
    rerank: arm("rerank", {}),
  });

  const markdown = renderComparisonMarkdown(comparison);
  assert.match(markdown, /facts_layer_independent: false/);
  assert.match(markdown, /## 人话结论/);
  assert.match(markdown, /建议：/);
  assert.match(markdown, /facts 层只能作为一致性参考/);
  assert.match(markdown, /R1 critical chunk 召回率/);
});
