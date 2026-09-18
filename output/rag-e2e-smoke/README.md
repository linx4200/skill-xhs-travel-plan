# RAG E2E Smoke 验证方案

本目录用于最小化验证完整 RAG 流程，并让每一步的输入、输出、脚本行为和 agent 处理过程都可 inspect。

## 验证目标

验证链路：

```text
route-structure.json
-> rag-index 校验
-> facts-workspace skeleton
-> retrieval-workspace
-> agent 读取 retrieval
-> facts-patch
-> facts-workspace
-> HTML render
-> verify
```

重点观察：

- 每个脚本的输入、输出和统计结果。
- RAG 检索为什么召回这些 chunk。
- agent 读取了哪些 target、theme 和 chunk。
- agent 如何把 chunk 信息转成 facts patch。
- 最终 HTML 是否由 facts 正确渲染。

## 目录结构

```text
output/rag-e2e-smoke/
  README.md
  route-structure.json
  rag-index.json
  facts-workspace.json
  retrieval-workspace.json
  retrieval-log.json
  agent-trace.md
  patches/
    place-<地点名>.json
    city-<城市名>.json
    day-level.json
    global-level.json
  html/
```

## 最小 Fixture 要求

`route-structure.json` 和 `rag-index.json` 保持小规模，便于人工审查。

建议内容：

- 1 天路线。
- 2 个地点。
- 1 个城市。
- 6-8 个 chunks。
- 至少包含目标地点 A 的亮点、门票、交通。
- 至少包含目标地点 B 的亮点、风险。
- 至少包含城市级住宿、美食或备选点。
- 至少包含 1 条路线外地点干扰 chunk。
- 至少包含 1 条同地点但 off-theme 的 chunk，用来观察主题过滤。

第一轮验证使用 `--no-embedding`，不启用 rerank。主链路稳定后，再单独验证 embedding 和 rerank。

## Step 1：输入契约检查

运行：

```bash
npm run rag:validate -- output/rag-e2e-smoke/rag-index.json
```

Inspect：

- chunk 总数。
- 必填字段是否齐全。
- `candidate_places` / `candidate_cities` 是否存在。
- 命令输出是否只包含统计和错误，不打印 chunk 全文或 embedding。

通过标准：

- 校验成功。
- 契约错误能明确指出字段或结构问题。
- 输出不泄露大段原文。

## Step 2：路线结构检查

人工 inspect：

```text
output/rag-e2e-smoke/route-structure.json
```

检查：

- `days[].route_places` 只包含本次验证地点。
- `cities` 包含验证城市。
- route place 名称能和 `rag-index.json` 中的 `candidate_places` 对上。

通过标准：

- 目标地点和城市数量与预期一致。
- 没有多余路线目标。

## Step 3：创建 Facts Skeleton

运行：

```bash
npm run create-workspace -- \
  --route-json output/rag-e2e-smoke/route-structure.json \
  --rag-index output/rag-e2e-smoke/rag-index.json \
  -o output/rag-e2e-smoke/facts-workspace.json
```

Inspect：

```text
output/rag-e2e-smoke/facts-workspace.json
```

检查：

- `places`、`cities`、`trip.days` 已创建。
- `needs_agent_review` 为 `true`。
- facts 字段基本为空。
- `source.rag_index` 和 `source.photo_resource_root` 存在。
- 文件内没有 chunk 原文、score 或 `matched_by`。

通过标准：

- skeleton 只建槽位，不提前抽取攻略事实。

## Step 4：创建 Retrieval Workspace 和 Log

运行：

```bash
npm run rag:workspace -- \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --rag-index output/rag-e2e-smoke/rag-index.json \
  -o output/rag-e2e-smoke/retrieval-workspace.json \
  --no-embedding \
  --log output/rag-e2e-smoke/retrieval-log.json
```

Inspect `retrieval-workspace.json`：

- `chunks_by_id`
- `places.<地点名>.themes`
- `places.<地点名>.unique_chunk_ids`
- `cities.<城市名>.themes`
- `summary.attention_places`
- `retrieval_health`

Inspect `retrieval-log.json`：

- 每个 request 的 entity gate 是否按 candidate place/city 生效。
- 干扰 chunk 是否被过滤。
- `selected`、`zero_score`、`filtered_by_entity_gate` 是否合理。
- 每个 theme 的 query 和 `selected_rank` 是否可解释。

通过标准：

- 目标地点只召回 `candidate_places` 命中的 chunks。
- 目标城市只召回 `candidate_cities` 命中的 chunks。
- 干扰 chunk 不进入对应 target。
- `retrieval-workspace.json` 只包含阅读包，不包含最终 facts。

## Step 5：执行并记录 Agent 处理过程

这一步没有固定项目脚本，因为它验证的是 agent 如何阅读 `retrieval-workspace.json` 并判断事实。执行时按单个 target 处理，每次只处理一个地点或城市。

### Step 5.1：选择一个 Target

先列出本轮可以处理的 target：

```bash
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync("output/rag-e2e-smoke/retrieval-workspace.json","utf8")); console.log("places:", Object.keys(r.places||{})); console.log("cities:", Object.keys(r.cities||{}));'
```

选择一个 target，例如：

```text
places.兴文石海
```

### Step 5.2：Inspect 该 Target 的读取入口

只打印该 target 的 theme 和 chunk_id，不打印 chunk 原文：

```bash
node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync("output/rag-e2e-smoke/retrieval-workspace.json","utf8")); const t=r.places["兴文石海"]; for (const [theme, items] of Object.entries(t.themes||{})) console.log(theme, items.map(i=>i.chunk_id)); console.log("unique_chunk_ids", t.unique_chunk_ids); console.log("health", t.retrieval_health);'
```

观察重点：

- 当前字段应该优先读哪个 theme。
- off-theme chunk 是否只出现在合理主题中。
- `retrieval_health.warnings` 是否提示召回偏弱或配额丢弃。

### Step 5.3：让 Agent 处理单个 Target

向 agent 发起单 target 处理请求，格式固定如下：

```text
请只处理 output/rag-e2e-smoke/retrieval-workspace.json 里的 places.兴文石海。

目标字段：
summary, highlights, tickets, practical_info, notes

读取规则：
- 优先按字段读取 themes.<theme>[] 对应 chunk_id，再到 chunks_by_id 读取原文。
- 不触发兜底条件时，不读取完整 unique_chunk_ids。
- 只输出两个文件：
  1. 追加 agent-trace.md
  2. 写入 patches/place-兴文石海.json

写入要求：
- patch 只包含 places.兴文石海。
- 不复制 chunk 原文。
- 不写 chunk_id、score、matched_by 或大段 evidence。
- 不写“材料指出”“材料显示”“来源”等旁白式溯源。
```

agent 执行后，应产生：

```text
output/rag-e2e-smoke/agent-trace.md
output/rag-e2e-smoke/patches/place-兴文石海.json
```

### Step 5.4：Inspect Agent Trace

人工打开：

```text
output/rag-e2e-smoke/agent-trace.md
```

每个 target 都应有一段固定格式记录：

建议格式：

```markdown
## places.<地点名>

目标字段：
summary, highlights, tickets, practical_info, notes

读取入口：
- highlights: chunk-a-1, chunk-a-2
- tickets: chunk-a-3
- transport: chunk-a-4

采用事实：
- highlights: ...
- tickets: ...

丢弃信息：
- chunk-a-2 中的泛泛描述无执行价值，未写入 facts。

冲突/不确定：
- 门票价格与开放时间未确认，写入需出行前确认。

输出 patch：
patches/place-<地点名>.json
```

检查：

- 可以记录读取了哪些 chunk_id。
- 不复制 chunk 原文。
- 不记录 score、matched_by 或大段 evidence 到最终 facts。
- 明确说明采用、丢弃、冲突或不确定信息。

### Step 5.5：Inspect Patch

检查 patch 是否是合法 JSON：

```bash
node -e 'JSON.parse(require("fs").readFileSync("output/rag-e2e-smoke/patches/place-兴文石海.json","utf8")); console.log("patch json ok");'
```

检查 patch 是否误写了检索内部字段或旁白式溯源词：

```bash
node -e 'const fs=require("fs"); const p=fs.readFileSync("output/rag-e2e-smoke/patches/place-兴文石海.json","utf8"); const banned=["chunk_id","matched_by","score","材料指出","材料显示","材料提到","来源"]; const hits=banned.filter(x=>p.includes(x)); if(hits.length){console.error("banned terms:", hits.join(", ")); process.exit(1);} console.log("patch content guard ok");'
```

检查 patch 是否只包含当前 target：

```bash
node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("output/rag-e2e-smoke/patches/place-兴文石海.json","utf8")); const placeKeys=Object.keys(p.places||{}); const cityKeys=Object.keys(p.cities||{}); console.log({placeKeys, cityKeys}); if(placeKeys.length!==1 || placeKeys[0]!=="兴文石海" || cityKeys.length>0) process.exit(1);'
```

通过标准：

- `agent-trace.md` 能说明 agent 读了哪些 theme/chunk_id，以及采用或丢弃的判断。
- patch 是合法 JSON。
- patch 只包含当前 target。
- patch 不包含 chunk 原文、chunk_id、score、matched_by 或旁白式溯源。
- off-theme chunk 被合理处理：可以用于 `practical_info`，但不应被写成 `highlights`、`tickets` 或 `routes` 的核心依据。

## Step 6：单 Target Patch 和 Merge

每个地点单独生成 patch，例如：

```text
output/rag-e2e-smoke/patches/place-<地点名>.json
```

合并：

```bash
npm run apply-facts-patch -- \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --patch output/rag-e2e-smoke/patches/place-<地点名>.json
```

Inspect：

- patch 只包含当前 target。
- 数组字段是完整数组。
- `facts-workspace.json` 只增加判断后的 facts。
- `facts-workspace.json` 不包含 chunk_id、score、matched_by 或大段 evidence。

通过标准：

- 每个 patch 可以独立审查。
- 出错时能定位到具体 target。
- `facts-workspace.json` 始终保持事实层干净。

## Step 7：Day 和 Global Patch

地点和城市完成后，再单独生成：

```text
output/rag-e2e-smoke/patches/day-level.json
output/rag-e2e-smoke/patches/global-level.json
```

检查：

- day summary / timeline 只基于已写入 facts 和 route。
- global notes / confirm-before-departure 只汇总跨天风险和出行前确认项。
- 不重新引入未采用 chunk 信息。

## Step 8：渲染和最终校验

运行：

```bash
npm run render -- output/rag-e2e-smoke/facts-workspace.json -o output/rag-e2e-smoke/html
npm run verify -- output/rag-e2e-smoke/html
```

Inspect：

- `output/rag-e2e-smoke/html/index.html`
- 每日页面。
- 城市页面是否只在 `include: true` 时出现。
- verify 输出。

通过标准：

- HTML 能生成。
- verify 通过。
- 页面内容和 `facts-workspace.json` 对得上。

## 可选扩展验证

主链路通过后，再逐项打开复杂组件。

### 验证 Embedding

运行 `rag:workspace` 时移除 `--no-embedding`，并确保本地 embedding 服务可访问。

检查：

- `retrieval-log.json` 中 `query_embedding.used` 为 `true`。
- chunk 的 `vector_match.cosine_similarity` 有值。
- 排序变化可以解释。

### 验证 Rerank

先启动本地 rerank 服务：

```bash
cd ~/Documents/rag-reranker
node server.mjs
curl http://127.0.0.1:11435/health
```

再运行：

```bash
npm run rag:workspace -- \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --rag-index output/rag-e2e-smoke/rag-index.json \
  -o output/rag-e2e-smoke/retrieval-workspace.json \
  --rerank \
  --rerank-url http://127.0.0.1:11435/rerank \
  --rerank-recall-width 12 \
  --rerank-threshold 0.9 \
  --log output/rag-e2e-smoke/retrieval-log.json
```

检查：

- `retrieval.scoring.rerank.enabled` 为 `true`。
- `retrieval-log.json` 中对应 theme 有 rerank 诊断。
- `filtered_count`、`kept_count`、`rerank_probability` 可解释。

### 验证 Quota Dropped

通过调小阅读池上限或调大 top-k，故意触发 `retrieval_quota.dropped_total > 0`。

检查：

- `retrieval_quota.dropped_by_theme` 记录被丢弃主题。
- `retrieval_health.warnings` 出现 `quota_dropped:<theme>:<count>`。
- agent 不把 quota dropped 误判为“该 theme 没有素材”。
