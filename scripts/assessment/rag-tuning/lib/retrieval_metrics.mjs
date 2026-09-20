import { attributeChunkRetrieval, isRetrievedAttribution } from "./attribution.mjs";

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function targetGroup(retrievalWorkspace, targetType) {
  if (targetType === "place") return retrievalWorkspace?.places ?? {};
  if (targetType === "city") return retrievalWorkspace?.cities ?? {};
  return {};
}

function targetEntry(retrievalWorkspace, item) {
  return targetGroup(retrievalWorkspace, item.target_type)?.[item.target_name] ?? null;
}

function isTargetThemeItem(item) {
  return (item.target_type === "place" || item.target_type === "city") && item.target_name && item.theme;
}

function themeIsEmpty(retrievalWorkspace, item) {
  const target = targetEntry(retrievalWorkspace, item);
  return asList(target?.themes?.[item.theme]).length === 0;
}

function attributionDistribution(chunkResults) {
  const distribution = {};
  for (const result of chunkResults) {
    if (isRetrievedAttribution(result)) continue;
    distribution[result.attribution_code] = (distribution[result.attribution_code] ?? 0) + 1;
  }
  return distribution;
}

function itemResult(item, chunkResults) {
  const retrievedChunkIds = chunkResults.filter(isRetrievedAttribution).map((result) => result.chunk_id);
  const missing = chunkResults.filter((result) => !isRetrievedAttribution(result));
  return {
    item_id: item.id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    retrieved: retrievedChunkIds.length > 0,
    source_chunk_count: chunkResults.length,
    retrieved_chunk_ids: retrievedChunkIds,
    missing_chunk_ids: missing.map((result) => result.chunk_id),
    chunk_results: chunkResults,
  };
}

function lostItemDelta(item, result) {
  const firstMissing = result.chunk_results.find((chunk) => !isRetrievedAttribution(chunk));
  return {
    item_id: item.id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    layer: "retrieval",
    attribution_code: firstMissing?.attribution_code ?? "unknown",
    evidence: {
      missing_chunk_ids: result.missing_chunk_ids,
      text: item.text,
    },
    suggestion: firstMissing?.suggestion ?? "需要人工复查检索层状态。",
  };
}

function attributionItems(results) {
  const items = [];
  for (const result of results) {
    for (const chunk of result.chunk_results) {
      if (isRetrievedAttribution(chunk)) continue;
      items.push({
        item_id: result.item_id,
        target_type: result.target_type,
        target_name: result.target_name,
        theme: result.theme,
        criticality: result.criticality,
        layer: "retrieval",
        attribution_code: chunk.attribution_code,
        evidence: chunk.evidence,
        suggestion: chunk.suggestion,
      });
    }
  }
  return items;
}

export function evaluateRetrievalLayer(checklist, retrievalWorkspace, retrievalLog = null) {
  const items = asList(checklist?.items);
  const results = [];
  const allChunkResults = [];

  for (const item of items) {
    const chunkResults = asList(item.source_chunk_ids).map((chunkId) =>
      attributeChunkRetrieval({ item, chunkId, retrievalWorkspace, retrievalLog }),
    );
    allChunkResults.push(...chunkResults);
    results.push(itemResult(item, chunkResults));
  }

  const criticalResults = results.filter((result) => result.criticality === "critical");
  const criticalRetained = criticalResults.filter((result) => result.retrieved).length;
  const criticalChunkResults = allChunkResults.filter((chunk) => {
    const item = items.find((candidate) => candidate.id === chunk.item_id);
    return item?.criticality === "critical";
  });
  const retrievedCriticalChunks = criticalChunkResults.filter(isRetrievedAttribution).length;
  const retrievedAllChunks = allChunkResults.filter(isRetrievedAttribution).length;

  const targetThemes = new Map();
  for (const item of items.filter(isTargetThemeItem)) {
    targetThemes.set(`${item.target_type}:${item.target_name}:${item.theme}`, item);
  }
  const emptyTargetThemes = [...targetThemes.values()].filter((item) => themeIsEmpty(retrievalWorkspace, item));

  const lostItems = results
    .filter((result) => !result.retrieved)
    .map((result) => lostItemDelta(items.find((item) => item.id === result.item_id), result));

  return {
    schema_version: 1,
    baseline_id: checklist?.baseline_id ?? "",
    degraded_attribution: !retrievalLog,
    metrics: {
      CIR: {
        critical_items: criticalResults.length,
        retained: criticalRetained,
        lost: criticalResults.length - criticalRetained,
        rate: rate(criticalRetained, criticalResults.length),
      },
      R1: {
        critical_source_chunks: criticalChunkResults.length,
        retrieved: retrievedCriticalChunks,
        lost: criticalChunkResults.length - retrievedCriticalChunks,
        rate: rate(retrievedCriticalChunks, criticalChunkResults.length),
      },
      R2: {
        source_chunks: allChunkResults.length,
        retrieved: retrievedAllChunks,
        lost: allChunkResults.length - retrievedAllChunks,
        rate: rate(retrievedAllChunks, allChunkResults.length),
      },
      R3: {
        target_theme_count: targetThemes.size,
        empty_theme_count: emptyTargetThemes.length,
        rate: rate(emptyTargetThemes.length, targetThemes.size),
        empty_themes: emptyTargetThemes.map((item) => ({
          target_type: item.target_type,
          target_name: item.target_name,
          theme: item.theme,
        })),
      },
      R4: attributionDistribution(allChunkResults),
    },
    item_results: results,
    lost_items: lostItems,
    attribution: attributionItems(results),
  };
}
