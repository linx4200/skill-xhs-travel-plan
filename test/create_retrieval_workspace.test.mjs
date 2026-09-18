import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRetrievalWorkspace } from "../scripts/rag/create_retrieval_workspace.mjs";
import { RAG_SCORING } from "../scripts/rag/rag_retrieval_config.mjs";

// 每个 place theme 取一个只在该 theme 词表里出现的触发词，保证「一个 chunk 只被一个主题强命中」。
const ONE_TERM_PER_PLACE_THEME = {
  highlights: "看点",
  drawbacks: "避雷",
  tickets: "门票",
  transport: "停车",
  routes: "环线",
  nearby: "周边",
  crowds: "错峰",
  accessibility: "无人机",
  facilities: "厕所",
  safety: "防滑",
};

/**
 * 造一份最小 facts + rag-index 落盘，供 createRetrievalWorkspace 读取。
 * 所有 chunk 都绑定同一个 place，因此都会通过实体 gate，方便观察配额行为。
 */
function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-workspace-test-"));
  const factsPath = path.join(dir, "facts-workspace.json");
  const ragIndexPath = path.join(dir, "rag-index.json");

  fs.writeFileSync(
    factsPath,
    JSON.stringify({ places: { A地方: { source_files: [] } }, cities: {} }),
    "utf8",
  );
  fs.writeFileSync(
    ragIndexPath,
    JSON.stringify({
      schema_version: 1,
      chunks: Object.entries(ONE_TERM_PER_PLACE_THEME).map(([theme, term]) => ({
        chunk_id: `a-place-${theme}`,
        source_uri: `resources/a-place-${theme}.json`,
        resource_path: `a-place-${theme}.json`,
        title: `A地方${theme}`,
        text: `${term}相关记录。`,
        candidate_places: ["A地方"],
        candidate_cities: [],
        embedding: [],
      })),
    }),
    "utf8",
  );

  return { factsPath, ragIndexPath, chunkCount: Object.keys(ONE_TERM_PER_PLACE_THEME).length };
}

function writeCityFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-workspace-city-test-"));
  const factsPath = path.join(dir, "facts-workspace.json");
  const ragIndexPath = path.join(dir, "rag-index.json");

  fs.writeFileSync(
    factsPath,
    JSON.stringify({ places: {}, cities: { 甲城市: { source_files: [] } } }),
    "utf8",
  );
  fs.writeFileSync(
    ragIndexPath,
    JSON.stringify({
      schema_version: 1,
      chunks: [
        {
          chunk_id: "city-backup",
          source_uri: "resources/city-backup.json",
          resource_path: "city-backup.json",
          title: "甲城市备选",
          text: "冷门 小众 景点。",
          candidate_places: [],
          candidate_cities: ["甲城市"],
          embedding: [],
        },
        {
          chunk_id: "place-backup",
          source_uri: "resources/place-backup.json",
          resource_path: "place-backup.json",
          title: "甲城市观景台",
          text: "景点 打卡点 冷门 小众 顺路 附近。",
          candidate_places: ["A地方"],
          candidate_cities: ["甲城市"],
          embedding: [],
        },
      ],
    }),
    "utf8",
  );

  return { factsPath, ragIndexPath };
}

/**
 * 引用完整性：unique_chunk_ids 和 themes.*[].chunk_id 都必须能在 chunks_by_id 里找到，
 * 且 chunks_by_id 不应残留没有任何 target 引用的 chunk。
 */
function assertReferenceIntegrity(workspace) {
  const referenced = new Set();
  for (const group of ["places", "cities"]) {
    for (const target of Object.values(workspace[group])) {
      for (const chunkId of target.unique_chunk_ids) {
        assert.ok(workspace.chunks_by_id[chunkId], `${chunkId} 应在 chunks_by_id 中`);
        referenced.add(chunkId);
      }
      for (const results of Object.values(target.themes)) {
        for (const item of results) {
          assert.ok(workspace.chunks_by_id[item.chunk_id], `${item.chunk_id} 应在 chunks_by_id 中`);
          referenced.add(item.chunk_id);
        }
      }
    }
  }
  assert.deepEqual(new Set(Object.keys(workspace.chunks_by_id)), referenced);
}

test("阅读池名额足够时不会丢弃任何 chunk", async () => {
  const { factsPath, ragIndexPath, chunkCount } = writeFixture();
  const workspace = await createRetrievalWorkspace(factsPath, ragIndexPath, {
    noEmbedding: true,
    maxPlaceChunks: chunkCount,
  });
  const place = workspace.places["A地方"];

  assert.equal(place.unique_chunk_ids.length, chunkCount);
  assert.deepEqual(place.retrieval_quota, {
    max_chunks: chunkCount,
    selected_chunks: chunkCount,
    dropped_total: 0,
    dropped_by_theme: {},
  });
  assert.equal(place.retrieval_health.status, "ok");
  assert.deepEqual(workspace.retrieval.scoring.business_rules, {
    city_tier_themes: RAG_SCORING.cityTierThemes,
    video_tilt: RAG_SCORING.videoTilt,
    city_tilt: {
      default: RAG_SCORING.defaultCityTilt,
      by_theme: RAG_SCORING.cityTiltByTheme,
    },
  });
  assert.deepEqual(workspace.retrieval.scoring.weights.entity_query, {
    keyword_match: 0.55,
    route_entity_match: 0.35,
    title_source_match: 0.1,
  });
  assertReferenceIntegrity(workspace);
});

test("阅读池先到先得：名额占满后后续主题不再贡献新 chunk，并记录丢弃账目", async () => {
  const { factsPath, ragIndexPath } = writeFixture();
  const maxChunks = 2;
  const workspace = await createRetrievalWorkspace(factsPath, ragIndexPath, {
    noEmbedding: true,
    maxPlaceChunks: maxChunks,
  });
  const place = workspace.places["A地方"];

  // 名额被主题顺序最靠前的 highlights 直接占满，后序主题只可能命中已入池的 chunk。
  assert.equal(place.unique_chunk_ids.length, maxChunks);
  assert.ok(place.unique_chunk_ids.every((id) => place.themes.highlights.some((item) => item.chunk_id === id)));
  for (const [theme, results] of Object.entries(place.themes)) {
    if (theme === "highlights") continue;
    for (const item of results) {
      assert.ok(place.unique_chunk_ids.includes(item.chunk_id), `${theme} 不应引入池外 chunk`);
    }
  }

  // 丢弃账目按主题归集，总数等于各主题之和，且保留 first-seen 的主题顺序。
  const droppedByTheme = place.retrieval_quota.dropped_by_theme;
  assert.equal(place.retrieval_quota.max_chunks, maxChunks);
  assert.equal(place.retrieval_quota.selected_chunks, maxChunks);
  assert.equal(
    place.retrieval_quota.dropped_total,
    Object.values(droppedByTheme).reduce((total, count) => total + count, 0),
  );
  assert.ok(place.retrieval_quota.dropped_total > 0);
  assert.deepEqual(Object.keys(droppedByTheme), Object.keys(place.themes).filter((theme) => droppedByTheme[theme]));
  assert.ok(droppedByTheme.highlights > 0, "highlights 自身超出名额的候选也应计入丢弃");

  // 丢弃是软提醒：进入 retrieval_health.warnings，把该 target 标成 weak 以便进入 attention 列表。
  assert.equal(place.retrieval_health.status, "weak");
  assert.ok(place.retrieval_health.warnings.includes(`quota_dropped:highlights:${droppedByTheme.highlights}`));
  assert.deepEqual(workspace.summary.attention_places, ["A地方"]);
  assertReferenceIntegrity(workspace);
});

test("城市地点级解释字段会进入 theme 轻量索引", async () => {
  const { factsPath, ragIndexPath } = writeCityFixture();
  const workspace = await createRetrievalWorkspace(factsPath, ragIndexPath, { noEmbedding: true });
  const backupItems = workspace.cities["甲城市"].themes.backup_places;

  const cityLevel = backupItems.find((item) => item.chunk_id === "city-backup");
  assert.equal(Object.hasOwn(cityLevel, "place_specific"), false);
  assert.equal(Object.hasOwn(cityLevel, "tier"), false);

  const placeSpecific = backupItems.find((item) => item.chunk_id === "place-backup");
  assert.equal(placeSpecific.place_specific, true);
  assert.equal(placeSpecific.tier, 1);
  assert.equal(Object.hasOwn(placeSpecific, "tilt_multiplier"), false);
  assert.equal(Object.hasOwn(placeSpecific, "final_rerank_score"), false);
  assertReferenceIntegrity(workspace);
});
