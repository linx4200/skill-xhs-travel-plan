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

`retrieval-workspace.json` 的阅读方向保持 target-first：agent 先选择一个 `places.<地点名>` 或 `cities.<城市名>`，再按当前字段优先读取该 target 下的 `themes.<theme>[]`，最后到顶层 `chunks_by_id` 取原文。`unique_chunk_ids` 是 target 级兜底阅读池，不是默认全量阅读入口。

`chunks_by_id.<chunk_id>` 字段：

- `chunk_id`
- `source_uri`
- `title`
- `candidate_places`
- `candidate_cities`
- `text`

`places.<地点名>` 和 `cities.<城市名>` 字段：

- `target.type`、`target.name`、`target.days`、`target.source_files_count`：检索目标元信息。
- `unique_chunk_ids`：该 target 跨主题去重后的兜底阅读池。只有对应 theme 为空、信息不足、信息互相冲突、字段需要跨 theme 综合判断，或高风险执行字段需要复核时，agent 才按此数组到顶层 `chunks_by_id` 读取原文。
- `retrieval_health.status`：`ok`、`weak` 或 `empty`。只描述 RAG 召回质量，不等同于 facts 完整性或字段完整性。
- `retrieval_health.warnings`：召回偏少、主题为空、城市检索过泛或配额丢弃等软提醒。配额丢弃的格式为 `quota_dropped:<theme>:<count>`。
- `retrieval_health.hard_gap_reasons`：明确无法依赖 RAG 的原因，例如完全没有召回。
- `retrieval_quota.max_chunks`、`selected_chunks`：该 target 的阅读池上限与实际入池数量。
- `retrieval_quota.dropped_total`、`dropped_by_theme`：被阅读池名额丢弃的 chunk 数量，按主题归集。这些 chunk 确实被对应主题命中，但既不在 `unique_chunk_ids` 里，也不在 `themes.<theme>[]` 索引里。默认参数下为 0 和 `{}`。当该值大于 0 时，agent 不得直接判断对应字段没有素材；字段缺口或高风险事项需要用单点检索定向复核。
- `themes.<theme>[]`：字段优先阅读索引；每项固定包含 `chunk_id`、`score` 和 `matched_by`。当条目需要解释业务排序时，可额外包含 `place_specific: true` 或 `tier: 1`。该索引不包含 `rerank_probability`、`final_rerank_score`、`tilt_multiplier` 或 `penalty_multiplier`。agent 填写与该 theme 对应的字段时，优先按这里的 `chunk_id` 到 `chunks_by_id` 读取原文。

阅读池名额按主题顺序先到先得：各主题按 `themes` 的 key 顺序依次入池，池满后新 chunk 一律丢弃（记录到 `retrieval_quota`），已入池的 chunk 仍会登记进后序主题的索引。默认参数下 place 为 10 个主题 × 每个主题 5 条 = 50、city 为 5 × 5 = 25，恰好等于 `max_place_chunks` / `max_city_chunks`，因此默认不产生丢弃；调大 `--place-top-k` / `--city-top-k` 或新增主题后才会触发，且总是从主题顺序末尾开始。

`summary` 字段：

- `place_count`、`city_count`：本次批量检索覆盖的 target 数量。
- `attention_places`、`attention_cities`：`retrieval_health.status` 非 `ok` 或存在硬缺口的 target；供 agent 优先检查召回质量，不表示这些 target 的 facts 字段一定不完整。
- `gap_places`、`gap_cities`：存在硬缺口原因的 target。

检索排序约束：

- 带 `place` 的检索只召回 `candidate_places` 命中目标地点的 chunk。
- 带 `city` 的检索只召回 `candidate_cities` 命中目标城市的 chunk。`backup_places` 中同时绑定 `candidate_places` 的地点级 chunk 进入低优先档；其他 city theme 中的地点级 chunk 只做软降权。
- 若 chunks 含 embedding，则 query embedding 相似度参与主题候选池内排序；标题/正文关键词、实体、标题来源分组成纯相关性分。视频来源和城市地点级业务规则不进入 `score.breakdown`，而由 `business` / `retrieval.scoring.business_rules` 表达。
- 启用 rerank 时，rerank 只在 `retrieval.scoring.rerank.theme_scope` 命中的 target/theme 上执行。rerank 概率只用于主题相关性过滤和内部排序，不写入常规阅读索引。

`retrieval.scoring` 字段：

- `strategy`：检索排序策略名。启用 rerank 时以 `_rerank` 结尾。
- `weights`：相关性分权重。只描述 query embedding、关键词、实体和标题来源等相关性信号。
- `business_rules.city_tier_themes`：城市检索中使用硬档位的 theme；当前为 `backup_places`。
- `business_rules.video_tilt`：视频来源软降权幅度。
- `business_rules.city_tilt.default`、`business_rules.city_tilt.by_theme`：非硬档位 city theme 中地点级 chunk 的软降权规则。
- `rerank.enabled`：本次批量生成是否启用 rerank。
- `rerank.url`：项目侧调用的本地 rerank HTTP endpoint。
- `rerank.model_id`：传给 rerank 服务的模型标识。
- `rerank.recall_width`：每个命中 theme 进入 rerank 的候选窗口宽度。
- `rerank.probability_threshold`：rerank 概率阈值；低于阈值的候选不进入该 theme 的常规结果。
- `rerank.theme_scope.place`、`rerank.theme_scope.city`：默认和额外启用的 rerank theme 白名单。
- `rerank.theme_scope.all_themes`：是否对所有 theme 启用 rerank。为 `true` 时 `place` / `city` 列表仍输出，但不代表实际启用范围。
- `rerank.threshold_filtering`：是否按概率阈值过滤。
- `rerank.business_rules_preserved`：是否保留业务排序规则；为 `true` 时 rerank 后仍先按 `tier` 分层，再按软降权后的 rerank 分排序。

Agent 填 facts 时按字段优先读取 `themes.<theme>[]` 的 chunk_id，再到顶层 `chunks_by_id` 读取原文；`unique_chunk_ids` 只在 theme 为空、信息不足、冲突、综合判断或高风险复核时作为兜底。若已读 chunk 中出现本次行程城市或地点的海拔数值，必须写入对应 facts 目标的 `elevation_m`。不要把 `text`、`score`、`matched_by` 或大段 evidence 写入最终 `facts-workspace.json`。

## retrieval-log.json

`retrieval-log.json` 是用户明确要求时才生成的可选调试产物，由 `scripts/rag/rag_retrieve.mjs --log` 或 `scripts/rag/create_retrieval_workspace.mjs --log` 生成。默认 RAG 流程不得创建该文件。它解释每个 chunk 如何被召回、是否被过滤、向量相似度如何参与相关性分、业务状态如何影响排序，以及 rerank 是否执行。该文件面向调试和调参，不作为 facts 填充的事实来源。

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
- `rerank`：rerank 诊断块；未启用或未命中范围时记录跳过原因，启用时记录 query、阈值、概率、`tier`、软降权乘子和最终 rerank 排序分。
- `chunks[]`：该请求下每个 chunk 的评估日志。

`requests[].chunks[]` 字段：

- `chunk_id`、`source_uri`、`title`
- `gate.passed`、`gate.reason`
- `recall_status`：`selected`、`reranked_filtered`、`scored_not_selected`、`zero_score` 或 `filtered_by_entity_gate`
- `candidate_rank`、`selected_rank`
- `matched_by`
- `vector_match.used`、`query_dimensions`、`chunk_dimensions`、`chunk_has_embedding`、`cosine_similarity`
- `score.profile`、`weights`、`signals`、`contributions`、`total`
- `business.tier`、`tilt_multiplier`、`is_video`、`place_specific`
- `candidate_places`、`candidate_cities`

日志不复制完整 embedding 数组。

`requests[].rerank` 字段：

- `enabled`、`applied`、`skipped_reason`
- `url`、`model_id`
- `rerank_query`
- `recall_width`、`probability_threshold`
- `input_count`、`kept_count`、`filtered_count`、`out_of_window_count`
- `duration_ms`
- `items[]`：窗口内候选诊断，包含 `chunk_id`、`original_rank`、`original_score`、`tier`、`rerank_probability`、`passed_threshold`、`penalty_multiplier` 和 `final_rerank_score`。这些字段只用于日志调试，不进入常规 `retrieval-workspace.json` 阅读索引。

## facts-workspace.json 的 RAG 差异

共同 facts 字段见 [data-contracts.md](data-contracts.md)。RAG-only 分支有以下差异：

- `source.resource_index` 应为空字符串。
- `source.rag_index` 应记录当前 RAG index 文件名或相对路径。
- `source.source_chunks` 应记录由 `rag-index.source_chunks` 解析出的绝对目录路径。
- `source.photo_resource_root` 应记录输入 `rag-index.json` 所在目录，渲染脚本用它定位同级 `photos/` 下的本地照片。
- `places.*.source_files` 和 `cities.*.source_files` 来自命中 chunk 的 `source_uri` / `path`，只作为内部来源线索和调试口径，不表示必须回读原始文本。
- `photos` 由 `create_fact_workspace.mjs --rag-index` 直接扫描输入的 `rag-index.json` 同级 `photos/` 的目录名、文件名和路径后按地点名或别名归属。该字段不保存图片 OCR、视觉摘要或其他画面解析结果。
