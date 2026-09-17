# RAG Rerank 技术方案

本文定义 RAG 检索链路中的 cross-encoder rerank 能力。方案以可选开关方式接入现有 Node ESM 脚本，默认 RAG 流程保持轻量检索；需要更高 top-5 准确率时，在高风险 theme 内调用本地 rerank API。

## 目标

- 提高每个 target/theme 返回结果的主题相关性，优先解决 `highlights`、`nearby`、`facilities` 和城市 `backup_places` 中泛化触发词带来的跨主题误排。
- rerank 只在实体 gate 之后、theme 内排序截断之前生效。
- rerank 保留现有业务约束：视频来源降权和城市检索中的地点级 chunk 软惩罚必须继续影响最终结果。
- rerank 允许某个 theme 返回少于 `topK` 条结果；无关内容不为凑满名额进入阅读池。
- rerank 不改变 agent 填写 facts 的职责：`retrieval-workspace.json` 仍只提供阅读索引，不自动判断最终攻略事实。

非目标：

- 项目内不引入 Python、模型运行时、常驻服务或向量数据库。
- 项目内不安装或加载 reranker 模型依赖；模型运行能力由全局本地服务提供。
- 不改动上游离线索引链。
- 不在第一阶段实现跨 theme 全局重排或阅读池保底配额。
- 不默认生成 `retrieval-log.json`。

## 接入位置

Rerank 接在 `scripts/rag/rag_retrieve.mjs` 的 `retrieve()` 内：

1. 读取索引并生成 embedding query、rerank query、terms、aliases。
2. 调用 embedding API 得到 `queryVector`。
3. 遍历 `index.chunks`，执行 entity gate 和现有综合打分。
4. 得到 `rankedRows`。
5. 对命中的高风险 theme 取前 `recallWidth` 条执行 rerank。
6. 根据 rerank 概率阈值过滤候选。
7. 把业务 penalty 作为后处理排序信号保留。
8. 截断到 `topK`，生成 `results`。

批量入口 `scripts/rag/create_retrieval_workspace.mjs` 只负责透传 rerank 配置。`collectThemeResults()` 的跨 theme 去重、阅读池名额和 `retrieval_health` 规则保持同一职责边界。

## 模块设计

### 新增 `scripts/rag/rag_rerank.mjs`

职责：

- 判断当前请求是否需要调用 rerank。
- 构造本地 rerank API 请求。
- 解析 `(query, doc)` 对的 `probability` 响应。
- 批量处理候选 rows。
- 支持测试注入 mock reranker 或 mock HTTP client。

导出接口：

```js
export async function rerankRows(rows, request, config = {})
```

`rows` 是 `retrieve()` 中的内部 row 数组，元素保留 `chunk`、`result`、`scored`、`gate` 等字段。

`request` 字段：

```js
{
  query: string,
  rerankQuery: string,
  entity: { type: "place" | "city", name: string } | null,
  theme: string,
  topK: number
}
```

`config` 字段：

```js
{
  enabled: boolean,
  url: string,
  model?: string,
  recallWidth: number,
  probThreshold: number,
  maxDocChars: number,
  timeoutMs: number,
  highRiskThemes: {
    place: string[],
    city: string[]
  },
  reranker?: (pairs) => Promise<Array<{ probability: number }>>
}
```

返回值：

```js
{
  rows: rankedRowsAfterRerank,
  diagnostics: {
    enabled: boolean,
    applied: boolean,
    skipped_reason: string | null,
    url: string,
    model_id: string | null,
    recall_width: number,
    probability_threshold: number,
    input_count: number,
    kept_count: number,
    duration_ms: number,
    items: [
      {
        chunk_id: string,
        original_rank: number,
        original_score: number,
        rerank_probability: number,
        passed_threshold: boolean,
        penalty_multiplier: number,
        final_rerank_score: number
      }
    ]
  }
}
```

### 修改 `scripts/rag/rag_retrieval_config.mjs`

新增配置块：

```js
export const RAG_RERANK_DEFAULTS = {
  enabled: false,
  url: "http://localhost:11435/rerank",
  model: "onnx-community/Qwen3-Reranker-0.6B-ONNX",
  recallWidth: 12,
  probThreshold: 0.9,
  maxDocChars: 700,
  timeoutMs: 120000,
  queryTemplates: {
    place: {
      highlights: "{name}有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？",
      nearby: "{name}周边有哪些顺路、附近或可组合游玩的地点和路线建议？",
      facilities: "{name}现场有哪些厕所、补给、餐饮、休息区、游客中心等设施信息？"
    },
    city: {
      backup_places: "{name}有哪些可作为行程备选、顺路补充或城市周边的小众地点？"
    }
  },
  highRiskThemes: {
    place: ["highlights", "nearby", "facilities"],
    city: ["backup_places"],
  },
};
```

配置原则：

- `enabled` 默认为 `false`，避免常规 RAG workspace 生成变慢。
- `url` 默认指向本地 rerank 服务，实际地址可用 CLI 或环境变量覆盖。
- `model` 只是传给服务的模型选择参数；项目不解析模型路径、不下载模型。
- `recallWidth` 必须大于等于 `topK`，小于等于通过 gate 后的候选数。
- `probThreshold` 作为主题相关性门槛；阈值过滤后不足 `topK` 时直接返回较少条数。
- `queryTemplates` 是固定模板表，只用于 rerank API，不改变 embedding query；没有模板的 theme 使用固定兜底句。
- `highRiskThemes` 是第一阶段白名单。非白名单 theme 不调用模型。

### 修改 `scripts/rag/rag_retrieve.mjs`

新增 CLI 参数：

```bash
--rerank
--rerank-url <url>
--rerank-all-themes
--rerank-theme <theme>
--rerank-recall-width <n>
--rerank-threshold <probability>
--rerank-model <model-name>
--rerank-timeout-ms <n>
```

`parseArgs()` 增加对应字段，并把它们传给 `retrieve()`。

配置读取顺序：

1. CLI 参数。
2. 环境变量 `RAG_RERANK_URL`、`RAG_RERANK_MODEL`、`RAG_RERANK_TIMEOUT_MS`。
3. `RAG_RERANK_DEFAULTS`。

`retrieve()` 增加流程：

```js
const rankedRows = rows
  .filter(...)
  .sort(...);

const reranked = await maybeRerankRows(rankedRows, {
  query,
  rerankQuery,
  entity,
  theme,
  topK,
}, options.rerank);

const selectedRows = reranked.rows.slice(0, topK);
```

排序后处理规则：

- rerank 只改变参与 rerank 窗口内 rows 的顺序和过滤状态。
- 未进入 rerank 窗口的候选不参与最终补位；阈值过滤后不从窗口外拉候选补满。
- 最终排序使用 `final_rerank_score`，同分时使用原始综合分、命中信号数量、城市级优先级和稳定字段兜底。
- `video_source_penalty` 与 `city_place_specific_penalty` 通过 penalty multiplier 或后处理扣分继续生效。

推荐后处理公式：

```text
businessPenalty = 1
  + video_source_penalty_signal * VIDEO_CHUNK_PENALTY_WEIGHT
  + city_place_specific_penalty_signal * city_place_specific_penalty_weight

final_rerank_score = rerank_probability * clamp(businessPenalty, 0.01, 1)
```

公式只用于 rerank 后排序，不写入普通 `result.score` 覆盖现有综合分。`result.score` 保留原始检索分，便于兼容现有 workspace 和测试；rerank 细节只进入诊断日志和 `retrieval.scoring` 元信息。

### 修改 `scripts/rag/create_retrieval_workspace.mjs`

新增 CLI 参数并透传：

```bash
--rerank
--rerank-url <url>
--rerank-all-themes
--rerank-theme <theme>
--rerank-recall-width <n>
--rerank-threshold <probability>
--rerank-model <model-name>
--rerank-timeout-ms <n>
```

`retrieval.scoring` 增加 rerank 元信息：

```json
{
  "strategy": "candidate_gated_embedding_keyword_entity_title_rerank",
  "rerank": {
    "enabled": true,
    "url": "http://localhost:11435/rerank",
    "model_id": "onnx-community/Qwen3-Reranker-0.6B-ONNX",
    "recall_width": 12,
    "probability_threshold": 0.9,
    "theme_scope": {
      "place": ["highlights", "nearby", "facilities"],
      "city": ["backup_places"]
    },
    "threshold_filtering": true,
    "business_penalties_preserved": [
      "video_source_penalty",
      "city_place_specific_penalty"
    ]
  }
}
```

`themes.<theme>[]` 保持只写 `chunk_id`、`score`、`matched_by`。rerank 不把概率写入 `retrieval-workspace.json` 的常规阅读索引，避免 agent 把模型概率当作事实依据。

### 外部 rerank 服务契约

项目侧只调用 HTTP API。全局环境中的 reranker 服务负责安装 `@huggingface/transformers`、下载或加载 Qwen3 reranker 模型、维护模型缓存和执行推理。

健康检查：

```http
GET /health
```

响应：

```json
{
  "ok": true,
  "model": "onnx-community/Qwen3-Reranker-0.6B-ONNX"
}
```

Rerank 请求：

```http
POST /rerank
Content-Type: application/json
```

请求体：

```json
{
  "model": "onnx-community/Qwen3-Reranker-0.6B-ONNX",
  "query": "大山包有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？",
  "documents": [
    {
      "id": "020-dashanbao-note.md#1",
      "title": "大山包",
      "text": "玻璃跳台、峡谷云海、日出日落..."
    }
  ]
}
```

响应体：

```json
{
  "model": "onnx-community/Qwen3-Reranker-0.6B-ONNX",
  "results": [
    {
      "id": "020-dashanbao-note.md#1",
      "probability": 0.9987
    }
  ]
}
```

服务响应要求：

- `results[].id` 必须与请求中的 `documents[].id` 一一对应。
- `probability` 必须是 `[0, 1]` 内的有限数字。
- 服务可以按任意顺序返回结果；项目侧按 `id` 对齐。
- 非 2xx 响应、缺失结果、重复 id 或非法概率都视为 rerank 失败。
- 项目仓库不新增 `@huggingface/transformers` 依赖，不提交模型文件，不管理模型缓存。

## Rerank Query 构造

Embedding query 继续使用 `retrieve()` 已生成的关键词查询：

```text
<entity name> <theme terms...> <free query>
```

Rerank query 使用固定自然语言意图句，不直接复用关键词堆。字段和 theme 是固定集合，因此 query 不在运行时由模型或 agent 改写；项目只按 `entity.type` 和 `theme` 查 `RAG_RERANK_DEFAULTS.queryTemplates`，再把 `{name}` 替换为当前地点或城市名。

固定模板表：

| 类型 | theme | rerank query |
|---|---|---|
| 景点 | `highlights` | `{name}有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？` |
| 景点 | `nearby` | `{name}周边有哪些顺路、附近或可组合游玩的地点和路线建议？` |
| 景点 | `facilities` | `{name}现场有哪些厕所、补给、餐饮、休息区、游客中心等设施信息？` |
| 城市 | `backup_places` | `{name}有哪些可作为行程备选、顺路补充或城市周边的小众地点？` |

固定兜底句：

```text
请判断下面材料是否有助于回答「<entity name> 的 <theme> 相关旅行信息」。
```

doc 使用 chunk 的标题和正文：

```text
标题：<chunk.title>
正文：<chunk.text>
```

`maxDocChars` 默认 700。当前 chunk 平均长度较短，截断主要用于防止异常长文本拖慢推理。

项目侧不构造模型内部 prompt，也不读取 logits。服务内部负责把 `query` 和 `documents` 转换成模型输入，并返回统一的 `probability`。

设计原因：

- embedding query 用关键词堆能保留当前召回行为和词表可解释性。
- rerank query 用自然语言句更贴近 cross-encoder 的判断任务，能减少“推荐火锅”被当成“推荐看点”的误判。
- query 模板集中写死在配置里，后续调优只改模板表，不改模型服务或排序逻辑。

## 启用策略

默认策略：

- 景点：`highlights`、`nearby`、`facilities`
- 城市：`backup_places`

单点调试：

```bash
npm run rag:retrieve -- \
  --rag-index <rag-index.json> \
  --place 大山包 \
  --theme highlights \
  --top-k 5 \
  --rerank \
  --rerank-url http://localhost:11435/rerank \
  --rerank-recall-width 12 \
  --json
```

批量生成：

```bash
npm run rag:workspace -- \
  --facts <facts-workspace.json> \
  --rag-index <rag-index.json> \
  -o <retrieval-workspace.json> \
  --rerank \
  --rerank-url http://localhost:11435/rerank \
  --rerank-recall-width 12 \
  --rerank-threshold 0.9
```

全 theme 调参：

```bash
npm run rag:workspace -- \
  --facts <facts-workspace.json> \
  --rag-index <rag-index.json> \
  -o <retrieval-workspace.json> \
  --rerank \
  --rerank-url http://localhost:11435/rerank \
  --rerank-all-themes
```

## 诊断日志

默认不创建日志。用户传 `--log` 时，`requests[].rerank` 记录 rerank 明细：

```json
{
  "enabled": true,
  "applied": true,
  "skipped_reason": null,
  "url": "http://localhost:11435/rerank",
  "model_id": "onnx-community/Qwen3-Reranker-0.6B-ONNX",
  "rerank_query": "大山包有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？",
  "recall_width": 12,
  "probability_threshold": 0.9,
  "input_count": 12,
  "kept_count": 4,
  "duration_ms": 8820,
  "items": [
    {
      "chunk_id": "020-dashanbao-note.md#1",
      "original_rank": 7,
      "original_score": 0.6821,
      "rerank_probability": 0.9987,
      "passed_threshold": true,
      "penalty_multiplier": 1,
      "final_rerank_score": 0.9987
    }
  ]
}
```

`diagnosticForRow()` 继续记录原始评分 breakdown。`recall_status` 的判定增加 rerank 语义：

- `selected`
- `reranked_filtered`
- `scored_not_selected`
- `zero_score`
- `filtered_by_entity_gate`

`selected_rank` 按最终输出顺序计算。`candidate_rank` 保持原始综合分排序名次。

## 错误处理

- `--rerank` 显式启用时，rerank API 不可用、超时或返回非法结果应直接报错退出，不静默降级。
- 未传 `--rerank` 时，不访问 rerank API。
- theme 不在启用范围内时，记录 `skipped_reason: "theme_not_in_scope"`。
- 候选数为 0 时，记录 `skipped_reason: "empty_candidates"`。
- 候选数小于等于 `topK` 时仍可 rerank 和阈值过滤；这样可以剔除少量明显不相关内容。
- `recallWidth < topK` 时启动参数校验报错。
- `probThreshold` 必须在 `[0, 1]` 内。
- `rerankUrl` 为空或不是有效 URL 时启动参数校验报错。

## 测试方案

### 单元测试：`test/rag_rerank.test.mjs`

覆盖：

- mock reranker 返回概率后，rows 按概率重排。
- 低于阈值的候选被过滤。
- 阈值过滤后结果数量可以少于 `topK`。
- `video_source_penalty` 会降低 `final_rerank_score`。
- 城市 `backup_places` 下地点级 chunk 的 city penalty 保留。
- 非白名单 theme 返回原始 rows，并给出 skipped diagnostics。
- mock HTTP client 返回乱序结果时，项目侧按 document id 对齐。
- API 缺失结果、重复 id 或非法概率时抛错。

### 集成测试：`test/rag_retrieve.test.mjs`

新增 fixture：

- `highlights` 里包含景观 chunk、住宿 chunk、餐饮 chunk。
- mock rerank client 给景观 chunk 高分、住宿餐饮低分。
- 调用 `retrieve(index, { place, theme: "highlights", topK: 5, rerank: { enabled: true, reranker } })`。
- 断言传给 mock rerank client 的 query 是自然语言模板结果，不是关键词堆。
- 断言最终 `results` 只包含过阈值 chunk，且 `result.score` 仍是原始综合分。

### 批量测试：`test/create_retrieval_workspace.test.mjs`

覆盖：

- CLI options 透传到 `collectThemeResults()` 和 `retrieve()`。
- `retrieval.scoring.rerank.enabled` 正确反映启用状态。
- `themes.<theme>[]` 不包含 rerank 概率字段。
- 阈值过滤导致某 theme 为空时，`retrieval_health.warnings` 出现 `empty_theme:<theme>`。

### 手工验证

使用同一份 `rag-index.json` 对照：

```bash
node scripts/rag/rag_retrieve.mjs \
  --rag-index <rag-index.json> \
  --place 大山包 \
  --theme highlights \
  --top-k 5 \
  --json

node scripts/rag/rag_retrieve.mjs \
  --rag-index <rag-index.json> \
  --place 大山包 \
  --theme highlights \
  --top-k 5 \
  --rerank \
  --rerank-url http://localhost:11435/rerank \
  --rerank-recall-width 12 \
  --rerank-threshold 0.9 \
  --json
```

检查点：

- `highlights` 不返回住宿、餐饮、咖啡等非看点内容。
- `drawbacks`、`tickets`、`transport` 等非启用 theme 的输出不发生额外模型调用。
- 批量 rerank 高风险 theme 的耗时在可接受范围内。
- rerank 服务日志中的请求数量符合启用范围和 target/theme 数量。

## 实施顺序

1. 在 `rag_retrieval_config.mjs` 增加 `RAG_RERANK_DEFAULTS`。
2. 新增 `rag_rerank.mjs`，实现 mock-friendly 的 `rerankRows()`、HTTP client、排序和阈值过滤逻辑。
3. 在 `rag_retrieve.mjs` 接入 `maybeRerankRows()`，完成 CLI 参数和诊断结构。
4. 补充单元测试和 `retrieve()` 集成测试，测试中使用 mock rerank client。
5. 在外部全局环境准备 rerank 服务，服务实现 transformers.js 与 Qwen3 reranker 推理。
6. 在 `create_retrieval_workspace.mjs` 透传 CLI 参数，并补充 workspace 元信息测试。
7. 更新 `references/rag-data-contracts.md` 和 `references/rag-workflow.md`，只描述启用 rerank 时的执行方式和日志字段。
8. 用真实样本跑单点和批量验证，记录耗时、空 theme 数、top-5 主观相关性。

## 验收标准

- 未传 `--rerank` 时，现有测试全部通过，默认输出结构不增加模型依赖行为。
- 传 `--rerank` 时，仅启用范围内的 theme 调用 rerank API。
- `result.score`、`themes.<theme>[]` 和 `chunks_by_id` 兼容现有消费方式。
- rerank 诊断只在 `--log` 时写入日志。
- 高风险 theme 允许少于 `topK` 条结果，并通过 `retrieval_health` 暴露空 theme 或弱召回提醒。
- 视频来源和城市地点级 chunk 的业务 penalty 在 rerank 后仍能影响最终排序。
- 项目仓库不新增 `@huggingface/transformers`、`onnxruntime` 或模型文件。
- rerank 服务地址可通过 `--rerank-url` 或 `RAG_RERANK_URL` 配置。

## 风险与控制

- 推理耗时高：默认只跑高风险 theme，`recallWidth` 默认 12。
- 模型概率饱和：概率只用于主题相关性过滤和粗排序，不解释为事实可靠度。
- 服务不可用：显式启用 rerank 时快速失败，提示检查 `RAG_RERANK_URL` 或本地服务状态。
- 依赖下载不稳定：模型下载和缓存由全局 rerank 服务负责，项目侧不管理依赖源。
- 日志体积膨胀：普通 workspace 不写 rerank item，只有 `--log` 写详细诊断。
- 配额问题仍存在：第一阶段不处理跨 theme 阅读池保底；当 `retrieval_quota.dropped_total > 0` 时，agent 按现有规则定向补检索。
