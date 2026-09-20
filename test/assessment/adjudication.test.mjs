import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCoverageOverrides,
  createAdjudicationSkeleton,
} from "../../scripts/assessment/rag-tuning/lib/adjudication.mjs";
import { assertValidAdjudications } from "../../scripts/assessment/rag-tuning/lib/schemas.mjs";

test("createAdjudicationSkeleton creates review items for low-confidence coverage", () => {
  const skeleton = createAdjudicationSkeleton("run-1", {
    adjudication_needed: [
      {
        item_id: "item-1",
        target_type: "place",
        target_name: "A地方",
        theme: "highlights",
        criticality: "core-quality",
        reason: "match_hints_found",
        matched_hints: ["峡谷观景台"],
      },
    ],
  });

  assert.doesNotThrow(() => assertValidAdjudications(skeleton));
  assert.equal(skeleton.coverage_review_items.length, 1);
  assert.equal(skeleton.coverage_review_items[0].current_assessment, "covered_low_confidence");
});

test("applyCoverageOverrides updates coverage and critical metrics", () => {
  const result = applyCoverageOverrides(
    {
      metrics: {},
      item_results: [
        {
          item_id: "critical-1",
          criticality: "critical",
          covered: false,
        },
        {
          item_id: "mid-1",
          criticality: "mid",
          covered: true,
        },
      ],
    },
    {
      coverage_overrides: [
        {
          item_id: "critical-1",
          facts_covered: true,
          reason: "人工确认 facts 已覆盖。",
        },
      ],
    },
  );

  assert.equal(result.item_results.find((item) => item.item_id === "critical-1").covered, true);
  assert.deepEqual(result.metrics.N1, { critical_lost: 0 });
  assert.deepEqual(result.metrics.N2, { noncritical_lost: 0 });
  assert.equal(result.metrics.CIR.rate, 1);
});
