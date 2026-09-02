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
- `embedding.provider`、`model`、`dimensions`：向量信息；当前 MVP 检索不调用 embedding API，但保留用于后续升级。
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
- `retrieval.place_themes`：景点默认检索主题。
- `retrieval.city_themes`：城市默认检索主题。
- `retrieval.place_top_k`、`city_top_k`：每个主题保留的结果数量。
- `retrieval.max_place_chunks`、`max_city_chunks`：单个 target 跨主题去重后的最大阅读 chunk 数。
- `retrieval.scoring`：检索排序策略说明，用于复现实验和调参。带 `place` / `city` 的检索会先要求 chunk 命中目标实体，再用主题关键词排序；纯关键词命中不会进入该实体命中池。
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

## facts-workspace.json 的 RAG 差异

共同 facts 字段见 [data-contracts.md](data-contracts.md)。RAG-only 分支有以下差异：

- `source.resource_index` 应为空字符串。
- `source.rag_index` 应记录当前 RAG index 文件名或相对路径。
- `places.*.source_files` 和 `cities.*.source_files` 来自命中 chunk 的 `source_uri` / `path`，只作为内部来源线索和调试口径，不表示必须回读原始文本。
- `photos` 由 `create_fact_workspace.mjs --rag-index` 直接扫描 `rag-index.resource_root/photos` 后按地点名或别名归属。

RAG-only happy path 不创建 `resource-index.json`、`reading-queue.json`、`source-digest.json` 或 `read-log.json`。
