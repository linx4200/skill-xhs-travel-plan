import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateHtmlLayer } from "../../scripts/assessment/rag-tuning/lib/html_metrics.mjs";

function checklist() {
  return {
    schema_version: 1,
    baseline_id: "B1",
    items: [
      {
        id: "critical-rendered",
        text: "门票需出行前确认。",
        target_type: "place",
        target_name: "A地方",
        theme: "tickets",
        criticality: "critical",
        match_hints: ["门票", "出行前确认"],
      },
      {
        id: "critical-render-drop",
        text: "停车场在游客中心旁。",
        target_type: "place",
        target_name: "A地方",
        theme: "transport",
        criticality: "critical",
        match_hints: ["停车场", "游客中心"],
      },
      {
        id: "facts-miss",
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

function factsEvaluation() {
  return {
    item_results: [
      { item_id: "critical-rendered", covered: true },
      { item_id: "critical-render-drop", covered: true },
      { item_id: "facts-miss", covered: false },
    ],
  };
}

function writeHtmlDir(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-html-test-"));
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  return dir;
}

test("evaluateHtmlLayer returns N/A when html dir is not provided", () => {
  const result = evaluateHtmlLayer(checklist(), "", factsEvaluation());

  assert.equal(result.status, "N/A");
  assert.equal(result.mechanical.status, "N/A");
  assert.equal(result.metrics.N8.structure_complete, "N/A");
});

test("evaluateHtmlLayer detects rendered items and render_drop", () => {
  const dir = writeHtmlDir(`
    <!doctype html>
    <html><body>
      <p>门票需出行前确认。</p>
    </body></html>
  `);
  const result = evaluateHtmlLayer(checklist(), dir, factsEvaluation());

  assert.equal(result.mechanical.status, "PASS");
  assert.deepEqual(result.metrics.CIR, {
    critical_items: 2,
    retained: 1,
    lost: 1,
    rate: 0.5,
  });
  assert.equal(result.metrics.render_drop_count, 1);
  assert.deepEqual(result.lost_items.map((item) => item.item_id), ["critical-render-drop"]);
  assert.equal(result.item_results.some((item) => item.item_id === "facts-miss"), false);
});

test("evaluateHtmlLayer surfaces mechanical verification failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-html-broken-test-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html><body><img src="missing.jpg"><a href="https://example.com">remote</a></body></html>',
    "utf8",
  );

  const result = evaluateHtmlLayer({ schema_version: 1, baseline_id: "B1", items: [] }, dir);

  assert.equal(result.mechanical.status, "FAIL");
  assert.ok(result.mechanical.verifyErrors.some((error) => error.includes("missing linked target")));
  assert.ok(result.mechanical.verifyErrors.some((error) => error.includes("remote resource")));
  assert.equal(result.metrics.N8.structure_complete, false);
});
