import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const skillRoot = path.resolve(import.meta.dirname, "..");

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function minimalFacts() {
  return {
    schema_version: 1,
    needs_agent_review: true,
    title: "海拔测试",
    source: {
      resource_root: "",
      resource_index: "resource-index.json",
      route_structure: "route-structure.json",
    },
    trip: {
      mode: "unknown",
      days: [
        {
          day: 1,
          date: "",
          title: "高海拔景点",
          lodging_city: "",
          summary: "当天细节见详情页。",
          route_places: ["高海拔景点", "临界景点"],
          timeline: [],
          notes: [],
          confirmations: [],
          source_line: "",
        },
      ],
    },
    places: {
      高海拔景点: {
        summary: "高海拔景点摘要。",
        elevation_m: null,
        elevation_source_url: "",
        elevation_checked_at: "",
        highlights: [],
        drawbacks: [],
        opening_hours: [],
        tickets: [],
        duration: "",
        routes: [],
        play_options: [],
        practical_info: [],
        notes: [],
        conflicts: [],
        photos: [],
        source_files: ["notes/high.md"],
      },
      临界景点: {
        summary: "临界景点摘要。",
        elevation_m: 2500,
        elevation_source_url: "",
        elevation_checked_at: "",
        highlights: [],
        drawbacks: [],
        opening_hours: [],
        tickets: [],
        duration: "",
        routes: [],
        play_options: [],
        practical_info: [],
        notes: [],
        conflicts: [],
        photos: [],
        source_files: ["notes/edge.md"],
      },
    },
    cities: {
      高城: {
        include: true,
        summary: "高城摘要。",
        elevation_m: null,
        elevation_source_url: "",
        elevation_checked_at: "",
        overview: [],
        backup_places: [],
        foods: [],
        lodging: [],
        transport: [],
        shopping: [],
        notes: [],
        source_files: ["notes/city.md"],
      },
    },
    global_notes: [],
    confirm_before_departure: [],
  };
}

test("source digest can validate and apply elevation_m scalar facts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "elevation-digest-"));
  const factsPath = path.join(tmp, "facts-workspace.json");
  const digestPath = path.join(tmp, "source-digest.json");
  const outPath = path.join(tmp, "facts-applied.json");
  writeJson(factsPath, minimalFacts());
  writeJson(digestPath, {
    schema_version: 1,
    needs_agent_review: true,
    files: [
      {
        path: "notes/high.md",
        reviewed: true,
        facts: [
          {
            id: "high-place-elevation",
            target_type: "place",
            target_name: "高海拔景点",
            field: "elevation_m",
            items: ["海拔约 2,601 米"],
          },
          {
            id: "high-city-elevation",
            target_type: "city",
            target_name: "高城",
            field: "elevation_m",
            items: [3188],
          },
        ],
      },
    ],
  });

  execFileSync(process.execPath, [path.join(skillRoot, "scripts", "validate_source_digest.mjs"), "--digest", digestPath, "--facts", factsPath], {
    cwd: skillRoot,
  });
  execFileSync(
    process.execPath,
    [path.join(skillRoot, "scripts", "apply_source_digest_to_facts.mjs"), "--digest", digestPath, "--facts", factsPath, "-o", outPath],
    { cwd: skillRoot },
  );

  const facts = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(facts.places["高海拔景点"].elevation_m, 2601);
  assert.equal(facts.cities["高城"].elevation_m, 3188);
});

test("rendered HTML highlights elevation above 2500 meters", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "elevation-render-"));
  const factsPath = path.join(tmp, "facts-workspace.json");
  const outDir = path.join(tmp, "html");
  const facts = minimalFacts();
  facts.places["高海拔景点"].elevation_m = 2601;
  facts.cities["高城"].elevation_m = 3188;
  writeJson(factsPath, facts);

  execFileSync(process.execPath, [path.join(skillRoot, "scripts", "render_travel_html.mjs"), factsPath, "-o", outDir], {
    cwd: skillRoot,
  });

  const dayHtml = fs.readFileSync(path.join(outDir, "day-01.html"), "utf8");
  const cityHtml = fs.readFileSync(path.join(outDir, "city-01.html"), "utf8");
  const css = fs.readFileSync(path.join(outDir, "reading-first.css"), "utf8");
  assert.match(dayHtml, /<li class="elevation-alert">海拔约 2601 米。<\/li>/);
  assert.match(dayHtml, /<li>海拔约 2500 米。<\/li>/);
  assert.match(cityHtml, /<li class="elevation-alert">海拔约 3188 米。<\/li>/);
  assert.match(css, /\.elevation-alert/);
});
