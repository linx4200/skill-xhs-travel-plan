# RAG Facts 生成总体框架

本文档记录用户提供 `rag-index.json` 时，RAG 介入结构化攻略生成的总体框架。它是后续逐步完善每个阶段的设计基线；共同字段契约以 `data-contracts.md` 为准，RAG 专属字段契约以 `rag-data-contracts.md` 为准，事实取舍仍以 `info-rules.md` 为准，执行细节仍以 `rag-workflow.md` 和 `structured-generation-workflow.md` 为准。

## 目标

RAG 作为素材读取层，目标是在用户已经提供 `rag-index.json` 的情况下，让 agent 直接阅读脚本产出的检索结果中命中的 chunks，并提高事实字段定位效率。`rag-index.json` 本体只能由项目脚本读取，agent 不得直接打开、抽样、统计、检索或阅读该大文件。RAG 不直接替代事实判断，也不自动把检索结果视为最终攻略事实。

RAG 主流程不再生成 `resource-index.json`、`reading-queue.json` 或 `source-digest.json`。如果用户明确不希望回读原材料，后续缺口只通过字段级 checklist、定向 RAG retrieve、冲突保留或“材料未说明 / 出行前确认”处理。

最终事实仍必须由 agent 基于检索结果、冲突处理和字段完整性判断后写入 `facts-workspace.json`。

## 总体流程

1. 创建 `route-structure.json`
2. 用项目脚本校验 `rag-index.json`
3. 基于 `route-structure.json` 和 `rag-index.json` 创建带 schema 和路线骨架的 `facts-workspace.json`
4. 基于 `facts-workspace.json` 和 `rag-index.json` 批量创建 `retrieval-workspace.json`
5. 读取 `retrieval-workspace.json`，按景点、城市和主题填充 `facts-workspace.json`
6. 按字段级 checklist 评估 facts 缺口
7. 对缺口做定向二次 RAG retrieve
8. 仍不足时记录冲突、材料未说明或出行前确认事项
9. 评估 `facts-workspace.json` 是否足够生成 HTML
10. 渲染 HTML 并运行校验

RAG 流程中的主路径应短于非 RAG 结构化流程。第 4 步之后，如果 `retrieval-workspace.json` 的召回质量足够，且第 6 步字段级 checklist 通过，agent 可以从 `retrieval-workspace.json` 读取目标 chunks，把判断后的结果整理成 facts patch，用 `apply_facts_patch.mjs` 合并到 `facts-workspace.json`，再进入渲染前评估；不需要创建或维护 `resource-index.json`、`reading-queue.json` 和 `source-digest.json`。

旧的原文读取链路不属于当前 RAG 主流程。若未来需要支持“RAG 失败后回读原材料”，应作为显式可选分支另行设计，而不是默认混入 RAG happy path。

## 推荐循环

第一轮是批量检索，不是人工关键词循环：

```text
route-structure.json
  -> rag-index.json
  -> skeleton facts-workspace.json
  -> retrieval-workspace.json
  -> agent 填 facts-workspace.json
```

第二轮只处理缺口：

```text
facts completeness checklist
  -> missing fields
  -> targeted rag retrieve
  -> update facts-workspace.json
```

第三轮处理仍不足的信息：

```text
unresolved high-risk fields or conflicts
  -> targeted rag retrieve / conflicts / 材料未说明 / 出行前确认
  -> update facts-workspace.json
```

## 关键设计判断

### 结构先行

`route-structure.json` 必须先于 RAG 检索创建。检索目标应来自 agent 已判断过的路线结构，包括日期、城市、真实游玩地点、短停点和出行方式。

不要让 RAG 从零推断路线，也不要只靠临时关键词驱动检索。否则容易出现路线外噪声、城市泛匹配、别名漏召回和地点归属错误。

### Facts 工作区不是空 JSON

`facts-workspace.json` 可以是“事实为空”的工作区，但不应是 `{}`。

创建时至少应包含：

- schema/version/source 信息
- trip days 和 route places
- places 骨架
- cities 骨架
- 每个地点或城市的 RAG source 线索
- 可承载缺失项、冲突和全局提醒的字段

这样后续才能稳定判断每个目标缺哪些字段，也才能批量生成 `retrieval-workspace.json`。

### 批量检索优先

默认流程应先按 `facts-workspace.json` 中的所有 route places 和候选城市批量生成 `retrieval-workspace.json`。

不建议把主流程设计成：

```text
手动想关键词 -> RAG retrieve -> 填 facts -> 再想关键词 -> 再 retrieve
```

这种循环可行，但效率较低，并且容易产生 query drift、重复召回和主观退出判断。

更稳的方式是：

```text
批量 retrieval workspace -> 先填 facts -> checklist 找缺口 -> 少量定向补检索
```

### 字段级退出判断

退出循环不应依赖“整体感觉是否足够”，而应依赖字段级缺口判断。

每个 route place 至少应判断：

- 是否有可写入正文的玩法、亮点或取舍建议
- 是否有交通、导航、停车或到达方式信息
- 是否有时间、票价、预约、开放、路线封闭等高风险执行信息
- 是否有避坑、限制、冲突或材料未说明项
- 是否保留必要的内部来源线索

每个 included city 至少应判断：

- 是否有足够理由生成城市页
- 是否有城市级交通、住宿、补给、节奏或风险信息
- 是否和每日景点详情去重
- 是否保留必要的内部来源线索

## 阶段边界

### 阶段 1 和阶段 2 设计结论

阶段 1 沿用现有路线解析逻辑，阶段 2 改为读取并校验 `rag-index.json`。

阶段 1 继续按 `structured-generation-workflow.md` 和 `info-rules.md` 的既有规则，由 agent 解析用户路线并创建 `route-structure.json`。路线解析边界、真实游玩地点、短停点、城市和住宿/中转点的判断继续沿用现有逻辑。

阶段 2 不再使用 `scan_resources.mjs` 创建 `resource-index.json`。RAG index 已经包含 chunk text、候选地点、候选城市和来源 URI；重复扫描原始素材会增加一个低价值中间文件，并重新引入原材料回读心智负担。不要由 agent 直接打印、预览、抽样、统计或读取完整 RAG index；只能把该文件路径传给项目脚本。脚本解析失败时停止流程并报告错误。

阶段 2 需要确认：

- `rag-index.json` 可以被解析为 JSON 或 JSONL。
- chunks 至少包含 `chunk_id`、`source_uri`、`title`、`text`、`candidate_places` 和 `candidate_cities`。
- 如需渲染本地照片，`resource_root` 指向可读目录，且照片位于 `photos/` 下。照片只影响渲染素材归属，不意味着要回读原始文本。

本框架后续重点从阶段 3 开始：如何直接基于 `rag-index.json` 创建 skeleton `facts-workspace.json`，如何批量创建 `retrieval-workspace.json`，以及如何用字段级 checklist 驱动补检索和缺口处理。

### 阶段 3 设计结论

第三步的产物 `facts-workspace.json` 定位为“最终事实容器的结构化空壳”。它负责承载后续会进入 HTML 渲染的事实字段，并为 RAG 检索和缺口处理提供稳定目标，但不负责保存 RAG 过程状态。

第三步必须完成：

- 确定最终可渲染字段，包括地点、城市、每日路线、全局提醒和出发前确认。
- 为每个 `route_places` 创建 `places.<地点名>` 空槽位。
- 为每个候选城市创建 `cities.<城市名>` 空槽位，并默认 `include: false`。
- 为所有字段提供稳定默认值，例如字符串为空字符串、列表为空数组、数值未知为 `null`。
- 从 `rag-index.json` 初步填入地点/城市的来源线索，并从 `rag-index.resource_root/photos` 直接匹配本地照片。
- 保持 `needs_agent_review: true`，直到 agent 完成事实填充、冲突处理和完整性评估。

第三步不应写入：

- RAG chunk 原文
- retrieve score
- `matched_by`
- 字段完整性状态
- 补检索或缺口处理决策
- 大段 evidence

这些过程信息分别放在后续的 `retrieval-workspace.json` 或 completeness checklist 中处理。

当前 `create_fact_workspace.mjs` 应支持 `--rag-index`。RAG 分支下不需要先生成 `resource-index.json`；脚本可以从 RAG chunks 生成最小来源线索，并直接扫描 `resource_root/photos` 归属照片。如需区分地点命中与城市泛命中的可靠性，优先在第四步或第六步处理，不急于污染 `facts-workspace.json`。

### Skeleton facts-workspace.json 建议结构

下面是第三步生成的 skeleton `facts-workspace.json` 的注释版结构，用于说明每个字段的职责。真实文件必须仍是合法 JSON，不能包含注释。

```jsonc
{
  // 数据结构版本。字段新增、删除或语义变化时递增。
  "schema_version": 1,

  // create_fact_workspace.mjs 生成后固定为 true。
  // 只有 agent 完成事实填充、冲突处理和完整性评估后，才可改为 false。
  "needs_agent_review": true,

  // 攻略标题，来自 route-structure.json.title；可先为空。
  "title": "",

  // 上游输入和索引来源。渲染本地照片时依赖 resource_root。
  "source": {
    // 输入材料文件夹绝对路径，来自 rag-index.json.resource_root。
    "resource_root": "/absolute/path/to/resources",

    // RAG 分支可为空字符串；保留该字段兼容既有渲染和工具。
    "resource_index": "",

    // 当前 facts workspace 对应的 RAG 索引文件名或相对路径。
    "rag_index": "rag-index.json",

    // 当前 facts workspace 对应的路线结构文件名或相对路径。
    "route_structure": "route-structure.json"
  },

  "trip": {
    // 出行方式，沿用 route-structure.json.mode。
    // 未明确时为 "unknown"，不要由脚本猜测。
    "mode": "unknown",

    // 每日路线骨架，沿用 route-structure.json.days。
    // 这些字段既参与渲染，也参与后续评估 route place 覆盖率。
    "days": [
      {
        // 第几天，用于生成 day-XX.html。
        "day": 1,

        // 用户路线中给出的日期；没有可为空字符串。
        "date": "",

        // 当天标题，不写住宿后缀。
        "title": "",

        // 当天住宿城市；无住宿安排或无法判断时为空。
        "lodging_city": "",

        // 当天概览。skeleton 阶段为空，由 agent 后续填。
        "summary": "",

        // 当天真实游玩或短停地点。
        // 每个值都必须在 places 中有同名 key。
        "route_places": ["路线地点A"],

        // 当天时间线或行程顺序。skeleton 阶段可为空。
        "timeline": [],

        // 当天特有提醒。skeleton 阶段可为空。
        "notes": [],

        // 当天出发前或到达前必须确认的事项。skeleton 阶段可为空。
        "confirmations": [],

        // 用户原始路线文本，便于回溯。
        "source_line": ""
      }
    ]
  },

  "places": {
    "路线地点A": {
      // 地点一句话判断：值不值得去、适合什么玩法、在本路线中的角色。
      "summary": "",

      // 海拔字段只在材料或允许的联网检查提供明确值时填写。
      "elevation_m": null,
      "elevation_source_url": "",
      "elevation_checked_at": "",

      // 值得看的点、体验亮点、适合拍照或游玩的内容。
      "highlights": [],

      // 不推荐、体验差、绕路、季节不合适等负面信息。
      "drawbacks": [],

      // 开放时间、闭园、入园窗口等。高风险字段，不可无来源猜测。
      "opening_hours": [],

      // 门票、预约、优惠、购票方式等。高风险字段，不可无来源猜测。
      "tickets": [],

      // 建议停留时长。材料未说明时不要硬编。
      "duration": "",

      // 游览路线、入口、换乘、步行顺序、景区内交通等。
      "routes": [],

      // 多方案玩法，例如精简版、深度版、老人小孩友好版。
      "play_options": [],

      // 可执行信息：导航点、停车、厕所、补给、信号、路况等。
      "practical_info": [],

      // 其他提醒。应保留和本路线有关的执行信息，不写泛泛攻略套话。
      "notes": [],

      // 材料冲突、低置信、需出行前确认的信息。
      "conflicts": [],

      // 本地照片路径，来自 rag-index.resource_root/photos 的目录匹配。
      // 只能使用输入材料中的本地照片。
      "photos": [],

      // RAG 来源线索，来自命中该地点的 chunk source_uri。
      // RAG-only 流程中不用于自动回读原文。
      "source_files": []
    }
  },

  "cities": {
    "城市A": {
      // 默认 false。只有城市页有独立增量价值时，agent 才能改为 true。
      "include": false,

      // 城市页一句话概览。include=false 时可为空。
      "summary": "",

      // 城市海拔字段，只在材料或允许的联网检查提供明确值时填写。
      "elevation_m": null,
      "elevation_source_url": "",
      "elevation_checked_at": "",

      // 城市级路线策略、适合作为基地的原因、整体节奏建议。
      "overview": [],

      // 备选景点或顺路点。不能进入每日 route_places，除非用户路线明确安排。
      "backup_places": [],

      // 城市级餐饮信息。只写材料中和本次路线有执行价值的内容。
      "foods": [],

      // 住宿区域、住哪里更顺、换宿风险等。
      "lodging": [],

      // 城市级交通、抵离、包车/自驾/公共交通注意事项。
      "transport": [],

      // 购物、补给、特产等。只保留和本次出行有关的信息。
      "shopping": [],

      // 城市级提醒、风险、材料未说明项。
      "notes": [],

      // RAG 来源线索，来自命中该城市的 chunk source_uri。
      // 城市命中通常更泛，后续需要 RAG 和 include 判断收敛。
      "source_files": []
    }
  },

  // 跨天通用提醒。可以是数组，也可以在后续改为分组对象。
  // 只写对本次路线有执行价值的信息。
  "global_notes": [],

  // 出发前真正需要确认、预约、购票、核验开放状态或准备的事项。
  "confirm_before_departure": []
}
```

第三步只负责生成上述骨架和候选来源，不负责填充正文事实。RAG chunk、检索分数、`matched_by`、字段缺口和补检索判断不写入 `facts-workspace.json`，分别放在后续的 `retrieval-workspace.json` 或 completeness checklist 中处理。

### 阶段 4 设计结论

第四步的产物 `retrieval-workspace.json` 定位为“批量检索阅读包”。它负责保存 RAG 检索过程信息，帮助 agent 更少、更有序地阅读 note chunks，但不承担最终事实库和 facts 完整性判断职责。

第四步必须完成：

- 从 `facts-workspace.json.places` 读取所有 route place 作为景点检索目标。
- 从 `facts-workspace.json.cities` 读取候选城市作为城市检索目标。
- 按固定主题批量检索，而不是让 agent 在主流程中反复手写关键词。
- 在顶层生成全局 `chunks_by_id`，把唯一 note chunk 原文保存一份；同一 chunk 即使命中多个 place、city 或 theme，也不重复保存 `text`。
- 为每个 target 生成 `unique_chunk_ids`，作为稳定阅读顺序、去重统计和召回量判断口径。
- 为每个 target 生成 `themes.<theme>[]`，只保存主题命中索引，包括 `chunk_id`、`score` 和 `matched_by`。
- 为每个 target 记录 `target` 元信息，例如 `type`、`name`、`days` 和 `source_files_count`。RAG-only 流程中 `source_files_count` 是来源线索数量，不代表后续要回读原文。
- 为每个 target 记录 `retrieval_health`，只描述召回质量和需要关注的检索风险。

第四步不应完成：

- 不从 RAG 结果新增路线地点。
- 不决定城市是否 `include: true`。
- 不把检索结果直接写入 `facts-workspace.json`。
- 不判断 facts 是否足够生成 HTML。
- 不因为任意 theme 为空就直接强制回读全部原文。

`chunks_by_id`、`unique_chunk_ids` 和 `themes` 的职责分工：

- 顶层 `chunks_by_id` 是全局唯一 note 原文库。agent 真正阅读 `text` 时从这里取。
- target 下的 `unique_chunk_ids` 是该地点或城市的阅读顺序和去重口径。agent 初次填某个地点或城市时，按这个数组顺序到顶层 `chunks_by_id` 读取原文。
- `themes` 是主题命中索引。agent 补某个字段时先看对应 theme，再通过 `chunk_id` 到 `chunks_by_id` 读取原文。

第四步可以做 retrieval health 初筛，例如标记召回太少、城市检索过泛、某主题为空或结果缺少实体命中。但这些只是软提醒或硬缺口线索。真正是否二次定向检索、保留冲突或标注“材料未说明”，必须由第六步字段级 checklist 判断。

在 RAG happy path 中，第四步之后不再默认创建 `resource-index.json`、`reading-queue.json` 或 `source-digest.json`。agent 直接按 `unique_chunk_ids` 读取 `chunks_by_id` 中的 note 原文，并把判断后的事实整理成 facts patch，再合并到 `facts-workspace.json`。只有第六步发现字段缺口、冲突或高风险不确定项时，才补检索或写入缺口/确认事项。

### Retrieval workspace 建议结构

`retrieval-workspace.json` 是第四步的批量检索阅读包。它保存 RAG 的过程信息，供 agent 填充 `facts-workspace.json` 时阅读和判断；它不是最终事实库，不直接进入 HTML 渲染。

下面是注释版结构。真实 `retrieval-workspace.json` 必须是合法 JSON，不能包含注释。

```jsonc
{
  // 数据结构版本。retrieval workspace 的结构变化时递增。
  "schema_version": 1,

  "source": {
    // 本次检索基于哪个 facts workspace。
    // 用于回溯检索目标来自哪份 route/facts 骨架。
    "facts_workspace": "facts-workspace.json",

    // 本次检索使用的 RAG index。
    "rag_index": "rag-index.json",

    // 可选：传入 --log 时记录 retrieval-log.json 路径。
    "retrieval_log": "retrieval-log.json"
  },

  "retrieval": {
    // 景点检索默认主题。每个主题会生成一组 note chunk 结果。
    "place_themes": [
      "highlights",
      "drawbacks",
      "tickets",
      "transport",
      "routes",
      "crowds",
      "accessibility",
      "facilities",
      "safety"
    ],

    // 城市检索默认主题。城市结果只服务城市级判断，不自动进入每日景点详情。
    "city_themes": [
      "foods",
      "lodging",
      "transport",
      "backup_places",
      "notes"
    ],

    // 每个景点主题最多保留多少条结果。
    "place_top_k": 5,

    // 每个城市主题最多保留多少条结果。
    "city_top_k": 4,

    // 单个景点跨主题去重后的理论上限。
    // 实现上可以先按主题 top_k 收集，再按 unique_chunk_ids 控制阅读量。
    "max_place_chunks": 45,

    // 单个城市跨主题去重后的理论上限。
    "max_city_chunks": 24,

    // 可选：记录检索排序策略，方便后续复现实验。
    "scoring": {
      // 当前实现使用 candidate 归属门控 + query embedding 相似度 + 关键词/实体/标题来源排序。
      "strategy": "candidate_gated_embedding_keyword_entity_title",

      // 当前推荐权重。实际以 rag_retrieve.mjs 实现为准。
      "weights": {
        "entity_query": {
          "query_embedding_similarity": 0.45,
          "keyword_match": 0.25,
          "route_entity_match": 0.2,
          "title_source_match": 0.1
        },
        "query_only": {
          "query_embedding_similarity": 0.7,
          "keyword_match": 0.2,
          "title_source_match": 0.1
        }
      }
    }
  },

  // 全局唯一 note chunk 原文库。
  // 同一个 chunk 即使命中多个地点、城市或主题，text 也只在这里保存一份。
  "chunks_by_id": {
    "resources/001-place-a-note.json#note": {
      // chunk 稳定 ID，来自 rag-index.json。
      "chunk_id": "resources/001-place-a-note.json#note",

      // 原始来源 URI。内部溯源和 chunk 归属判断时使用。
      "source_uri": "resources/001-place-a-note.json",

      // note 标题，供 agent 快速判断来源语境。
      "title": "路线地点A游玩笔记",

      // 该 chunk 被上游标注命中的候选景点。
      "candidate_places": ["路线地点A"],

      // 该 chunk 被上游标注命中的候选城市。
      "candidate_cities": ["城市A"],

      // note chunk 原文。第四步允许保留，供 agent 填 facts 时阅读。
      // 不要把 text 直接复制到最终 HTML；必须经过事实判断、去重和改写。
      "text": "小红书 note 原文..."
    },

    "resources/002-place-a-transport.json#note": {
      "chunk_id": "resources/002-place-a-transport.json#note",
      "source_uri": "resources/002-place-a-transport.json",
      "title": "路线地点A交通笔记",
      "candidate_places": ["路线地点A"],
      "candidate_cities": ["城市A"],
      "text": "小红书 note 原文..."
    },

    "resources/010-city-a-food.json#note": {
      "chunk_id": "resources/010-city-a-food.json#note",
      "source_uri": "resources/010-city-a-food.json",
      "title": "城市A吃饭笔记",
      "candidate_places": [],
      "candidate_cities": ["城市A"],
      "text": "小红书 note 原文..."
    },

    "resources/011-city-a-lodging.json#note": {
      "chunk_id": "resources/011-city-a-lodging.json#note",
      "source_uri": "resources/011-city-a-lodging.json",
      "title": "城市A住宿交通笔记",
      "candidate_places": [],
      "candidate_cities": ["城市A"],
      "text": "小红书 note 原文..."
    }
  },

  "places": {
    "路线地点A": {
      // 检索目标元信息。用于 agent 判断这个 target 在本路线里的角色。
      "target": {
        "type": "place",
        "name": "路线地点A",

        // 该地点出现在第几天。来自 facts-workspace.json.trip.days。
        "days": [1],

        // skeleton facts 中该地点的 RAG 来源线索数量。
        "source_files_count": 6
      },

      // 该地点跨所有主题去重后的 chunk_id 列表。
      // Agent 初次填该地点 facts 时，按这个顺序到顶层 chunks_by_id 读取原文。
      // 保留该数组是为了稳定阅读顺序；不要依赖对象 key 顺序承担这个职责。
      "unique_chunk_ids": [
        "resources/001-place-a-note.json#note",
        "resources/002-place-a-transport.json#note"
      ],

      // 检索健康状态，只描述 RAG 召回质量，不等同于 facts 完整性。
      "retrieval_health": {
        // ok: 召回基本可用；weak: 召回偏少或有空主题；empty: 基本没有召回。
        "status": "ok",

        // 软提醒。是否需要补检索或缺口标注，由后续 completeness checklist 决定。
        "warnings": [],

        // 硬缺口原因。只有明确无法依赖 RAG 时才写入。
        "hard_gap_reasons": []
      },

      // 主题命中索引。这里只保存 chunk_id、score 和 matched_by，
      // 不重复保存 title、source_uri 或 text。
      // Agent 补某个字段时先看对应 theme，再到顶层 chunks_by_id 读取原文。
      "themes": {
        // 看点、体验、拍照、推荐理由。
        "highlights": [
          {
            "chunk_id": "resources/001-place-a-note.json#note",
            "score": 0.82,
            "matched_by": ["candidate_places", "keyword"]
          }
        ],

        // 负面体验、避坑、不推荐、排队、季节或体验限制。
        "drawbacks": [
          {
            "chunk_id": "resources/001-place-a-note.json#note",
            "score": 0.68,
            "matched_by": ["candidate_places", "keyword"]
          }
        ],

        // 门票、预约、开放时间、优惠、套票等高风险执行信息。
        // 这里的召回结果只能作为材料线索；最终写 facts 时不能无来源断言。
        "tickets": [],

        // 停车、入口、导航、自驾、摆渡车、游客中心、观光车、包车、打车等。
        "transport": [
          {
            "chunk_id": "resources/002-place-a-transport.json#note",
            "score": 0.79,
            "matched_by": ["candidate_places", "keyword"]
          }
        ],

        // 游览顺序、景区内路线、徒步、游船、索道、步道、多玩法路线。
        "routes": [
          {
            "chunk_id": "resources/002-place-a-transport.json#note",
            "score": 0.61,
            "matched_by": ["candidate_places", "keyword"]
          }
        ],

        // 老人小孩、天气、温差、高反、防滑、风大、补给、厕所等风险提醒。
        "safety": []
      }
    }
  },

  "cities": {
    "城市A": {
      "target": {
        "type": "city",
        "name": "城市A",

        // 该城市涉及的天数，可来自 lodging_city、route title 或 route cities。
        "days": [1, 2],

        // skeleton facts 中该城市的 RAG 来源线索数量。
        "source_files_count": 12
      },

      // 城市检索通常更泛。Agent 应优先读取 matched_by 包含 candidate_cities
      // 且内容确实服务本路线的 chunks。
      "unique_chunk_ids": [
        "resources/001-place-a-note.json#note",
        "resources/010-city-a-food.json#note",
        "resources/011-city-a-lodging.json#note"
      ],

      "retrieval_health": {
        "status": "weak",
        "warnings": [
          "city_retrieval_is_broad",
          "empty_theme:backup_places"
        ],
        "hard_gap_reasons": []
      },

      "themes": {
        // 城市餐饮、小吃、餐厅、夜市等。只服务城市页或全局建议。
        "foods": [
          {
            "chunk_id": "resources/010-city-a-food.json#note",
            "score": 0.74,
            "matched_by": ["candidate_cities", "keyword"]
          }
        ],

        // 住宿区域、酒店/民宿选择、住哪里顺路。
        "lodging": [
          {
            "chunk_id": "resources/011-city-a-lodging.json#note",
            "score": 0.71,
            "matched_by": ["candidate_cities", "keyword"]
          }
        ],

        // 城市级交通、抵离、路况、限行、包车/打车/公共交通。
        "transport": [
          {
            "chunk_id": "resources/001-place-a-note.json#note",
            "score": 0.51,
            "matched_by": ["candidate_cities", "keyword"]
          },
          {
            "chunk_id": "resources/011-city-a-lodging.json#note",
            "score": 0.66,
            "matched_by": ["candidate_cities", "keyword"]
          }
        ],

        // 备选景点、顺路点、老城、街区等。
        // 不得自动加入 facts.trip.days[].route_places。
        "backup_places": [],

        // 城市级风险、天气、海拔、安全、温差、避坑等提醒。
        "notes": [
          {
            "chunk_id": "resources/010-city-a-food.json#note",
            "score": 0.48,
            "matched_by": ["candidate_cities", "keyword"]
          }
        ]
      }
    }
  },

  "summary": {
    // 本次批量检索覆盖的地点数量。
    "place_count": 1,

    // 本次批量检索覆盖的城市数量。
    "city_count": 1,

    // retrieval_health.status 非 ok 或硬缺口的地点列表。
    // 供 agent 优先检查，不代表最终必须回读全部原文。
    "attention_places": [],

    // retrieval_health.status 非 ok 或硬缺口的城市列表。
    "attention_cities": ["城市A"],

    // 兼容当前脚本字段：存在硬缺口原因的地点。
    "gap_places": [],

    // 兼容当前脚本字段：存在硬缺口原因的城市。
    "gap_cities": []
  }
}
```

第四步只判断检索结果是否便于阅读和初步可用，不判断 `facts-workspace.json` 是否足够渲染。后续第六步应基于字段级 checklist 决定是否二次定向检索、记录冲突或标注缺口。

### 阶段 5 设计结论

第五步的核心产物是填充后的 `facts-workspace.json`，但推荐先生成局部 `facts-patch.json`，再通过 `apply_facts_patch.mjs` 合并。它定位为“RAG 阅读结果到可渲染 facts 的人工判断层”：agent 读取第四步生成的 `retrieval-workspace.json`，按地点、城市和主题理解 note chunks，再把经过归属确认、去重、冲突处理和压缩改写后的事实写入 facts patch。

第五步必须完成：

- 先做引用完整性检查：确认 `facts-workspace.json` 中的地点和城市都有对应 retrieval target，且 retrieval target 引用的所有 `chunk_id` 都能在顶层 `chunks_by_id` 中找到。
- 按每日路线顺序处理 `places`，而不是按 JSON key 顺序处理。这样每日摘要、timeline、当天提醒和确认事项能跟路线执行顺序保持一致。
- 每个地点先按 `unique_chunk_ids` 去重阅读 chunk 原文，再用 `themes` 辅助定位字段。`themes` 只作为阅读索引，不作为事实归属的最终判断。
- 将有效事实写入 facts patch 中的 `places.<地点名>` 的 summary、highlights、drawbacks、opening_hours、tickets、duration、routes、play_options、practical_info、notes 和 conflicts 等字段。
- 在所有地点处理完成后，再处理 `cities`。城市页 `include` 判断必须先排除已经写进每日路线、地点详情、全局提醒或出发前确认的内容。
- 最后整理 `trip.days[].summary`、`trip.days[].timeline`、`trip.days[].notes`、`trip.days[].confirmations`、`global_notes` 和 `confirm_before_departure`。
- 对冲突、低置信或高风险待确认的信息，在对应的 `conflicts`、`notes`、`confirmations` 或 `confirm_before_departure` 中保留 `source_uri` 或 title 线索。

第五步不应完成：

- 不从 RAG 结果新增 `route_places`。
- 不把 chunk 原文、score、`matched_by` 或大段 evidence 写入 facts patch 或 `facts-workspace.json`。
- 不把 `themes` 命中结果机械搬运成 facts 字段；同一 chunk 可以服务多个字段，但最终 facts 必须是 agent 判断后的执行信息。
- 不默认创建或维护 `source-digest.json`。在 RAG happy path 中，`retrieval-workspace.json` 已经承担批量阅读包职责；再新增一层 digest 会让流程变重。
- 不判断 `facts-workspace.json` 是否已经足够渲染 HTML。字段级完整性评估留给第六步。
- 不为了填满 HTML 小节而写空泛内容。无有效依据且不影响执行的信息保持空值，让渲染脚本跳过。

第五步的推荐处理顺序：

```text
引用完整性检查
  -> 按每日 route_places 顺序填 places
  -> 基于已写地点内容填 trip.days
  -> 排除重复后判断并填 cities
  -> 汇总 global_notes 和 confirm_before_departure
  -> apply_facts_patch.mjs 合并 facts patch
  -> 保持 needs_agent_review: true，交给第六步 checklist
```

地点填充规则：

- `unique_chunk_ids` 是初次阅读顺序。agent 应按这个数组读取顶层 `chunks_by_id` 的 chunk 原文，避免同一 note 因多个 theme 命中而被重复阅读。
- `themes` 是字段定位索引。补 `tickets`、`transport`、`routes`、`safety` 等字段时，优先查看对应 theme，但仍要回到 chunk 原文判断上下文和地点归属。
- 地点检索只读取 `candidate_places` 命中目标地点的 chunks；`matched_by` 只靠 `keyword` 的结果不应进入地点命中池。
- 同一事实在多个 chunk 中重复出现时，只写一次，保留更具体、更可执行的表达。
- 同一事实存在执行层面的冲突时，不强行合并；写入 `conflicts`，并在当天 `confirmations` 或顶层 `confirm_before_departure` 中保留需要出行前确认的事项。

城市填充规则：

- 城市固定在所有地点之后处理。原因是城市页是否有独立增量价值，必须先排除已经被地点页、每日页、全局提醒或确认清单吸收的内容。
- 城市检索只读取 `candidate_cities` 命中目标城市的 chunks，并优先读取没有 `candidate_places` 的城市级 chunks；带具体地点归属的 chunks 只作为城市级材料不足时的补充。
- `cities.<城市名>.include` 只有在排除重复后仍满足 `info-rules.md` 的城市 include 标准时才设为 `true`。
- 城市里的 `backup_places` 只能作为备选信息，不得自动加入每日 `route_places` 或改变用户路线。

高风险字段处理规则：

- 高风险字段包括开放时间、票价、预约、停车入口、导航点、交通管制、路线封闭、班次、天气安全和高海拔风险等会影响执行的信息。
- 如果材料没有提到某个普通高风险字段，且没有迹象显示它会影响本次执行，第五步默认留空，交给第六步 checklist 判断是否需要补检索或标注缺口。
- 只有材料明确暗示存在风险、限制、预约、购票、封闭、入口变化或确认需求，但缺少关键细节时，才在 facts 中写“材料未说明”或等价的待确认表达。
- 如果不同 chunks 对高风险字段存在冲突，第五步应记录冲突和来源线索；是否联网核验、二次 RAG 或写入出行前确认，由第六步和后续流程决定。

第五步完成后，`needs_agent_review` 仍应保持 `true`。只有第六步字段级 checklist、必要补检索、缺口处理和渲染前评估都完成后，才可改为 `false`。

## 缺口处理原则

以下情况不应继续无限 RAG 检索，应转为定向补检索、冲突保留，或明确写入“材料未说明 / 出行前确认”：

- 某路线景点去重后的有效 note chunks 少于 3 条
- 高风险执行字段被材料暗示会影响本次执行，但 RAG 结果缺少关键细节或互相冲突
- 检索结果太泛、太营销，不能支持可执行建议
- 同一 chunk 混合多个地点，归属不确定
- 城市页是否 include 无法判断

## HTML 生成前评估

渲染前应独立评估 `facts-workspace.json` 是否足够生成 HTML。

最低要求：

- 每个 `route_places` 地点都有可用内容，或明确记录材料不足
- 路线外地点不会进入每日详情
- 城市页只为 `include: true` 的城市生成
- 高风险事实不被无来源地断言
- 冲突信息被保留，而不是被强行合并
- 全局提醒和出发前确认只包含对本次路线有执行价值的信息
- 图片只来自本地材料并和地点匹配

只有通过以上判断后，才运行渲染和机械校验。

## 效率预期

合理实现后，RAG 层的收益应来自以下方面：

- 在 `reading-queue.json` 的唯一文件集合之上，进一步裁剪不相关或低价值的 source files / note chunks。
- 缓解城市名泛匹配导致的素材范围过宽问题，优先保留真正服务城市级吃住行、风险和备选点判断的 chunks。
- 对长评论文件、多地点混合文件或后续更细 chunk 粒度的素材，只让 agent 阅读相关 chunk，而不是整份原文。
- 通过 `themes` 索引把 chunks 映射到 `highlights`、`tickets`、`transport` 等字段，减少 agent 读完原文后再自行分类的成本。
- 需要调试召回质量时，通过 `retrieval-log.json` 查看每个 chunk 的 entity gate、向量余弦相似度、召回状态和 score 分项贡献。
- 在后续局部修改中，直接从目标地点/城市和目标 theme 定位到少量 chunks，减少重新阅读全局读取队列的需要。

RAG 不应被表述为默认比 `reading-queue.json` 更省。若 chunk 粒度仍是一篇 note，且 `retrieval-workspace.json` 实际包含了大量 note 原文，初次完整生成的 token 节省可能有限。收益成立的前提是：先批量生成受 topK 和去重约束的 `retrieval-workspace.json`，agent 按 target 的 `unique_chunk_ids` 局部读取顶层 `chunks_by_id`，再按 checklist 做少量缺口补检索，而不是把全部 retrieval workspace 原文一次性读入上下文。
