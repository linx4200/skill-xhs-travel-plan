# 结构化低上下文生成流程

当满足以下任一条件时，优先使用本流程：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、需要生成完整静态 HTML 攻略，或用户要求后续可重复修改。

目标是让 agent 只在事实判断阶段读取少量相关原文，避免在最终 HTML 编写时反复加载素材全文。JSON 字段契约见 [data-contracts.md](data-contracts.md)，事实取舍和字段填充规则见 [info-rules.md](info-rules.md)。

注意：本流程中的脚本不是语义事实抽取器。`scan_resources.mjs` 只做素材索引、短摘录、照片目录识别和候选关键词匹配；`create_fact_workspace.mjs` 只创建结构化工作区。景点事实、冲突判断、城市页取舍和正文表达仍必须由 agent 阅读相关原文后完成。

## 阶段 1：生成路线结构

先由 agent 读取用户原始路线，按 [info-rules.md](info-rules.md) 的路线解析规则生成 `route-structure.json`。路线解析不要交给脚本用正则完成；脚本只接收 agent 已经判断过的结构。

`route-structure.json` 的结构和字段见 [data-contracts.md](data-contracts.md)。

## 阶段 2：建立素材索引

运行：

```bash
node scripts/scan_resources.mjs <输入材料文件夹> \
  --route-json <工作目录>/route-structure.json \
  -o <工作目录>/resource-index.json
```

脚本会从 `route-structure.json` 读取 `days[].route_places` 和 `cities` 作为候选匹配词。只有需要临时补充路线 JSON 之外的匹配词时，才追加独立的 `--place` 或 `--city` 参数；不要把只承担住宿、中转或行政定位作用的城市名塞进 `--place`。用户明确安排游玩或短停的城市/城区型地点应先规范进 `route_places`，例如“盐津县城”。

脚本会扫描 `.json`、`.md`、`.txt` 和 `photos/`，输出文本素材索引、短摘录、候选地点命中和本地照片目录索引。使用索引决定下一步读取哪些原文；不要把大段素材直接打印进对话，只输出统计、异常和少量必要片段。

## 阶段 3：生成事实工作区

读取上一阶段生成的 `route-structure.json` 和 `resource-index.json`，运行：

```bash
node scripts/create_fact_workspace.mjs \
  --route-json <工作目录>/route-structure.json \
  --index <工作目录>/resource-index.json \
  -o <工作目录>/facts-workspace.json
```

再基于事实工作区生成按唯一文件去重的读取队列：

```bash
node scripts/create_reading_queue.mjs \
  --index <工作目录>/resource-index.json \
  --facts <工作目录>/facts-workspace.json \
  -o <工作目录>/reading-queue.json
```

再创建待 agent 填充的文件级摘要工作区：

```bash
node scripts/create_source_digest_workspace.mjs \
  --queue <工作目录>/reading-queue.json \
  -o <工作目录>/source-digest.json
```

随后 agent 读取 `source-digest.json` 中的 `files[]`，只打开与地点、城市、全局提醒或冲突判断相关的原文，并按 [info-rules.md](info-rules.md) 填充每个文件的 `facts`、`conflicts` 和 `global_notes`。填完文件级 digest 后，再把有效事实分发到 `facts-workspace.json` 的对应地点、城市、每日提醒或全局字段。地点 `source_files` 来自 `candidate_places` 和明显同指的别名匹配，城市 `source_files` 来自 `candidate_cities`；文件路径或标题命中只作为兜底。若没有生成 `source-digest.json`，才直接读取 `reading-queue.json`；若也没有生成 `reading-queue.json`，才直接从 `facts-workspace.json` 汇总 `source_files` 后手工建立去重读取队列。

无论使用 `source-digest.json`、`reading-queue.json`，还是手工队列，读取原文前都必须保证 `places.*.source_files` 和 `cities.*.source_files` 已按唯一文件去重。每个文件项应记录该文件服务的所有目标，包括相关地点、城市、全局事项和可能的冲突判断。每次打开一个原文文件时，同时处理它对应的全部目标；不要按 `places` 或 `cities` 逐项重复读取同一文件。

渲染 HTML 前必须读取 [pre-render-online-research.md](pre-render-online-research.md)，独立判断本次攻略是否触发被允许的联网查询项。除用户另行明确授权外，只能查询该 reference 白名单中列出的信息；如果触发高原海拔规则，再把查询到的海拔、来源 URL 和查询日期填入 `facts-workspace.json`。

## 阶段 4：渲染 HTML

填好 `facts-workspace.json` 后运行：

```bash
npm install
node scripts/render_travel_html.mjs <工作目录>/facts-workspace.json -o <输出目录>
```

如果当前仓库已经安装过依赖，可以直接运行渲染命令。

渲染脚本会生成 `index.html`、`day-XX.html` 和通过 `include: true` 的 `city-XX.html`，复制 `reading-first.css`，并把 `photos` 中存在的本地照片复制到 `<输出目录>/assets/photos/景点名/`。脚本不会替 agent 判断事实质量；若 JSON 中字段为空，对应小节会被跳过。

## 阶段 5：校验输出

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

校验脚本不能判断攻略事实是否正确、是否只使用授权材料、景点是否应出现在路线中、城市 `include` 是否合理、信息冲突是否处理充分、或内容是否有套话重复。这些仍按 [info-rules.md](info-rules.md) 和 `SKILL.md` 的人工检查执行。

## 何时跳过脚本

只有在用户要求的是很小的文字整理、单页草稿、或不需要静态 HTML 产物时，才可以直接整理正文。只要要生成完整 HTML 攻略，就优先走结构化流程。
