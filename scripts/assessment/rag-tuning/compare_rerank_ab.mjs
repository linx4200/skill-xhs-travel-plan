#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRetrievalWorkspace } from "../../rag/create_retrieval_workspace.mjs";
import { writeRetrievalLog } from "../../rag/rag_retrieve.mjs";
import { createAssessmentRun } from "./prepare_run.mjs";
import { evaluateAssessmentRun } from "./evaluate_run.mjs";
import { assertValidChecklist } from "./lib/schemas.mjs";

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function timestampForRunId(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}-${value.hour}${value.minute}`;
}

function parseNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number.`);
  return parsed;
}

function parseArgs(argv) {
  const args = {
    baseline: "",
    ragIndex: "",
    outDir: "",
    facts: "",
    noRerankFacts: "",
    rerankFacts: "",
    noRerankHtmlDir: "",
    rerankHtmlDir: "",
    readScope: undefined,
    placeTopK: undefined,
    cityTopK: undefined,
    maxPlaceChunks: undefined,
    maxCityChunks: undefined,
    embeddingUrl: "",
    embeddingModel: "",
    noEmbedding: false,
    rerankUrl: "",
    rerankModel: "",
    rerankAllThemes: false,
    rerankThemes: [],
    rerankRecallWidth: undefined,
    rerankThreshold: undefined,
    rerankTimeoutMs: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") args.baseline = argv[++i];
    else if (arg === "--rag-index") args.ragIndex = argv[++i];
    else if (arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--no-rerank-facts") args.noRerankFacts = argv[++i];
    else if (arg === "--rerank-facts") args.rerankFacts = argv[++i];
    else if (arg === "--no-rerank-html-dir") args.noRerankHtmlDir = argv[++i];
    else if (arg === "--rerank-html-dir") args.rerankHtmlDir = argv[++i];
    else if (arg === "--read-scope") args.readScope = argv[++i];
    else if (arg === "--place-top-k") args.placeTopK = parseNumber(argv[++i], arg);
    else if (arg === "--city-top-k") args.cityTopK = parseNumber(argv[++i], arg);
    else if (arg === "--max-place-chunks") args.maxPlaceChunks = parseNumber(argv[++i], arg);
    else if (arg === "--max-city-chunks") args.maxCityChunks = parseNumber(argv[++i], arg);
    else if (arg === "--embedding-url") args.embeddingUrl = argv[++i];
    else if (arg === "--embedding-model") args.embeddingModel = argv[++i];
    else if (arg === "--no-embedding") args.noEmbedding = true;
    else if (arg === "--rerank-url") args.rerankUrl = argv[++i];
    else if (arg === "--rerank-model") args.rerankModel = argv[++i];
    else if (arg === "--rerank-all-themes") args.rerankAllThemes = true;
    else if (arg === "--rerank-theme") args.rerankThemes.push(argv[++i]);
    else if (arg === "--rerank-recall-width") args.rerankRecallWidth = parseNumber(argv[++i], arg);
    else if (arg === "--rerank-threshold") args.rerankThreshold = parseNumber(argv[++i], arg);
    else if (arg === "--rerank-timeout-ms") args.rerankTimeoutMs = parseNumber(argv[++i], arg);
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.baseline) throw new Error("Missing required --baseline <checklist.json>.");
  if (!args.ragIndex) throw new Error("Missing required --rag-index <rag-index.json>.");
  if (!args.facts && (!args.noRerankFacts || !args.rerankFacts)) {
    throw new Error("Provide either --facts <shared facts-workspace.json> or both --no-rerank-facts and --rerank-facts.");
  }
  return args;
}

function relativePath(filePath, fromDir) {
  if (!filePath) return "";
  const resolved = path.resolve(filePath);
  const rel = path.relative(path.resolve(fromDir), resolved);
  return rel && !rel.startsWith("..") ? rel : resolved;
}

function retrievalLogDocument(workspace, requests) {
  const selectedCount = requests.reduce(
    (total, request) => total + asList(request.chunks).filter((chunk) => chunk.recall_status === "selected").length,
    0,
  );
  return {
    schema_version: 1,
    source: workspace.source,
    retrieval: workspace.retrieval,
    summary: {
      request_count: requests.length,
      index_chunk_evaluations: requests.reduce((total, request) => total + asList(request.chunks).length, 0),
      selected_results: selectedCount,
    },
    requests,
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "" && item !== null));
}

function commonRetrievalOptions(args) {
  return compactObject({
    readScope: args.readScope,
    placeTopK: args.placeTopK,
    cityTopK: args.cityTopK,
    maxPlaceChunks: args.maxPlaceChunks,
    maxCityChunks: args.maxCityChunks,
    embeddingUrl: args.embeddingUrl,
    embeddingModel: args.embeddingModel,
    noEmbedding: args.noEmbedding,
  });
}

function rerankOnlyOptions(args) {
  return compactObject({
    rerankUrl: args.rerankUrl,
    rerankModel: args.rerankModel,
    rerankAllThemes: args.rerankAllThemes,
    rerankThemes: args.rerankThemes.length ? args.rerankThemes : undefined,
    rerankRecallWidth: args.rerankRecallWidth,
    rerankThreshold: args.rerankThreshold,
    rerankTimeoutMs: args.rerankTimeoutMs,
  });
}

function cliOverridesForArm(args, rerankEnabled) {
  const common = commonRetrievalOptions(args);
  const rerank = rerankEnabled ? rerankOnlyOptions(args) : {};
  return {
    ...common,
    rerank: rerankEnabled,
    ...rerank,
  };
}

function poolSummary(workspace) {
  const targets = [...Object.values(workspace?.places ?? {}), ...Object.values(workspace?.cities ?? {})];
  const droppedByTheme = {};
  let droppedTotal = 0;
  let targetSelectedTotal = 0;
  const perTarget = {};
  for (const [name, target] of [
    ...Object.entries(workspace?.places ?? {}),
    ...Object.entries(workspace?.cities ?? {}),
  ]) {
    const ids = asList(target?.unique_chunk_ids);
    perTarget[name] = ids.length;
    targetSelectedTotal += ids.length;
    const quota = target?.retrieval_quota ?? {};
    droppedTotal += Number(quota.dropped_total ?? 0);
    for (const [theme, count] of Object.entries(quota.dropped_by_theme ?? {})) {
      droppedByTheme[theme] = (droppedByTheme[theme] ?? 0) + Number(count ?? 0);
    }
  }
  return {
    global_chunks: Object.keys(workspace?.chunks_by_id ?? {}).length,
    target_count: targets.length,
    target_selected_total: targetSelectedTotal,
    dropped_total: droppedTotal,
    dropped_by_theme: droppedByTheme,
    per_target: perTarget,
  };
}

function summarizeRerankLog(log) {
  const summary = {
    request_count: asList(log?.requests).length,
    enabled_requests: 0,
    applied_requests: 0,
    skipped_requests: 0,
    skipped_by_reason: {},
    rerank_items: 0,
    threshold_filtered_items: 0,
  };
  for (const request of asList(log?.requests)) {
    const rerank = request?.rerank;
    if (!rerank) continue;
    if (rerank.enabled) summary.enabled_requests += 1;
    if (rerank.applied) summary.applied_requests += 1;
    else {
      summary.skipped_requests += 1;
      const reason = rerank.skipped_reason ?? "unknown";
      summary.skipped_by_reason[reason] = (summary.skipped_by_reason[reason] ?? 0) + 1;
    }
    const items = asList(rerank.items);
    summary.rerank_items += items.length;
    summary.threshold_filtered_items += items.filter((item) => item.passed_threshold === false).length;
  }
  return summary;
}

function metricValue(report, pathParts) {
  let value = report;
  for (const part of pathParts) value = value?.[part];
  return value ?? null;
}

function armSummary({ label, armDir, factsPath, htmlDir, workspace, log, report, deltas, cliOverrides }) {
  return {
    label,
    run_dir: armDir,
    facts_workspace: factsPath,
    html_dir: htmlDir,
    retrieval_workspace: path.join(armDir, "retrieval-workspace.json"),
    retrieval_log: path.join(armDir, "retrieval-log.json"),
    report: path.join(armDir, "report.json"),
    cli_overrides: cliOverrides,
    conclusion: report.conclusion,
    gates: report.gates,
    metrics: {
      read_pool_chunks: report.metrics.M3?.read_pool_chunks ?? Object.keys(workspace?.chunks_by_id ?? {}).length,
      retrieval_R1_rate: metricValue(report, ["metrics", "retrieval", "R1", "rate"]),
      retrieval_R1_lost: metricValue(report, ["metrics", "retrieval", "R1", "lost"]),
      retrieval_R2_rate: metricValue(report, ["metrics", "retrieval", "R2", "rate"]),
      retrieval_R2_lost: metricValue(report, ["metrics", "retrieval", "R2", "lost"]),
      empty_theme_count: metricValue(report, ["metrics", "retrieval", "R3", "empty_theme_count"]),
      facts_critical_lost: metricValue(report, ["metrics", "facts", "N1", "critical_lost"]),
      facts_noncritical_lost: metricValue(report, ["metrics", "facts", "N2", "noncritical_lost"]),
      facts_low_confidence_count: metricValue(report, ["metrics", "facts", "low_confidence_count"]),
      html_structure_complete: metricValue(report, ["metrics", "html", "N8", "structure_complete"]),
      html_render_drop_count: metricValue(report, ["metrics", "html", "render_drop_count"]),
      lost_items: metricValue(report, ["metrics", "deltas", "lost_items"]),
      new_items: metricValue(report, ["metrics", "deltas", "new_items"]),
      M3_novel_evidence_chunks: metricValue(report, ["metrics", "M3", "novel_evidence_chunks"]),
      M3_novel_pool_chunks: metricValue(report, ["metrics", "M3", "novel_pool_chunks"]),
      M3_raw_candidate_items: metricValue(report, ["metrics", "M3", "raw_candidate_items"]),
    },
    retrieval_R4: report.metrics.retrieval?.R4 ?? {},
    pool: poolSummary(workspace),
    rerank_log: summarizeRerankLog(log),
    notes: report.notes,
    recommendations: report.recommendations,
    deltas: {
      lost_items: asList(deltas.lost_items).length,
      new_items: asList(deltas.new_items).length,
      misplaced_items: asList(deltas.misplaced_items).length,
      unsupported_facts: asList(deltas.unsupported_facts).length,
    },
  };
}

function deltaValue(after, before) {
  if (typeof after !== "number" || typeof before !== "number") return null;
  return Number((after - before).toFixed(4));
}

function gateRank(conclusion) {
  if (conclusion === "PASS") return 3;
  if (conclusion === "PASS_WITH_NOTES") return 2;
  if (conclusion === "CEILING") return 1;
  if (conclusion === "FAIL") return 0;
  return 1;
}

function decideVerdict(noRerank, rerank) {
  if (gateRank(rerank.conclusion) < gateRank(noRerank.conclusion)) return "RERANK_REGRESSED";
  if (gateRank(rerank.conclusion) > gateRank(noRerank.conclusion)) return "RERANK_IMPROVED";

  const before = noRerank.metrics;
  const after = rerank.metrics;
  const hardRegression =
    Number(after.facts_critical_lost ?? 0) > Number(before.facts_critical_lost ?? 0) ||
    Number(after.lost_items ?? 0) > Number(before.lost_items ?? 0);
  if (hardRegression) return "RERANK_REGRESSED";

  const r1Delta = deltaValue(after.retrieval_R1_rate, before.retrieval_R1_rate) ?? 0;
  const r2Delta = deltaValue(after.retrieval_R2_rate, before.retrieval_R2_rate) ?? 0;
  const m3Delta = deltaValue(after.M3_novel_evidence_chunks, before.M3_novel_evidence_chunks) ?? 0;
  const readDelta = deltaValue(after.read_pool_chunks, before.read_pool_chunks) ?? 0;
  if (r1Delta > 0 || r2Delta > 0 || m3Delta > 0 || readDelta < 0) return "RERANK_IMPROVED";
  if (r1Delta < 0 || r2Delta < 0 || m3Delta < 0 || readDelta > 0) return "RERANK_MIXED";
  return "NO_MATERIAL_DIFFERENCE";
}

function signedText(value, suffix = "") {
  if (value === null || value === undefined) return "无可比数据";
  const text = value > 0 ? `+${formatValue(value)}` : formatValue(value);
  return `${text}${suffix}`;
}

function verdictSentence(verdict) {
  if (verdict === "RERANK_IMPROVED") return "这组参数下，开 rerank 整体更好。";
  if (verdict === "RERANK_REGRESSED") return "这组参数下，开 rerank 造成退化，不建议直接采用。";
  if (verdict === "RERANK_MIXED") return "这组参数下，开 rerank 有得有失，需要看丢失项再决定。";
  if (verdict === "NO_MATERIAL_DIFFERENCE") return "这组参数下，开不开 rerank 没有明显差别。";
  return "这组参数下，rerank 影响需要人工复核。";
}

function recommendationSentence(verdict, independentFacts) {
  const suffix = independentFacts ? "" : "；当前共用 facts，facts 层结论只能作为参考";
  if (verdict === "RERANK_IMPROVED") return `倾向开启 rerank${suffix}。`;
  if (verdict === "RERANK_REGRESSED") return `倾向关闭 rerank，先处理退化来源${suffix}。`;
  if (verdict === "RERANK_MIXED") return `暂不直接定版，先看 lost_items 和 R4 归因${suffix}。`;
  if (verdict === "NO_MATERIAL_DIFFERENCE") return `不必为了这组样本单独开启 rerank${suffix}。`;
  return `先人工复核关键丢失项${suffix}。`;
}

function buildHumanSummary({ verdict, noRerank, rerank, metricDeltas, independentFacts }) {
  const reasons = [];
  const before = noRerank.metrics;
  const after = rerank.metrics;
  if (noRerank.conclusion !== rerank.conclusion) {
    reasons.push(`结论从 ${noRerank.conclusion} 变为 ${rerank.conclusion}。`);
  } else {
    reasons.push(`两侧 assessment 结论同为 ${rerank.conclusion}。`);
  }

  const criticalDelta = metricDeltas.facts_critical_lost;
  const lostDelta = metricDeltas.lost_items;
  if (criticalDelta > 0 || lostDelta > 0) {
    reasons.push(`开 rerank 后丢失变多：critical 丢失 ${signedText(criticalDelta)}，lost_items ${signedText(lostDelta)}。`);
  } else if (criticalDelta < 0 || lostDelta < 0) {
    reasons.push(`开 rerank 后丢失减少：critical 丢失 ${signedText(criticalDelta)}，lost_items ${signedText(lostDelta)}。`);
  } else {
    reasons.push("开 rerank 没有增加 critical 丢失或总丢失项。");
  }

  reasons.push(
    `检索召回变化：R1 ${signedText(metricDeltas.retrieval_R1_rate)}，R2 ${signedText(metricDeltas.retrieval_R2_rate)}。`,
  );
  reasons.push(`阅读池变化：${before.read_pool_chunks} -> ${after.read_pool_chunks}（${signedText(metricDeltas.read_pool_chunks, " chunk")}）。`);
  reasons.push(
    `新增证据变化：M3 新增证据 chunk ${signedText(metricDeltas.M3_novel_evidence_chunks)}，池内基准未用 chunk ${signedText(metricDeltas.M3_novel_pool_chunks)}。`,
  );
  if (!independentFacts) {
    reasons.push("两侧共用同一份 facts-workspace，facts 层指标不能单独证明 rerank 对最终整理质量的影响。");
  }

  return {
    headline: verdictSentence(verdict),
    recommendation: recommendationSentence(verdict, independentFacts),
    reasons,
  };
}

export function buildComparison({ comparisonId, baselineId, outDir, noRerank, rerank, independentFacts }) {
  const metricDeltas = {};
  for (const key of Object.keys(rerank.metrics)) {
    metricDeltas[key] = deltaValue(rerank.metrics[key], noRerank.metrics[key]);
  }
  const verdict = decideVerdict(noRerank, rerank);
  const humanSummary = buildHumanSummary({
    verdict,
    noRerank,
    rerank,
    metricDeltas,
    independentFacts,
  });
  return {
    schema_version: 1,
    comparison_id: comparisonId,
    generated_at: new Date().toISOString(),
    baseline_id: baselineId,
    out_dir: outDir,
    mode: "rerank_ab_full_assessment",
    facts_layer_independent: independentFacts,
    verdict,
    human_summary: humanSummary,
    arms: {
      no_rerank: noRerank,
      rerank,
    },
    metric_deltas: {
      direction: "rerank_minus_no_rerank",
      values: metricDeltas,
    },
  };
}

function formatValue(value) {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (typeof value === "object") return `\`${JSON.stringify(value)}\``;
  return String(value);
}

function formatDelta(value) {
  if (value === null || value === undefined) return "N/A";
  if (value > 0) return `+${formatValue(value)}`;
  return formatValue(value);
}

function markdownTable(rows) {
  return rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\n/g, " ")).join(" | ")} |`).join("\n");
}

export function renderComparisonMarkdown(comparison) {
  const noRerank = comparison.arms.no_rerank;
  const rerank = comparison.arms.rerank;
  const rows = [
    ["指标", "不开 rerank", "开 rerank", "差值（开-不开）"],
    ["---", "---", "---", "---"],
    ["结论", noRerank.conclusion, rerank.conclusion, comparison.verdict],
    ["阅读池 chunk 数", noRerank.metrics.read_pool_chunks, rerank.metrics.read_pool_chunks, formatDelta(comparison.metric_deltas.values.read_pool_chunks)],
    ["R1 critical chunk 召回率", formatValue(noRerank.metrics.retrieval_R1_rate), formatValue(rerank.metrics.retrieval_R1_rate), formatDelta(comparison.metric_deltas.values.retrieval_R1_rate)],
    ["R2 总体 chunk 召回率", formatValue(noRerank.metrics.retrieval_R2_rate), formatValue(rerank.metrics.retrieval_R2_rate), formatDelta(comparison.metric_deltas.values.retrieval_R2_rate)],
    ["R3 空主题数", noRerank.metrics.empty_theme_count, rerank.metrics.empty_theme_count, formatDelta(comparison.metric_deltas.values.empty_theme_count)],
    ["facts critical 丢失", noRerank.metrics.facts_critical_lost, rerank.metrics.facts_critical_lost, formatDelta(comparison.metric_deltas.values.facts_critical_lost)],
    ["facts noncritical 丢失", noRerank.metrics.facts_noncritical_lost, rerank.metrics.facts_noncritical_lost, formatDelta(comparison.metric_deltas.values.facts_noncritical_lost)],
    ["lost_items", noRerank.metrics.lost_items, rerank.metrics.lost_items, formatDelta(comparison.metric_deltas.values.lost_items)],
    ["M3 新增证据 chunk", noRerank.metrics.M3_novel_evidence_chunks, rerank.metrics.M3_novel_evidence_chunks, formatDelta(comparison.metric_deltas.values.M3_novel_evidence_chunks)],
    ["M3 池内基准未用 chunk", noRerank.metrics.M3_novel_pool_chunks, rerank.metrics.M3_novel_pool_chunks, formatDelta(comparison.metric_deltas.values.M3_novel_pool_chunks)],
  ];
  const rerankLogRows = [
    ["指标", "不开 rerank", "开 rerank"],
    ["---", "---", "---"],
    ["请求数", noRerank.rerank_log.request_count, rerank.rerank_log.request_count],
    ["实际 rerank 请求", noRerank.rerank_log.applied_requests, rerank.rerank_log.applied_requests],
    ["阈值过滤 item", noRerank.rerank_log.threshold_filtered_items, rerank.rerank_log.threshold_filtered_items],
    ["跳过原因", formatValue(noRerank.rerank_log.skipped_by_reason), formatValue(rerank.rerank_log.skipped_by_reason)],
  ];
  return [
    "# Rerank A/B 全评对比",
    "",
    `- comparison_id: ${comparison.comparison_id}`,
    `- baseline_id: ${comparison.baseline_id}`,
    `- verdict: ${comparison.verdict}`,
    `- facts_layer_independent: ${comparison.facts_layer_independent ? "true" : "false"}`,
    "",
    "## 人话结论",
    "",
    comparison.human_summary?.headline ?? verdictSentence(comparison.verdict),
    "",
    `建议：${comparison.human_summary?.recommendation ?? "先人工复核关键丢失项。"}`,
    "",
    ...(comparison.human_summary?.reasons ?? []).map((reason) => `- ${reason}`),
    "",
    comparison.facts_layer_independent
      ? "两侧使用各自的 facts-workspace，facts 层指标可用于比较。"
      : "两侧共用同一份 facts-workspace；检索层可比较，facts 层只能作为一致性参考。",
    "",
    "## 核心对比",
    "",
    markdownTable(rows),
    "",
    "## Rerank 日志",
    "",
    markdownTable(rerankLogRows),
    "",
    "## 输出位置",
    "",
    `- no-rerank: ${noRerank.run_dir}`,
    `- rerank: ${rerank.run_dir}`,
    "",
  ].join("\n");
}

async function runArm({ label, armName, rerankEnabled, args, baselineId, baselinePath, outDir, factsPath, htmlDir }) {
  const armDir = path.join(outDir, armName);
  const retrievalWorkspacePath = path.join(armDir, "retrieval-workspace.json");
  const retrievalLogPath = path.join(armDir, "retrieval-log.json");
  fs.mkdirSync(armDir, { recursive: true });

  const logRequests = [];
  const retrievalOptions = {
    ...commonRetrievalOptions(args),
    ...(rerankEnabled ? rerankOnlyOptions(args) : {}),
    rerank: rerankEnabled,
    logRequests,
  };
  const workspace = await createRetrievalWorkspace(factsPath, args.ragIndex, retrievalOptions);
  workspace.source.facts_workspace = relativePath(factsPath, armDir);
  workspace.source.rag_index = relativePath(args.ragIndex, armDir);
  workspace.source.retrieval_log = "retrieval-log.json";
  fs.writeFileSync(retrievalWorkspacePath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  const retrievalLog = retrievalLogDocument(workspace, logRequests);
  writeRetrievalLog(retrievalLogPath, retrievalLog);

  const cliOverrides = cliOverridesForArm(args, rerankEnabled);
  createAssessmentRun({
    baselineId,
    tag: armName,
    runDir: armDir,
    facts: factsPath,
    retrievalWorkspace: retrievalWorkspacePath,
    retrievalLog: retrievalLogPath,
    htmlDir,
    cliOverrides,
  });
  const result = evaluateAssessmentRun({ baselinePath, runDir: armDir });
  return armSummary({
    label,
    armDir,
    factsPath,
    htmlDir,
    workspace,
    log: retrievalLog,
    report: result.report,
    deltas: result.deltas,
    cliOverrides,
  });
}

export async function createRerankAbComparison(rawArgs) {
  const args = typeof rawArgs?.baseline === "string" ? rawArgs : parseArgs(rawArgs);
  const baselinePath = path.resolve(args.baseline);
  const checklist = assertValidChecklist(readJson(baselinePath));
  const noRerankFacts = path.resolve(args.noRerankFacts || args.facts);
  const rerankFacts = path.resolve(args.rerankFacts || args.facts);
  const outDir = path.resolve(
    args.outDir || path.join("assessment/rag-tuning/runs", `${timestampForRunId()}-${checklist.baseline_id}-rerank-ab`),
  );
  fs.mkdirSync(outDir, { recursive: true });

  const noRerank = await runArm({
    label: "不开 rerank",
    armName: "no-rerank",
    rerankEnabled: false,
    args,
    baselineId: checklist.baseline_id,
    baselinePath,
    outDir,
    factsPath: noRerankFacts,
    htmlDir: args.noRerankHtmlDir,
  });
  const rerank = await runArm({
    label: "开 rerank",
    armName: "rerank",
    rerankEnabled: true,
    args,
    baselineId: checklist.baseline_id,
    baselinePath,
    outDir,
    factsPath: rerankFacts,
    htmlDir: args.rerankHtmlDir,
  });
  const comparison = buildComparison({
    comparisonId: path.basename(outDir),
    baselineId: checklist.baseline_id,
    outDir,
    noRerank,
    rerank,
    independentFacts: noRerankFacts !== rerankFacts,
  });
  fs.writeFileSync(path.join(outDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "comparison.md"), renderComparisonMarkdown(comparison), "utf8");
  return comparison;
}

async function main() {
  const comparison = await createRerankAbComparison(process.argv.slice(2));
  console.log(`Rerank A/B ${comparison.verdict}: ${path.join(comparison.out_dir, "comparison.md")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
