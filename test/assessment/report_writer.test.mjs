import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeltas,
  createNewItemDeltas,
  createReport,
  renderReportMarkdown,
} from "../../scripts/assessment/rag-tuning/lib/report_writer.mjs";

function checklist() {
  return {
    schema_version: 1,
    baseline_id: "B1",
    baseline_name: "smoke",
    items: [
      {
        id: "item-1",
        text: "门票需确认。",
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        criticality: "critical",
      },
    ],
  };
}

test("createReport keeps report JSON and markdown conclusion aligned", () => {
  const deltas = createDeltas({
    checklist: checklist(),
    runId: "run-1",
    retrievalEvaluation: {
      metrics: {
        CIR: { lost: 0 },
      },
      lost_items: [],
      attribution: [],
    },
    factsEvaluation: {
      metrics: {
        N1: { critical_lost: 0 },
        N2: { noncritical_lost: 0 },
        N3: { misplaced_items: 0 },
        low_confidence_count: 0,
      },
      lost_items: [],
    },
    htmlEvaluation: {
      status: "N/A",
      metrics: {
        CIR: { lost: 0 },
        N3: { misplaced_items: 0 },
      },
      lost_items: [],
    },
  });

  const report = createReport({
    checklist: checklist(),
    runManifest: { run_id: "run-1" },
    retrievalEvaluation: {
      metrics: {
        CIR: { lost: 0 },
        R1: { rate: 1 },
        R2: { rate: 1 },
      },
      lost_items: [],
      attribution: [],
    },
    factsEvaluation: {
      metrics: {
        N1: { critical_lost: 0 },
        N2: { noncritical_lost: 0 },
        N3: { misplaced_items: 0 },
        low_confidence_count: 0,
      },
      lost_items: [],
    },
    htmlEvaluation: {
      status: "N/A",
      metrics: {
        CIR: { lost: 0 },
        N3: { misplaced_items: 0 },
      },
      lost_items: [],
    },
    adjudications: { semantic_scores: [] },
    deltas,
  });

  assert.equal(report.conclusion, "PASS");
  const markdown = renderReportMarkdown(report, deltas);
  assert.match(markdown, /conclusion: PASS/);
});

test("createNewItemDeltas emits upgrade candidates without downgrading PASS", () => {
  const baseline = checklist();
  const newItems = createNewItemDeltas({
    checklist: baseline,
    runManifest: {
      run_id: "run-1",
      paths: { retrieval_workspace: "retrieval-workspace.json" },
    },
    facts: {
      places: {
        A地方: {
          tickets: ["门票需确认。"],
          practical_info: ["停车场在游客中心旁。"],
        },
      },
    },
    retrievalWorkspace: {
      places: {
        A地方: {
          unique_chunk_ids: ["chunk-1", "chunk-2"],
          themes: {
            tickets: [{ chunk_id: "chunk-1" }],
            transport: [{ chunk_id: "chunk-2" }],
          },
        },
      },
    },
  });

  assert.deepEqual(newItems.map((item) => item.item_id), ["B1-new-0001"]);
  assert.equal(newItems[0].checklist_item.text, "停车场在游客中心旁。");

  const deltas = createDeltas({
    checklist: baseline,
    runId: "run-1",
    retrievalEvaluation: { metrics: { CIR: { lost: 0 } }, lost_items: [], attribution: [] },
    factsEvaluation: {
      metrics: { N1: { critical_lost: 0 }, N2: { noncritical_lost: 0 }, N3: { misplaced_items: 0 }, low_confidence_count: 0 },
      lost_items: [],
    },
    htmlEvaluation: { status: "N/A", metrics: { N3: { misplaced_items: 0 } }, lost_items: [] },
    newItems,
  });
  const report = createReport({
    checklist: baseline,
    runManifest: { run_id: "run-1" },
    retrievalEvaluation: { metrics: { CIR: { lost: 0 } } },
    factsEvaluation: { metrics: { N1: { critical_lost: 0 }, N2: { noncritical_lost: 0 }, N3: { misplaced_items: 0 }, low_confidence_count: 0 } },
    htmlEvaluation: { status: "N/A", metrics: { N3: { misplaced_items: 0 } } },
    deltas,
  });

  assert.equal(report.conclusion, "PASS");
  assert.equal(report.metrics.deltas.new_items, 1);
  assert.match(renderReportMarkdown(report, deltas), /有效新增明细/);
});

test("createReport fails hard gates when critical facts are lost", () => {
  const lostItem = {
    item_id: "item-1",
    target_type: "place",
    target_name: "A地方",
    theme: "tickets",
    criticality: "critical",
    layer: "facts",
    attribution_code: "facts_drop",
  };
  const deltas = createDeltas({
    checklist: checklist(),
    runId: "run-1",
    retrievalEvaluation: { metrics: { CIR: { lost: 0 } }, lost_items: [], attribution: [] },
    factsEvaluation: { metrics: { N1: { critical_lost: 1 } }, lost_items: [lostItem] },
    htmlEvaluation: { status: "N/A", metrics: {}, lost_items: [] },
  });

  const report = createReport({
    checklist: checklist(),
    runManifest: { run_id: "run-1" },
    retrievalEvaluation: { metrics: { CIR: { lost: 0 } } },
    factsEvaluation: { metrics: { N1: { critical_lost: 1 }, N2: { noncritical_lost: 0 }, N3: { misplaced_items: 0 } } },
    htmlEvaluation: { status: "N/A", metrics: { N3: { misplaced_items: 0 } } },
    deltas,
  });

  assert.equal(report.gates.G2.status, "FAIL");
  assert.equal(report.conclusion, "FAIL");
});
