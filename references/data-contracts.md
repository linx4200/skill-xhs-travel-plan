# 数据契约

本文件只记录 RAG 流程和结构化流程共享的 JSON 契约。字段的内容取舍和事实判断见 [info-rules.md](info-rules.md)。

分支专属契约：

- RAG 分支见 [rag-data-contracts.md](rag-data-contracts.md)。
- 结构化分支见 [structured-data-contracts.md](structured-data-contracts.md)。

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

## facts-workspace.json

`facts-workspace.json` 由 `create_fact_workspace.mjs` 初始化，再由 agent 按所选分支阅读材料后填充。脚本只创建空槽位，不会自行补事实。

分支输入：

- RAG 分支：按 `retrieval-workspace.json` 读取 chunks 并填充 facts。
- 结构化分支：按 `source-digest.json` 或 `reading-queue.json` 阅读原文并填充 facts。

顶层字段：

- `schema_version`：数据结构版本。
- `needs_agent_review`：脚本生成后默认为 `true`，表示还需要 agent 填事实和判断。
- `title`：攻略标题。
- `source.resource_root`：输入材料文件夹路径；渲染本地照片时使用。
- `source.resource_index`：素材索引文件名。RAG-only 分支可为空字符串。
- `source.rag_index`：RAG 分支使用的索引文件名或相对路径；结构化分支可不存在。
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

`source_files` 的语义由分支决定：

- RAG-only 分支中，`places.*.source_files` 和 `cities.*.source_files` 来自命中 chunk 的 `source_uri` / `path`，只作为内部来源线索和调试口径，不表示必须回读原始文本。
- 结构化分支中，`source_files` 作为 `reading-queue.json` 的候选原文引用。

## 字段维护原则

- 新增、删除或改名 `route-structure.json` 或 `facts-workspace.json` 共同字段时，同时检查 `scripts/create_fact_workspace.mjs`、`scripts/render_travel_html.mjs` 和本文件。
- 新增或调整 RAG 分支专属结构时，同时检查 `scripts/create_retrieval_workspace.mjs`、[rag-workflow.md](rag-workflow.md)、[rag-data-contracts.md](rag-data-contracts.md)。
- 新增或调整结构化分支专属结构时，同时检查 `scripts/create_reading_queue.mjs`、`scripts/create_source_digest_workspace.mjs`、[structured-generation-workflow.md](structured-generation-workflow.md)、[structured-data-contracts.md](structured-data-contracts.md)。
- 字段是否应该填、填什么内容，按 [info-rules.md](info-rules.md) 判断。
- 字段为空时，渲染脚本应跳过对应小节，不要靠占位文案凑完整性。
