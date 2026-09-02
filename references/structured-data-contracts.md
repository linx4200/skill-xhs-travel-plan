# 结构化分支数据契约

本文件只记录没有 `rag-index.json` 时的结构化分支专属 JSON 契约。共同结构见 [data-contracts.md](data-contracts.md)，事实取舍见 [info-rules.md](info-rules.md)，执行步骤见 [structured-generation-workflow.md](structured-generation-workflow.md)。

## resource-index.json

`resource-index.json` 由 `scan_resources.mjs` 生成，只用于低上下文索引和候选匹配，不是事实抽取结果。

重要字段：

- `resource_root`：输入材料文件夹绝对路径。
- `files[].path`：相对输入材料文件夹的文本文件路径。
- `files[].title`：脚本推断的素材标题。
- `files[].kind`：素材类型，例如 `json-note`、`md-note`、`txt-note`。
- `files[].char_count`：文本字符数。
- `files[].keywords`：命中的景点、城市和实用关键词合集。
- `files[].candidate_places`：命中的候选景点名，来自 `route-structure.json`、显式 `--place` 或照片目录。
- `files[].candidate_cities`：命中的候选城市名，来自 `route-structure.json` 或显式 `--city`。
- `files[].excerpt`：短摘录，只用于判断是否需要打开原文。
- `photos`：按 `photos/地点名/` 或 `photos/地点别名/` 目录归属整理的本地照片路径。

## reading-queue.json

`reading-queue.json` 由 `create_reading_queue.mjs` 根据 `resource-index.json` 和 `facts-workspace.json` 生成，用于让 agent 按唯一原文文件读取材料。脚本只整理读取顺序和引用关系，不会抽取或判断攻略事实。

重要字段：

- `schema_version`：数据结构版本。
- `needs_agent_review`：脚本生成后默认为 `true`，表示还需要 agent 阅读原文并填充事实。
- `source.resource_root`：输入材料文件夹绝对路径。
- `source.resource_index`：生成队列时使用的素材索引文件名。
- `source.facts_workspace`：生成队列时使用的事实工作区文件名。
- `stats.source_refs`：从 `places.*.source_files` 和 `cities.*.source_files` 收集到的引用次数。
- `stats.unique_files`：去重后的原文文件数量。
- `stats.unique_source_chars`：去重后文件的字符数总和。
- `stats.repeated_source_chars`：按引用重复累计的字符数总和。
- `stats.read_amplification`：重复读取放大倍数。
- `stats.input_source_refs`：过滤前从 facts 收集到的 source 引用次数。
- `stats.filtered_source_refs`：被路线范围过滤跳过的城市 source 引用次数。
- `stats.filtered_unique_files`：被过滤引用涉及的唯一文件数。
- `filtered_refs[]`：被过滤的引用明细；用于人工判断是否需要恢复某个路线外城市素材。
- `files[].path`：相对输入材料文件夹的文本文件路径。
- `files[].title`、`kind`、`char_count`、`candidate_places`、`candidate_cities`、`keywords`：来自 `resource-index.json` 的素材元数据。
- `files[].consumers`：该文件服务的目标列表；每项包含 `type`、`name` 和 `reason`。
- `files[].priority`：读取优先级；命中路线地点的文件为 `primary`，只命中城市的文件为 `secondary`。

## source-digest.json

`source-digest.json` 由 `create_source_digest_workspace.mjs` 根据 `reading-queue.json` 生成，用于保存 agent 逐个文件阅读原文后的结构化事实摘要。脚本只创建空壳，不会抽取事实，也不会把 digest 自动写回 `facts-workspace.json`。

重要字段：

- `schema_version`：数据结构版本。
- `needs_agent_review`：脚本生成后默认为 `true`，表示还需要 agent 阅读原文、填充 digest 并复核。
- `source.resource_root`：输入材料文件夹绝对路径。
- `source.resource_index`：上游素材索引文件名。
- `source.facts_workspace`：待接收事实分发的事实工作区文件名。
- `source.reading_queue`：生成 digest 时使用的读取队列文件名。
- `stats.files`：digest 中的文件壳数量。
- `stats.reviewed_files`：已完成 agent 阅读的文件数量；初始化为 `0`。
- `stats.pending_files`：尚未完成 agent 阅读的文件数量；初始化为文件总数。
- `files[].path`、`title`、`kind`、`char_count`、`consumers`、`candidate_places`、`candidate_cities`、`keywords`、`priority`：来自 `reading-queue.json` 的文件元数据和目标归属。
- `files[].reviewed`：agent 读完该文件并完成摘要后设为 `true`。
- `files[].facts`：该文件中可分发到地点、城市、每日提醒或全局字段的事实项；每项应标明 `target_type`、`target_name`、`field` 和 `items`。可选保留短 `evidence`，只用于复核，不进入最终正文。
- `files[].conflicts`：该文件暴露的事实冲突或待复核线索。
- `files[].global_notes`：不只归属单个地点或城市的全局提醒。

## read-log.json

`read-log.json` 记录本次运行中实际或可审计推断的材料读取事件，用于计算 `actual_loaded_chars` 和 `actual_loaded_tokens_estimated`。如果由 `source-digest.json` 中 `reviewed=true` 的文件生成，事件会标记 `inferred=true`，表示它来自已完成 digest review 的推断日志，而不是底层工具自动埋点。

重要字段：

- `schema_version`：数据结构版本。
- `generated_at`：日志生成时间。
- `source.kind`：日志来源，例如 `source_digest` 或 `reading_queue`。
- `source.path`：生成日志时使用的上游文件路径。
- `stats.event_count`：读取事件数量。
- `stats.full_file_read_count`：完整原文读取事件数量。
- `stats.unique_loaded_file_count`：去重后的读取文件数。
- `stats.actual_loaded_chars`：所有读取事件的字符数累计。
- `stats.actual_loaded_tokens_estimated`：估算输入 token 数。
- `events[].path`：被读取的原文文件路径。
- `events[].mode`：读取模式；当前支持 `full_file`。
- `events[].chars`：该次读取进入上下文的字符数。
- `events[].tokens_estimated`：该次读取的估算 token 数。
- `events[].reason`：读取原因，例如 `source_digest_review`。
- `events[].targets`：该文件服务的地点或城市目标。
- `events[].inferred` 和 `events[].inferred_from`：是否由上游结构推断生成，以及推断来源。

## facts-workspace.json 的结构化差异

共同 facts 字段见 [data-contracts.md](data-contracts.md)。结构化分支有以下差异：

- `source.resource_index` 应记录当前 `resource-index.json` 文件名或相对路径。
- `source.rag_index` 通常不存在。
- `places.*.source_files` 和 `cities.*.source_files` 来自 `resource-index.json` 的候选命中，作为 `reading-queue.json` 的候选原文引用。
- `photos` 来自 `resource-index.json.photos`。
