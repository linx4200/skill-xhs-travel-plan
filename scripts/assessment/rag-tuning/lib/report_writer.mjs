import fs from "node:fs";
import path from "node:path";
import { isRetrievedAttribution } from "./attribution.mjs";
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

function groupKeyOf(item) {
  return [item?.target_type, item?.target_name ?? "", item?.theme].join("|");
}

/** 冷冻基准清单实际引用过的 chunk 集合。 */
function baselineUsedChunkIds(baselineItems) {
  const ids = new Set();
  for (const item of asList(baselineItems)) {
    for (const id of asList(item?.source_chunk_ids)) ids.add(id);
  }
  return ids;
}

/** 阅读池（retrieval-workspace.json）中出现的全部 chunk id。 */
function workspaceChunkIds(retrievalWorkspace) {
  const ids = new Set();
  const visit = (group) => {
    for (const target of Object.values(group ?? {})) {
      for (const entries of Object.values(target?.themes ?? {})) {
        for (const entry of asList(entries)) {
          const id = typeof entry === "string" ? entry : entry?.chunk_id;
          if (id) ids.add(id);
        }
      }
      for (const id of asList(target?.unique_chunk_ids)) if (id) ids.add(id);
    }
  };
  visit(retrievalWorkspace?.places);
  visit(retrievalWorkspace?.cities);
  return ids;
}

/**
 * 逐 (target_type, target_name, theme) 分组统计「证据新颖度」。
 *
 * 证据是分组级的（同组内候选共享同一组 chunk id），因此以分组为聚合单位天然免疫
 * 「基准条目粒度粗于生成粒度」导致的条数虚增：把一条基准拆成 3 条候选，chunk 集合不变。
 */
function groupNovelty(newItems, baselineItems) {
  const used = baselineUsedChunkIds(baselineItems);
  const byGroup = new Map();
  const allGroups = new Set();
  for (const item of asList(newItems)) {
    const key = groupKeyOf(item);
    allGroups.add(key);
    for (const id of asList(item?.evidence?.source_chunk_ids)) {
      if (used.has(id)) continue;
      if (!byGroup.has(key)) byGroup.set(key, new Set());
      byGroup.get(key).add(id);
    }
  }
  return { used, byGroup, allGroups };
}

/**
 * M3「有效新增」的度量块。
 *
 * 度量单位是**证据 chunk**，不是「条」。原因：基准 checklist 是粗粒度摘要，生成层按字段
 * 展开，二者粒度不可通约；而「某条候选是否携带基准没有的新事实」需要阅读理解，任何词面
 * 或向量比较都无法可靠判定（实测：字符 bigram、整段命中、embedding 余弦三种方法均无法
 * 区分真实重复与真实新增，已知重复项与已知新增项得分重叠）。
 */
export function computeNewItemEffect({ checklist, newItems, retrievalWorkspace }) {
  const baselineItems = asList(checklist?.items);
  const baselineGroups = new Set(baselineItems.map(groupKeyOf));
  const { used, byGroup, allGroups } = groupNovelty(newItems, baselineItems);

  const novelEvidence = new Set();
  for (const ids of byGroup.values()) for (const id of ids) novelEvidence.add(id);
  const pool = workspaceChunkIds(retrievalWorkspace);
  const items = asList(newItems);

  return {
    unit: "evidence_chunk",
    candidate_groups: allGroups.size,
    novel_evidence_chunks: novelEvidence.size,
    novel_evidence_groups: byGroup.size,
    new_topic_groups: [...allGroups].filter((key) => !baselineGroups.has(key)).length,
    read_pool_chunks: pool.size,
    novel_pool_chunks: [...pool].filter((id) => !used.has(id)).length,
    baseline_used_chunks: used.size,
    raw_candidate_items: items.length,
    effective_new_items: items.filter((item) => byGroup.has(groupKeyOf(item))).length,
  };
}

function gate(status, summary, details = {}) {
  return { status, summary, ...details };
}

/**
 * 天花板模式（`capability: "ceiling"`）下 Gate 不判定，只保留数值。
 *
 * 天花板是「你见过的最好产出」的并集，任何单次 run 都不可能全覆盖；拿它当硬门槛
 * 只会得到恒定的 FAIL。因此把 critical 从 fail 条件降级为缺口权重（见
 * `computeCeilingCoverage`），Gate 结论由 `report.coverage` 取代。
 */
function skippedGate(summary, details = {}) {
  return gate("SKIPPED", `${summary}（天花板模式：不判定，仅记录数值）`, details);
}

/** 天花板模式下的缺口权重：critical 是排序权重，不再是通过条件。 */
export const CEILING_CRITICALITY_WEIGHTS = {
  critical: 4,
  "core-quality": 3,
  mid: 2,
  low: 1,
};

/** 层序：越靠上游，缺口越根本，也就越值得优先看。 */
const LAYER_SEQUENCE = ["retrieval", "facts", "render"];

/**
 * 每层的「前置层」。
 *
 * 单看「覆盖 / 全部条目」会把上游的丢失一路传导到下游——facts 没写的东西不可能出现在
 * 页面上，于是呈现层的覆盖率会被 facts 层锁死，看不出模板本身的问题。因此额外给一个
 * 条件覆盖率：分母只算上游已覆盖的条目，衡量**这一层自己**漏了多少。
 */
const CONDITIONAL_ON = { facts: "retrieval", render: "facts" };

function ceilingRate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function truncateText(value, max = 120) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 天花板覆盖率：本次 run 的产出覆盖了天花板清单的多少。
 *
 * 与 Gate 判定的三点区别：
 * 1. 主口径是**覆盖率**，不是通过与否。「未覆盖」是缺口，不是失败。
 * 2. 每条缺口只记**最上游**那一层（`first_missing_layer`）——上游没读到的东西
 *    在下游必然也缺，逐层重复计数会放大缺口。
 * 3. 同时给「条数覆盖率」与「加权覆盖率」（critical 4 / core-quality 3 / mid 2 / low 1），
 *    后者才是「这份产出离理想还差多少」的可比分数。
 */
export function computeCeilingCoverage({ checklist, retrievalEvaluation, factsEvaluation, htmlEvaluation }) {
  const items = asList(checklist?.items);
  const retrievalMap = new Map(asList(retrievalEvaluation?.item_results).map((result) => [result.item_id, result]));
  const factsMap = new Map(asList(factsEvaluation?.item_results).map((result) => [result.item_id, result]));
  const renderMap = new Map(asList(htmlEvaluation?.item_results).map((result) => [result.item_id, result]));
  const renderActive = htmlEvaluation?.status !== "N/A";

  const entries = items.map((item) => {
    const retrieval = retrievalMap.get(item.id);
    const facts = factsMap.get(item.id);
    const render = renderMap.get(item.id);
    const covered = {
      retrieval: retrieval ? Boolean(retrieval.retrieved) : null,
      facts: facts ? Boolean(facts.covered) : null,
      // facts 未覆盖的条目在呈现层不会被评估（html_metrics 会跳过），按未呈现计；
      // 其缺口已在 facts 层记过一次，这里不再重复计入 gaps。
      render: renderActive ? Boolean(render?.rendered) : null,
    };
    const missingLayers = LAYER_SEQUENCE.filter((layer) => covered[layer] === false);
    return {
      item,
      weight: CEILING_CRITICALITY_WEIGHTS[item.criticality] ?? 1,
      covered,
      missingLayers,
      firstMissing: missingLayers[0] ?? null,
    };
  });

  const layerBlock = (layer) => {
    const participants = entries.filter((entry) => entry.covered[layer] !== null);
    const hit = participants.filter((entry) => entry.covered[layer] === true);
    const weightedTotal = sum(...participants.map((entry) => entry.weight));
    const weightedHit = sum(...hit.map((entry) => entry.weight));
    const upstream = CONDITIONAL_ON[layer] ?? null;
    const eligible = upstream ? entries.filter((entry) => entry.covered[upstream] === true) : [];
    const eligibleHit = upstream ? eligible.filter((entry) => entry.covered[layer] === true) : [];
    const eligibleWeightTotal = sum(...eligible.map((entry) => entry.weight));
    const eligibleWeightHit = sum(...eligibleHit.map((entry) => entry.weight));
    return {
      items: participants.length,
      covered: hit.length,
      lost: participants.length - hit.length,
      rate: ceilingRate(hit.length, participants.length),
      weighted_total: weightedTotal,
      weighted_covered: weightedHit,
      weighted_rate: ceilingRate(weightedHit, weightedTotal),
      // 条件覆盖率：上游已覆盖的条目里，本层也覆盖了多少。检索层无上游、或本层整层未参与
      // （例如未提供 HTML）时为 null —— 此时任何比率都是无意义的 0。
      conditional:
        upstream && participants.length > 0
          ? {
              upstream_layer: upstream,
              items: eligible.length,
              covered: eligibleHit.length,
              lost: eligible.length - eligibleHit.length,
              rate: ceilingRate(eligibleHit.length, eligible.length),
              weighted_total: eligibleWeightTotal,
              weighted_covered: eligibleWeightHit,
              weighted_rate: ceilingRate(eligibleWeightHit, eligibleWeightTotal),
            }
          : null,
    };
  };

  const byCriticality = {};
  for (const entry of entries) {
    const key = entry.item.criticality;
    const bucket = (byCriticality[key] = byCriticality[key] ?? {
      weight: entry.weight,
      items: 0,
      retrieval_covered: 0,
      facts_covered: 0,
      render_covered: 0,
      fully_covered: 0,
      gap_weight: 0,
    });
    bucket.items += 1;
    for (const layer of LAYER_SEQUENCE) if (entry.covered[layer] === true) bucket[`${layer}_covered`] += 1;
    if (entry.firstMissing) bucket.gap_weight += entry.weight;
    else bucket.fully_covered += 1;
  }

  const gaps = entries
    .filter((entry) => entry.firstMissing)
    .map((entry) => {
      const retrievalResult = retrievalMap.get(entry.item.id);
      const firstRetrievalMiss = asList(retrievalResult?.chunk_results).find((chunk) => !isRetrievedAttribution(chunk));
      return {
        item_id: entry.item.id,
        target_type: entry.item.target_type,
        target_name: entry.item.target_name ?? "",
        theme: entry.item.theme,
        criticality: entry.item.criticality,
        weight: entry.weight,
        first_missing_layer: entry.firstMissing,
        missing_layers: entry.missingLayers,
        attribution_code:
          entry.firstMissing === "retrieval" ? firstRetrievalMiss?.attribution_code ?? "unknown" : `${entry.firstMissing}_drop`,
        text: truncateText(entry.item.text),
      };
    })
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        LAYER_SEQUENCE.indexOf(a.first_missing_layer) - LAYER_SEQUENCE.indexOf(b.first_missing_layer) ||
        a.target_name.localeCompare(b.target_name, "zh") ||
        a.item_id.localeCompare(b.item_id),
    );

  const totalWeight = sum(...entries.map((entry) => entry.weight));
  const gapWeight = sum(...gaps.map((gap) => gap.weight));
  const fullyCovered = entries.filter((entry) => !entry.firstMissing).length;

  const gapByLayer = {};
  for (const layer of LAYER_SEQUENCE) gapByLayer[layer] = gaps.filter((gap) => gap.first_missing_layer === layer).length;

  return {
    mode: "ceiling",
    unit: "checklist_item",
    criticality_weights: CEILING_CRITICALITY_WEIGHTS,
    layer_order: LAYER_SEQUENCE,
    items: entries.length,
    fully_covered: fullyCovered,
    fully_covered_rate: ceilingRate(fullyCovered, entries.length),
    total_weight: totalWeight,
    gap_weight: gapWeight,
    weighted_coverage: ceilingRate(totalWeight - gapWeight, totalWeight),
    layers: {
      retrieval: layerBlock("retrieval"),
      facts: layerBlock("facts"),
      render: layerBlock("render"),
    },
    by_criticality: byCriticality,
    gaps: {
      total: gaps.length,
      by_layer: gapByLayer,
      items: gaps,
    },
  };
}

function gateStatus(condition) {
  return condition ? "PASS" : "FAIL";
}

function semanticMinimum(semanticScores) {
  const values = asList(semanticScores).flatMap((entry) => Object.values(entry?.scores ?? {}));
  if (!values.length) return null;
  return Math.min(...values);
}

function collectNotes({ retrievalEvaluation, factsEvaluation, htmlEvaluation, adjudications, deltas, semantic_minimum, ceiling = false }) {
  const notes = [];
  if (ceiling) {
    notes.push("天花板模式：Gate 全部跳过、不产生通过结论，判据是 report.coverage 的分层覆盖率与缺口清单。");
  }
  if (retrievalEvaluation?.degraded_attribution) notes.push("检索日志缺失或未接入，归因处于降级模式。");
  // N2 是覆盖缺口；天花板下覆盖不全属预期，已由 coverage 承载，不再重复报警。
  if (!ceiling && factsEvaluation?.metrics?.N2?.noncritical_lost > 0) notes.push("存在非 critical 条目未进入 facts。");
  if (
    ceiling &&
    htmlEvaluation?.status !== "N/A" &&
    htmlEvaluation?.mechanical?.status === "FAIL"
  ) {
    notes.push("HTML 机械校验失败。天花板模式未把它计入 Gate，但这是客观缺陷，应先修。");
  }
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
  // effective_new 以「该分组是否带来基准未使用过的证据」为准，不再恒为 true。
  const { byGroup } = groupNovelty(candidates, baselineItems);
  for (const candidate of candidates) {
    candidate.effective_new = byGroup.has(groupKeyOf(candidate));
  }
  return candidates;
}

export function createDeltas({
  checklist,
  runId,
  retrievalEvaluation,
  factsEvaluation,
  htmlEvaluation,
  newItems = [],
  newItemEffect = null,
}) {
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
    new_item_effect: newItemEffect,
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

  // 天花板模式：B1/B2 的判定链路完全不动，只在这里分流。
  const ceiling = checklist?.capability === "ceiling";
  const coverage = ceiling
    ? computeCeilingCoverage({ checklist, retrievalEvaluation, factsEvaluation, htmlEvaluation })
    : null;

  const gates = ceiling
    ? {
        G1: htmlEvaluation?.status === "N/A"
          ? gate("N/A", "未提供 HTML，跳过呈现机械校验。")
          : skippedGate("HTML 机械校验。", {
              mechanical_status: htmlEvaluation?.mechanical?.status ?? "FAIL",
              verify_error_count: asList(htmlEvaluation?.mechanical?.verifyErrors).length,
            }),
        G2: skippedGate("critical 条目零丢失。", {
          retrieval_lost: criticalRetrievalLost,
          facts_lost: criticalFactsLost,
          render_lost: criticalRenderLost,
        }),
        G3: skippedGate("高置信归位错误为 0。", { misplaced_items: misplacedItems }),
        G4: skippedGate("关键类越界事实为 0。", { unsupported_facts: unsupportedFacts }),
      }
    : {
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
  const notes = collectNotes({
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
    adjudications,
    deltas,
    semantic_minimum,
    ceiling,
  });
  const conclusion = ceiling ? "CEILING" : hardFailed ? "FAIL" : notes.length ? "PASS_WITH_NOTES" : "PASS";

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
      M3: deltas.new_item_effect ?? null,
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
    recommendations: ceiling
      ? ceilingRecommendationList(coverage)
      : recommendationList({ gates, retrievalEvaluation, factsEvaluation, htmlEvaluation }),
  };
  // 非 ceiling 模式的 report 结构与改动前逐字段一致（不新增字段）。
  if (coverage) report.coverage = coverage;
  assertValidReport(report);
  return report;
}

function formatRate(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function ceilingRecommendationList(coverage) {
  if (!coverage) return ["未计算覆盖率。"];
  const recommendations = [];
  const { retrieval, facts, render } = coverage.layers;
  if (retrieval.lost > 0) {
    recommendations.push(
      `检索层缺口 ${retrieval.lost} 项（加权覆盖率 ${formatRate(retrieval.weighted_rate)}）：先看 R4 归因分布，区分关键词未命中 / 打分不足 / topk 截断 / 配额掉落。`,
    );
  }
  if (facts.lost > 0) {
    const alreadyRead = facts.conditional?.lost ?? 0;
    recommendations.push(
      `facts 层缺口 ${facts.lost} 项（加权覆盖率 ${formatRate(facts.weighted_rate)}）：其中 ${alreadyRead} 项是「已读到但未写进 facts」` +
        `（层内转化 ${formatRate(facts.conditional?.rate ?? null)}），属整理层取舍；其余是上游检索未命中。`,
    );
  }
  if (render.lost > 0) {
    const inner = render.conditional;
    const innerLost = inner?.lost ?? 0;
    recommendations.push(
      `呈现层缺口 ${render.lost} 项，其中只有 ${innerLost} 项是「已进 facts 但没上页面」（层内转化 ${formatRate(inner?.rate ?? null)}）：` +
        (innerLost === 0 ? "模板映射无漏损，缺口全部来自上游。" : "需检查模板字段映射与页面归位。"),
    );
  }
  const topCritical = asList(coverage.gaps?.items).filter((gap) => gap.criticality === "critical").slice(0, 3);
  if (topCritical.length) {
    recommendations.push(
      `最高权重缺口（critical）：${topCritical.map((gap) => `${gap.target_name || "全局"}·${gap.theme}`).join("、")}。`,
    );
  }
  if (!recommendations.length) recommendations.push("三层全部覆盖，已触及天花板。");
  return recommendations;
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

const CEILING_LAYER_LABELS = { retrieval: "检索层", facts: "facts 层", render: "呈现层" };

/** 天花板模式专属段落：分层覆盖率 + 按 criticality 分解 + 缺口清单。 */
function renderCeilingSections(coverage) {
  const layerRows = [
    ["层", "覆盖 / 参与", "覆盖率", "加权覆盖率", "层内转化（分母 = 上游已覆盖）"],
    ["---", "---", "---", "---", "---"],
    ...coverage.layer_order.map((key) => {
      const block = coverage.layers[key];
      const conditional = block.conditional;
      return [
        CEILING_LAYER_LABELS[key],
        `${block.covered} / ${block.items}`,
        formatRate(block.rate),
        formatRate(block.weighted_rate),
        conditional ? `${conditional.covered} / ${conditional.items} = ${formatRate(conditional.rate)}` : "—",
      ];
    }),
  ];
  const criticalityRows = [
    ["criticality", "权重", "条目", "检索层覆盖", "facts 层覆盖", "呈现层覆盖", "全层覆盖", "缺口权重"],
    ["---", "---", "---", "---", "---", "---", "---", "---"],
    ...Object.entries(coverage.by_criticality).map(([key, bucket]) => [
      key,
      bucket.weight,
      bucket.items,
      bucket.retrieval_covered,
      bucket.facts_covered,
      bucket.render_covered,
      bucket.fully_covered,
      bucket.gap_weight,
    ]),
  ];
  const gapRows = [
    ["#", "权重", "首断层", "criticality", "目标", "主题", "归因", "内容摘要"],
    ["---", "---", "---", "---", "---", "---", "---", "---"],
    ...coverage.gaps.items.slice(0, 40).map((gap, index) => [
      index + 1,
      gap.weight,
      CEILING_LAYER_LABELS[gap.first_missing_layer] ?? gap.first_missing_layer,
      gap.criticality,
      gap.target_name || "-",
      gap.theme,
      gap.attribution_code,
      gap.text,
    ]),
  ];
  const moreGaps =
    coverage.gaps.items.length > 40
      ? `（仅显示前 40 条；完整 ${coverage.gaps.items.length} 条见 report.json 的 \`coverage.gaps.items\`）`
      : "";

  return [
    "## 分层覆盖率",
    "",
    markdownTable(layerRows),
    "",
    `全部三层覆盖的条目：${coverage.fully_covered} / ${coverage.items}（${formatRate(coverage.fully_covered_rate)}）；` +
      `整体加权覆盖率 ${formatRate(coverage.weighted_coverage)}（权重：critical 4 / core-quality 3 / mid 2 / low 1）。`,
    "「覆盖率」分母是全部天花板条目，衡量离理想并集有多远；「层内转化」分母只算上游已覆盖的条目，衡量这一层自己漏了多少。",
    "调 RAG 参数时只看检索层与 facts 层（检索层管材料广度、facts 层管整理效率）；呈现层受模板影响，会污染参数排序。",
    "",
    "## 按 criticality 分解",
    "",
    markdownTable(criticalityRows),
    "",
    "## 缺口清单（按权重排序，每条只记最上游丢失的层）",
    "",
    gapRows.length > 2 ? markdownTable(gapRows) : "- 无缺口",
    "",
    ...(moreGaps ? [moreGaps, ""] : []),
  ];
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
    ["候选", "主题", "目标", "证据 chunk", "证据判定"],
    ["---", "---", "---", "---", "---"],
    ...asList(deltas.new_items).slice(0, 20).map((item) => [
      item.item_id,
      item.theme,
      `${item.target_type}:${item.target_name ?? ""}`,
      asList(item.evidence?.source_chunk_ids).join(", "),
      item.effective_new ? "该分组含基准未使用的证据" : "证据已被基准用过",
    ]),
  ];
  const m3 = report.metrics.M3;
  const m3Rows = m3
    ? [
        ["指标", "值"],
        ["---", "---"],
        ["度量单位", m3.unit],
        ["候选分组数 (target×theme)", m3.candidate_groups],
        ["新增证据 chunk 数", m3.novel_evidence_chunks],
        ["含新增证据的分组数", `${m3.novel_evidence_groups} / ${m3.candidate_groups}`],
        ["基准无对应分组的全新覆盖数", m3.new_topic_groups],
        ["阅读池 chunk 数", m3.read_pool_chunks],
        ["阅读池中基准未使用 chunk 数", m3.novel_pool_chunks],
        ["基准已使用 chunk 数", m3.baseline_used_chunks],
        ["原始候选条数（诊断，粒度不齐不可计分）", m3.raw_candidate_items],
        ["有效新增条数（诊断，粒度不齐不可计分）", m3.effective_new_items],
      ]
    : null;
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

  const header = [
    `- run_id: ${report.run_id}`,
    `- baseline_id: ${report.baseline_id}`,
    `- conclusion: ${report.conclusion}`,
  ];
  const m3Section = [
    "## M3 有效新增（证据单位）",
    "",
    ...(m3Rows ? [markdownTable(m3Rows)] : ["- N/A（未提供 retrieval workspace，M3 未计算）"]),
    "",
  ];
  const tailSection = [
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
  ];

  if (report.coverage) {
    return [
      "# RAG 天花板覆盖率报告",
      "",
      ...header,
      `- mode: ceiling（目标函数，不做通过判定）`,
      "",
      "> 天花板模式下 4 个 Gate 全部跳过：天花板是各批次优点的并集，任何单次 run 都覆盖不全，",
      "> 拿它当硬门槛只会恒得 FAIL。判据是下方「分层覆盖率」与「缺口清单」。",
      "",
      ...renderCeilingSections(report.coverage),
      "## 核心指标",
      "",
      markdownTable(metricRows),
      "",
      "## Gate（跳过判定，仅记录数值）",
      "",
      markdownTable(gateRows),
      "",
      ...m3Section,
      ...tailSection,
    ].join("\n");
  }

  return [
    `# RAG 调参评估报告`,
    "",
    ...header,
    "",
    "## Gate",
    "",
    markdownTable(gateRows),
    "",
    "## 核心指标",
    "",
    markdownTable(metricRows),
    "",
    ...m3Section,
    ...tailSection,
  ].join("\n");
}

export function writeAssessmentOutputs(runDir, { report, deltas }) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "deltas.json"), `${JSON.stringify(deltas, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDir, "report.md"), renderReportMarkdown(report, deltas), "utf8");
}
