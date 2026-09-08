# 数据契约

本文件是结构化流程中 JSON 文件字段的唯一契约来源。字段的内容取舍和事实判断见 [info-rules.md](info-rules.md)；脚本调用顺序见 [structured-generation-workflow.md](structured-generation-workflow.md)。

## route-structure.json

`route-structure.json` 由 agent 根据用户原始路线生成。路线解析不要交给脚本用正则完成；脚本只接收 agent 已经判断过的结构。

建议结构：

```json
{
  "title": "",
  "mode": "unknown",
  "cities": ["毕节", "威宁"],
  "days": [
    {
      "day": 1,
      "date": "2026-10-03",
      "title": "2026-10-03 - 毕节 - 九洞天",
      "lodging_city": "毕节",
      "summary": "",
      "route_places": ["九洞天"],
      "timeline": [],
      "notes": [],
      "confirmations": [],
      "source_line": "2026-10-03 - 毕节 - 九洞天，宿毕节"
    }
  ]
}
```

字段说明：

- `title`：攻略标题；可从用户行程目的地、天数和主题归纳。
- `mode`：只根据用户明确说明的出行方式填写；推荐值为 `self-drive`、`rail`、`charter`、`public-transit`、`walking` 或 `unknown`。未明确说明时填 `unknown`，不要默认成自驾。
- `cities`：候选城市名数组。来自路线中的城市、住宿地、中转地或连续游玩基地；不要放景点名、停车场、游客中心、餐厅或酒店名。
- `days[].day`：数字，用于生成 `day-XX.html`。
- `days[].date`：用户路线给出的日期；没有日期可留空。
- `days[].title`：当天标题，概括城市和主要路线，不写住宿后缀；住宿城市只写入 `lodging_city`。
- `days[].lodging_city`：当天住宿城市，由 agent 根据用户原始路线判断后填写；用户路线写了“宿某地”“住某地”“继续住某地”等住宿安排时必须填写城市名，没有住宿安排或无法判断时留空。脚本不得从 `source_line` 正则抽取住宿城市。
- `days[].summary`：当天概览，可先留空，后续填入执行重点。
- `days[].route_places`：当天真实游玩或短停地点名称数组。通常是景点/景区，也可以是用户明确安排游玩的古镇、县城老城、街区、观景台或村镇；必须排除只承担出发、住宿、中转或行政定位作用的城市名，以及停车场、游客中心、入口、车站、码头、餐厅、酒店等设施或普通导航点。
- `days[].timeline`：当天行程顺序，可先留空，后续按事实整理。
- `days[].notes`：当天特有提醒。
- `days[].confirmations`：当天出发前或到达前必须确认的事项。
- `days[].source_line`：对应用户原始路线文本，便于回溯。

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
- `events[].mode`：读取模式；当前支持 `full_file`，后续 RAG 可扩展为 `chunk`。
- `events[].chars`：该次读取进入上下文的字符数。
- `events[].tokens_estimated`：该次读取的估算 token 数。
- `events[].reason`：读取原因，例如 `source_digest_review`、`rag_fallback_full_file`。
- `events[].targets`：该文件服务的地点或城市目标。
- `events[].inferred` 和 `events[].inferred_from`：是否由上游结构推断生成，以及推断来源。

## facts-workspace.json

`facts-workspace.json` 由 `create_fact_workspace.mjs` 初始化，再由 agent 按 `source-digest.json` 或 `reading-queue.json` 的唯一文件顺序阅读原文后填充。脚本只创建空槽位，不会自行补事实；若已填好 `source-digest.json`，应先从 digest 分发有效事实，再按需回读原文复核。

顶层字段：

- `schema_version`：数据结构版本。
- `needs_agent_review`：脚本生成后默认为 `true`，表示还需要 agent 填事实和判断。
- `title`：攻略标题。
- `source.resource_root`：输入材料文件夹路径；渲染本地照片时使用。
- `source.resource_index`：素材索引文件名。
- `source.route_structure`：路线结构文件名。
- `trip.mode`：出行方式。
- `trip.days`：每日路线、摘要、timeline、当天提醒。
- `places`：用户路线中 `route_places` 地点的事实；每个 `route_places` 都应有对应 key。
- `cities`：城市级信息；只有通过独立增量价值判断时才把 `include` 设为 `true`。
- `global_notes`：跨天通用注意事项；可为列表，也可为 `{小节名: [事项]}`。
- `confirm_before_departure`：真正需要出发前确认、预约、购票、核验开放状态或准备的事项。

`trip.days[]` 字段：

- `day`
- `date`
- `title`：当天标题，沿用 `route-structure.json.days[].title` 的同一要求；不写住宿后缀，最终展示标题由脚本根据 `lodging_city` 统一追加。
- `lodging_city`
- `summary`
- `route_places`
- `timeline`
- `notes`
- `confirmations`
- `source_line`

`places.<景点名>` 字段：

- `summary`
- `elevation_m`
- `elevation_source_url`
- `elevation_checked_at`
- `highlights`
- `drawbacks`
- `opening_hours`
- `tickets`
- `duration`
- `routes`
- `play_options`
- `practical_info`
- `notes`
- `conflicts`
- `photos`
- `source_files`

`cities.<城市名>` 字段：

- `include`
- `summary`
- `elevation_m`
- `elevation_source_url`
- `elevation_checked_at`
- `overview`
- `backup_places`
- `foods`
- `lodging`
- `transport`
- `shopping`
- `notes`
- `source_files`

## 字段维护原则

- 新增、删除或改名 JSON 字段时，同时检查 `scripts/create_fact_workspace.mjs`、`scripts/render_travel_html.mjs` 和本文件。
- 新增或调整读取队列结构时，同时检查 `scripts/create_reading_queue.mjs`、[structured-generation-workflow.md](structured-generation-workflow.md) 和本文件。
- 新增或调整 source digest 结构时，同时检查 `scripts/create_source_digest_workspace.mjs`、[structured-generation-workflow.md](structured-generation-workflow.md) 和本文件。
- 字段是否应该填、填什么内容，按 [info-rules.md](info-rules.md) 判断。
- 字段为空时，渲染脚本应跳过对应小节，不要靠占位文案凑完整性。
