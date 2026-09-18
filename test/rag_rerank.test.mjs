import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRerankQuery, rerankRows } from "../scripts/rag/rag_rerank.mjs";

function row(id, options = {}) {
  const score = options.score ?? 0.5;
  const business = Object.hasOwn(options, "business")
    ? options.business
    : {
        tier: options.tier ?? 0,
        tilt_multiplier: options.tilt ?? 1,
        is_video: false,
        place_specific: false,
      };
  return {
    chunk: {
      chunk_id: id,
      source_uri: `resources/${id}.json`,
      title: options.title ?? id,
      text: options.text ?? `${id} 正文`,
      candidate_places: [],
      candidate_cities: [],
    },
    scored: {
      score,
      business,
    },
    result: {
      chunk_id: id,
      score,
      matched_by: options.matched_by ?? ["keyword"],
      candidate_places: options.candidate_places ?? [],
      candidate_cities: options.candidate_cities ?? [],
    },
  };
}

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    recallWidth: 10,
    probThreshold: 0.9,
    timeoutMs: 1000,
    ...overrides,
  };
}

test("fixed template table builds natural-language rerank queries", () => {
  assert.equal(
    buildRerankQuery({ type: "place", name: "大山包" }, "highlights"),
    "大山包有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？",
  );
  assert.equal(
    buildRerankQuery({ type: "city", name: "昭通" }, "backup_places"),
    "昭通有哪些可作为行程备选、顺路补充或城市周边的小众地点？",
  );
  assert.equal(
    buildRerankQuery({ type: "place", name: "大山包" }, "facilities"),
    "大山包游玩有什么厕所、停车、吃饭、住宿、骑马等实用配套信息？",
  );
  assert.equal(
    buildRerankQuery({ type: "place", name: "大山包" }, "unknown_theme"),
    "请判断下面材料是否有助于回答「大山包 的 unknown_theme 相关旅行信息」。",
  );
});

test("mock reranker reorders rows and filters low-probability candidates", async () => {
  const rows = [row("weak", { score: 0.9 }), row("strong", { score: 0.4 }), row("off-topic", { score: 0.8 })];
  const result = await rerankRows(
    rows,
    { entity: { type: "place", name: "A地方" }, theme: "highlights", topK: 3 },
    enabledConfig({
      reranker: async ({ documents }) =>
        documents.map((document) => ({
          id: document.id,
          probability: { weak: 0.91, strong: 0.99, "off-topic": 0.2 }[document.id],
        })),
    }),
  );

  assert.deepEqual(
    result.rows.map((item) => item.chunk.chunk_id),
    ["strong", "weak"],
  );
  assert.equal(result.diagnostics.applied, true);
  assert.equal(result.diagnostics.kept_count, 2);
  assert.equal(result.diagnostics.filtered_count, 1);
  assert.equal(result.diagnostics.items.find((item) => item.chunk_id === "off-topic").passed_threshold, false);
});

test("threshold filtering can return fewer rows than topK", async () => {
  const result = await rerankRows(
    [row("keep"), row("drop")],
    { entity: { type: "place", name: "A地方" }, theme: "highlights", topK: 2 },
    enabledConfig({
      reranker: async ({ documents }) =>
        documents.map((document) => ({ id: document.id, probability: document.id === "keep" ? 0.95 : 0.1 })),
    }),
  );

  assert.deepEqual(
    result.rows.map((item) => item.chunk.chunk_id),
    ["keep"],
  );
  assert.equal(result.rows.length < 2, true);
});

test("tilt_multiplier lowers final rerank score inside the same tier", async () => {
  const result = await rerankRows(
    [row("tilted", { tilt: 0.5 }), row("plain", { tilt: 1 })],
    { entity: { type: "place", name: "A地方" }, theme: "highlights", topK: 2 },
    enabledConfig({
      reranker: async ({ documents }) =>
        documents.map((document) => ({ id: document.id, probability: document.id === "tilted" ? 0.99 : 0.9 })),
    }),
  );

  assert.deepEqual(
    result.rows.map((item) => item.chunk.chunk_id),
    ["plain", "tilted"],
  );
  assert.equal(result.diagnostics.items.find((item) => item.chunk_id === "tilted").final_rerank_score, 0.495);
});

test("city backup_places keeps tier 0 above higher-probability tier 1 rows", async () => {
  const result = await rerankRows(
    [
      row("city-level", { tier: 0, candidate_cities: ["甲城市"] }),
      row("place-specific", { tier: 1, candidate_places: ["A地方"], candidate_cities: ["甲城市"] }),
    ],
    { entity: { type: "city", name: "甲城市" }, theme: "backup_places", topK: 2 },
    enabledConfig({
      reranker: async ({ documents }) =>
        documents.map((document) => ({ id: document.id, probability: document.id === "city-level" ? 0.91 : 0.99 })),
    }),
  );

  assert.deepEqual(
    result.rows.map((item) => item.chunk.chunk_id),
    ["city-level", "place-specific"],
  );
});

test("missing scored.business uses default tier and multiplier", async () => {
  const result = await rerankRows(
    [row("without-business", { business: undefined })],
    { entity: { type: "place", name: "A地方" }, theme: "highlights", topK: 1 },
    enabledConfig({
      reranker: async () => [{ id: "without-business", probability: 0.95 }],
    }),
  );

  const item = result.diagnostics.items[0];
  assert.equal(item.tier, 0);
  assert.equal(item.penalty_multiplier, 1);
  assert.equal(item.final_rerank_score, 0.95);
});

test("unordered API results are aligned by document id", async () => {
  const result = await rerankRows(
    [row("first"), row("second")],
    { entity: { type: "place", name: "A地方" }, theme: "highlights", topK: 2 },
    enabledConfig({
      httpClient: async () => ({
        model: "test-model",
        results: [
          { id: "second", probability: 0.99 },
          { id: "first", probability: 0.91 },
        ],
      }),
    }),
  );

  assert.deepEqual(
    result.rows.map((item) => item.chunk.chunk_id),
    ["second", "first"],
  );
  assert.equal(result.diagnostics.model_id, "test-model");
});

test("invalid API responses fail when rerank is explicitly enabled", async () => {
  const cases = [
    {
      name: "missing result",
      results: [{ id: "first", probability: 0.95 }],
      pattern: /returned 1 results for 2 documents/,
    },
    {
      name: "duplicate id",
      results: [
        { id: "first", probability: 0.95 },
        { id: "first", probability: 0.96 },
      ],
      pattern: /duplicate result id: first/,
    },
    {
      name: "invalid probability",
      results: [
        { id: "first", probability: 0.95 },
        { id: "second", probability: Number.NaN },
      ],
      pattern: /invalid probability for second/,
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () =>
        rerankRows(
          [row("first"), row("second")],
          { entity: { type: "place", name: "A地方" }, theme: "highlights", topK: 2 },
          enabledConfig({
            httpClient: async () => ({ results: item.results }),
          }),
        ),
      item.pattern,
      item.name,
    );
  }
});

test("non-whitelisted themes do not call the HTTP client", async () => {
  let called = false;
  const rows = [row("drawback")];
  const result = await rerankRows(
    rows,
    { entity: { type: "place", name: "A地方" }, theme: "drawbacks", topK: 1 },
    enabledConfig({
      httpClient: async () => {
        called = true;
        return { results: [] };
      },
    }),
  );

  assert.equal(called, false);
  assert.equal(result.rows, rows);
  assert.equal(result.diagnostics.skipped_reason, "theme_not_in_scope");
});
