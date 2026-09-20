import fs from "node:fs";
import path from "node:path";
import { buildChecklistFromFacts } from "./checklist.mjs";
import { assertValidDeltas, assertValidReport } from "./schemas.mjs";

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function sum(...values) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).replace(/[，。；、：:,.!！?？\s"'“”‘’（）()[\]{}<>《》\-|｜]/g, "");
}

function itemKey(item) {
  return [
    item.target_type,
    item.target_name ?? "",
    item.theme,
    normalizeText(item.text),
  ].join("\u0000");
}

function candidateAlreadyCovered(candidate, baselineItems) {
  const candidateKey = itemKey(candidate);
  if (baselineItems.some((item) => itemKey(item) === candidateKey)) return true;
  const candidateText = normalizeText(candidate.text);
  if (!candidateText) return true;
  return baselineItems.some((item) => {
    if (item.target_type !== candidate.target_type) return false;
    if ((item.target_name ?? "") !== (candidate.target_name ?? "")) return false;
    if (item.theme !== candidate.theme) return false;
    const baselineText = normalizeText(item.text);
    return baselineText.includes(candidateText) || candidateText.includes(baselineText);
  });
}

function gate(status, summary, details = {}) {
  return { status, summary, ...details };
}

function gateStatus(condition) {
  return condition ? "PASS" : "FAIL";
}

function semanticMinimum(semanticScores) {
  const values = asList(semanticScores).flatMap((entry) => Object.values(entry?.scores ?? {}));
  if (!values.length) return null;
  return Math.min(...values);
}

function collectNotes({ retrievalEvaluation, factsEvaluation, htmlEvaluation, adjudications, deltas, semantic_minimum }) {
  const notes = [];
  if (retrievalEvaluation?.degraded_attribution) notes.push("检索日志缺失或未接入，归因处于降级模式。");
  if (factsEvaluation?.metrics?.N2?.noncritical_lost > 0) notes.push("存在非 critical 条目未进入 facts。");
  if (factsEvaluation?.metrics?.low_confidence_count > 0) notes.push("facts 层存在低置信覆盖，需要人工裁定。");
  if (htmlEvaluation?.status !== "N/A" && htmlEvaluation?.metrics?.low_confidence_count > 0) notes.push("呈现层存在低置信覆盖，需要人工复查。");
  if (semantic_minimum !== null && semantic_minimum < 4) notes.push("语义评分低于最低满意线。");
  if (asList(adjudications?.coverage_review_items).length > 0) notes.push("adjudications.json 中存在待裁定覆盖项。");
  return notes;
}

export function createNewItemDeltas({ checklist, facts, retrievalWorkspace, runManifest }) {
  const candidateChecklist = buildChecklistFromFacts(facts, retrievalWorkspace, {
    baselineId: checklist.baseline_id,
    baselineName: checklist.baseline_name,
    capability: checklist.capability,
    sourceRun: runManifest.run_id,
    retrievalWorkspacePath: runManifest.paths?.retrieval_workspace ?? "",
    allowUnverified: false,
  });
  const baselineItems = asList(checklist.items);
  const candidates = [];
  for (const item of candidateChecklist.items) {
    if (candidateAlreadyCovered(item, baselineItems)) continue;
    const number = String(candidates.length + 1).padStart(4, "0");
    const candidateId = `${checklist.baseline_id}-new-${number}`;
    const checklistItem = {
      ...item,
      id: candidateId,
      added_at: new Date().toISOString(),
      source_run: runManifest.run_id,
    };
    candidates.push({
      item_id: candidateId,
      target_type: item.target_type,
      target_name: item.target_name,
      theme: item.theme,
      criticality: item.criticality,
      layer: "facts",
      attribution_code: "unknown",
      evidence: {
        text: item.text,
        source_chunk_ids: item.source_chunk_ids,
      },
      suggestion: "人工确认该新增信息有效后，可通过 assessment:upgrade 追加到基准清单。",
      checklist_item: checklistItem,
      duplicate_of: null,
      effective_new: true,
    });
  }
  return candidates;
}

export function createDeltas({ checklist, runId, retrievalEvaluation, factsEvaluation, htmlEvaluation, newItems = [] }) {
  const deltas = {
    schema_version: 1,
    baseline_id: checklist.baseline_id,
    run_id: runId,
    lost_items: [
      ...asList(retrievalEvaluation?.lost_items),
      ...asList(factsEvaluation?.lost_items),
      ...asList(htmlEvaluation?.lost_items),
    ],
    new_items: asList(newItems),
    misplaced_items: [],
    unsupported_facts: [],
    duplicates: [],
    attribution: asList(retrievalEvaluation?.attribution),
  };
  assertValidDeltas(deltas);
  return deltas;
}

export function createReport({
  checklist,
  runManifest,
  retrievalEvaluation,
  factsEvaluation,
  htmlEvaluation,
  adjudications = null,
  deltas,
}) {
  const criticalRetrievalLost = Number(retrievalEvaluation?.metrics?.CIR?.lost ?? 0);
  const criticalFactsLost = Number(factsEvaluation?.metrics?.N1?.critical_lost ?? 0);
  const criticalRenderLost = htmlEvaluation?.status === "N/A" ? 0 : Number(htmlEvaluation?.metrics?.CIR?.lost ?? 0);
  const misplacedItems = sum(factsEvaluation?.metrics?.N3?.misplaced_items, htmlEvaluation?.metrics?.N3?.misplaced_items);
  const unsupportedFacts = asList(deltas.unsupported_facts).length;
  const semantic_minimum = semanticMinimum(adjudications?.semantic_scores);

  const gates = {
    G1: htmlEvaluation?.status === "N/A"
      ? gate("N/A", "未提供 HTML，跳过呈现机械校验。")
      : gate(htmlEvaluation?.mechanical?.status ?? "FAIL", "HTML 机械校验。", {
          verify_error_count: asList(htmlEvaluation?.mechanical?.verifyErrors).length,
        }),
    G2: gate(gateStatus(criticalRetrievalLost === 0 && criticalFactsLost === 0 && criticalRenderLost === 0), "critical 条目零丢失。", {
      retrieval_lost: criticalRetrievalLost,
      facts_lost: criticalFactsLost,
      render_lost: criticalRenderLost,
    }),
    G3: gate(gateStatus(misplacedItems === 0), "高置信归位错误为 0。", { misplaced_items: misplacedItems }),
    G4: gate(gateStatus(unsupportedFacts === 0), "关键类越界事实为 0。", { unsupported_facts: unsupportedFacts }),
  };

  const hardFailed = Object.values(gates).some((item) => item.status === "FAIL");
  const notes = collectNotes({ retrievalEvaluation, factsEvaluation, htmlEvaluation, adjudications, deltas, semantic_minimum });
  const conclusion = hardFailed ? "FAIL" : notes.length ? "PASS_WITH_NOTES" : "PASS";

  const report = {
    schema_version: 1,
    baseline_id: checklist.baseline_id,
    baseline_name: checklist.baseline_name,
    run_id: runManifest.run_id,
    generated_at: new Date().toISOString(),
    conclusion,
    gates,
    metrics: {
      retrieval: retrievalEvaluation.metrics,
      facts: factsEvaluation.metrics,
      html: htmlEvaluation.metrics,
      deltas: {
        lost_items: asList(deltas.lost_items).length,
        new_items: asList(deltas.new_items).length,
        misplaced_items: asList(deltas.misplaced_items).length,
        unsupported_facts: asList(deltas.unsupported_facts).length,
        duplicates: asList(deltas.duplicates).length,
      },
      semantic_minimum,
    },
    semantic_scores: asList(adjudications?.semantic_scores),
    notes,
    recommendations: recommendationList({ gates, retrievalEvaluation, factsEvaluation, htmlEvaluation }),
  };
  assertValidReport(report);
  return report;
}

function recommendationList({ gates, retrievalEvaluation, factsEvaluation, htmlEvaluation }) {
  const recommendations = [];
  if (retrievalEvaluation?.metrics?.CIR?.lost > 0) recommendations.push("优先检查 critical 条目的检索召回和 R4 归因分布。");
  if (factsEvaluation?.metrics?.N1?.critical_lost > 0) recommendations.push("补齐 facts-workspace.json 中已召回但未吸收的 critical 信息。");
  if (htmlEvaluation?.status !== "N/A" && htmlEvaluation?.metrics?.CIR?.lost > 0) recommendations.push("检查 HTML 模板字段映射，确保 facts 已覆盖信息进入页面。");
  if (gates.G1.status === "FAIL") recommendations.push("先修复 HTML 机械校验错误，再复评呈现层覆盖。");
  if (!recommendations.length) recommendations.push("Gate 已满足，按 notes 处理低置信项和软指标。");
  return recommendations;
}

function markdownTable(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function formatValue(value) {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderReportMarkdown(report, deltas) {
  const gateRows = [
    ["Gate", "状态", "说明"],
    ["---", "---", "---"],
    ...Object.entries(report.gates).map(([name, value]) => [name, value.status, value.summary]),
  ];
  const lostRows = [
    ["条目", "层级", "归因", "目标", "建议"],
    ["---", "---", "---", "---", "---"],
    ...asList(deltas.lost_items).slice(0, 20).map((item) => [
      item.item_id,
      item.layer,
      item.attribution_code,
      `${item.target_type}:${item.target_name ?? ""}:${item.theme}`,
      item.suggestion ?? "",
    ]),
  ];
  const newRows = [
    ["候选", "主题", "目标", "证据 chunk", "判定"],
    ["---", "---", "---", "---", "---"],
    ...asList(deltas.new_items).slice(0, 20).map((item) => [
      item.item_id,
      item.theme,
      `${item.target_type}:${item.target_name ?? ""}`,
      asList(item.evidence?.source_chunk_ids).join(", "),
      item.effective_new ? "有效新增候选" : "待复查",
    ]),
  ];
  const metricRows = [
    ["指标", "值"],
    ["---", "---"],
    ["retrieval.CIR", formatValue(report.metrics.retrieval?.CIR)],
    ["retrieval.R1", formatValue(report.metrics.retrieval?.R1)],
    ["retrieval.R2", formatValue(report.metrics.retrieval?.R2)],
    ["facts.N1", formatValue(report.metrics.facts?.N1)],
    ["facts.N2", formatValue(report.metrics.facts?.N2)],
    ["html.CIR", formatValue(report.metrics.html?.CIR)],
  ];

  return [
    `# RAG 调参评估报告`,
    "",
    `- run_id: ${report.run_id}`,
    `- baseline_id: ${report.baseline_id}`,
    `- conclusion: ${report.conclusion}`,
    "",
    "## Gate",
    "",
    markdownTable(gateRows),
    "",
    "## 核心指标",
    "",
    markdownTable(metricRows),
    "",
    "## Notes",
    "",
    ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- 无"]),
    "",
    "## 丢失明细",
    "",
    lostRows.length > 2 ? markdownTable(lostRows) : "- 无",
    "",
    "## 有效新增明细",
    "",
    newRows.length > 2 ? markdownTable(newRows) : "- 无",
    "",
    "## 调参建议",
    "",
    ...report.recommendations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export function writeAssessmentOutputs(runDir, { report, deltas }) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "deltas.json"), `${JSON.stringify(deltas, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDir, "report.md"), renderReportMarkdown(report, deltas), "utf8");
}
