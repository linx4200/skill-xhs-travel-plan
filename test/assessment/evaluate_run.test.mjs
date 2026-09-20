import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateAssessmentRun } from "../../scripts/assessment/rag-tuning/evaluate_run.mjs";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function checklist() {
  return {
    schema_version: 1,
    baseline_id: "B1",
    baseline_name: "smoke",
    capability: "retrieval_and_facts",
    version: 1,
    created_at: "2026-09-20T00:00:00.000Z",
    source_run: "output/smoke",
    items: [
      {
        id: "B1-place-001",
        text: "门票需确认。",
        domain: "execution_fact",
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        criticality: "critical",
        source_chunk_ids: ["chunk-1"],
        evidence_ref: {
          rag_index: "rag-index.json",
          chunk_ids: ["chunk-1"],
        },
        match_hints: ["门票", "确认"],
        added_at: "2026-09-20T00:00:00.000Z",
        source_run: "output/smoke",
      },
    ],
  };
}

test("evaluateAssessmentRun writes report, deltas, and adjudication skeleton", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-evaluate-test-"));
  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir);

  const baselinePath = path.join(dir, "baseline.json");
  writeJson(baselinePath, checklist());
  writeJson(path.join(runDir, "facts-workspace.json"), {
    places: {
      A地方: {
        tickets: ["门票需确认。"],
      },
    },
  });
  writeJson(path.join(runDir, "retrieval-workspace.json"), {
    places: {
      A地方: {
        unique_chunk_ids: ["chunk-1"],
        themes: {
          tickets: [{ chunk_id: "chunk-1" }],
        },
      },
    },
  });
  writeJson(path.join(runDir, "retrieval-log.json"), {
    requests: [
      {
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        chunks: [{ chunk_id: "chunk-1", recall_status: "selected" }],
      },
    ],
  });
  writeJson(path.join(runDir, "params.json"), { schema_version: 1 });
  writeJson(path.join(runDir, "run.json"), {
    schema_version: 1,
    run_id: "20260920-1200-B1-smoke",
    baseline_id: "B1",
    created_at: "2026-09-20T04:00:00.000Z",
    paths: {
      facts_workspace: "facts-workspace.json",
      retrieval_workspace: "retrieval-workspace.json",
      retrieval_log: "retrieval-log.json",
      params: "params.json",
    },
    params: {},
  });

  const result = evaluateAssessmentRun({ baselinePath, runDir });

  assert.equal(result.report.conclusion, "PASS");
  assert.equal(fs.existsSync(path.join(runDir, "report.md")), true);
  assert.equal(fs.existsSync(path.join(runDir, "report.json")), true);
  assert.equal(fs.existsSync(path.join(runDir, "deltas.json")), true);
  assert.equal(fs.existsSync(path.join(runDir, "adjudications.json")), true);

  const report = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  const markdown = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  assert.equal(report.conclusion, "PASS");
  assert.match(markdown, /conclusion: PASS/);
});
