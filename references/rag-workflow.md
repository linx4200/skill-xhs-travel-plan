# RAG 检索工作流

本流程用于用户提供 `rag-index.json` 时生成旅游攻略事实工作区。RAG 只减少 agent 需要阅读的素材范围，不自动判断最终攻略事实。`retrieval-workspace.json` 中的 chunk 必须经 agent 按 [info-rules.md](info-rules.md) 判断、去重、处理冲突后，才能写入 `facts-workspace.json`。

共同 JSON 契约见 [data-contracts.md](data-contracts.md)，RAG 分支专属契约见 [rag-data-contracts.md](rag-data-contracts.md)。

## 原则

- `rag-index.json` 只能作为项目脚本输入。Agent 不得用 `cat`、`sed`、`head`、`jq`、临时脚本或编辑器打开、抽样、检索、统计或阅读其中的 `chunks`、`text`、`embedding`。
- RAG happy path 不创建 `resource-index.json`、`reading-queue.json`、`source-digest.json`、`read-log.json` 或 `retrieval-log.json`。只有用户明确要求召回日志、检索日志或召回原因诊断时，才创建 `retrieval-log.json`。
- 先批量生成 `retrieval-workspace.json`，再按 target 的 `unique_chunk_ids` 局部阅读 chunks；不要把流程变成反复手写关键词、反复检索的主循环。
- `themes` 只辅助定位字段，不能代替事实判断。不要把 chunk 原文、score、`matched_by` 或大段 evidence 写入 `facts-workspace.json`。
- 后续局部修改优先复用已有 `retrieval-workspace.json` 的 target、`unique_chunk_ids` 和 `themes`；只有字段缺口、冲突或高风险不确定项需要复核时才定向补检索。
- 照片只按 `rag-index.source_chunks/photos` 下的目录名、文件名和路径归属，不读取、预览、OCR 或视觉解析图片内容。

## 输入

必须具备：

- 用户路线，或 agent 已创建的 `route-structure.json`。
- `rag-index.json`。

可选具备：

- `rag-index.source_chunks/photos` 对应的本地照片目录；缺失时只影响照片归属，不触发原材料回读。

## Step 1：创建 Route Structure

由 agent 读取用户原始路线，按 [info-rules.md](info-rules.md) 的路线解析规则生成 `route-structure.json`。路线解析不要交给脚本用正则完成；脚本只接收 agent 已经判断过的结构。

`route-structure.json` 的结构和字段见 [data-contracts.md](data-contracts.md)。

## Step 2：校验 RAG Index

用固定脚本读取并校验 `rag-index.json`：

```bash
node scripts/rag/validate_rag_index.mjs <rag-index.json>
```

校验目标：

- 顶层应能解析为 JSON 或 JSONL。
- chunk 应包含可用于检索的 `chunk_id`、`source_uri`、`title`、`text`、`candidate_places` 和 `candidate_cities`。
- 如果需要渲染本地照片，`source_chunks` 应指向可读资源目录，且照片应位于 `<source_chunks>/photos/` 下。

命令输出只保留统计和错误；不要把 `chunks[].text`、chunk 标题列表或 `embedding` 打印到对话上下文。脚本报错时停止当前流程，并向用户报告错误。

## Step 3：创建 Skeleton Facts Workspace

运行：

```bash
node scripts/create_fact_workspace.mjs \
  --route-json <工作目录>/route-structure.json \
  --rag-index <rag-index.json> \
  -o <工作目录>/facts-workspace.json
```

脚本只创建可渲染 facts 的空槽位和来源线索，不补攻略事实。生成后 `needs_agent_review` 应保持 `true`。

RAG 分支下的 skeleton 应至少包含 schema/source、trip days、route places、cities、`global_notes` 和 `confirm_before_departure`。RAG chunk 原文、检索分数、字段完整性状态、补检索决策和大段 evidence 不写入 `facts-workspace.json`。

## Step 4：创建 Retrieval Workspace

运行：

```bash
node scripts/rag/create_retrieval_workspace.mjs \
  --facts <工作目录>/facts-workspace.json \
  --rag-index <rag-index.json> \
  -o <工作目录>/retrieval-workspace.json
```

Embedding 配置规则：

- RAG 检索使用真实 embedding API。优先使用当前 shell 环境中的 `RAG_EMBEDDING_URL`、`RAG_EMBEDDING_MODEL`。
- `RAG_EMBEDDING_URL` 未设置时，脚本默认使用 `http://localhost:11434/api/embed`。
- `RAG_EMBEDDING_MODEL` 未设置时，脚本回退到 `rag-index.json` 的 `embedding.model`。
- 如果环境变量和索引里都没有 model，先询问用户模型名，或在用户同意时使用 `--no-embedding` 临时关闭向量排序。
- 不要把 API key 写入 skill、reference 或项目文件；需要 key 时只通过环境变量传入。

如果 embedding URL 是 `localhost`、`127.0.0.1` 或 `::1`，第一次运行 `scripts/rag/create_retrieval_workspace.mjs` 或 `scripts/rag/rag_retrieve.mjs` 时就请求在可访问用户宿主机 loopback 端口的执行环境里运行，并说明这是为了访问用户本地 embedding API。只有用户拒绝授权，或本地端点在可访问环境里仍失败时，才考虑 `--no-embedding` 降级或让用户检查本地服务。

`retrieval-workspace.json` 应包含：

- 顶层 `chunks_by_id`，保存本次批量检索命中的唯一 chunk 原文。
- `places.<地点名>.target`、`unique_chunk_ids`、`retrieval_health` 和 `themes`。
- `cities.<城市名>.target`、`unique_chunk_ids`、`retrieval_health` 和 `themes`。
- `summary.attention_places`、`attention_cities`、`gap_places` 和 `gap_cities`。

默认不生成 `retrieval-log.json`。只有用户明确要求时，才追加 `--log <工作目录>/retrieval-log.json`。日志面向调试和调参，不作为 facts 填充的事实来源。

## Step 5：填充第一版 Facts Workspace

Agent 读取 `retrieval-workspace.json` 后整理局部 `facts-patch.json`，再运行：

```bash
node scripts/apply_facts_patch.mjs \
  --facts <工作目录>/facts-workspace.json \
  --patch <工作目录>/facts-patch.json
```

处理顺序：

1. 做引用完整性检查：facts 中的地点和城市都有对应 retrieval target，且 `unique_chunk_ids` / `themes.*[].chunk_id` 都能在 `chunks_by_id` 中找到。
2. 按每日 `route_places` 顺序处理 `places`，先读 `unique_chunk_ids`，再用 `themes` 辅助定位字段。
3. 将有效事实整理成 facts patch，只写判断后的执行信息、冲突和待确认事项，不复制 chunk 原文；如果 chunk 中出现对应地点或城市的海拔数值，必须写入 `places.<地点名>.elevation_m` 或 `cities.<城市名>.elevation_m`。
4. 基于已写地点内容整理 `trip.days[].summary`、`timeline`、`notes` 和 `confirmations`。
5. 所有地点处理完成后再处理 `cities`。城市页 `include` 判断必须先排除已经写进地点页、每日页、全局提醒或确认清单的内容。
6. 最后整理 `global_notes` 和 `confirm_before_departure`。
7. 合并 patch 后继续保持 `needs_agent_review: true`，等待字段级 checklist 和渲染前评估。

写入展示字段前必须做表达自检。`trip.days[].summary/timeline/notes/confirmations`、`places.*`、`cities.*`、`global_notes` 和 `confirm_before_departure` 中不得出现“材料指出”“材料中的”“材料还提到”“材料提到”“材料显示”“材料写到”“材料中出现”“资料中”“来源”等旁白式溯源。只允许保留必要边界提示，例如 `材料未说明`、`需出行前确认`、`未确认`；冲突字段可以说明“记录时间不一”“说法不一致”。

## Step 6：字段级缺口检查

第一版 facts 完成后，不用整体感觉判断是否足够。按字段级 checklist 判断是否需要定向补检索、记录冲突或标注缺口。

每个 route place 至少判断：

- 是否有可写入正文的玩法、亮点或取舍建议。
- 是否有交通、导航、停车、到达方式或内部路线信息。
- 是否有时间、票价、预约、开放、路线封闭等会影响执行的高风险信息。
- 是否有避坑、限制、冲突或材料未说明项。
- 是否保留必要的内部来源线索。

每个 included city 至少判断：

- 是否有足够理由生成城市页。
- 是否有城市级交通、住宿、补给、节奏或风险信息。
- 是否已排除地点页、每日页、全局提醒和确认清单中的重复内容。
- 是否保留必要的内部来源线索。

以下情况不应无限 RAG 检索，应转为定向补检索、冲突保留，或明确写入 `材料未说明` / `出行前确认`：

- 某路线景点去重后的有效 note chunks 少于 3 条。
- 高风险执行字段被材料暗示会影响本次执行，但 RAG 结果缺少关键细节或互相冲突。
- 检索结果太泛、太营销，不能支持可执行建议。
- 同一 chunk 混合多个地点，归属不确定。
- 城市页是否 include 无法判断。

## Step 7：定向补检索

只有 Step 6 发现具体缺口时，才运行 `scripts/rag/rag_retrieve.mjs` 做定向补检索。query 应围绕明确字段和目标，例如某地点的停车入口、预约限制、路线封闭或城市住宿区域；不要为了“再看看有没有更多内容”泛泛检索。

补检索命中内容仍需 agent 判断后写入局部 `facts-patch.json` 并合并。仍不足时，保留冲突、`材料未说明` 或 `需出行前确认`，不要用常识补齐。

## Step 8：渲染前评估

进入渲染前，确认：

- 每个 `route_places` 地点都有可用内容，或明确记录材料不足。
- RAG chunks 中已经出现的城市或景点海拔都已写入对应 `elevation_m`；海拔缺失按 [info-rules.md](info-rules.md) 处理。
- 路线外地点不会进入每日详情。
- 城市页只为 `include: true` 的城市生成。
- 高风险事实不被无来源地断言。
- 冲突信息被保留，而不是被强行合并。
- 全局提醒和出发前确认只包含对本次路线有执行价值的信息。
- 图片只来自本地材料并和地点匹配。

通过字段级检查、必要补检索和渲染前评估后，才可把 `needs_agent_review` 改为 `false` 并进入 HTML 渲染与质量检查。
