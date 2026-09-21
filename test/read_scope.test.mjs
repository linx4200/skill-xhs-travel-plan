import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRetrievalWorkspace, parseArgs, resolveReadQuotas, retrievalOptionsFromArgs } from "../scripts/rag/create_retrieval_workspace.mjs";
import {
  RAG_READ_PROFILES,
  RAG_READ_PROFILE_DEFAULT,
  RAG_RETRIEVAL_DEFAULTS,
  resolveReadProfile,
} from "../scripts/rag/rag_retrieval_config.mjs";

/**
 * 造一份「单个景点 + N 条同主题 chunk」的最小 fixture。
 * 所有 chunk 只命中 highlights，因此阅读池大小直接等于 placeTopK（受可用条数封顶），
 * 可以干净地观察档位对读量的影响。
 */
function writeFixture(chunkCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-scope-test-"));
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
      chunks: Array.from({ length: chunkCount }, (_, index) => ({
        chunk_id: `a-place-highlights-${index + 1}`,
        source_uri: `resources/a-place-highlights-${index + 1}.json`,
        resource_path: `a-place-highlights-${index + 1}.json`,
        title: `A地方看点${index + 1}`,
        text: `看点相关记录 ${index + 1}。`,
        candidate_places: ["A地方"],
        candidate_cities: [],
        embedding: [],
      })),
    }),
    "utf8",
  );

  return { factsPath, ragIndexPath };
}

test("default 档数值与冻结基线逐字一致，且 RAG_RETRIEVAL_DEFAULTS 由它派生", () => {
  // 这四个数字是 2026-09 P2/P3 轮次跑出来的冻结基线。改动会让 B1/B2 基线与评估报告失效。
  assert.deepEqual(
    {
      place: RAG_READ_PROFILES.default.placeMaxThemeChunks,
      city: RAG_READ_PROFILES.default.cityMaxThemeChunks,
      maxPlace: RAG_READ_PROFILES.default.maxPlaceChunks,
      maxCity: RAG_READ_PROFILES.default.maxCityChunks,
    },
    { place: 5, city: 5, maxPlace: 50, maxCity: 25 },
  );
  assert.equal(RAG_RETRIEVAL_DEFAULTS.placeMaxThemeChunks, RAG_READ_PROFILES.default.placeMaxThemeChunks);
  assert.equal(RAG_RETRIEVAL_DEFAULTS.cityMaxThemeChunks, RAG_READ_PROFILES.default.cityMaxThemeChunks);
  assert.equal(RAG_RETRIEVAL_DEFAULTS.maxPlaceChunks, RAG_READ_PROFILES.default.maxPlaceChunks);
  assert.equal(RAG_RETRIEVAL_DEFAULTS.maxCityChunks, RAG_READ_PROFILES.default.maxCityChunks);
});

test("wide 档等于 B1 复核过的 10/10/100/50", () => {
  // 取值来自 assessment/rag-tuning/rounds/P3-2026-09-20/B1-RECHECK.md 的落地复核。
  // 这是一条防漂移断言：没有重新跑 B1 就不要改这里。
  assert.deepEqual(
    {
      place: RAG_READ_PROFILES.wide.placeMaxThemeChunks,
      city: RAG_READ_PROFILES.wide.cityMaxThemeChunks,
      maxPlace: RAG_READ_PROFILES.wide.maxPlaceChunks,
      maxCity: RAG_READ_PROFILES.wide.maxCityChunks,
    },
    { place: 10, city: 10, maxPlace: 100, maxCity: 50 },
  );
});

test("未传档位名时解析为 default 档", () => {
  assert.equal(resolveReadProfile(undefined).name, RAG_READ_PROFILE_DEFAULT);
  assert.equal(resolveReadProfile("").name, RAG_READ_PROFILE_DEFAULT);
  assert.equal(resolveReadProfile("  ").name, RAG_READ_PROFILE_DEFAULT);
});

test("未知档位名直接报错，不静默回退到 default", () => {
  assert.throws(() => resolveReadProfile("bogus"), /Unknown --read-scope "bogus"/);
  assert.throws(() => resolveReadQuotas({ readScope: "bogus" }), /Unknown --read-scope "bogus"/);
});

test("原子配额优先于档位，且只覆盖显式传入的那一项", () => {
  const quotas = resolveReadQuotas({ readScope: "wide", placeTopK: 3 });
  assert.deepEqual(quotas, {
    read_scope: "wide",
    placeMaxThemeChunks: 3,
    cityMaxThemeChunks: 10,
    maxPlaceChunks: 100,
    maxCityChunks: 50,
  });
});

test("原子配额非法时报错，不退回档位值", () => {
  assert.throws(() => resolveReadQuotas({ placeTopK: 0 }), /--place-top-k must be a positive number/);
  assert.throws(() => resolveReadQuotas({ readScope: "wide", maxCityChunks: -1 }), /--max-city-chunks must be a positive number/);
});

test("不传档位与原子参数时等于冻结基线配额", () => {
  assert.deepEqual(resolveReadQuotas(), {
    read_scope: "default",
    placeMaxThemeChunks: 5,
    cityMaxThemeChunks: 5,
    maxPlaceChunks: 50,
    maxCityChunks: 25,
  });
});

test("wide 档实际读得比 default 多，并在 workspace 里留下档位名", async () => {
  const { factsPath, ragIndexPath } = writeFixture(8);

  const baseline = await createRetrievalWorkspace(factsPath, ragIndexPath, { noEmbedding: true });
  assert.equal(baseline.retrieval.read_scope, "default");
  assert.equal(baseline.places["A地方"].unique_chunk_ids.length, 5);

  const wide = await createRetrievalWorkspace(factsPath, ragIndexPath, { noEmbedding: true, readScope: "wide" });
  assert.equal(wide.retrieval.read_scope, "wide");
  assert.equal(wide.places["A地方"].unique_chunk_ids.length, 8);
  assert.equal(wide.retrieval.place_top_k, 10);
  assert.equal(wide.retrieval.max_place_chunks, 100);
  assert.equal(Object.keys(wide.chunks_by_id).length, 8);
  assert.equal(Object.keys(baseline.chunks_by_id).length, 5);
});

test("广读档下仍可用原子参数压回小配额", async () => {
  const { factsPath, ragIndexPath } = writeFixture(8);
  const workspace = await createRetrievalWorkspace(factsPath, ragIndexPath, {
    noEmbedding: true,
    readScope: "wide",
    placeTopK: 2,
    maxPlaceChunks: 2,
  });

  assert.equal(workspace.retrieval.read_scope, "wide");
  assert.equal(workspace.places["A地方"].unique_chunk_ids.length, 2);
  assert.equal(workspace.retrieval.place_top_k, 2);
  assert.equal(workspace.retrieval.max_place_chunks, 2);
});

/**
 * 这一组是回归测试：曾经出现「档位在 CLI 上静默失效」——
 * parseArgs 解析出了 wide，但 main() 转发 options 时漏掉 readScope 与 placeTopK，
 * 结果 workspace 写成 read_scope=default、place_top_k=5、max_place_chunks=100 的混杂配额。
 */
test("CLI 参数解析后四个配额都已按档位补齐", () => {
  const args = parseArgs(["--facts", "f.json", "--rag-index", "i.json", "--read-scope", "wide"]);
  assert.equal(args.readScope, "wide");
  assert.equal(args.placeTopK, 10);
  assert.equal(args.cityTopK, 10);
  assert.equal(args.maxPlaceChunks, 100);
  assert.equal(args.maxCityChunks, 50);
});

test("CLI 转发给 createRetrievalWorkspace 的 options 保留档位名", () => {
  const args = parseArgs(["--facts", "f.json", "--rag-index", "i.json", "--read-scope", "wide"]);
  const options = retrievalOptionsFromArgs(args);
  assert.equal(options.readScope, "wide");
  assert.equal(options.placeTopK, 10);
  assert.equal(options.maxPlaceChunks, 100);
});

test("CLI 全链路：wide 档在 workspace 里读得更多且不留混杂配额", async () => {
  const { factsPath, ragIndexPath } = writeFixture(8);
  const args = parseArgs([
    "--facts", factsPath,
    "--rag-index", ragIndexPath,
    "--read-scope", "wide",
    "--no-embedding",
  ]);
  const workspace = await createRetrievalWorkspace(args.facts, args.ragIndex, retrievalOptionsFromArgs(args));

  assert.equal(workspace.retrieval.read_scope, "wide");
  assert.equal(workspace.retrieval.place_top_k, 10);
  assert.equal(workspace.retrieval.max_place_chunks, 100);
  assert.equal(workspace.retrieval.max_city_chunks, 50);
  assert.equal(Object.keys(workspace.chunks_by_id).length, 8);
});

test("CLI 解析未知档位名与非法原子参数都会报错", () => {
  assert.throws(
    () => parseArgs(["--facts", "f.json", "--rag-index", "i.json", "--read-scope", "bogus"]),
    /Unknown --read-scope "bogus"/,
  );
  assert.throws(
    () => parseArgs(["--facts", "f.json", "--rag-index", "i.json", "--max-place-chunks", "0"]),
    /--max-place-chunks must be a positive number/,
  );
  assert.throws(
    () => parseArgs(["--facts", "f.json", "--rag-index", "i.json", "--place-top-k", "abc"]),
    /--place-top-k must be a positive number/,
  );
});
