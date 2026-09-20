import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { upgradeBaselineFromRun } from "../../scripts/assessment/rag-tuning/upgrade_baseline.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function baseline() {
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
        id: "B1-place-0001",
        text: "门票需确认。",
        domain: "execution_fact",
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        criticality: "critical",
        source_chunk_ids: ["chunk-1"],
        evidence_ref: { chunk_ids: ["chunk-1"] },
        added_at: "2026-09-20T00:00:00.000Z",
        source_run: "output/smoke",
      },
    ],
  };
}

function report(conclusion = "PASS") {
  return {
    schema_version: 1,
    baseline_id: "B1",
    run_id: "run-1",
    conclusion,
    gates: {},
    metrics: {},
    semantic_scores: [],
  };
}

function deltas() {
  return {
    schema_version: 1,
    baseline_id: "B1",
    run_id: "run-1",
    lost_items: [],
    new_items: [
      {
        item_id: "B1-new-0001",
        target_type: "place",
        target_name: "A地方",
        theme: "transport",
        criticality: "critical",
        layer: "facts",
        attribution_code: "unknown",
        checklist_item: {
          id: "B1-new-0001",
          text: "停车场在游客中心旁。",
          domain: "execution_fact",
          target_type: "place",
          target_name: "A地方",
          theme: "transport",
          criticality: "critical",
          source_chunk_ids: ["chunk-2"],
          evidence_ref: { chunk_ids: ["chunk-2"] },
          match_hints: ["停车场", "游客中心"],
          added_at: "2026-09-20T00:00:00.000Z",
          source_run: "run-1",
        },
      },
    ],
    misplaced_items: [],
    unsupported_facts: [],
    duplicates: [],
    attribution: [],
  };
}

function fixtureRun(conclusion = "PASS") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-upgrade-test-"));
  const baselinePath = path.join(dir, "baseline.json");
  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir);
  writeJson(baselinePath, baseline());
  writeJson(path.join(runDir, "report.json"), report(conclusion));
  writeJson(path.join(runDir, "deltas.json"), deltas());
  return { dir, baselinePath, runDir };
}

test("upgradeBaselineFromRun writes a new version and changelog without overwriting baseline", () => {
  const { dir, baselinePath, runDir } = fixtureRun();
  const changelog = path.join(dir, "CHANGELOG.md");
  const out = path.join(dir, "baseline.v2.json");

  const result = upgradeBaselineFromRun(
    {
      baseline: baselinePath,
      run: runDir,
      acceptNewItems: ["B1-new-0001"],
      out,
      changelog,
    },
    new Date("2026-09-20T04:00:00.000Z"),
  );

  assert.equal(result.outPath, out);
  assert.equal(result.upgraded.version, 2);
  assert.equal(result.addedItems[0].id, "B1-place-0002");
  assert.equal(JSON.parse(fs.readFileSync(baselinePath, "utf8")).version, 1);
  assert.match(fs.readFileSync(changelog, "utf8"), /B1-place-0002/);
});

test("upgradeBaselineFromRun rejects non-PASS runs", () => {
  const { baselinePath, runDir } = fixtureRun("PASS_WITH_NOTES");

  assert.throws(
    () =>
      upgradeBaselineFromRun({
        baseline: baselinePath,
        run: runDir,
        acceptNewItems: ["B1-new-0001"],
      }),
    /Only PASS runs/,
  );
});
