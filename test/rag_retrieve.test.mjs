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
      keywords: ["安全", "风大", "防滑"],
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
      keywords: ["安全", "海拔", "温差"],
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
      keywords: ["温差"],
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
      keywords: ["住宿", "停车", "交通"],
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
      keywords: ["住宿", "交通"],
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
      keywords: ["安全", "天气"],
      embedding: [],
    },
  ],
};

test("place retrieval only returns chunks that match candidate_places", () => {
  const result = retrieve(index, { place: "A地方", theme: "safety", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["a-place-safety"],
  );
});

test("query-only retrieval can still use keyword matches without candidate entities", () => {
  const result = retrieve(index, { query: "安全", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["a-place-safety", "b-place-safety", "general-safety"],
  );
});

test("city retrieval prefers city-level chunks without candidate_places", () => {
  const result = retrieve(index, { city: "甲城市", theme: "transport", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["city-lodging", "a-text-only", "a-place-safety", "b-place-safety"],
  );
});

test("city retrieval does not fall back to title or text city matches without candidate_cities", () => {
  const result = retrieve(index, { city: "乙城市", theme: "lodging", topK: 10, maxChunks: 10 });
  assert.deepEqual(
    result.results.map((item) => item.chunk_id),
    ["other-city-lodging"],
  );
});
