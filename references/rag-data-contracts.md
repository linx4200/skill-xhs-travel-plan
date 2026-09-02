# RAG 分支数据契约

本文件只记录 RAG 分支专属 JSON 契约。共同结构见 [data-contracts.md](data-contracts.md)，事实取舍见 [info-rules.md](info-rules.md)，执行步骤见 [rag-workflow.md](rag-workflow.md)。

## rag-index.json

`rag-index.json` 由上游 RAG 索引生成流程提供，当前 skill 直接消费，不在主流程中重新扫描原始文本材料。

支持两种输入：

- JSON：顶层包含 `chunks` 数组。
- JSONL：每行一个 chunk，作为旧版兼容格式。

JSON 版本重要字段：

- `schema_version`：索引结构版本。
- `resource_root`：输入材料文件夹绝对路径；RAG-only 流程只用它定位本地 `photos/`，不回读原始文本。
- `source_chunks`：上游 chunk 来源文件路径或说明。
- `embedding.provider`、`model`、`dimensions`：向量信息；当 chunks 含有 `embedding` 向量时，检索脚本会调用真实 embedding API 生成 query 向量参与排序。
- `chunks[]`：RAG chunk 列表。

`chunks[]` 字段：

- `chunk_id`：chunk 稳定 ID。
- `source_uri`：原始来源 URI，用于内部溯源。
- `path`：可选；相对资源目录的源文件路径。
- `title`：note 或 chunk 标题。
- `kind`：可选；素材类型。
- `text`：chunk 原文。
- `candidate_places`：该 chunk 实际命中的候选景点名，不是候选全集。
- `candidate_cities`：该 chunk 实际命中的候选城市名，不是候选全集。
- `keywords`：该 chunk 实际命中的实用关键词。
- `metadata`：可选；上游元信息。
- `embedding`：可选；向量数组。

## retrieval-workspace.json

`retrieval-workspace.json` 由 `create_retrieval_workspace.mjs` 根据 `facts-workspace.json` 和 `rag-index.json` 生成，用于 RAG 分支下的批量 chunk 阅读。脚本只整理检索结果和阅读顺序，不会抽取最终攻略事实，也不会把结果自动写回 `facts-workspace.json`。

重要字段：

- `schema_version`：数据结构版本。
- `source.facts_workspace`：生成 retrieval workspace 时使用的事实工作区路径。
- `source.rag_index`：本次检索使用的 RAG 索引路径。
- `source.retrieval_log`：可选；本次检索调试日志路径，仅在传入 `--log` 时存在。
- `retrieval.place_themes`：景点默认检索主题。
- `retrieval.city_themes`：城市默认检索主题。
- `retrieval.place_top_k`、`city_top_k`：每个主题保留的结果数量。
- `retrieval.max_place_chunks`、`max_city_chunks`：单个 target 跨主题去重后的最大阅读 chunk 数。
- `retrieval.scoring`：检索排序策略说明，用于复现实验和调参。带 `place` 的检索只召回 `candidate_places` 命中目标地点的 chunk；带 `city` 的检索只召回 `candidate_cities` 命中目标城市的 chunk，并优先排序没有 `candidate_places` 的城市级 chunk。若 chunks 含 embedding，则 query embedding 相似度参与主题候选池内排序；主题关键词、实体和标题来源分保留为解释性兜底。
- `chunks_by_id`：本次批量检索命中的全局唯一 chunk 原文库；同一 chunk 即使命中多个 target 或 theme，`text` 也只保存一份。
- `places.<地点名>.target`：地点 target 元信息，包括 `type`、`name`、`days` 和 `source_files_count`。
- `places.<地点名>.unique_chunk_ids`：该地点跨主题去重后的 chunk 阅读顺序。
- `places.<地点名>.retrieval_health`：该地点的召回健康状态；只描述 RAG 召回质量，不等同于 facts 完整性。
- `places.<地点名>.themes.<theme>[]`：主题命中索引；每项只包含 `chunk_id`、`score` 和 `matched_by`。
- `cities.<城市名>.target`：城市 target 元信息，包括 `type`、`name`、`days` 和 `source_files_count`。
- `cities.<城市名>.unique_chunk_ids`：该城市跨主题去重后的 chunk 阅读顺序。
- `cities.<城市名>.retrieval_health`：该城市的召回健康状态；城市检索通常更泛，需由 agent 判断是否有独立增量价值。
- `cities.<城市名>.themes.<theme>[]`：城市主题命中索引；每项只包含 `chunk_id`、`score` 和 `matched_by`。
- `summary.place_count`、`city_count`：本次批量检索覆盖的 target 数量。
- `summary.attention_places`、`attention_cities`：召回健康状态非 `ok` 的 target；供 agent 优先检查，不代表必须回读全部原文。
- `summary.gap_places`、`gap_cities`：存在硬缺口原因的 target。

`chunks_by_id.<chunk_id>` 字段：

- `chunk_id`
- `source_uri`
- `title`
- `candidate_places`
- `candidate_cities`
- `keywords`
- `text`

`retrieval_health` 字段：

- `status`：`ok`、`weak` 或 `empty`。
- `warnings`：召回偏少、主题为空或城市检索过泛等软提醒。
- `hard_gap_reasons`：明确无法依赖 RAG 的原因，例如完全没有召回。

RAG 分支填 facts 时，agent 应按 `unique_chunk_ids` 到顶层 `chunks_by_id` 读取原文，再用 `themes` 辅助定位字段。不要把 `text`、`score`、`matched_by` 或大段 evidence 写入最终 `facts-workspace.json`。

## retrieval-log.json

`retrieval-log.json` 是可选调试产物，由 `rag_retrieve.mjs --log` 或 `create_retrieval_workspace.mjs --log` 生成。它解释每个 chunk 如何被召回、是否被过滤、向量相似度如何参与排序，以及总分如何由各分项贡献组成。该文件面向调试和调参，不作为 facts 填充的事实来源。

顶层字段：

- `schema_version`：日志结构版本。
- `source`：输入索引、facts workspace 和 retrieval workspace 相关路径；批量流程会复用 `retrieval-workspace.json` 的 `source`。
- `retrieval`：批量流程的检索主题、topK、maxChunks 和评分策略；单点 `rag_retrieve.mjs --log` 可不存在。
- `summary`：批量流程的请求数、chunk 评估次数和 selected 结果数。
- `request_count`：单点检索日志的请求数量。
- `requests[]`：每次实际 retrieve 调用的完整诊断。

`requests[]` 字段：

- `target_type`、`target_name`：批量流程中的地点或城市目标；单点检索可不存在。
- `query`、`entity`、`theme`：本次检索请求。
- `terms`、`aliases`：参与关键词/别名匹配的词。
- `top_k`、`max_chunks`、`returned_limit`：本次检索限制。
- `index_chunk_count`：索引总 chunk 数。
- `query_embedding.used`、`dimensions`：是否生成 query embedding 以及向量维度。
- `chunks[]`：该请求下每个 chunk 的评估日志。

`requests[].chunks[]` 字段：

- `chunk_id`、`source_uri`、`title`：chunk 标识。
- `gate.passed`、`gate.reason`：entity gate 是否通过；地点检索必须 `candidate_places` 命中，城市检索必须 `candidate_cities` 命中。
- `recall_status`：`selected`、`scored_not_selected`、`zero_score` 或 `filtered_by_entity_gate`。
- `candidate_rank`：通过 gate 且得分大于 0 后，在候选排序中的名次。
- `selected_rank`：进入最终返回结果后的名次。
- `matched_by`：召回信号，例如 `candidate_places`、`candidate_cities`、`title_source`、`keyword`、`embedding`。
- `vector_match.used`、`query_dimensions`、`chunk_dimensions`、`chunk_has_embedding`、`cosine_similarity`：向量匹配摘要；不保存完整 embedding 数组。
- `score.profile`、`weights`、`signals`、`contributions`、`total`：评分模式、权重、原始分项信号、各分项加权贡献和最终总分。
- `candidate_places`、`candidate_cities`、`keywords`：用于解释 gate 和关键词匹配的结构化字段。

## facts-workspace.json 的 RAG 差异

共同 facts 字段见 [data-contracts.md](data-contracts.md)。RAG-only 分支有以下差异：

- `source.resource_index` 应为空字符串。
- `source.rag_index` 应记录当前 RAG index 文件名或相对路径。
- `places.*.source_files` 和 `cities.*.source_files` 来自命中 chunk 的 `source_uri` / `path`，只作为内部来源线索和调试口径，不表示必须回读原始文本。
- `photos` 由 `create_fact_workspace.mjs --rag-index` 直接扫描 `rag-index.resource_root/photos` 后按地点名或别名归属。

RAG-only happy path 不创建 `resource-index.json`、`reading-queue.json`、`source-digest.json` 或 `read-log.json`；检索调试只按需创建 `retrieval-log.json`。
