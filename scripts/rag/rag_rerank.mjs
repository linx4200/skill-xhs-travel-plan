/**
 * RAG cross-encoder rerank 接入模块。
 *
 * 职责边界：
 * 1. 合并 rerank 配置（CLI overrides → 环境变量 → RAG_RERANK_DEFAULTS）。
 * 2. 判断当前 `entity.type + theme` 是否需要 rerank；不在启用范围内时不访问网络。
 * 3. 取候选窗口前 `recallWidth` 条，按固定模板表生成 rerank query 和 documents。
 * 4. 调用本地 HTTP rerank 服务，并校验响应完整性（缺失结果、重复 id、非法概率都报错）。
 * 5. 按概率阈值过滤，乘回业务软降权 multiplier 得到 `final_rerank_score`，再按最终分重排。
 *
 * 关键约定：
 * - 不改写 `result.score`。rerank 概率只用于重排、过滤和诊断，相关性分继续对外输出。
 * - 只在显式启用且 theme 在启用范围内时访问网络；未启用时零网络调用。
 * - 窗口外候选不参与补位：阈值过滤后允许某个 theme 返回少于 `topK` 条结果。
 * - 显式启用时不静默降级：服务不可用、超时或响应非法都直接抛错。
 * - 业务软降权 multiplier 由主流程 `rag_retrieve.mjs` 折算并给出，本模块只消费：
 *   优先读 `row.scored.business.tilt_multiplier`，兼容旧字段 `businessPenaltyMultiplier`。
 *
 * 输入 `rows` 来自 `rag_retrieve.mjs` 的 `rankedRows`，元素结构为
 * `{ chunk, gate, scored, queryVector, result }`。
 */

import { RAG_RERANK_DEFAULTS } from "./rag_retrieval_config.mjs";

/** `skipped_reason` 取值；null 表示本次真正执行了 rerank。 */
const SKIPPED_DISABLED = "disabled";
const SKIPPED_MISSING_ENTITY = "missing_entity";
const SKIPPED_THEME_NOT_IN_SCOPE = "theme_not_in_scope";
const SKIPPED_EMPTY_CANDIDATES = "empty_candidates";

/**
 * 通用辅助：把空值、单值或数组统一规范成数组。
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
 * 通用辅助：返回第一个有效配置值。只跳过 undefined / null / 空串，
 * 因此显式传入的 `false`、`0` 不会被默认值覆盖。
 */
function pick(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    return value;
  }
  return undefined;
}

/**
 * 通用辅助：保持诊断中的小数稳定，避免浮点尾数干扰 diff。
 */
function round4(value) {
  return Number(Number(value).toFixed(4));
}

/**
 * 合并 rerank 配置。
 *
 * 读取顺序：CLI overrides → 环境变量（RAG_RERANK_URL / RAG_RERANK_MODEL /
 * RAG_RERANK_TIMEOUT_MS）→ RAG_RERANK_DEFAULTS。
 *
 * `overrides` 同时接受 CLI 风格别名（`rerankUrl`、`rerankRecallWidth`、
 * `rerankThreshold`、`rerankTimeoutMs`、`rerankAllThemes`、`rerankTheme`），
 * 便于 `rag_retrieve.mjs` 直接透传解析结果。函数是幂等的：传入已合并的配置不会改变结果。
 */
export function resolveRerankConfig(overrides = {}, env = process.env) {
  const source = overrides ?? {};
  const defaults = RAG_RERANK_DEFAULTS;
  const templateOverride = source.queryTemplates ?? {};
  const highRiskOverride = source.highRiskThemes ?? {};

  return {
    enabled: Boolean(pick(source.enabled, defaults.enabled)),
    url: String(pick(source.url, source.rerankUrl, env.RAG_RERANK_URL, defaults.url) ?? ""),
    model: String(pick(source.model, source.rerankModel, env.RAG_RERANK_MODEL, defaults.model) ?? ""),
    recallWidth: Number(pick(source.recallWidth, source.rerankRecallWidth, defaults.recallWidth)),
    probThreshold: Number(pick(source.probThreshold, source.rerankThreshold, defaults.probThreshold)),
    timeoutMs: Number(pick(source.timeoutMs, source.rerankTimeoutMs, env.RAG_RERANK_TIMEOUT_MS, defaults.timeoutMs)),
    maxDocChars: Number(pick(source.maxDocChars, defaults.maxDocChars)),
    allThemes: Boolean(pick(source.allThemes, source.rerankAllThemes, false)),
    extraThemes: uniqueStrings([...asList(source.extraThemes), ...asList(source.themes), ...asList(source.rerankTheme)]),
    highRiskThemes: {
      place: uniqueStrings([...asList(highRiskOverride.place ?? defaults.highRiskThemes.place)]),
      city: uniqueStrings([...asList(highRiskOverride.city ?? defaults.highRiskThemes.city)]),
    },
    queryTemplates: {
      place: { ...defaults.queryTemplates.place, ...(templateOverride.place ?? {}) },
      city: { ...defaults.queryTemplates.city, ...(templateOverride.city ?? {}) },
    },
    reranker: typeof source.reranker === "function" ? source.reranker : null,
    httpClient: typeof source.httpClient === "function" ? source.httpClient : null,
  };
}

/**
 * 计算 theme 启用范围。`extraThemes`（`--rerank-theme`）同时扩展到景点和城市两套白名单，
 * 具体生效与否由请求时的 `entity.type` 决定。
 */
function scopeFor(resolved) {
  const extra = asList(resolved.extraThemes);
  return {
    place: uniqueStrings([...asList(resolved.highRiskThemes.place), ...extra]),
    city: uniqueStrings([...asList(resolved.highRiskThemes.city), ...extra]),
    all_themes: Boolean(resolved.allThemes),
  };
}

/**
 * 输出当前配置的 theme 启用范围，供 `retrieval.scoring.rerank.theme_scope` 直接引用。
 *
 * `--rerank-all-themes` 时仍返回白名单列表，另外用 `all_themes: true` 标出「全部 theme 都启用」。
 */
export function rerankThemeScope(config = {}) {
  return scopeFor(resolveRerankConfig(config));
}

/**
 * 判断某个 `entity.type + theme` 是否需要 rerank。
 *
 * 默认只覆盖高风险 theme；`extraThemes`（`--rerank-theme`）用于临时扩大范围，
 * `allThemes`（`--rerank-all-themes`）用于调参时覆盖全部 theme。
 */
export function isThemeInScope(entityType, theme, config = {}) {
  if (!entityType || !theme) return false;
  const resolved = resolveRerankConfig(config);
  if (resolved.allThemes) return true;
  return scopeFor(resolved)[entityType]?.includes(theme) ?? false;
}

/**
 * 生成 rerank query。
 *
 * 使用固定模板表，不在运行时由模型或 agent 改写：按 `entity.type` 和 `theme`
 * 查表后只替换 `{name}`。表里没有的 theme 走固定兜底句，保证 query 始终是自然语言意图句，
 * 而不是关键词堆。
 */
export function buildRerankQuery(entity, theme, config = {}) {
  const resolved = resolveRerankConfig(config);
  const name = String(entity?.name ?? "").trim();
  const template = resolved.queryTemplates?.[entity?.type]?.[theme];
  if (template) return String(template).replaceAll("{name}", name);
  if (theme) return `请判断下面材料是否有助于回答「${name} 的 ${theme} 相关旅行信息」。`;
  return `请判断下面材料是否与「${name}」的旅行信息相关。`;
}

/**
 * 构造单条 rerank document。
 *
 * 标题和正文分字段传给服务，由服务拼装模型 prompt。`maxDocChars` 只截断正文，
 * 用于防止异常长文本拖慢推理。服务要求 `text` 非空，因此正文为空时退回标题，
 * 避免整批请求被 400 拒绝。
 */
export function buildRerankDocument(chunk, maxDocChars = RAG_RERANK_DEFAULTS.maxDocChars) {
  const title = String(chunk?.title ?? "").trim();
  const rawText = String(chunk?.text ?? "").trim();
  const text = rawText || title;
  const limit = Number.isFinite(maxDocChars) && maxDocChars > 0 ? maxDocChars : text.length;
  return {
    id: String(chunk?.chunk_id ?? ""),
    title,
    text: text.length > limit ? text.slice(0, limit) : text,
  };
}

/**
 * 校验 rerank URL 是否可用。在真正发请求前调用，因此非白名单 theme 不会因为 URL 配置失败。
 */
function assertRerankUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid rerank URL: ${url || "(empty)"}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Rerank URL must use http or https: ${url}`);
  }
}

/**
 * 启动参数校验。只在显式启用时执行，保证未启用 rerank 的调用不受这些参数影响。
 */
function validateRerankOptions(config, topK) {
  if (!Number.isFinite(config.recallWidth) || config.recallWidth <= 0) {
    throw new Error("--rerank-recall-width must be a positive number.");
  }
  if (!Number.isFinite(config.probThreshold) || config.probThreshold < 0 || config.probThreshold > 1) {
    throw new Error("--rerank-threshold must be within [0, 1].");
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error("--rerank-timeout-ms must be a positive number.");
  }
  if (topK !== null && config.recallWidth < topK) {
    throw new Error(`--rerank-recall-width (${config.recallWidth}) must be greater than or equal to top-k (${topK}).`);
  }
}

/**
 * 调用真实 rerank HTTP 服务。非 2xx、超时和网络不可达都转成明确错误，不静默降级。
 */
async function postRerankRequest({ url, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Rerank API request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Rerank API request timed out after ${timeoutMs}ms: ${url}`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Rerank API is unreachable at ${url}: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注入式 httpClient 允许返回已解析的 payload，也兼容 fetch Response 形态。
 */
async function toRerankPayload(result) {
  if (result && typeof result.json === "function") {
    if (result.ok === false) {
      const status = `${result.status ?? ""} ${result.statusText ?? ""}`.trim();
      throw new Error(`Rerank API request failed: ${status || "unknown error"}`);
    }
    return result.json();
  }
  return result;
}

/**
 * 注入式 reranker（模型层 mock）返回值对齐：允许纯数字、`{ probability }` 或 `{ id, probability }`。
 * 缺省 id 时按 documents 顺序对齐。
 */
function alignRerankerItems(items, documents) {
  if (!Array.isArray(items)) throw new Error("Rerank client did not return an array of results.");
  if (items.length !== documents.length) {
    throw new Error(`Rerank client returned ${items.length} results for ${documents.length} documents.`);
  }
  return items.map((entry, index) => {
    const record = typeof entry === "object" && entry !== null ? entry : { probability: entry };
    const id = record.id === undefined || record.id === null || record.id === "" ? documents[index].id : String(record.id);
    return { id, probability: record.probability };
  });
}

/**
 * 发起 rerank 请求。优先使用注入的 `reranker`（模型层 mock），其次 `httpClient`（传输层 mock），
 * 都没有时才访问 `config.url` 指向的本地服务。
 */
async function requestRerankResults({ documents, query, config }) {
  const body = { model: config.model, query, documents };

  if (config.reranker) {
    const items = await config.reranker({ model: config.model, query, documents });
    return { modelId: config.model || null, results: alignRerankerItems(items, documents) };
  }

  if (config.httpClient) {
    const payload = await toRerankPayload(await config.httpClient({ url: config.url, body, timeoutMs: config.timeoutMs }));
    return { modelId: payload?.model ? String(payload.model) : config.model || null, results: payload?.results };
  }

  assertRerankUrl(config.url);
  const payload = await postRerankRequest({ url: config.url, body, timeoutMs: config.timeoutMs });
  return { modelId: payload?.model ? String(payload.model) : config.model || null, results: payload?.results };
}

/**
 * 校验 rerank 响应并返回 `id -> probability` 映射。
 *
 * 结果可以乱序返回，项目侧一律按 document id 对齐；结果数量、id 唯一性和概率范围都必须合法。
 */
function validateRerankResults(results, documents) {
  if (!Array.isArray(results)) throw new Error("Rerank API response is missing a results array.");
  if (results.length !== documents.length) {
    throw new Error(`Rerank API returned ${results.length} results for ${documents.length} documents.`);
  }
  const probabilities = new Map();
  for (const entry of results) {
    const id = String(entry?.id ?? "").trim();
    if (!id) throw new Error("Rerank API returned a result without an id.");
    if (probabilities.has(id)) throw new Error(`Rerank API returned a duplicate result id: ${id}`);
    const probability = Number(entry?.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Rerank API returned an invalid probability for ${id}: ${entry?.probability}`);
    }
    probabilities.set(id, probability);
  }
  for (const document of documents) {
    if (!probabilities.has(document.id)) {
      throw new Error(`Rerank API response is missing a result for: ${document.id}`);
    }
  }
  return probabilities;
}

/**
 * 读取候选行的相关性分。`result.score` 是检索对外分，标题/来源分等派生字段不参与。
 */
function originalScore(row) {
  const value = Number(row?.result?.score ?? row?.scored?.score ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 命中信号数量，用于 rerank 同分时兜底排序。
 */
function matchCount(row) {
  return asList(row?.result?.matched_by).length;
}

/**
 * 城市检索同分时偏向城市级 chunk，与 `rag_retrieve.mjs` 的同名 tie-breaker 保持一致。
 */
function cityLevelPriority(result, entity) {
  if (entity?.type !== "city") return 0;
  return result?.matched_by?.includes("candidate_cities") && asList(result.candidate_places).length === 0 ? 1 : 0;
}

/**
 * 读取主流程给出的业务软降权 multiplier。
 *
 * 新契约是 `scored.business.tilt_multiplier`；R1 期间保留旧字段兼容，避免外部 fixture
 * 尚未迁移时把软降权整段丢掉。拿不到或不是有限数按 1 处理，避免 NaN 渗进最终分。
 */
function penaltyMultiplierOf(row) {
  const value = Number(row?.scored?.business?.tilt_multiplier ?? row?.scored?.businessPenaltyMultiplier);
  return Number.isFinite(value) ? value : 1;
}

/**
 * rerank 后排序：最终分优先，随后用相关性分、命中信号数量、城市级优先级和稳定字段兜底。
 */
function compareRerankedRows(left, right, entity) {
  return (
    right.item.final_rerank_score - left.item.final_rerank_score ||
    right.item.original_score - left.item.original_score ||
    matchCount(right.row) - matchCount(left.row) ||
    cityLevelPriority(right.row?.result, entity) - cityLevelPriority(left.row?.result, entity) ||
    String(left.row?.chunk?.source_uri ?? "").localeCompare(String(right.row?.chunk?.source_uri ?? ""), "zh-CN") ||
    String(left.item.chunk_id).localeCompare(String(right.item.chunk_id), "zh-CN")
  );
}

/**
 * 对候选 rows 执行 rerank。
 *
 * @param {Array} rows `retrieve()` 内部 rows，未 rerank 前按召回窗口排序。
 * @param {{ query?: string, rerankQuery?: string, entity?: { type: string, name: string } | null, theme?: string, topK?: number }} request
 * @param {object} config rerank overrides；也接受 `resolveRerankConfig()` 的结果。
 * @returns {Promise<{ rows: Array, diagnostics: object }>}
 *
 * 返回的 `rows` 只包含窗口内且过阈值的候选，并按 `final_rerank_score` 排序。
 * 窗口外候选、以及窗口内被阈值过滤的候选都不再出现在返回值里，因此某个 theme
 * 可能少于 `topK` 条结果 —— 这是刻意的：不为凑满名额引入弱相关内容。
 * 跳过 rerank 时原样返回输入 rows。
 */
export async function rerankRows(rows, request = {}, config = {}) {
  const resolved = resolveRerankConfig(config);
  const rankedRows = asList(rows);
  const entity = request.entity ?? null;
  const entityType = entity?.type ?? null;
  const theme = String(request.theme ?? "");
  const topK = Number.isFinite(Number(request.topK)) ? Number(request.topK) : null;

  // 先构造完整诊断骨架，每个退出分支都复用同一套字段，避免下游判空。
  const diagnostics = {
    enabled: resolved.enabled,
    applied: false,
    skipped_reason: null,
    url: resolved.url,
    model_id: resolved.model || null,
    rerank_query: null,
    recall_width: resolved.recallWidth,
    probability_threshold: resolved.probThreshold,
    input_count: 0,
    kept_count: 0,
    filtered_count: 0,
    out_of_window_count: 0,
    duration_ms: 0,
    items: [],
  };
  const skip = (reason) => {
    diagnostics.skipped_reason = reason;
    return { rows: rankedRows, diagnostics };
  };

  if (!resolved.enabled) return skip(SKIPPED_DISABLED);
  validateRerankOptions(resolved, topK);
  if (!entityType || !entity?.name) return skip(SKIPPED_MISSING_ENTITY);
  if (!isThemeInScope(entityType, theme, resolved)) return skip(SKIPPED_THEME_NOT_IN_SCOPE);

  const windowRows = rankedRows.slice(0, resolved.recallWidth);
  if (!windowRows.length) return skip(SKIPPED_EMPTY_CANDIDATES);

  const rerankQuery = String(request.rerankQuery ?? "").trim() || buildRerankQuery(entity, theme, resolved);
  const documents = windowRows.map((row) => buildRerankDocument(row.chunk, resolved.maxDocChars));
  diagnostics.rerank_query = rerankQuery;
  diagnostics.input_count = windowRows.length;
  diagnostics.out_of_window_count = rankedRows.length - windowRows.length;

  // 显式启用时快速失败：请求和响应校验的任何异常都带上 target/theme 上下文后抛出，
  // 便于批量生成时定位是哪个 target 的哪个 theme 失败。
  const failureContext = `Rerank failed for ${entityType} ${entity.name} / ${theme}`;
  const startedAt = Date.now();
  let response;
  try {
    response = await requestRerankResults({ documents, query: rerankQuery, config: resolved });
  } catch (error) {
    throw new Error(`${failureContext}: ${error.message}`, { cause: error });
  }
  diagnostics.duration_ms = Date.now() - startedAt;
  diagnostics.model_id = response.modelId ?? diagnostics.model_id;

  let probabilities;
  try {
    probabilities = validateRerankResults(response.results, documents);
  } catch (error) {
    throw new Error(`${failureContext}: ${error.message}`, { cause: error });
  }

  const scored = windowRows.map((row, index) => {
    const document = documents[index];
    const probability = probabilities.get(document.id);
    const penaltyMultiplier = penaltyMultiplierOf(row);
    const passedThreshold = probability >= resolved.probThreshold;
    return {
      row,
      passedThreshold,
      item: {
        chunk_id: document.id,
        original_rank: index + 1,
        original_score: round4(originalScore(row)),
        rerank_probability: round4(probability),
        passed_threshold: passedThreshold,
        penalty_multiplier: round4(penaltyMultiplier),
        final_rerank_score: round4(probability * penaltyMultiplier),
      },
    };
  });

  const kept = scored.filter((entry) => entry.passedThreshold).sort((left, right) => compareRerankedRows(left, right, entity));

  diagnostics.applied = true;
  diagnostics.kept_count = kept.length;
  diagnostics.filtered_count = scored.length - kept.length;
  diagnostics.items = scored.map((entry) => entry.item);

  return { rows: kept.map((entry) => entry.row), diagnostics };
}
