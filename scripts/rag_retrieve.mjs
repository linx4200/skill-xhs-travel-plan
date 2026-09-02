#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeAliases, relatedPlaceName } from "./place_name_utils.mjs";

/**
 * 景点级检索主题。每个 theme 对应一组用于关键词召回和排序的中文触发词。
 */
export const PLACE_THEMES = {
  highlights: ["看点", "体验", "推荐", "拍照", "观景台", "风景", "出片"],
  drawbacks: ["缺点", "避坑", "排队", "差评", "坑", "不推荐"],
  tickets: ["门票", "预约", "开放", "开放时间", "优惠", "套票", "票价"],
  transport: ["停车", "入口", "导航", "交通", "自驾", "路况", "摆渡车", "游客中心", "观光车", "包车", "打车"],
  routes: ["路线", "游船", "徒步", "玩法", "顺序", "索道", "缆车", "观光车", "步道"],
  safety: ["老人", "小孩", "安全", "温差", "高反", "防滑", "风大", "天气", "海拔", "补给", "厕所"],
};

/**
 * 城市级检索主题。城市主题偏向吃住行、备选点和整体风险提醒。
 */
export const CITY_THEMES = {
  foods: ["美食", "餐厅", "小吃", "夜市", "避坑", "豆花", "燃面", "烧烤"],
  lodging: ["住宿", "酒店", "民宿", "区域", "县城", "住"],
  transport: ["停车", "路况", "导航", "限行", "交通", "自驾", "高铁", "大巴", "包车", "打车", "拼车"],
  backup_places: ["备选", "景点", "古城", "街区", "观景台", "老城", "县城"],
  notes: ["风险", "天气", "海拔", "安全", "温差", "高反", "风大", "避坑"],
};

/**
 * 解析单点检索命令参数。`--theme` 可重复传入；未传时只按实体或 query 检索。
 */
function parseArgs(argv) {
  const args = {
    ragIndex: "",
    place: "",
    city: "",
    query: "",
    themes: [],
    topK: 5,
    maxChunks: 20,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rag-index") args.ragIndex = argv[++i];
    else if (arg === "--place") args.place = argv[++i];
    else if (arg === "--city") args.city = argv[++i];
    else if (arg === "--query") args.query = argv[++i];
    else if (arg === "--theme") args.themes.push(argv[++i]);
    else if (arg === "--top-k") args.topK = Number(argv[++i]);
    else if (arg === "--max-chunks") args.maxChunks = Number(argv[++i]);
    else if (arg === "--json") args.json = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.ragIndex) throw new Error("Missing required --rag-index <path>.");
  if (!args.place && !args.city && !args.query) {
    throw new Error("At least one of --place, --city, or --query is required.");
  }
  if (args.place && args.city) throw new Error("Use either --place or --city for entity retrieval, not both.");
  if (!Number.isFinite(args.topK) || args.topK <= 0) throw new Error("--top-k must be a positive number.");
  if (!Number.isFinite(args.maxChunks) || args.maxChunks <= 0) throw new Error("--max-chunks must be a positive number.");
  return args;
}

/**
 * 把空值、单值或数组统一规范成数组，兼容不同索引生成器输出。
 */
function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
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
 * 读取旧版 JSONL chunks。主流程使用 `rag-index.json`，这里保留兼容能力。
 */
function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

/**
 * 把 chunk 规范成检索内部结构。`resource_path` 只供内部匹配，不写入检索结果。
 */
function normalizeRawJsonlRow(row, index) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const sourceUri = String(metadata.source_uri ?? row.source_uri ?? row.path ?? `inline-${String(index + 1).padStart(4, "0")}`).trim();
  const resourcePath = String(row.path ?? sourceUri.replace(/^\.?\/*resources\//, ""));
  return {
    chunk_id: String(row.chunk_id ?? `${sourceUri}#note`),
    source_uri: sourceUri,
    resource_path: resourcePath,
    title: String(row.title ?? metadata.title ?? sourceUri),
    text: String(row.text ?? ""),
    candidate_places: uniqueStrings(asList(row.candidate_places)),
    candidate_cities: uniqueStrings(asList(row.candidate_cities)),
    keywords: uniqueStrings(asList(row.keywords)),
    metadata,
    embedding: Array.isArray(row.embedding) ? row.embedding : [],
  };
}

/**
 * 加载 RAG 索引。支持新版 `rag-index.json`，也兼容旧版逐行 JSONL。
 */
export function loadRagIndex(ragIndexPath) {
  const raw = fs.readFileSync(ragIndexPath, "utf8").trim();
  if (!raw) throw new Error(`RAG index is empty: ${ragIndexPath}`);
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      chunks: asList(parsed.chunks).map((chunk, index) => normalizeRawJsonlRow(chunk, index)),
    };
  }
  const chunks = readJsonl(ragIndexPath).map((row, index) => normalizeRawJsonlRow(row, index));
  return {
    schema_version: 1,
    resource_root: path.dirname(path.resolve(ragIndexPath)),
    source_chunks: path.resolve(ragIndexPath),
    embedding: {
      provider: "unknown",
      model: "unknown",
      dimensions: chunks.find((chunk) => chunk.embedding.length)?.embedding.length ?? 0,
    },
    chunks,
  };
}

/**
 * 根据 entity 类型和 theme 名称取主题词；未知 theme 直接当作关键词使用。
 */
function themeTerms(entityType, theme) {
  if (!theme) return [];
  const map = entityType === "city" ? CITY_THEMES : PLACE_THEMES;
  return map[theme] ? [...map[theme]] : [theme];
}

/**
 * 把自由查询拆成关键词，参与 keyword score。
 */
function queryTerms(query) {
  return String(query ?? "")
    .split(/[\s,，、;；|/]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

/**
 * 生成景点/城市别名，用于标题、source_uri 和正文中的宽松实体匹配。
 */
function entityAliases(entity) {
  if (!entity?.name) return [];
  if (entity.type === "place") return placeAliases(entity.name);
  return uniqueStrings([entity.name, ...placeAliases(entity.name)]);
}

/**
 * 计算主题词和查询词命中分。命中标题、正文或 chunk.keywords 都算有效。
 */
function keywordScore(chunk, terms) {
  if (!terms.length) return 0;
  const haystack = `${chunk.title}\n${chunk.text}`;
  let hits = 0;
  for (const term of terms) {
    if (haystack.includes(term) || chunk.keywords.includes(term)) hits += 1;
  }
  return Math.min(1, hits / Math.min(terms.length, 6));
}

/**
 * 计算实体命中分。结构化 candidate 命中最高，标题/source/text 里的别名命中次之。
 */
function entityScore(chunk, entity, aliases) {
  if (!entity?.name) return 0;
  if (entity.type === "place") {
    if (chunk.candidate_places.some((place) => relatedPlaceName(entity.name, place))) return 1;
    const haystack = `${chunk.title}\n${chunk.source_uri}\n${chunk.resource_path}\n${chunk.text}`;
    if (aliases.some((alias) => haystack.includes(alias))) return 0.75;
    return 0;
  }
  if (chunk.candidate_cities.includes(entity.name)) return 1;
  const haystack = `${chunk.title}\n${chunk.source_uri}\n${chunk.resource_path}\n${chunk.text}`;
  if (aliases.some((alias) => haystack.includes(alias))) return 0.75;
  return 0;
}

/**
 * 标题和来源 URI 命中分，用于把明显同名的 note 往前排。
 */
function titleSourceScore(chunk, aliases) {
  if (!aliases.length) return 0;
  const haystack = `${chunk.title}\n${chunk.source_uri}\n${chunk.resource_path}`;
  if (aliases.some((alias) => haystack.includes(alias))) return 1;
  return 0;
}

/**
 * 记录该结果是被哪些信号召回的，方便人工检查排序原因。
 */
function matchedBy(chunk, entity, aliases, terms) {
  const matches = [];
  if (entity?.type === "place" && chunk.candidate_places.some((place) => relatedPlaceName(entity.name, place))) matches.push("candidate_places");
  if (entity?.type === "city" && chunk.candidate_cities.includes(entity.name)) matches.push("candidate_cities");
  if (titleSourceScore(chunk, aliases) > 0) matches.push("title_source");
  if (keywordScore(chunk, terms) > 0) matches.push("keyword");
  if (!matches.length && entityScore(chunk, entity, aliases) > 0) matches.push("text_entity");
  return matches;
}

/**
 * 输出面向 agent 阅读的检索结果；不暴露内部派生字段。
 */
function resultForChunk(chunk, score, matches) {
  return {
    chunk_id: chunk.chunk_id,
    source_uri: chunk.source_uri,
    title: chunk.title,
    score: Number(score.toFixed(4)),
    matched_by: matches,
    candidate_places: chunk.candidate_places,
    candidate_cities: chunk.candidate_cities,
    keywords: chunk.keywords,
    text: chunk.text,
  };
}

/**
 * 综合评分。MVP 不调用 embedding API，先用关键词、实体和标题来源做确定性排序。
 */
function scoreChunk(chunk, entity, aliases, terms) {
  const keyword = keywordScore(chunk, terms);
  const routeEntity = entityScore(chunk, entity, aliases);
  const titleSource = titleSourceScore(chunk, aliases);
  const baseScore = 0.45 * keyword + 0.35 * routeEntity + 0.2 * titleSource;
  const score = entity?.name ? baseScore : 0.8 * keyword + 0.2 * titleSource;
  return {
    score,
    matches: matchedBy(chunk, entity, aliases, terms),
  };
}

/**
 * 让同分结果稳定排序，避免多次运行产生不必要的 JSON diff。
 */
function compareResults(left, right) {
  return (
    right.score - left.score ||
    right.matched_by.length - left.matched_by.length ||
    left.source_uri.localeCompare(right.source_uri, "zh-CN") ||
    left.chunk_id.localeCompare(right.chunk_id, "zh-CN")
  );
}

/**
 * 检索入口，可被 CLI 和 `create_retrieval_workspace.mjs` 复用。
 */
export function retrieve(indexOrPath, options = {}) {
  const index = typeof indexOrPath === "string" ? loadRagIndex(indexOrPath) : indexOrPath;
  const entity = options.place
    ? { type: "place", name: String(options.place) }
    : options.city
      ? { type: "city", name: String(options.city) }
      : null;
  const theme = String(options.theme ?? "");
  const aliases = entityAliases(entity);
  const terms = uniqueStrings([...themeTerms(entity?.type, theme), ...queryTerms(options.query), ...aliases]);
  const query = uniqueStrings([entity?.name, ...themeTerms(entity?.type, theme), options.query]).join(" ");
  const topK = Number(options.topK ?? 5);
  const maxChunks = Number(options.maxChunks ?? 20);
  const limit = Math.min(topK, maxChunks);

  const results = index.chunks
    .map((chunk) => {
      const scored = scoreChunk(chunk, entity, aliases, terms);
      return resultForChunk(chunk, scored.score, scored.matches);
    })
    .filter((result) => result.score > 0)
    .sort(compareResults)
    .slice(0, limit);

  return {
    query,
    entity,
    theme: theme || null,
    results,
  };
}

/**
 * 非 JSON 模式下打印短预览，避免在终端输出过长素材。
 */
function printText(result) {
  console.log(`${result.entity?.type ?? "query"}: ${result.entity?.name ?? result.query}`);
  if (result.theme) console.log(`theme: ${result.theme}`);
  for (const item of result.results) {
    console.log(`\n[${item.score}] ${item.title} (${item.source_uri})`);
    console.log(item.text.slice(0, 500).replace(/\s+/g, " "));
  }
}

/**
 * CLI 入口：支持一次传多个 `--theme`，JSON 模式下输出稳定结构。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const themes = args.themes.length ? args.themes : [""];
  const requests = themes.map((theme) =>
    retrieve(args.ragIndex, {
      place: args.place,
      city: args.city,
      query: args.query,
      theme,
      topK: args.topK,
      maxChunks: args.maxChunks,
    }),
  );
  const output = requests.length === 1 ? requests[0] : { requests };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else if (requests.length === 1) printText(requests[0]);
  else for (const request of requests) printText(request);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
