# RAG 分支数据契约

本文件只记录 RAG 分支专属 JSON 契约。共同结构见 [data-contracts.md](data-contracts.md)，事实取舍见 [info-rules.md](info-rules.md)，执行步骤见 [rag-workflow.md](rag-workflow.md)。

## rag-index.json

`rag-index.json` 由上游 RAG 索引生成流程提供，当前 skill 直接消费，不在主流程中重新扫描原始文本材料。

支持两种输入：

- JSON：顶层包含 `chunks` 数组。
- JSONL：每行一个 chunk，作为旧版兼容格式。

JSON 版本重要字段：

- `schema_version`：索引结构版本。
- `resource_root`：结构化流程字段；RAG-only 流程不使用它定位本地照片。
- `source_chunks`：上游 chunk 来源目录。RAG-only 流程不使用它定位本地照片。
- 本地照片：位于输入的 `rag-index.json` 同级 `photos/` 目录。照片只按目录名、文件名和路径处理，不读取图片画面。
- `embedding.provider`、`embedding.model`、`embedding.dimensions`：向量信息。chunks 含有 `embedding` 向量时，检索脚本会调用真实 embedding API 生成 query 向量参与排序。
- `chunks[]`：RAG chunk 列表。

`chunks[]` 重要字段：

- `chunk_id`：chunk 稳定 ID。
- `source_uri`：原始来源 URI，用于内部溯源。
- `path`：可选；相对资源目录的源文件路径。
- `title`：note 或 chunk 标题。
- `kind`：可选；素材类型。
- `text`：chunk 原文。
- `candidate_places`：该 chunk 实际命中的候选景点名，不是候选全集。
- `candidate_cities`：该 chunk 实际命中的候选城市名，不是候选全集。
- `metadata`：可选；上游元信息。
- `embedding`：可选；向量数组。

Agent 不直接读取 `rag-index.json`。需要校验时调用 `scripts/rag/validate_rag_index.mjs`，需要召回时调用 `scripts/rag/create_retrieval_workspace.mjs` 或 `scripts/rag/rag_retrieve.mjs`。

## retrieval-workspace.json

`retrieval-workspace.json` 由 `scripts/rag/create_retrieval_workspace.mjs` 根据 `facts-workspace.json` 和 `rag-index.json` 生成，用于 RAG 分支下的批量 chunk 阅读。脚本只整理检索结果和阅读顺序，不会抽取最终攻略事实，也不会把结果自动写回 `facts-workspace.json`。

顶层字段：

- `schema_version`：数据结构版本。
- `source.facts_workspace`：生成 retrieval workspace 时使用的事实工作区路径。
- `source.rag_index`：本次检索使用的 RAG 索引路径。
- `source.retrieval_log`：可选；仅在传入 `--log` 时存在。
- `retrieval.place_themes`、`retrieval.city_themes`：默认检索主题，默认值来自 `scripts/rag/rag_retrieval_config.mjs`。
- `retrieval.place_top_k`、`retrieval.city_top_k`：每个主题保留的结果数量。
- `retrieval.max_place_chunks`、`retrieval.max_city_chunks`：单个 target 跨主题去重后的最大阅读 chunk 数。
- `retrieval.scoring`：检索排序策略说明，用于复现实验和调参。
- `chunks_by_id`：本次批量检索命中的全局唯一 chunk 原文库；同一 chunk 即使命中多个 target 或 theme，`text` 也只保存一份。
- `places`：地点 target 的检索阅读包。
- `cities`：城市 target 的检索阅读包。
- `summary`：批量检索覆盖数量和需要关注的 target。

`chunks_by_id.<chunk_id>` 字段：

- `chunk_id`
- `source_uri`
- `title`
- `candidate_places`
- `candidate_cities`
- `text`

`places.<地点名>` 和 `cities.<城市名>` 字段：

- `target.type`、`target.name`、`target.days`、`target.source_files_count`：检索目标元信息。
- `unique_chunk_ids`：该 target 跨主题去重后的 chunk 阅读顺序。Agent 初次填该地点或城市 facts 时按此数组到顶层 `chunks_by_id` 读取原文。
- `retrieval_health.status`：`ok`、`weak` 或 `empty`。只描述 RAG 召回质量，不等同于 facts 完整性。
- `retrieval_health.warnings`：召回偏少、主题为空或城市检索过泛等软提醒。
- `retrieval_health.hard_gap_reasons`：明确无法依赖 RAG 的原因，例如完全没有召回。
- `themes.<theme>[]`：主题命中索引；每项只包含 `chunk_id`、`score` 和 `matched_by`。

`summary` 字段：

- `place_count`、`city_count`：本次批量检索覆盖的 target 数量。
- `attention_places`、`attention_cities`：`retrieval_health.status` 非 `ok` 或存在硬缺口的 target；供 agent 优先检查。
- `gap_places`、`gap_cities`：存在硬缺口原因的 target。

检索排序约束：

- 带 `place` 的检索只召回 `candidate_places` 命中目标地点的 chunk。
- 带 `city` 的检索只召回 `candidate_cities` 命中目标城市的 chunk，并对同时绑定 `candidate_places` 的地点级 chunk 施加 theme-sensitive 软惩罚。
- 若 chunks 含 embedding，则 query embedding 相似度参与主题候选池内排序；标题/正文关键词、实体、标题来源分和来源 penalty 保留为可解释排序信号。

Agent 填 facts 时按 `unique_chunk_ids` 到顶层 `chunks_by_id` 读取原文，再用 `themes` 辅助定位字段。若 chunk 中出现本次行程城市或地点的海拔数值，必须写入对应 facts 目标的 `elevation_m`。不要把 `text`、`score`、`matched_by` 或大段 evidence 写入最终 `facts-workspace.json`。

## retrieval-log.json

`retrieval-log.json` 是用户明确要求时才生成的可选调试产物，由 `scripts/rag/rag_retrieve.mjs --log` 或 `scripts/rag/create_retrieval_workspace.mjs --log` 生成。默认 RAG 流程不得创建该文件。它解释每个 chunk 如何被召回、是否被过滤、向量相似度如何参与排序，以及总分如何由各分项贡献组成。该文件面向调试和调参，不作为 facts 填充的事实来源。

顶层字段：

- `schema_version`
- `source`
- `retrieval`
- `summary`
- `request_count`
- `requests[]`

`requests[]` 字段：

- `target_type`、`target_name`：批量流程中的地点或城市目标；单点检索可不存在。
- `query`、`entity`、`theme`：本次检索请求。
- `terms`、`aliases`：参与关键词/别名匹配的词。
- `top_k`：本次检索最多返回多少条 chunk。
- `index_chunk_count`：索引总 chunk 数。
- `query_embedding.used`、`query_embedding.dimensions`：是否生成 query embedding 以及向量维度。
- `chunks[]`：该请求下每个 chunk 的评估日志。

`requests[].chunks[]` 字段：

- `chunk_id`、`source_uri`、`title`
- `gate.passed`、`gate.reason`
- `recall_status`：`selected`、`scored_not_selected`、`zero_score` 或 `filtered_by_entity_gate`
- `candidate_rank`、`selected_rank`
- `matched_by`
- `vector_match.used`、`query_dimensions`、`chunk_dimensions`、`chunk_has_embedding`、`cosine_similarity`
- `score.profile`、`weights`、`signals`、`contributions`、`total`
- `candidate_places`、`candidate_cities`

日志不复制完整 embedding 数组。

## facts-workspace.json 的 RAG 差异

共同 facts 字段见 [data-contracts.md](data-contracts.md)。RAG-only 分支有以下差异：

- `source.resource_index` 应为空字符串。
- `source.rag_index` 应记录当前 RAG index 文件名或相对路径。
- `source.source_chunks` 应记录由 `rag-index.source_chunks` 解析出的绝对目录路径。
- `source.photo_resource_root` 应记录输入 `rag-index.json` 所在目录，渲染脚本用它定位同级 `photos/` 下的本地照片。
- `places.*.source_files` 和 `cities.*.source_files` 来自命中 chunk 的 `source_uri` / `path`，只作为内部来源线索和调试口径，不表示必须回读原始文本。
- `photos` 由 `create_fact_workspace.mjs --rag-index` 直接扫描输入的 `rag-index.json` 同级 `photos/` 的目录名、文件名和路径后按地点名或别名归属。该字段不保存图片 OCR、视觉摘要或其他画面解析结果。
