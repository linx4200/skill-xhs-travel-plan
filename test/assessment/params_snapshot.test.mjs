import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAssessmentRun } from "../../scripts/assessment/rag-tuning/prepare_run.mjs";
import { createParamsSnapshot, writeParamsSnapshot } from "../../scripts/assessment/rag-tuning/lib/params_snapshot.mjs";
import {
  CITY_THEMES,
  PLACE_THEMES,
  RAG_RERANK_DEFAULTS,
  RAG_RETRIEVAL_DEFAULTS,
  RAG_SCORING,
} from "../../scripts/rag/rag_retrieval_config.mjs";

test("params snapshot captures the complete RAG config and CLI overrides", () => {
  const snapshot = createParamsSnapshot({
    capturedAt: "2026-09-20T00:00:00.000Z",
    cliOverrides: {
      place_top_k: 7,
      rerank: true,
    },
  });

  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.captured_at, "2026-09-20T00:00:00.000Z");
  assert.deepEqual(snapshot.place_themes, PLACE_THEMES);
  assert.deepEqual(snapshot.city_themes, CITY_THEMES);
  assert.deepEqual(snapshot.rag_scoring, RAG_SCORING);
  assert.deepEqual(snapshot.retrieval_defaults, RAG_RETRIEVAL_DEFAULTS);
  assert.deepEqual(snapshot.rerank_defaults, RAG_RERANK_DEFAULTS);
  assert.deepEqual(snapshot.cli_overrides, {
    place_top_k: 7,
    rerank: true,
  });
});

test("params snapshot is detached from imported config objects", () => {
  const snapshot = createParamsSnapshot();
  snapshot.place_themes.highlights.push("mutated");

  assert.equal(PLACE_THEMES.highlights.includes("mutated"), false);
});

test("writeParamsSnapshot writes stable JSON to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-params-test-"));
  const outPath = path.join(dir, "params.json");

  writeParamsSnapshot(outPath, {
    capturedAt: "2026-09-20T00:00:00.000Z",
    cliOverrides: { city_top_k: 3 },
  });

  const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(parsed.captured_at, "2026-09-20T00:00:00.000Z");
  assert.equal(parsed.cli_overrides.city_top_k, 3);
});

test("prepare run creates run.json and params.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-run-test-"));
  const result = createAssessmentRun(
    {
      baselineId: "B1",
      tag: "phase-1",
      outRoot: dir,
      cliOverrides: {
        rerank_threshold: 0.9,
      },
    },
    new Date("2026-09-20T04:00:00.000Z"),
  );

  const paramsPath = path.join(result.runDir, "params.json");
  const runPath = path.join(result.runDir, "run.json");
  assert.equal(fs.existsSync(paramsPath), true);
  assert.equal(fs.existsSync(runPath), true);

  const manifest = JSON.parse(fs.readFileSync(runPath, "utf8"));
  assert.equal(manifest.baseline_id, "B1");
  assert.equal(manifest.paths.params, "params.json");
  assert.equal(manifest.params.cli_overrides.rerank_threshold, 0.9);
});
