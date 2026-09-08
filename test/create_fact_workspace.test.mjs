import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const skillRoot = path.resolve(import.meta.dirname, "..");

test("RAG facts workspace takes photos from rag-index sibling photos", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-photos-"));
  const sourceChunksRoot = path.join(tmp, "chunks");
  fs.mkdirSync(path.join(tmp, "photos", "A地方"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "photos", "A地方", "01.jpg"), "");

  const ragIndexPath = path.join(tmp, "rag-index.json");
  fs.writeFileSync(
    ragIndexPath,
    `${JSON.stringify({
      schema_version: 1,
      source_chunks: "chunks",
      chunks: [
        {
          chunk_id: "a-place",
          source_uri: "resources/a-place.json",
          title: "A地方攻略",
          text: "A地方适合慢慢逛。",
          candidate_places: ["A地方"],
          candidate_cities: ["甲城市"],
          embedding: [],
        },
      ],
    })}\n`,
  );

  const routePath = path.join(tmp, "route-structure.json");
  fs.writeFileSync(
    routePath,
    `${JSON.stringify({
      title: "测试路线",
      mode: "self_drive",
      cities: ["甲城市"],
      days: [{ day: 1, title: "A地方", route_places: ["A地方"] }],
    })}\n`,
  );

  const outPath = path.join(tmp, "facts-workspace.json");
  execFileSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "create_fact_workspace.mjs"),
      "--route-json",
      routePath,
      "--rag-index",
      ragIndexPath,
      "-o",
      outPath,
    ],
    { cwd: skillRoot },
  );

  const facts = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(facts.source.resource_root, "");
  assert.equal(facts.source.source_chunks, sourceChunksRoot);
  assert.equal(facts.source.photo_resource_root, tmp);
  assert.deepEqual(facts.places["A地方"].photos, ["photos/A地方/01.jpg"]);
});

test("RAG facts workspace does not fall back to source_chunks or resource_root for photos", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-no-photo-fallback-"));
  const sourceChunksRoot = path.join(tmp, "chunks");
  fs.mkdirSync(path.join(sourceChunksRoot, "photos", "A地方"), { recursive: true });
  fs.writeFileSync(path.join(sourceChunksRoot, "photos", "A地方", "01.jpg"), "");
  const resourceRoot = path.join(tmp, "resources");
  fs.mkdirSync(path.join(resourceRoot, "photos", "A地方"), { recursive: true });
  fs.writeFileSync(path.join(resourceRoot, "photos", "A地方", "01.jpg"), "");

  const ragIndexPath = path.join(tmp, "rag-index.json");
  fs.writeFileSync(
    ragIndexPath,
    `${JSON.stringify({
      schema_version: 1,
      resource_root: resourceRoot,
      source_chunks: "chunks",
      chunks: [
        {
          chunk_id: "a-place",
          source_uri: "resources/a-place.json",
          title: "A地方攻略",
          text: "A地方适合慢慢逛。",
          candidate_places: ["A地方"],
          candidate_cities: ["甲城市"],
          embedding: [],
        },
      ],
    })}\n`,
  );

  const routePath = path.join(tmp, "route-structure.json");
  fs.writeFileSync(
    routePath,
    `${JSON.stringify({
      title: "测试路线",
      mode: "self_drive",
      cities: ["甲城市"],
      days: [{ day: 1, title: "A地方", route_places: ["A地方"] }],
    })}\n`,
  );

  const outPath = path.join(tmp, "facts-workspace.json");
  execFileSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "create_fact_workspace.mjs"),
      "--route-json",
      routePath,
      "--rag-index",
      ragIndexPath,
      "-o",
      outPath,
    ],
    { cwd: skillRoot },
  );

  const facts = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(facts.source.resource_root, "");
  assert.equal(facts.source.source_chunks, sourceChunksRoot);
  assert.equal(facts.source.photo_resource_root, tmp);
  assert.deepEqual(facts.places["A地方"].photos, []);
});

test("RAG rendered HTML copies photos from photo_resource_root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-render-photos-"));
  fs.mkdirSync(path.join(tmp, "chunks"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "photos", "A地方"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "photos", "A地方", "01.jpg"), "fake image bytes");

  const ragIndexPath = path.join(tmp, "rag-index.json");
  fs.writeFileSync(
    ragIndexPath,
    `${JSON.stringify({
      schema_version: 1,
      source_chunks: "chunks",
      chunks: [
        {
          chunk_id: "a-place",
          source_uri: "resources/a-place.json",
          title: "A地方攻略",
          text: "A地方适合慢慢逛。",
          candidate_places: ["A地方"],
          candidate_cities: ["甲城市"],
          embedding: [],
        },
      ],
    })}\n`,
  );

  const routePath = path.join(tmp, "route-structure.json");
  fs.writeFileSync(
    routePath,
    `${JSON.stringify({
      title: "测试路线",
      mode: "self_drive",
      cities: ["甲城市"],
      days: [
        {
          day: 1,
          title: "A地方",
          route_places: ["A地方"],
          summary: "去 A地方。",
        },
      ],
    })}\n`,
  );

  const factsPath = path.join(tmp, "facts-workspace.json");
  execFileSync(
    process.execPath,
    [
      path.join(skillRoot, "scripts", "create_fact_workspace.mjs"),
      "--route-json",
      routePath,
      "--rag-index",
      ragIndexPath,
      "-o",
      factsPath,
    ],
    { cwd: skillRoot },
  );

  const facts = JSON.parse(fs.readFileSync(factsPath, "utf8"));
  facts.needs_agent_review = false;
  facts.places["A地方"].summary = "A地方适合慢慢逛。";
  fs.writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`);

  const outDir = path.join(tmp, "out");
  execFileSync(
    process.execPath,
    [path.join(skillRoot, "scripts", "render_travel_html.mjs"), factsPath, "-o", outDir],
    { cwd: skillRoot },
  );

  assert.equal(fs.existsSync(path.join(outDir, "assets", "photos", "A地方", "01.jpg")), true);
  const html = fs.readFileSync(path.join(outDir, "day-01.html"), "utf8");
  assert.match(html, /assets\/photos\/A%E5%9C%B0%E6%96%B9\/01\.jpg|assets\/photos\/A地方\/01\.jpg/);
});
