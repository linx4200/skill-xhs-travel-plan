import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const skillRoot = path.resolve(import.meta.dirname, "..");

test("RAG facts workspace takes photos from source_chunks/photos", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-photos-"));
  const sourceChunksRoot = path.join(tmp, "chunks");
  fs.mkdirSync(path.join(sourceChunksRoot, "photos", "A地方"), { recursive: true });
  fs.writeFileSync(path.join(sourceChunksRoot, "photos", "A地方", "01.jpg"), "");

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
  assert.deepEqual(facts.places["A地方"].photos, ["photos/A地方/01.jpg"]);
});

test("RAG facts workspace does not fall back to resource_root for photos", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-no-photo-fallback-"));
  const resourceRoot = path.join(tmp, "resources");
  fs.mkdirSync(path.join(resourceRoot, "photos", "A地方"), { recursive: true });
  fs.writeFileSync(path.join(resourceRoot, "photos", "A地方", "01.jpg"), "");

  const ragIndexPath = path.join(tmp, "rag-index.json");
  fs.writeFileSync(
    ragIndexPath,
    `${JSON.stringify({
      schema_version: 1,
      resource_root: resourceRoot,
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
  assert.equal(Object.hasOwn(facts.source, "source_chunks"), false);
  assert.deepEqual(facts.places["A地方"].photos, []);
});
