import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CEILING_CRITICALITY_WEIGHTS,
  computeCeilingCoverage,
  createDeltas,
  createReport,
  renderReportMarkdown,
} from "../../scripts/assessment/rag-tuning/lib/report_writer.mjs";
import { assertValidReport } from "../../scripts/assessment/rag-tuning/lib/schemas.mjs";

/**
 * 天花板场景的四条 fixture，各自只在一个层上断：
 *
 * | 条目 | 权重 | 检索 | facts | 呈现 | 首断层 |
 * |------|------|------|-------|------|--------|
 * | A    | 4    | ✓    | ✓     | ✓    | 无     |
 * | B    | 3    | ✗    | ✗     | ✗    | 检索   |
 * | C    | 2    | ✓    | ✗     | ✗    | facts  |
 * | D    | 1    | ✓    | ✓     | ✗    | 呈现   |
 */
function ceilingChecklist() {
  return {
    schema_version: 1,
    baseline_id: "B3",
    baseline_name: "ceiling",
    capability: "ceiling",
    version: 1,
    items: [
      { id: "A", text: "A。", target_type: "place", target_name: "甲", theme: "tickets", criticality: "critical", source_chunk_ids: ["c-a"] },
      { id: "B", text: "B。", target_type: "place", target_name: "乙", theme: "tickets", criticality: "core-quality", source_chunk_ids: ["c-b"] },
      { id: "C", text: "C。", target_type: "place", target_name: "丙", theme: "tickets", criticality: "mid", source_chunk_ids: ["c-c"] },
      { id: "D", text: "D。", target_type: "place", target_name: "丁", theme: "tickets", criticality: "low", source_chunk_ids: ["c-d"] },
    ],
  };
}

function evaluations() {
  return {
    retrievalEvaluation: {
      metrics: { CIR: { lost: 0 }, R1: { rate: 0.75 }, R2: { rate: 0.75 } },
      item_results: [
        { item_id: "A", retrieved: true, chunk_results: [{ chunk_id: "c-a", retrieved: true, attribution_code: "theme_selected" }] },
        {
          item_id: "B",
          retrieved: false,
          chunk_results: [{ chunk_id: "c-b", retrieved: false, attribution_code: "topk_cut" }],
        },
        { item_id: "C", retrieved: true, chunk_results: [{ chunk_id: "c-c", retrieved: true, attribution_code: "theme_selected" }] },
        { item_id: "D", retrieved: true, chunk_results: [{ chunk_id: "c-d", retrieved: true, attribution_code: "theme_selected" }] },
      ],
      lost_items: [],
      attribution: [],
    },
    factsEvaluation: {
      metrics: { N1: { critical_lost: 0 }, N2: { noncritical_lost: 2 }, N3: { misplaced_items: 0 }, low_confidence_count: 0 },
      item_results: [
        { item_id: "A", covered: true, confidence: "high", retrieved: true, matched_hints: [] },
        { item_id: "B", covered: false, confidence: "none", retrieved: false, matched_hints: [] },
        { item_id: "C", covered: false, confidence: "none", retrieved: true, matched_hints: [] },
        { item_id: "D", covered: true, confidence: "high", retrieved: true, matched_hints: [] },
      ],
      lost_items: [],
    },
    htmlEvaluation: {
      status: "evaluated",
      mechanical: { status: "PASS", verifyErrors: [] },
      metrics: { CIR: { critical_items: 1, retained: 1, lost: 0, rate: 1 }, N3: { misplaced_items: 0 }, low_confidence_count: 0 },
      // facts 未覆盖的 B、C 会被 html_metrics 跳过，不进入 item_results。
      item_results: [
        { item_id: "A", rendered: true, confidence: "high", facts_covered: true, matched_hints: [] },
        { item_id: "D", rendered: false, confidence: "none", facts_covered: true, matched_hints: [] },
      ],
      lost_items: [],
    },
  };
}

function buildCeilingReport() {
  const checklist = ceilingChecklist();
  const { retrievalEvaluation, factsEvaluation, htmlEvaluation } = evaluations();
  const deltas = createDeltas({
    checklist,
    runId: "run-ceiling",
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
  });
  const report = createReport({
    checklist,
    runManifest: { run_id: "run-ceiling" },
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
    adjudications: { semantic_scores: [] },
    deltas,
  });
  return { report, deltas };
}

test("ceiling capability downgrades gates to SKIPPED and reports CEILING", () => {
  const { report } = buildCeilingReport();

  assert.equal(report.conclusion, "CEILING");
  assert.equal(report.gates.G2.status, "SKIPPED");
  assert.equal(report.gates.G3.status, "SKIPPED");
  assert.equal(report.gates.G4.status, "SKIPPED");
  assert.equal(report.gates.G2.retrieval_lost, 0);
  assert.equal(report.gates.G2.facts_lost, 0);
  // SKIPPED 与 CEILING 必须能通过 schema。
  assertValidReport(report);
});

test("ceiling mode ignores gate failures but still records the numbers", () => {
  const checklist = ceilingChecklist();
  const { retrievalEvaluation, factsEvaluation, htmlEvaluation } = evaluations();
  // 故意制造会触发 G2 FAIL 的数值：天花板下必须照常记数值、但不产生 FAIL 结论。
  const failingFacts = {
    ...factsEvaluation,
    metrics: { ...factsEvaluation.metrics, N1: { critical_lost: 1 } },
  };
  const deltas = createDeltas({
    checklist,
    runId: "run-ceiling",
    retrievalEvaluation,
    factsEvaluation: failingFacts,
    htmlEvaluation,
  });
  const report = createReport({
    checklist,
    runManifest: { run_id: "run-ceiling" },
    retrievalEvaluation,
    factsEvaluation: failingFacts,
    htmlEvaluation,
    adjudications: { semantic_scores: [] },
    deltas,
  });

  assert.equal(report.conclusion, "CEILING", "天花板模式不产生 FAIL");
  assert.equal(report.gates.G2.status, "SKIPPED");
  assert.equal(report.gates.G2.facts_lost, 1, "原始数值仍被保留供诊断");
  assert.equal(report.coverage.mode, "ceiling");
});

test("ceiling coverage scores each layer by count and by criticality weight", () => {
  const { report } = buildCeilingReport();
  const coverage = report.coverage;

  assert.equal(coverage.mode, "ceiling");
  assert.deepEqual(coverage.criticality_weights, CEILING_CRITICALITY_WEIGHTS);
  assert.equal(coverage.items, 4);

  // 检索层：A/B✗/C/D → 3/4；加权 4+2+1=7 / 10
  assert.deepEqual(
    [coverage.layers.retrieval.covered, coverage.layers.retrieval.items, coverage.layers.retrieval.rate],
    [3, 4, 0.75],
  );
  assert.equal(coverage.layers.retrieval.weighted_rate, 0.7);
  // facts 层：A/C✗/D → 2/4；加权 4+1=5 / 10
  assert.equal(coverage.layers.facts.rate, 0.5);
  assert.equal(coverage.layers.facts.weighted_rate, 0.5);
  // 呈现层：仅 A → 1/4；加权 4 / 10
  assert.equal(coverage.layers.render.rate, 0.25);
  assert.equal(coverage.layers.render.weighted_rate, 0.4);

  assert.equal(coverage.fully_covered, 1);
  assert.equal(coverage.fully_covered_rate, 0.25);
  // 缺口权重 3+2+1=6，整体加权覆盖率 4/10
  assert.equal(coverage.gap_weight, 6);
  assert.equal(coverage.weighted_coverage, 0.4);
});

test("each layer also reports a conditional rate so upstream loss cannot hide it", () => {
  const { report } = buildCeilingReport();
  const { retrieval, facts, render } = report.coverage.layers;

  assert.equal(retrieval.conditional, null, "检索层没有上游，条件覆盖率无意义");
  // facts 条件于检索：上游已覆盖 A、C、D → 其中 A、D 也进了 facts → 2/3（加权 5/7）
  assert.deepEqual([facts.conditional.upstream_layer, facts.conditional.items, facts.conditional.covered], ["retrieval", 3, 2]);
  assert.equal(facts.conditional.rate, 0.6667);
  assert.equal(facts.conditional.lost, 1);
  assert.equal(facts.conditional.weighted_rate, 0.7143);
  // 呈现条件于 facts：已进 facts 的 A、D 里只有 A 上了页面 → 1/2（加权 4/5）
  assert.deepEqual([render.conditional.upstream_layer, render.conditional.items, render.conditional.covered], ["facts", 2, 1]);
  assert.equal(render.conditional.rate, 0.5);
  assert.equal(render.conditional.weighted_rate, 0.8);
  // 关键：无条件的呈现层覆盖率（1/4）远低于层内转化（1/2），两者不可互相替代。
  assert.equal(render.rate, 0.25);
});

test("each gap is attributed to its most-upstream missing layer only", () => {
  const { report } = buildCeilingReport();
  const gaps = report.coverage.gaps;

  assert.equal(gaps.total, 3, "一条只算一次，不逐层重复计缺口");
  assert.deepEqual(gaps.by_layer, { retrieval: 1, facts: 1, render: 1 });
  assert.deepEqual(
    gaps.items.map((gap) => gap.item_id),
    ["B", "C", "D"],
    "按权重降序：core-quality(B) > mid(C) > low(D)",
  );

  const byId = Object.fromEntries(gaps.items.map((gap) => [gap.item_id, gap]));
  assert.equal(byId.B.first_missing_layer, "retrieval");
  assert.equal(byId.B.attribution_code, "topk_cut", "检索层缺口应带 chunk 级归因码");
  assert.deepEqual(byId.B.missing_layers, ["retrieval", "facts", "render"]);
  assert.equal(byId.C.first_missing_layer, "facts");
  assert.equal(byId.C.attribution_code, "facts_drop");
  assert.deepEqual(byId.C.missing_layers, ["facts", "render"], "facts 未覆盖时呈现层不再单独记");
  assert.equal(byId.D.first_missing_layer, "render");
  assert.equal(byId.D.attribution_code, "render_drop");
});

test("ceiling markdown leads with coverage, not with a pass/fail verdict", () => {
  const { report, deltas } = buildCeilingReport();
  const markdown = renderReportMarkdown(report, deltas);

  assert.match(markdown, /# RAG 天花板覆盖率报告/);
  assert.match(markdown, /conclusion: CEILING/);
  assert.match(markdown, /## 分层覆盖率/);
  assert.match(markdown, /## 按 criticality 分解/);
  assert.match(markdown, /## 缺口清单（按权重排序，每条只记最上游丢失的层）/);
  assert.match(markdown, /## Gate（跳过判定，仅记录数值）/);
  assert.match(markdown, /70\.0%/, "检索层加权覆盖率应出现在报告里");
  assert.match(markdown, /层内转化/);
  // 天花板模式下 N2（非 critical 未覆盖）属预期，不再当 note 报警。
  assert.doesNotMatch(markdown, /存在非 critical 条目未进入 facts/);
});

test("non-ceiling capability keeps the original verdict pipeline untouched", () => {
  const checklist = { ...ceilingChecklist(), capability: "full" };
  const { retrievalEvaluation, factsEvaluation, htmlEvaluation } = evaluations();
  const deltas = createDeltas({ checklist, runId: "run-full", retrievalEvaluation, factsEvaluation, htmlEvaluation });
  const report = createReport({
    checklist,
    runManifest: { run_id: "run-full" },
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
    adjudications: { semantic_scores: [] },
    deltas,
  });

  // 与天花板模式同源的数据，走原判定路径时应得到 PASS_WITH_NOTES：
  // G2 因 critical 全部覆盖而 PASS，N2（非 critical 未覆盖 2 条）产生 note。
  assert.equal(report.conclusion, "PASS_WITH_NOTES");
  assert.equal(report.gates.G2.status, "PASS");
  assert.equal(report.gates.G3.status, "PASS");
  assert.equal(report.gates.G4.status, "PASS");
  assert.equal(report.coverage, undefined, "非天花板模式不新增 coverage 字段");
  assert.match(renderReportMarkdown(report, deltas), /# RAG 调参评估报告/);
});

test("computeCeilingCoverage tolerates a missing render layer", () => {
  const checklist = ceilingChecklist();
  const { retrievalEvaluation, factsEvaluation } = evaluations();
  const coverage = computeCeilingCoverage({
    checklist,
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation: { status: "N/A", item_results: [] },
  });

  assert.equal(coverage.layers.render.items, 0);
  assert.equal(coverage.layers.render.rate, null);
  assert.equal(coverage.layers.render.conditional, null, "整层未参与时不应编造层内转化率");
  assert.equal(coverage.gaps.by_layer.render, 0, "无 HTML 时不应凭空造出呈现层缺口");
  assert.equal(coverage.gaps.total, 2);
});
