# 结构化低上下文生成流程

当满足以下任一条件时，优先使用本流程：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、需要生成完整静态 HTML 攻略，或用户要求后续可重复修改。目标是让 agent 只在事实判断阶段读取少量相关原文，避免在最终 HTML 编写时反复加载素材全文。

注意：本流程中的脚本不是语义事实抽取器。`scan_resources.mjs` 只做素材索引、短摘录、照片目录识别和候选关键词匹配；`create_fact_workspace.mjs` 只创建结构化工作区。景点事实、冲突判断、城市页取舍和正文表达仍必须由 agent 阅读相关原文后完成。

## 阶段 1：建立素材索引

运行索引脚本前，agent 先从用户路线规划中提取明确出现的真实景点/景区名称和候选城市，并排除住宿点、停车场、游客中心、入口、车站、餐厅等非景点设施。每个景点/景区名称都作为一个独立的 `--place` 参数传给脚本；每个候选城市都作为一个独立的 `--city` 参数传给脚本。不要把城市名塞进 `--place`。

运行：

```bash
node scripts/scan_resources.mjs <输入材料文件夹> -o <工作目录>/resource-index.json --place <行程景点名> --city <候选城市名>
```

可以重复传入 `--place` 和 `--city`。例如路线包含“兴文石海、九洞天、百草坪、草海、大山包、豆沙关古镇”，候选城市包含“宜宾、毕节、威宁、昭通、盐津县、乐山”时，命令应拼成：

```bash
node scripts/scan_resources.mjs <输入材料文件夹> \
  -o <工作目录>/resource-index.json \
  --place 兴文石海 \
  --place 九洞天 \
  --place 百草坪 \
  --place 草海 \
  --place 大山包 \
  --place 豆沙关古镇 \
  --city 宜宾 \
  --city 毕节 \
  --city 威宁 \
  --city 昭通 \
  --city 盐津县 \
  --city 乐山
```

脚本会扫描 `.json`、`.md`、`.txt` 和 `photos/`，输出：

- 文本文件路径、标题、正文长度、命中的景点、城市、实用关键词和短摘录。
- `photos/景点名/` 下的本地照片列表。

使用索引决定下一步读取哪些原文。不要把大段素材直接打印进对话；只输出统计、异常和少量必要片段。

## 阶段 2：生成事实工作区

先由 agent 读取用户原始路线，生成 `route-structure.json`。路线解析不要交给脚本用正则完成；脚本只接收 agent 已经判断过的结构。

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

字段来源：

- `days`：由 agent 从用户路线中提取每天的日期、城市、景点和活动。`route_places` 只放真实景点/景区，不放城市、住宿点、停车场、游客中心、入口、车站、餐厅等非景点设施。
- `mode`：只根据用户明确说明的出行方式填写。推荐归一化为 `self-drive`、`rail`、`charter`、`public-transit`、`walking` 或 `unknown`；未明确说明时填 `unknown`，不要默认成自驾。
- `cities`：从路线中的城市、住宿地、中转地或连续游玩基地提取候选城市名。不要把景点名、停车场、游客中心、餐厅或酒店名作为城市填入。

然后运行：

```bash
node scripts/create_fact_workspace.mjs \
  --route-json <工作目录>/route-structure.json \
  --index <工作目录>/resource-index.json \
  -o <工作目录>/facts-workspace.json
```

这个脚本只创建结构化工作区，不会自行补事实。随后 agent 读取 `facts-workspace.json` 中每个景点和城市的 `source_files`，只打开与该景点或城市相关的原文，填充事实字段。景点 `source_files` 来自 `candidate_places`，城市 `source_files` 来自 `candidate_cities`；文件路径或标题命中只作为兜底。

## facts-workspace.json 约定

顶层字段：

- `title`：攻略标题。
- `source.resource_root`：输入材料文件夹绝对路径或相对路径；渲染照片时使用。
- `trip.mode`：出行方式。
- `trip.days`：每日路线、摘要、timeline、当天提醒。
- `places`：景点事实，只为用户路线中明确出现的真实景点填正文。
- `cities`：城市级信息，只有通过独立增量价值判断时才把 `include` 设为 `true`。
- `global_notes`：跨天通用注意事项；可为列表，也可为 `{小节名: [事项]}`。
- `confirm_before_departure`：真正需要出发前确认或预约的事项。

每日字段：

- `day`：数字，用于生成 `day-XX.html`。
- `date`、`title`、`summary`：首页和每日页标题/摘要。
- `timeline`：列表，每项可含 `title`、`summary`、`details`。
- `route_places` 或 `places`：当天需要展开详情的景点名，必须匹配 `places` 中的 key。
- `notes`、`confirmations`：当天特有提醒。

景点字段：

- `summary`
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

城市字段：

- `include`
- `summary`
- `overview`
- `backup_places`
- `foods`
- `lodging`
- `transport`
- `shopping`
- `notes`

## 城市 include 判断

`cities.<城市名>.include` 控制是否生成 `city-XX.html`。默认保持 `false`；只有排除重复内容后仍有独立、具体、可执行的城市级信息，才改为 `true`。

先排除以下内容：

- 已经在当天安排、每日景点详情、整体准备或出行前确认中写过的信息。
- 只是说明城市角色的句子，例如“这里是出发地”“这里是住宿地”“这里是某景点所在地”。
- 只有景点名字，但没有具体介绍、玩法、交通、注意事项的信息。
- 需要大幅改变当前路线或住宿安排才成立的建议。
- 只有 `材料未说明` 或 `具体玩法未说明` 的内容。
- 纯粹为了凑城市章节而写的概览、餐饮、住宿、交通空话。

排除后，满足以下任一条件，才把 `include` 设为 `true`：

- 至少有 2 类对行程有用的城市级信息，例如明确美食、住宿区域、停车/交通风险、天气/海拔提醒、备选景点库。
- 至少有 2 个可作为备选的城市景点，且每个都有具体介绍。
- 该城市承担住宿、中转或连续游玩基地功能，且材料提供了具体住宿、停车、补给或交通信息。
- 有明确城市级风险会影响执行，例如山路、夜间驾驶、停车困难、高反、温差、限行、景区分散等。

通过判断后，只写对本次行程有帮助、且材料中有实质内容的信息：

- `summary`：首页城市汇总中展示的 1 句话摘要。
- `overview`：用 1-3 句话总结这个城市在本次行程中的角色。
- `backup_places`：排除每日景点详情中已经完整出现过的景点及其附属到达点，再列出输入材料中该城市出现过的其余景点；只介绍景点本身，不评价它是否应该加入本次行程。
- `foods`：整理材料中出现的餐厅、菜品、夜市、小吃、避坑餐饮。
- `lodging`：整理材料中提到的推荐区域、酒店、民宿、交通便利性和注意事项。
- `transport`：只列出符合用户出行方式的信息。
- `shopping`：仅整理材料中出现的购物或伴手礼信息。
- `notes`：天气、海拔、治安、支付、排队、节假日人流、文化习俗等城市级注意事项。

没有实质内容的小节直接留空。不要为了让城市页显得完整而填空话。

所有列表项可以直接写字符串；复杂来源判断留在 `source_files` 或工作笔记中，不要在最终攻略正文里写成“材料指出”。

## 阶段 3：渲染 HTML

填好 `facts-workspace.json` 后运行：

```bash
npm install
node scripts/render_travel_html.mjs <工作目录>/facts-workspace.json -o <输出目录>
```

如果当前仓库已经安装过依赖，可以直接运行渲染命令。

渲染脚本会：

- 生成 `index.html`、`day-XX.html` 和通过 `include: true` 的 `city-XX.html`。
- 复制 `reading-first.css`。
- 把 `photos` 中存在的本地照片复制到 `<输出目录>/assets/photos/景点名/`。
- 固定首页生成时间、页面互链、每日页顶部/底部导航和基础阅读结构。

脚本不会替 agent 判断事实质量。若 JSON 中字段为空，对应小节会被跳过。

## 阶段 4：校验输出

运行：

```bash
node scripts/verify_output.mjs <输出目录>
```

校验失败时，优先修正 `facts-workspace.json` 后重新渲染；只有样式或结构规则本身需要改变时，才修改渲染脚本。

校验覆盖：

- 所有 HTML 外链 `reading-first.css`。
- 所有 HTML 包含移动端 viewport meta。
- 首页无 `nav.page-nav`，并包含生成时间。
- 首页包含 `ol.timeline`，且首页 Day 节点不包含详情 `ul` 列表。
- 首页链接到所有 `day-XX.html`；城市页被首页链接。
- 每日页有顶部和底部导航。
- 链接和图片目标存在。
- 图片只来自 `assets/photos/...`。
- 禁止远程资源、脚本、iframe、占位图和“餐饮节奏”等不应出现的内容。

校验脚本不能判断攻略事实是否正确、是否只使用授权材料、景点是否应出现在路线中、城市 `include` 是否合理、信息冲突是否处理充分、或内容是否有套话重复。这些仍按 `SKILL.md` 的“人工质量检查”执行。

## 何时跳过脚本

只有在用户要求的是很小的文字整理、单页草稿、或不需要静态 HTML 产物时，才可以直接整理正文。只要要生成完整 HTML 攻略，就优先走结构化流程。
