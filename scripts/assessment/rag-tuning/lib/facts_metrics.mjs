function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).replace(/[，。；、：:,.!！?？\s"'“”‘’（）()[\]{}<>《》-]/g, "");
}

function valueTexts(value) {
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string" || typeof value === "number") return [cleanText(value)];
  if (Array.isArray(value)) return value.flatMap(valueTexts);
  if (typeof value === "object") {
    const texts = [];
    for (const key of ["title", "summary", "text", "note", "details"]) texts.push(...valueTexts(value[key]));
    return texts;
  }
  return [];
}

function allTargetTexts(target) {
  if (!target || typeof target !== "object") return [];
  const texts = [];
  for (const [key, value] of Object.entries(target)) {
    if (["source_files", "photos", "elevation_source_url", "elevation_checked_at"].includes(key)) continue;
    texts.push(...valueTexts(value));
  }
  return texts.filter(Boolean);
}

function dayTarget(facts, targetName) {
  const dayNumber = Number(String(targetName).match(/\d+/)?.[0]);
  if (!Number.isFinite(dayNumber)) return null;
  return asList(facts?.trip?.days).find((day) => Number(day.day) === dayNumber) ?? null;
}

function factsTarget(facts, item) {
  if (item.target_type === "place") return facts?.places?.[item.target_name] ?? null;
  if (item.target_type === "city") return facts?.cities?.[item.target_name] ?? null;
  if (item.target_type === "day") return dayTarget(facts, item.target_name);
  if (item.target_type === "global") {
    return {
      global_notes: facts?.global_notes ?? [],
      confirm_before_departure: facts?.confirm_before_departure ?? [],
    };
  }
  return null;
}

function targetTextBundle(facts, item) {
  const target = factsTarget(facts, item);
  const texts = allTargetTexts(target);
  return {
    target_exists: Boolean(target),
    texts,
    normalized_texts: texts.map(normalizeText),
    normalized_joined: normalizeText(texts.join(" ")),
  };
}

function hintMatches(item, bundle) {
  const hints = asList(item.match_hints).map(normalizeText).filter((hint) => hint.length >= 2);
  if (!hints.length) return { matched: [], total: 0, ratio: 0 };
  const matched = hints.filter((hint) => bundle.normalized_joined.includes(hint));
  return {
    matched,
    total: hints.length,
    ratio: matched.length / hints.length,
  };
}

function textTokenRatio(item, bundle) {
  const tokens = normalizeText(item.text)
    .split(/[；;]/)
    .flatMap((part) => part.split(/[，。、]/))
    .map(cleanText)
    .map(normalizeText)
    .filter((part) => part.length >= 4);
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => bundle.normalized_joined.includes(token));
  return matched.length / tokens.length;
}

export function assessFactsCoverage(item, facts) {
  const bundle = targetTextBundle(facts, item);
  const normalizedItemText = normalizeText(item.text);
  if (!bundle.target_exists) {
    return {
      covered: false,
      confidence: "none",
      reason: "target_not_found",
      matched_hints: [],
      target_texts: [],
    };
  }
  if (normalizedItemText && bundle.normalized_joined.includes(normalizedItemText)) {
    return {
      covered: true,
      confidence: "high",
      reason: "exact_item_text_found",
      matched_hints: asList(item.match_hints),
      target_texts: bundle.texts,
    };
  }

  const hints = hintMatches(item, bundle);
  if (hints.total && hints.ratio >= 0.5) {
    return {
      covered: true,
      confidence: "low",
      reason: "match_hints_found",
      matched_hints: hints.matched,
      target_texts: bundle.texts,
    };
  }

  const tokenRatio = textTokenRatio(item, bundle);
  if (tokenRatio >= 0.5) {
    return {
      covered: true,
      confidence: "low",
      reason: "partial_text_overlap",
      matched_hints: hints.matched,
      target_texts: bundle.texts,
    };
  }

  return {
    covered: false,
    confidence: "none",
    reason: "item_text_not_found",
    matched_hints: hints.matched,
    target_texts: bundle.texts,
  };
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function retrievalByItem(retrievalEvaluation) {
  const map = new Map();
  for (const result of asList(retrievalEvaluation?.item_results)) map.set(result.item_id, result);
  return map;
}

function itemResult(item, coverage, retrievalResult) {
  return {
    item_id: item.id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    covered: coverage.covered,
    confidence: coverage.confidence,
    reason: coverage.reason,
    retrieved: retrievalResult ? Boolean(retrievalResult.retrieved) : null,
    matched_hints: coverage.matched_hints,
  };
}

function factsDropDelta(item, result) {
  return {
    item_id: item.id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    layer: "facts",
    attribution_code: "facts_drop",
    evidence: {
      text: item.text,
      facts_reason: result.reason,
      retrieved: result.retrieved,
    },
    suggestion: "该项已进入阅读池但未进入 facts-workspace.json，应在资料整理层补写或人工确认取舍。",
  };
}

export function evaluateFactsLayer(checklist, facts, retrievalEvaluation = null) {
  const retrievalMap = retrievalByItem(retrievalEvaluation);
  const results = [];
  for (const item of asList(checklist?.items)) {
    const coverage = assessFactsCoverage(item, facts);
    results.push(itemResult(item, coverage, retrievalMap.get(item.id)));
  }

  const criticalResults = results.filter((result) => result.criticality === "critical");
  const criticalCovered = criticalResults.filter((result) => result.covered).length;
  const nonCriticalResults = results.filter((result) => result.criticality !== "critical");
  const nonCriticalLost = nonCriticalResults.filter((result) => !result.covered).length;
  const lowConfidence = results.filter((result) => result.covered && result.confidence === "low");
  const factsDrops = results.filter((result) => !result.covered && result.retrieved !== false);
  const retrievedFactsDrops = results.filter((result) => !result.covered && result.retrieved === true);

  return {
    schema_version: 1,
    baseline_id: checklist?.baseline_id ?? "",
    metrics: {
      CIR: {
        critical_items: criticalResults.length,
        retained: criticalCovered,
        lost: criticalResults.length - criticalCovered,
        rate: rate(criticalCovered, criticalResults.length),
      },
      N1: {
        critical_lost: criticalResults.length - criticalCovered,
      },
      N2: {
        noncritical_lost: nonCriticalLost,
      },
      N3: {
        misplaced_items: 0,
      },
      N7: {
        actionability: null,
      },
      low_confidence_count: lowConfidence.length,
      facts_drop_count: factsDrops.length,
      retrieved_facts_drop_count: retrievedFactsDrops.length,
    },
    item_results: results,
    lost_items: factsDrops.map((result) => factsDropDelta(asList(checklist?.items).find((item) => item.id === result.item_id), result)),
    adjudication_needed: lowConfidence.map((result) => ({
      item_id: result.item_id,
      target_type: result.target_type,
      target_name: result.target_name,
      theme: result.theme,
      criticality: result.criticality,
      reason: result.reason,
      matched_hints: result.matched_hints,
    })),
  };
}
