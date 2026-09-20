import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildBaselineChecklistFromFiles } from "../../scripts/assessment/rag-tuning/build_baseline_checklist.mjs";
import { buildChecklistFromFacts } from "../../scripts/assessment/rag-tuning/lib/checklist.mjs";

function fixtureFacts() {
  return {
    schema_version: 1,
    trip: {
      days: [
        {
          day: 1,
          lodging_city: "甲城",
          route_places: ["A地方"],
          summary: "当天适合按半日游安排。",
          notes: ["雨天路滑，老人同行要减少台阶。"],
          confirmations: ["出发前确认门票。"],
        },
      ],
    },
    places: {
      A地方: {
        summary: "A地方适合作为半日自然景观点。",
        highlights: ["峡谷观景台值得专门停留。"],
        tickets: ["门票需出行前确认。"],
        practical_info: ["停车场在游客中心旁。"],
        notes: ["雨天栈道湿滑。"],
      },
    },
    cities: {
      甲城: {
        include: true,
        lodging: ["住宿优先选老城附近。"],
        transport: ["自驾进城注意停车。"],
        notes: ["节假日主路容易拥堵。"],
      },
    },
    global_notes: [],
    confirm_before_departure: [],
  };
}

function fixtureRetrievalWorkspace() {
  return {
    chunks_by_id: {
      "highlight-1": { chunk_id: "highlight-1", text: "峡谷观景台值得专门停留。" },
      "ticket-1": { chunk_id: "ticket-1", text: "门票需确认。" },
      "transport-1": { chunk_id: "transport-1", text: "停车场在游客中心旁。" },
      "safety-1": { chunk_id: "safety-1", text: "雨天栈道湿滑。" },
      "lodging-1": { chunk_id: "lodging-1", text: "住宿优先选老城附近。" },
    },
    places: {
      A地方: {
        unique_chunk_ids: ["highlight-1", "ticket-1", "transport-1", "safety-1"],
        themes: {
          highlights: [{ chunk_id: "highlight-1" }],
          tickets: [{ chunk_id: "ticket-1" }],
          transport: [{ chunk_id: "transport-1" }],
          safety: [{ chunk_id: "safety-1" }],
          routes: [{ chunk_id: "highlight-1" }],
        },
      },
    },
    cities: {
      甲城: {
        unique_chunk_ids: ["lodging-1", "transport-1", "safety-1"],
        themes: {
          lodging: [{ chunk_id: "lodging-1" }],
          transport: [{ chunk_id: "transport-1" }],
          notes: [{ chunk_id: "safety-1" }],
        },
      },
    },
  };
}

test("buildChecklistFromFacts extracts field-level checklist items with evidence refs", () => {
  const checklist = buildChecklistFromFacts(fixtureFacts(), fixtureRetrievalWorkspace(), {
    baselineId: "B1",
    baselineName: "Fixture",
    sourceRun: "output/fixture",
    retrievalWorkspacePath: "retrieval-workspace.json",
    createdAt: "2026-09-20T00:00:00.000Z",
  });

  assert.equal(checklist.baseline_id, "B1");
  assert.ok(checklist.items.length > 0);
  const ticket = checklist.items.find((item) => item.text === "门票需出行前确认。");
  assert.equal(ticket.criticality, "critical");
  assert.equal(ticket.theme, "tickets");
  assert.deepEqual(ticket.source_chunk_ids, ["ticket-1", "highlight-1", "transport-1", "safety-1"]);
});

test("buildChecklistFromFacts skips facts that cannot be tied to source chunk ids", () => {
  const checklist = buildChecklistFromFacts(fixtureFacts(), { chunks_by_id: {}, places: {}, cities: {} }, {
    baselineId: "B1",
    baselineName: "Fixture",
    sourceRun: "output/fixture",
    retrievalWorkspacePath: "retrieval-workspace.json",
    createdAt: "2026-09-20T00:00:00.000Z",
  });

  assert.equal(checklist.items.length, 0);
});

test("buildBaselineChecklistFromFiles writes a validated checklist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-checklist-test-"));
  const factsPath = path.join(dir, "facts-workspace.json");
  const retrievalPath = path.join(dir, "retrieval-workspace.json");
  const outPath = path.join(dir, "checklist.json");
  fs.writeFileSync(factsPath, JSON.stringify(fixtureFacts()), "utf8");
  fs.writeFileSync(retrievalPath, JSON.stringify(fixtureRetrievalWorkspace()), "utf8");

  const checklist = buildBaselineChecklistFromFiles({
    baselineId: "B1",
    baselineName: "Fixture",
    capability: "retrieval_and_facts",
    sourceDir: "output/fixture",
    facts: factsPath,
    retrievalWorkspace: retrievalPath,
    ragIndex: "",
    out: outPath,
    version: 1,
    allowUnverified: false,
  });

  assert.equal(fs.existsSync(outPath), true);
  assert.equal(JSON.parse(fs.readFileSync(outPath, "utf8")).items.length, checklist.items.length);
});
