function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

export function createAdjudicationSkeleton(runId, factsEvaluation) {
  const reviewItems = asList(factsEvaluation?.adjudication_needed).map((item) => ({
    item_id: item.item_id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    current_assessment: "covered_low_confidence",
    reason: item.reason,
    matched_hints: item.matched_hints,
  }));

  return {
    schema_version: 1,
    run_id: runId,
    coverage_overrides: [],
    semantic_scores: [],
    coverage_review_items: reviewItems,
  };
}

export function applyCoverageOverrides(factsEvaluation, adjudications) {
  const overrides = new Map(asList(adjudications?.coverage_overrides).map((item) => [item.item_id, item]));
  const itemResults = asList(factsEvaluation?.item_results).map((result) => {
    const override = overrides.get(result.item_id);
    if (!override) return result;
    return {
      ...result,
      covered: Boolean(override.facts_covered),
      confidence: "adjudicated",
      adjudication_reason: override.reason,
    };
  });
  const criticalResults = itemResults.filter((result) => result.criticality === "critical");
  const criticalCovered = criticalResults.filter((result) => result.covered).length;
  const nonCriticalLost = itemResults.filter((result) => result.criticality !== "critical" && !result.covered).length;

  return {
    ...factsEvaluation,
    item_results: itemResults,
    metrics: {
      ...factsEvaluation.metrics,
      CIR: {
        critical_items: criticalResults.length,
        retained: criticalCovered,
        lost: criticalResults.length - criticalCovered,
        rate: criticalResults.length ? Number((criticalCovered / criticalResults.length).toFixed(4)) : null,
      },
      N1: {
        critical_lost: criticalResults.length - criticalCovered,
      },
      N2: {
        noncritical_lost: nonCriticalLost,
      },
    },
  };
}
