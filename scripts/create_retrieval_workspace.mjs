#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_THEMES, PLACE_THEMES, loadRagIndex, retrieve, writeRetrievalLog } from "./rag_retrieve.mjs";

/**
 * 解析批量检索命令参数，读取 facts workspace、RAG index 和输出路径。
 */
function parseArgs(argv) {
  const args = {
    facts: "",
    ragIndex: "",
    out: "retrieval-workspace.json",
    placeTopK: 5,
    cityTopK: 4,
    maxPlaceChunks: 45,
    maxCityChunks: 24,
    embeddingUrl: "",
    embeddingModel: "",
    noEmbedding: false,
    log: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--rag-index") args.ragIndex = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else if (arg === "--place-top-k") args.placeTopK = Number(argv[++i]);
    else if (arg === "--city-top-k") args.cityTopK = Number(argv[++i]);
    else if (arg === "--max-place-chunks") args.maxPlaceChunks = Number(argv[++i]);
    else if (arg === "--max-city-chunks") args.maxCityChunks = Number(argv[++i]);
    else if (arg === "--embedding-url") args.embeddingUrl = argv[++i];
    else if (arg === "--embedding-model") args.embeddingModel = argv[++i];
    else if (arg === "--no-embedding") args.noEmbedding = true;
    else if (arg === "--log") args.log = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.facts) throw new Error("Missing required --facts <facts-workspace.json>.");
  if (!args.ragIndex) throw new Error("Missing required --rag-index <rag-index.json>.");
  for (const [name, value] of Object.entries({
    "--place-top-k": args.placeTopK,
    "--city-top-k": args.cityTopK,
    "--max-place-chunks": args.maxPlaceChunks,
    "--max-city-chunks": args.maxCityChunks,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  }
  return args;
}

/**
 * 读取并解析 JSON 文件。
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * 清理并去重字符串数组，保留第一次出现的顺序。
 */
function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

/**
 * 把空值、单值或数组统一规范成数组。
 */
function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 输出文件内记录相对路径；如果不在同一目录树内，则保留绝对路径。
 */
function relativeToOut(filePath, outPath) {
  const rel = path.relative(path.dirname(path.resolve(outPath)), path.resolve(filePath));
  return rel && !rel.startsWith("..") ? rel : path.resolve(filePath);
}

/**
 * 从检索结果中抽出放入 target theme 的轻量索引项。
 */
function themeItem(result) {
  return {
    chunk_id: result.chunk_id,
    score: result.score,
    matched_by: result.matched_by,
  };
}

/**
 * 顶层 chunks_by_id 只保存每个 chunk 原文一份。
 */
function chunkRecord(result) {
  return {
    chunk_id: result.chunk_id,
    source_uri: result.source_uri,
    title: result.title,
    candidate_places: result.candidate_places,
    candidate_cities: result.candidate_cities,
    text: result.text,
  };
}

/**
 * 检索健康状态只描述 RAG 召回质量，不等同于 facts 完整性。
 */
function retrievalHealth(targetType, themeResults, uniqueChunkIds, selectedResults) {
  const warnings = [];
  const hardGapReasons = [];
  const minimum = targetType === "city" ? 2 : 3;
  if (uniqueChunkIds.length === 0) hardGapReasons.push("no_retrieved_chunks");
  else if (uniqueChunkIds.length < minimum) warnings.push(`retrieved_note_chunks_below_${minimum}:${uniqueChunkIds.length}`);
  for (const [theme, results] of Object.entries(themeResults)) {
    if (!results.length) warnings.push(`empty_theme:${theme}`);
  }
  if (targetType === "city") {
    const cityLevelHits = selectedResults.filter((result) => asList(result.candidate_places).length === 0).length;
    if (selectedResults.length && cityLevelHits < Math.ceil(selectedResults.length / 2)) {
      warnings.push("city_retrieval_is_broad");
    }
  }
  return {
    status: hardGapReasons.length ? "empty" : warnings.length ? "weak" : "ok",
    warnings,
    hard_gap_reasons: hardGapReasons,
  };
}

/**
 * 对单个景点或城市运行所有默认主题检索，并收集主题结果和去重 chunk_id。
 *
 * 收集顺序等于 PLACE_THEMES / CITY_THEMES 的对象 key 顺序：
 * place 为 highlights -> drawbacks -> tickets -> transport -> routes -> crowds -> accessibility -> facilities -> safety；
 * city 为 foods -> lodging -> transport -> backup_places -> notes。
 *
 * 每个 theme 会单独调用 retrieve()，先在该 theme 内排序并取 topK。
 * 然后这里按 theme 顺序把结果加入 unique_chunk_ids，并用 selectedIdSet 跨 theme 去重。
 * unique_chunk_ids 到 maxChunks 后，后续 theme 的新 chunk 不再进入阅读池；
 * 但后续 theme 命中已入池的 chunk 时，仍会保留在 themes.<theme>[] 索引里。
 *
 * 这里不是把所有 theme 的候选合并后全局排序取 N。
 * 当 topK > maxChunks 时，前面的 theme 可能直接占满 N 个名额，后面的 theme 很难贡献新 chunk。
 */
async function collectThemeResults(index, entityType, name, themes, topK, maxChunks, options = {}) {
  const themeResults = {};
  const selectedIds = [];
  const selectedIdSet = new Set();
  const selectedById = new Map();

  for (const theme of Object.keys(themes)) {
    const result = await retrieve(index, {
      [entityType]: name,
      theme,
      topK,
      maxChunks,
      embeddingUrl: options.embeddingUrl,
      embeddingModel: options.embeddingModel,
      noEmbedding: options.noEmbedding,
      includeDiagnostics: Boolean(options.logRequests),
    });
    if (options.logRequests && result.diagnostics) {
      options.logRequests.push({
        target_type: entityType,
        target_name: name,
        theme,
        ...result.diagnostics,
      });
    }
    const kept = [];
    for (const item of result.results.slice(0, topK)) {
      if (!selectedIdSet.has(item.chunk_id)) {
        if (selectedIds.length >= maxChunks) continue;
        selectedIdSet.add(item.chunk_id);
        selectedIds.push(item.chunk_id);
        selectedById.set(item.chunk_id, item);
      }
      kept.push(item);
      if (!selectedById.has(item.chunk_id)) selectedById.set(item.chunk_id, item);
    }
    themeResults[theme] = kept;
  }

  return {
    themeResults,
    unique_chunk_ids: selectedIds,
    selected_results: selectedIds.map((id) => selectedById.get(id)).filter(Boolean),
  };
}

/**
 * 生成地点 target 元信息。
 */
function placeTarget(facts, place) {
  const days = [];
  for (const day of asList(facts.trip?.days)) {
    if (asList(day.route_places).includes(place)) days.push(Number(day.day));
  }
  return {
    type: "place",
    name: place,
    days: days.filter(Number.isFinite),
    source_files_count: asList(facts.places?.[place]?.source_files).length,
  };
}

/**
 * 生成城市 target 元信息。
 */
function cityTarget(facts, city) {
  const days = [];
  for (const day of asList(facts.trip?.days)) {
    const haystack = JSON.stringify({
      title: day.title,
      lodging_city: day.lodging_city,
      route_places: day.route_places,
      source_line: day.source_line,
    });
    if (haystack.includes(city)) days.push(Number(day.day));
  }
  return {
    type: "city",
    name: city,
    days: days.filter(Number.isFinite),
    source_files_count: asList(facts.cities?.[city]?.source_files).length,
  };
}

/**
 * 把完整检索结果压缩成 target 下的主题索引。
 */
function themeIndexes(themeResults) {
  return Object.fromEntries(Object.entries(themeResults).map(([theme, results]) => [theme, results.map(themeItem)]));
}

/**
 * 批量日志和 retrieval workspace 共用 source/scoring 元信息，方便对照调试。
 */
function retrievalLogDocument(workspace, requests) {
  const selectedCount = requests.reduce(
    (total, request) => total + request.chunks.filter((chunk) => chunk.recall_status === "selected").length,
    0,
  );
  return {
    schema_version: 1,
    source: workspace.source,
    retrieval: workspace.retrieval,
    summary: {
      request_count: requests.length,
      index_chunk_evaluations: requests.reduce((total, request) => total + request.chunks.length, 0),
      selected_results: selectedCount,
    },
    requests,
  };
}

/**
 * 批量生成 retrieval-workspace.json，供 agent 在填 facts 前优先阅读。
 */
export async function createRetrievalWorkspace(factsPath, ragIndexPath, options = {}) {
  const facts = readJson(factsPath);
  const index = loadRagIndex(ragIndexPath);
  const placeTopK = Number(options.placeTopK ?? 5);
  const cityTopK = Number(options.cityTopK ?? 4);
  const maxPlaceChunks = Number(options.maxPlaceChunks ?? 45);
  const maxCityChunks = Number(options.maxCityChunks ?? 24);
  const hasChunkEmbeddings = asList(index.chunks).some((chunk) => asList(chunk.embedding).length > 0);
  const usesEmbedding = hasChunkEmbeddings && !options.noEmbedding;

  const chunksById = {};
  const places = {};
  for (const place of Object.keys(facts.places ?? {})) {
    const { themeResults, unique_chunk_ids, selected_results } = await collectThemeResults(
      index,
      "place",
      place,
      PLACE_THEMES,
      placeTopK,
      maxPlaceChunks,
      options,
    );
    for (const result of selected_results) chunksById[result.chunk_id] ??= chunkRecord(result);
    places[place] = {
      target: placeTarget(facts, place),
      unique_chunk_ids,
      retrieval_health: retrievalHealth("place", themeResults, unique_chunk_ids, selected_results),
      themes: themeIndexes(themeResults),
    };
  }

  const cities = {};
  for (const city of Object.keys(facts.cities ?? {})) {
    const { themeResults, unique_chunk_ids, selected_results } = await collectThemeResults(
      index,
      "city",
      city,
      CITY_THEMES,
      cityTopK,
      maxCityChunks,
      options,
    );
    for (const result of selected_results) chunksById[result.chunk_id] ??= chunkRecord(result);
    cities[city] = {
      target: cityTarget(facts, city),
      unique_chunk_ids,
      retrieval_health: retrievalHealth("city", themeResults, unique_chunk_ids, selected_results),
      themes: themeIndexes(themeResults),
    };
  }

  const attentionPlaces = uniqueStrings(
    Object.entries(places)
      .filter(([, value]) => value.retrieval_health.status !== "ok")
      .map(([key]) => key),
  );
  const attentionCities = uniqueStrings(
    Object.entries(cities)
      .filter(([, value]) => value.retrieval_health.status !== "ok")
      .map(([key]) => key),
  );

  return {
    schema_version: 1,
    source: {
      facts_workspace: path.basename(factsPath),
      rag_index: path.basename(ragIndexPath),
    },
    retrieval: {
      place_themes: Object.keys(PLACE_THEMES),
      city_themes: Object.keys(CITY_THEMES),
      place_top_k: placeTopK,
      city_top_k: cityTopK,
      max_place_chunks: maxPlaceChunks,
      max_city_chunks: maxCityChunks,
      scoring: {
        strategy: usesEmbedding ? "candidate_gated_embedding_keyword_entity_title" : "candidate_gated_keyword_entity_title",
        weights: usesEmbedding
          ? {
              entity_query: {
                query_embedding_similarity: 0.45,
                keyword_match: 0.25,
                route_entity_match: 0.2,
                title_source_match: 0.1,
              },
              query_only: {
                query_embedding_similarity: 0.7,
                keyword_match: 0.2,
                title_source_match: 0.1,
              },
            }
          : {
              entity_query: {
                keyword_match: 0.45,
                route_entity_match: 0.35,
                title_source_match: 0.2,
              },
              query_only: {
                keyword_match: 0.8,
                title_source_match: 0.2,
              },
            },
      },
    },
    chunks_by_id: chunksById,
    places,
    cities,
    summary: {
      place_count: Object.keys(places).length,
      city_count: Object.keys(cities).length,
      attention_places: attentionPlaces,
      attention_cities: attentionCities,
      gap_places: uniqueStrings(
        Object.entries(places)
          .filter(([, value]) => value.retrieval_health.hard_gap_reasons.length)
          .map(([key]) => key),
      ),
      gap_cities: uniqueStrings(
        Object.entries(cities)
          .filter(([, value]) => value.retrieval_health.hard_gap_reasons.length)
          .map(([key]) => key),
      ),
    },
  };
}

/**
 * CLI 入口：生成文件并输出简短统计。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logRequests = [];
  const options = {
    ...args,
    logRequests: args.log ? logRequests : null,
  };
  const workspace = await createRetrievalWorkspace(args.facts, args.ragIndex, options);
  workspace.source.facts_workspace = relativeToOut(args.facts, args.out);
  workspace.source.rag_index = relativeToOut(args.ragIndex, args.out);
  if (args.log) workspace.source.retrieval_log = relativeToOut(args.log, args.out);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  if (args.log) writeRetrievalLog(args.log, retrievalLogDocument(workspace, logRequests));
  console.log(
    `Created ${args.out} with ${workspace.summary.place_count} places, ${workspace.summary.city_count} cities, ${workspace.summary.gap_places.length} place hard gaps, and ${workspace.summary.gap_cities.length} city hard gaps${args.log ? `; wrote retrieval log to ${args.log}` : ""}.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
