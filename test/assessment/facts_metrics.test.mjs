import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateFactsLayer } from "../../scripts/assessment/rag-tuning/lib/facts_metrics.mjs";

function checklist() {
  return {
    schema_version: 1,
    baseline_id: "B1",
    items: [
      {
        id: "critical-covered",
        text: "门票需出行前确认。",
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        criticality: "critical",
        match_hints: ["门票", "出行前确认"],
      },
      {
        id: "core-low-confidence",
        text: "峡谷观景台值得专门停留。",
        target_type: "place",
        target_name: "A地方",
        theme: "highlights",
        criticality: "core-quality",
        match_hints: ["峡谷观景台", "专门停留"],
      },
      {
        id: "critical-facts-drop",
        text: "停车场在游客中心旁。",
        target_type: "place",
        target_name: "A地方",
        theme: "transport",
        criticality: "critical",
        match_hints: ["停车场", "游客中心"],
      },
      {
        id: "retrieval-miss",
        text: "洞内路面湿滑。",
        target_type: "place",
        target_name: "A地方",
        theme: "safety",
        criticality: "critical",
        match_hints: ["洞内", "湿滑"],
      },
    ],
  };
}

function facts() {
  return {
    places: {
      A地方: {
        tickets: ["门票需出行前确认。"],
        highlights: ["峡谷观景台适合停留拍照。"],
        practical_info: [],
        notes: [],
      },
    },
  };
}

function retrievalEvaluation() {
  return {
    item_results: [
      { item_id: "critical-covered", retrieved: true },
      { item_id: "core-low-confidence", retrieved: true },
      { item_id: "critical-facts-drop", retrieved: true },
      { item_id: "retrieval-miss", retrieved: false },
    ],
  };
}

test("evaluateFactsLayer separates covered, low-confidence, facts_drop, and retrieval misses", () => {
  const result = evaluateFactsLayer(checklist(), facts(), retrievalEvaluation());

  assert.deepEqual(result.metrics.CIR, {
    critical_items: 3,
    retained: 1,
    lost: 2,
    rate: 0.3333,
  });
  assert.equal(result.metrics.N1.critical_lost, 2);
  assert.equal(result.metrics.N2.noncritical_lost, 0);
  assert.equal(result.metrics.low_confidence_count, 1);
  assert.equal(result.metrics.facts_drop_count, 1);
  assert.equal(result.metrics.retrieved_facts_drop_count, 1);

  const covered = result.item_results.find((item) => item.item_id === "critical-covered");
  assert.equal(covered.covered, true);
  assert.equal(covered.confidence, "high");

  const lowConfidence = result.item_results.find((item) => item.item_id === "core-low-confidence");
  assert.equal(lowConfidence.covered, true);
  assert.equal(lowConfidence.confidence, "low");
  assert.equal(result.adjudication_needed.length, 1);

  assert.deepEqual(
    result.lost_items.map((item) => item.item_id),
    ["critical-facts-drop"],
  );
  assert.equal(result.lost_items.find((item) => item.item_id === "critical-facts-drop").attribution_code, "facts_drop");
});

test("evaluateFactsLayer supports day and global targets", () => {
  const result = evaluateFactsLayer(
    {
      schema_version: 1,
      baseline_id: "B1",
      items: [
        {
          id: "day-note",
          text: "当天需要控制返程时间。",
          target_type: "day",
          target_name: "day-01",
          theme: "routes",
          criticality: "core-quality",
          match_hints: ["返程时间"],
        },
        {
          id: "global-note",
          text: "雨天优先穿防滑鞋。",
          target_type: "global",
          target_name: "global",
          theme: "safety",
          criticality: "critical",
          match_hints: ["防滑鞋"],
        },
      ],
    },
    {
      trip: {
        days: [{ day: 1, notes: ["当天需要控制返程时间。"] }],
      },
      global_notes: ["雨天优先穿防滑鞋。"],
      confirm_before_departure: [],
    },
  );

  assert.equal(result.metrics.CIR.rate, 1);
  assert.equal(result.lost_items.length, 0);
});
