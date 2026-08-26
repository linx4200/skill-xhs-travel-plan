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
      "summary": "",
      "route_places": ["九洞天"],
      "timeline": [],
      "notes": [],
      "confirmations": [],
      "source_line": "2026-10-03 - 毕节 - 九洞天"
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
- `days[].title`：当天标题，概括城市和主要路线。
- `days[].summary`：当天概览，可先留空，后续填入执行重点。
- `days[].route_places`：当天真实景点/景区名称数组；必须排除城市名、住宿点、停车场、游客中心、入口、车站、码头、餐厅、酒店等非景点设施。
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
- `photos`：按 `photos/景点名/` 目录归属整理的本地照片路径。

## facts-workspace.json

`facts-workspace.json` 由 `create_fact_workspace.mjs` 初始化，再由 agent 阅读相关原文后填充。脚本只创建空槽位，不会自行补事实。

顶层字段：

- `schema_version`：数据结构版本。
- `needs_agent_review`：脚本生成后默认为 `true`，表示还需要 agent 填事实和判断。
- `title`：攻略标题。
- `source.resource_root`：输入材料文件夹路径；渲染本地照片时使用。
- `source.resource_index`：素材索引文件名。
- `source.route_structure`：路线结构文件名。
- `trip.mode`：出行方式。
- `trip.days`：每日路线、摘要、timeline、当天提醒。
- `places`：用户路线中真实景点/景区的事实。
- `cities`：城市级信息；只有通过独立增量价值判断时才把 `include` 设为 `true`。
- `global_notes`：跨天通用注意事项；可为列表，也可为 `{小节名: [事项]}`。
- `confirm_before_departure`：真正需要出发前确认、预约、购票、核验开放状态或准备的事项。

`trip.days[]` 字段：

- `day`
- `date`
- `title`
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
- 字段是否应该填、填什么内容，按 [info-rules.md](info-rules.md) 判断。
- 字段为空时，渲染脚本应跳过对应小节，不要靠占位文案凑完整性。
