#!/usr/bin/env node
/**
 * RAG 单点检索脚本主流程：
 * 1. 解析 CLI 参数，确定索引路径、检索对象（景点/城市/自由 query）、主题、返回数量、embedding 和日志配置。
 * 2. 加载并规范化 RAG 索引，兼容新版 `rag-index.json` 和旧版 JSONL chunks。
 * 3. 构造本次检索的文本信号：
 *    3.1 根据景点/城市名称生成实体别名，用于匹配标题、来源路径和正文中的不同写法。
 *    3.2 根据实体类型和 theme 找到对应主题词；未知 theme 会直接作为关键词使用。
 *    3.3 拆分自由 query，提取可参与关键词命中的查询词。
 *    3.4 合并主题词、自由查询词和实体别名，形成用于 keyword score 的关键词集合。
 *    3.5 合并实体名、主题词和自由 query，拼出用于 embedding API 的检索 query。
 * 4. 在可用时调用 embedding API 生成 query 向量；否则退回到纯关键词、实体和标题来源打分。
 * 5. 对索引中的每个 chunk 逐条召回和排序：
 *    5.1 先执行实体 gate：景点检索要求 candidate_places 匹配，城市检索要求 candidate_cities 匹配。
 *    5.2 对通过 gate 的 chunk 计算关键词命中、实体命中、标题/来源命中和 embedding 相似度。
 *    5.3 根据是否有 query 向量、是否有实体目标选择评分权重，并计算综合总分。
 *    5.4 过滤掉未通过 gate 或总分为 0 的 chunk，得到候选结果。
 *    5.5 城市检索优先排列城市级 chunk，然后按总分、命中信号数量和稳定字段排序。
 *    5.6 按 min(topK, maxChunks) 截断，生成最终返回的 results。
 * 6. 按参数输出 JSON 或终端短预览；如指定 `--log`，额外写出可解释的召回与评分诊断日志。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeAliases, relatedPlaceName } from "./place_name_utils.mjs";

/**
 * 景点级检索主题。每个 theme 对应一组用于关键词召回和排序的中文触发词。
 */
export const PLACE_THEMES = {
  highlights: ["推荐", "看点", "体验", "出片"],
  drawbacks: ["避雷", "缺点", "避坑", "差评", "不推荐"],
  tickets: ["门票", "票价", "预约", "开放", "优惠", "套票"],
  transport: ["停车", "入口", "导航", "交通", "路况", "自驾", "游客中心", "包车", "打车"],
  routes: ["路线", "玩法", "排队", "摆渡车", "徒步", "索道", "游船", "缆车", "观光车", "步行"],
  safety: ["老人", "小孩", "安全", "补给", "厕所", "温差", "高反", "天气", "海拔", "厕所"],
};

/**
 * 城市级检索主题。城市主题偏向吃住行、备选点和整体风险提醒。
 */
export const CITY_THEMES = {
  foods: ["美食", "餐厅", "小吃", "夜市"],
  lodging: ["住宿", "酒店", "民宿"],
  transport: ["停车", "路况", "导航", "限行", "交通", "自驾", "高铁", "大巴", "包车", "打车", "拼车"],
  backup_places: ["备选", "景点", "古城", "观景台"],
  notes: ["风险", "注意", "安全", "贴士", "天气", "海拔", "温差", "高反"],
};

/**
 * 流程 1：解析单点检索命令参数。`--theme` 可重复传入；未传时只按实体或 query 检索。
 */
function parseArgs(argv) {
  const args = {
    ragIndex: "",
    place: "",
    city: "",
    query: "",
    themes: [],
    topK: 3,
    maxChunks: 20,
    embeddingUrl: "",
    embeddingModel: "",
    noEmbedding: false,
    log: "",
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
    else if (arg === "--embedding-url") args.embeddingUrl = argv[++i];
    else if (arg === "--embedding-model") args.embeddingModel = argv[++i];
    else if (arg === "--no-embedding") args.noEmbedding = true;
    else if (arg === "--log") args.log = argv[++i];
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
 * 通用辅助：把空值、单值或数组统一规范成数组，兼容不同索引生成器输出。
 */
function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 通用辅助：清理并去重字符串数组，保留第一次出现的顺序。
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
 * 流程 2.1：读取旧版 JSONL chunks。主流程使用 `rag-index.json`，这里保留兼容能力。
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
 * 流程 2.2：把 chunk 规范成检索内部结构。`resource_path` 只供内部匹配，不写入检索结果。
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
 * 流程 2：加载 RAG 索引。支持新版 `rag-index.json`，也兼容旧版逐行 JSONL。
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
 * 流程 3.2：根据 entity 类型和 theme 名称取主题词；未知 theme 直接当作关键词使用。
 */
function themeTerms(entityType, theme) {
  if (!theme) return [];
  const map = entityType === "city" ? CITY_THEMES : PLACE_THEMES;
  return map[theme] ? [...map[theme]] : [theme];
}

/**
 * 流程 3.3：把自由查询拆成关键词，参与 keyword score。
 */
function queryTerms(query) {
  return String(query ?? "")
    .split(/[\s,，、;；|/]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

/**
 * 流程 3.1：生成景点/城市别名，用于标题、source_uri 和正文中的宽松实体匹配。
 */
function entityAliases(entity) {
  if (!entity?.name) return [];
  if (entity.type === "place") return placeAliases(entity.name);
  return uniqueStrings([entity.name, ...placeAliases(entity.name)]);
}

/**
 * 流程 5.2：计算主题词和查询词命中分。命中标题、正文或 chunk.keywords 都算有效。
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
 * 流程 5.2：计算实体命中分。结构化 candidate 命中最高，标题/source/text 里的别名命中次之。
 */
function entityScore(chunk, entity, aliases) {
  if (!entity?.name) return 0;
  if (entity.type === "place") {
    if (candidatePlaceMatched(chunk, entity.name)) return 1;
    const haystack = `${chunk.title}\n${chunk.source_uri}\n${chunk.resource_path}\n${chunk.text}`;
    if (aliases.some((alias) => haystack.includes(alias))) return 0.75;
    return 0;
  }
  if (candidateCityMatched(chunk, entity.name)) return 1;
  const haystack = `${chunk.title}\n${chunk.source_uri}\n${chunk.resource_path}\n${chunk.text}`;
  if (aliases.some((alias) => haystack.includes(alias))) return 0.75;
  return 0;
}

/**
 * 流程 5.2：计算标题和来源 URI 命中分，用于把明显同名的 note 往前排。
 */
function titleSourceScore(chunk, aliases) {
  if (!aliases.length) return 0;
  const haystack = `${chunk.title}\n${chunk.source_uri}\n${chunk.resource_path}`;
  if (aliases.some((alias) => haystack.includes(alias))) return 1;
  return 0;
}

/**
 * 流程 5.2：记录该结果是被哪些信号召回的，方便人工检查排序原因。
 */
function matchedBy(chunk, entity, aliases, terms) {
  const matches = [];
  const candidateMatched = entity?.type === "place" && candidatePlaceMatched(chunk, entity.name);
  const cityMatched = entity?.type === "city" && candidateCityMatched(chunk, entity.name);
  const titleSourceMatched = titleSourceScore(chunk, aliases) > 0;
  const keywordMatched = keywordScore(chunk, terms) > 0;
  const textEntityMatched = entityScore(chunk, entity, aliases) > 0 && !candidateMatched && !cityMatched && !titleSourceMatched;

  if (candidateMatched) matches.push("candidate_places");
  if (cityMatched) matches.push("candidate_cities");
  if (titleSourceMatched) matches.push("title_source");
  if (textEntityMatched) matches.push("text_entity");
  if (keywordMatched) matches.push("keyword");
  return matches;
}

/**
 * 流程 4：判断 chunk 是否有可参与余弦相似度计算的向量。
 */
function hasEmbedding(chunk) {
  return Array.isArray(chunk.embedding) && chunk.embedding.length > 0;
}

/**
 * 流程 4：判断是否应该为本次检索调用 embedding API。
 */
function shouldUseEmbeddings(index, options) {
  if (options.noEmbedding) return false;
  return asList(index.chunks).some(hasEmbedding);
}

/**
 * 流程 4：返回第一个非空配置值，避免 CLI 默认空字符串遮住环境变量或索引元数据。
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * 流程 4：从环境变量和索引元数据中整理 embedding API 配置。
 */
function embeddingConfig(index, options) {
  const model = firstNonEmpty(
    options.embeddingModel,
    process.env.RAG_EMBEDDING_MODEL,
    process.env.EMBEDDING_MODEL,
    index.embedding?.model,
  );
  const url = firstNonEmpty(
    options.embeddingUrl,
    process.env.RAG_EMBEDDING_URL,
    process.env.EMBEDDING_API_URL,
    "http://localhost:11434/api/embed",
  );
  const apiKey = firstNonEmpty(
    options.embeddingApiKey,
    process.env.RAG_EMBEDDING_API_KEY,
    process.env.EMBEDDING_API_KEY,
    process.env.OPENAI_API_KEY,
  );

  if (!url) throw new Error("Embedding is enabled, but no embedding API URL is configured.");
  if (!model || model === "unknown") {
    throw new Error(
      "Embedding is enabled, but no embedding model is configured. Use --embedding-model or RAG_EMBEDDING_MODEL.",
    );
  }
  return { url, model, apiKey };
}

/**
 * 流程 4：把不同 embedding API 的响应统一成单条数值向量。
 *
 * 支持 Ollama `/api/embed` 的 `{ embeddings: [[...]] }`，旧 `/api/embeddings`
 * 的 `{ embedding: [...] }`，以及 OpenAI-compatible `{ data: [{ embedding }] }`。
 */
function parseEmbeddingResponse(payload) {
  const vector =
    (Array.isArray(payload?.embeddings) && payload.embeddings[0]) ||
    (Array.isArray(payload?.embedding) && payload.embedding) ||
    (Array.isArray(payload?.data) && payload.data[0]?.embedding) ||
    (Array.isArray(payload) && payload);
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error("Embedding API response did not contain an embedding vector.");
  }
  const parsed = vector.map((value) => Number(value));
  if (parsed.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding API response contained non-numeric vector values.");
  }
  return parsed;
}

/**
 * 流程 4：调用真实 embedding API 为检索 query 生成向量。
 */
async function fetchEmbedding(input, config) {
  const headers = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.model, input }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Embedding API request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }
  return parseEmbeddingResponse(await response.json());
}

/**
 * 流程 4：注入式 embedding client 便于测试；生产默认走 fetchEmbedding。
 */
async function queryEmbedding(index, query, options) {
  if (!shouldUseEmbeddings(index, options)) return [];
  if (!query.trim()) return [];
  if (options.queryEmbedding) return parseEmbeddingResponse(options.queryEmbedding);
  if (options.embeddingClient) {
    return parseEmbeddingResponse(await options.embeddingClient(query, embeddingConfig(index, options)));
  }
  return fetchEmbedding(query, embeddingConfig(index, options));
}

/**
 * 流程 5.2：计算余弦相似度。返回 0..1 的非负分，避免负相关结果仅因向量项进入召回。
 */
function cosineScore(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]);
    const b = Number(right[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(0, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

/**
 * 通用辅助：保持日志中的小数稳定，避免浮点尾数干扰 diff。
 */
function round4(value) {
  return Number(Number(value).toFixed(4));
}

/**
 * 流程 5.3：根据是否启用 query embedding 和是否有实体目标选择评分权重。
 */
function scoreWeights(hasQueryVector, entity) {
  if (hasQueryVector) {
    return entity?.name
      ? {
          profile: "entity_query_embedding",
          weights: {
            query_embedding_similarity: 0.45,
            keyword_match: 0.25,
            route_entity_match: 0.2,
            title_source_match: 0.1,
          },
        }
      : {
          profile: "query_only_embedding",
          weights: {
            query_embedding_similarity: 0.7,
            keyword_match: 0.2,
            title_source_match: 0.1,
          },
        };
  }
  return entity?.name
    ? {
        profile: "entity_query_keyword",
        weights: {
          keyword_match: 0.45,
          route_entity_match: 0.35,
          title_source_match: 0.2,
        },
      }
    : {
        profile: "query_only_keyword",
        weights: {
          keyword_match: 0.8,
          title_source_match: 0.2,
        },
      };
}

/**
 * 流程 5.3：展开每个评分分项对总分的贡献，供调试日志复盘。
 */
function scoreBreakdown(signals, scoring) {
  const contributions = {};
  let total = 0;
  for (const [name, weight] of Object.entries(scoring.weights)) {
    const contribution = (signals[name] ?? 0) * weight;
    contributions[name] = round4(contribution);
    total += contribution;
  }
  return {
    profile: scoring.profile,
    weights: scoring.weights,
    signals: Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, round4(value)])),
    contributions,
    total: round4(total),
  };
}

/**
 * 流程 5.6：输出面向 agent 阅读的检索结果；不暴露内部派生字段。
 */
function resultForChunk(chunk, score, matches) {
  return {
    chunk_id: chunk.chunk_id,
    source_uri: chunk.source_uri,
    title: chunk.title,
    score: round4(score),
    matched_by: matches,
    candidate_places: chunk.candidate_places,
    candidate_cities: chunk.candidate_cities,
    keywords: chunk.keywords,
    text: chunk.text,
  };
}

/**
 * 流程 5.2-5.3：综合评分。优先使用真实 embedding 相似度，同时保留关键词、实体和标题来源做可解释排序兜底。
 */
function scoreChunk(chunk, entity, aliases, terms, queryVector) {
  const keyword = keywordScore(chunk, terms);
  const routeEntity = entityScore(chunk, entity, aliases);
  const titleSource = titleSourceScore(chunk, aliases);
  const embedding = cosineScore(queryVector, chunk.embedding);
  const signals = {
    query_embedding_similarity: embedding,
    keyword_match: keyword,
    route_entity_match: routeEntity,
    title_source_match: titleSource,
  };
  const breakdown = scoreBreakdown(signals, scoreWeights(queryVector.length > 0, entity));
  const matches = matchedBy(chunk, entity, aliases, terms);
  if (embedding > 0) matches.push("embedding");
  return {
    score: breakdown.total,
    matches,
    breakdown,
  };
}

/**
 * 流程 5.1：判断 chunk 是否被上游明确标注为目标地点。
 */
function candidatePlaceMatched(chunk, placeName) {
  return chunk.candidate_places.some((place) => relatedPlaceName(placeName, place));
}

/**
 * 流程 5.1：判断 chunk 是否被上游明确标注为目标城市。
 */
function candidateCityMatched(chunk, cityName) {
  return chunk.candidate_cities.includes(cityName);
}

/**
 * 流程 5.1：实体检索必须先确认 chunk 归属；主题词只负责在已归属材料里排序。
 */
function passesEntityGate(chunk, entity) {
  if (!entity?.name) return true;
  if (entity.type === "place") return candidatePlaceMatched(chunk, entity.name);
  if (entity.type === "city") return candidateCityMatched(chunk, entity.name);
  return false;
}

/**
 * 流程 5.1：记录实体 gate 的具体原因，便于解释 chunk 为什么没有进入候选池。
 */
function entityGate(chunk, entity) {
  if (!entity?.name) return { passed: true, reason: "query_only_no_entity_gate" };
  if (entity.type === "place") {
    return candidatePlaceMatched(chunk, entity.name)
      ? { passed: true, reason: "candidate_places_match" }
      : { passed: false, reason: "candidate_places_miss" };
  }
  if (entity.type === "city") {
    return candidateCityMatched(chunk, entity.name)
      ? { passed: true, reason: "candidate_cities_match" }
      : { passed: false, reason: "candidate_cities_miss" };
  }
  return { passed: false, reason: "unknown_entity_type" };
}

/**
 * 流程 5.5：城市检索优先返回没有 candidate_places 的城市级 chunk。
 */
function cityLevelPriority(result, entity) {
  if (entity?.type !== "city") return 0;
  return result.matched_by.includes("candidate_cities") && result.candidate_places.length === 0 ? 1 : 0;
}

/**
 * 流程 5.5：让同分结果稳定排序，避免多次运行产生不必要的 JSON diff。
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
 * 流程 5.5：在城市检索中先排城市级 chunk，再使用通用分数排序。
 */
function compareResultsForEntity(left, right, entity) {
  return cityLevelPriority(right, entity) - cityLevelPriority(left, entity) || compareResults(left, right);
}

/**
 * 流程 6：日志只记录向量可解释摘要，不复制完整 embedding 数组，避免文件过大。
 */
function vectorTrace(queryVector, chunk, similarity) {
  return {
    used: queryVector.length > 0,
    query_dimensions: queryVector.length,
    chunk_dimensions: Array.isArray(chunk.embedding) ? chunk.embedding.length : 0,
    chunk_has_embedding: hasEmbedding(chunk),
    cosine_similarity: round4(similarity),
  };
}

/**
 * 流程 6：为单个 chunk 生成调试日志项。
 */
function diagnosticForRow(row, selectedIds, eligibleRanks) {
  let recallStatus = "filtered_by_entity_gate";
  if (row.gate.passed && row.result.score <= 0) recallStatus = "zero_score";
  else if (selectedIds.has(row.chunk.chunk_id)) recallStatus = "selected";
  else if (row.gate.passed) recallStatus = "scored_not_selected";

  return {
    chunk_id: row.chunk.chunk_id,
    source_uri: row.chunk.source_uri,
    title: row.chunk.title,
    gate: row.gate,
    recall_status: recallStatus,
    candidate_rank: eligibleRanks.get(row.chunk.chunk_id) ?? null,
    selected_rank: recallStatus === "selected" ? [...selectedIds].indexOf(row.chunk.chunk_id) + 1 : null,
    matched_by: row.result.matched_by,
    vector_match: vectorTrace(row.queryVector, row.chunk, row.scored.breakdown.signals.query_embedding_similarity),
    score: row.scored.breakdown,
    candidate_places: row.chunk.candidate_places,
    candidate_cities: row.chunk.candidate_cities,
    keywords: row.chunk.keywords,
  };
}

/**
 * 流程 6：生成单次 retrieve() 的完整调试日志。
 */
function retrievalDiagnostics({ index, query, entity, theme, aliases, terms, queryVector, topK, maxChunks, limit, rows, selectedRows, rankedRows }) {
  const selectedIds = new Set(selectedRows.map((row) => row.chunk.chunk_id));
  const eligibleRanks = new Map(rankedRows.map((row, index) => [row.chunk.chunk_id, index + 1]));
  return {
    query,
    entity,
    theme: theme || null,
    terms,
    aliases,
    top_k: topK,
    max_chunks: maxChunks,
    returned_limit: limit,
    index_chunk_count: asList(index.chunks).length,
    query_embedding: {
      used: queryVector.length > 0,
      dimensions: queryVector.length,
    },
    chunks: rows.map((row) => diagnosticForRow(row, selectedIds, eligibleRanks)),
  };
}

/**
 * 流程 6：从 retrieve() 返回值中移除调试日志，避免普通 JSON 输出过大。
 */
function withoutDiagnostics(result) {
  const { diagnostics, ...rest } = result;
  return rest;
}

/**
 * 流程 6：写出单点检索调试日志。
 */
export function writeRetrievalLog(logPath, payload) {
  fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true });
  fs.writeFileSync(logPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * 流程 2-5：检索入口，可被 CLI 和 `create_retrieval_workspace.mjs` 复用。
 */
export async function retrieve(indexOrPath, options = {}) {
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
  const queryVector = await queryEmbedding(index, query, options);
  const topK = Number(options.topK ?? 5);
  const maxChunks = Number(options.maxChunks ?? 20);
  // 单次 theme 检索最多返回 min(topK, maxChunks) 条。
  // 因此当 topK > maxChunks 时，超出的 K 不会增加该 theme 的候选结果。
  const limit = Math.min(topK, maxChunks);

  const rows = index.chunks.map((chunk) => {
    const gate = entityGate(chunk, entity);
    if (gate.passed !== passesEntityGate(chunk, entity)) {
      throw new Error(`Internal entity gate mismatch for chunk: ${chunk.chunk_id}`);
    }
    const scored = scoreChunk(chunk, entity, aliases, terms, queryVector);
    return {
      chunk,
      gate,
      scored,
      queryVector,
      result: resultForChunk(chunk, scored.score, scored.matches),
    };
  });
  const rankedRows = rows
    .filter((row) => row.gate.passed && row.result.score > 0)
    .sort((left, right) => compareResultsForEntity(left.result, right.result, entity));
  const selectedRows = rankedRows.slice(0, limit);
  const results = selectedRows.map((row) => row.result);

  const output = {
    query,
    entity,
    theme: theme || null,
    results,
  };
  if (options.includeDiagnostics) {
    output.diagnostics = retrievalDiagnostics({
      index,
      query,
      entity,
      theme,
      aliases,
      terms,
      queryVector,
      topK,
      maxChunks,
      limit,
      rows,
      selectedRows,
      rankedRows,
    });
  }
  return output;
}

/**
 * 流程 6：非 JSON 模式下打印短预览，避免在终端输出过长素材。
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
 * 流程 1-6：CLI 入口。支持一次传多个 `--theme`，JSON 模式下输出稳定结构。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const themes = args.themes.length ? args.themes : [""];
  const requests = [];
  for (const theme of themes) {
    requests.push(
      await retrieve(args.ragIndex, {
        place: args.place,
        city: args.city,
        query: args.query,
        theme,
        topK: args.topK,
        maxChunks: args.maxChunks,
        embeddingUrl: args.embeddingUrl,
        embeddingModel: args.embeddingModel,
        noEmbedding: args.noEmbedding,
        includeDiagnostics: Boolean(args.log),
      }),
    );
  }
  if (args.log) {
    writeRetrievalLog(args.log, {
      schema_version: 1,
      source: {
        rag_index: path.resolve(args.ragIndex),
      },
      request_count: requests.length,
      requests: requests.map((request) => request.diagnostics),
    });
  }
  const outputRequests = args.log ? requests.map(withoutDiagnostics) : requests;
  const output = outputRequests.length === 1 ? outputRequests[0] : { requests: outputRequests };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else if (requests.length === 1) printText(requests[0]);
  else for (const request of requests) printText(request);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
