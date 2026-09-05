import assert from "node:assert/strict";
import { test } from "node:test";
import { retrieve } from "../scripts/rag_retrieve.mjs";

const index = {
  chunks: [
    {
      chunk_id: "a-place-safety",
      source_uri: "resources/a-place-safety.json",
      resource_path: "a-place-safety.json",
      title: "A地方安全提醒",
      text: "A地方风大，带小孩要注意防滑。",
      candidate_places: ["A地方"],
      candidate_cities: ["甲城市"],
      embedding: [],
    },
    {
      chunk_id: "b-place-safety",
      source_uri: "resources/b-place-safety.json",
      resource_path: "b-place-safety.json",
      title: "B地方安全提醒",
      text: "B地方海拔高，早晚温差大。",
      candidate_places: ["B地方"],
      candidate_cities: ["甲城市"],
      embedding: [],
    },
    {
      chunk_id: "a-text-only",
      source_uri: "resources/a-text-only.json",
      resource_path: "a-text-only.json",
      title: "旅行提醒",
      text: "A地方早晚温差大，建议带外套。",
      candidate_places: [],
      candidate_cities: ["甲城市"],
      embedding: [],
    },
    {
      chunk_id: "city-lodging",
      source_uri: "resources/city-lodging.json",
      resource_path: "city-lodging.json",
      title: "甲城市住宿交通",
      text: "甲城市住宿建议选老城附近，自驾停车更方便。",
      candidate_places: [],
      candidate_cities: ["甲城市"],
      embedding: [],
    },
    {
      chunk_id: "other-city-lodging",
      source_uri: "resources/other-city-lodging.json",
      resource_path: "other-city-lodging.json",
      title: "乙城市住宿交通",
      text: "乙城市住宿建议选高铁站附近。",
      candidate_places: [],
      candidate_cities: ["乙城市"],
      embedding: [],
    },
    {
      chunk_id: "general-safety",
      source_uri: "resources/general-safety.json",
      resource_path: "general-safety.json",
      title: "安全提醒",
      text: "山区天气变化快，注意保暖。",
      candidate_places: [],
      candidate_cities: [],
      embedding: [],
    },
  ],
};

test("place retrieval only returns chunks that match candidate_places", async () => {
  const result = await retrieve(index, { place: "A地方", theme: "safety", topK: 10, maxChunks: 10, includeDiagnostics: true });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["a-place-safety"],
  );
  const selected = result.diagnostics.chunks.find((item) => item.chunk_id === "a-place-safety");
  assert.equal(selected.recall_status, "selected");
  assert.equal(selected.gate.reason, "candidate_places_match");
  assert.equal(selected.score.profile, "entity_query_keyword");
  assert.equal(selected.score.contributions.route_entity_match, 0.35);

  const filtered = result.diagnostics.chunks.find((item) => item.chunk_id === "a-text-only");
  assert.equal(filtered.recall_status, "filtered_by_entity_gate");
  assert.equal(filtered.gate.reason, "candidate_places_miss");
});

test("query-only retrieval can still use keyword matches without candidate entities", async () => {
  const result = await retrieve(index, { query: "安全", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["a-place-safety", "b-place-safety", "general-safety"],
  );
  assert.equal(Object.hasOwn(result.results[0], "keywords"), false);
});

test("city retrieval prefers city-level chunks without candidate_places", async () => {
  const result = await retrieve(index, { city: "甲城市", theme: "transport", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["city-lodging", "a-text-only", "a-place-safety", "b-place-safety"],
  );
});

test("city retrieval does not fall back to title or text city matches without candidate_cities", async () => {
  const result = await retrieve(index, { city: "乙城市", theme: "lodging", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["other-city-lodging"],
  );
});

test("query matching only uses title and text", async () => {
  const themeIndex = {
    chunks: [
      {
        chunk_id: "theme-only-keyword",
        source_uri: "resources/theme-only-keyword.json",
        resource_path: "theme-only-keyword.json",
        title: "候选一",
        text: "没有直接命中词。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [],
      },
      {
        chunk_id: "general-keyword",
        source_uri: "resources/general-keyword.json",
        resource_path: "general-keyword.json",
        title: "候选二",
        text: "没有直接命中词。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [],
      },
      {
        chunk_id: "text-hit",
        source_uri: "resources/text-hit.json",
        resource_path: "text-hit.json",
        title: "候选三",
        text: "门票需要提前预约。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [],
      },
    ],
  };

  const result = await retrieve(themeIndex, { query: "门票", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["text-hit"],
  );
});

test("video chunks receive a negative score contribution", async () => {
  const videoIndex = {
    chunks: [
      {
        chunk_id: "plain-note",
        source_uri: "resources/plain-note.json",
        resource_path: "plain-note.json",
        kind: "json-note",
        title: "普通笔记",
        text: "门票需要提前预约。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [],
      },
      {
        chunk_id: "video-note",
        source_uri: "resources/video-note.json",
        resource_path: "video-note.json",
        kind: "video",
        title: "视频笔记",
        text: "门票需要提前预约。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [],
      },
    ],
  };

  const result = await retrieve(videoIndex, { query: "门票", topK: 10, maxChunks: 10, includeDiagnostics: true });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["plain-note", "video-note"],
  );
  assert.equal(result.results[0].score > result.results[1].score, true);

  const video = result.diagnostics.chunks.find((item) => item.chunk_id === "video-note");
  assert.equal(video.score.signals.video_source_penalty, 1);
  assert.equal(video.score.contributions.video_source_penalty, -0.15);
});

test("query embedding similarity participates in ranking when chunk embeddings exist", async () => {
  const vectorIndex = {
    embedding: { provider: "ollama", model: "test-embed", dimensions: 3 },
    chunks: [
      {
        chunk_id: "keyword-hit",
        source_uri: "resources/keyword-hit.json",
        resource_path: "keyword-hit.json",
        title: "徒步提示",
        text: "徒步路线很轻松。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [0, 1, 0],
      },
      {
        chunk_id: "semantic-hit",
        source_uri: "resources/semantic-hit.json",
        resource_path: "semantic-hit.json",
        title: "山路体验",
        text: "需要预留体力。",
        candidate_places: [],
        candidate_cities: [],
        embedding: [1, 0, 0],
      },
    ],
  };
  const result = await retrieve(vectorIndex, {
    query: "徒步",
    topK: 10,
    maxChunks: 10,
    embeddingClient: async () => ({ embeddings: [[1, 0, 0]] }),
    includeDiagnostics: true,
  });

  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["semantic-hit", "keyword-hit"],
  );
  assert.equal(result.results[0].matched_by.includes("embedding"), true);
  const semanticTrace = result.diagnostics.chunks.find((item) => item.chunk_id === "semantic-hit");
  assert.equal(semanticTrace.vector_match.used, true);
  assert.equal(semanticTrace.vector_match.cosine_similarity, 1);
  assert.equal(semanticTrace.score.contributions.query_embedding_similarity, 0.7);
});
