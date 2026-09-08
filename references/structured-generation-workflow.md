# 结构化低上下文生成流程

当用户没有提供 `rag-index.json`，且满足以下任一条件时，优先使用本流程：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、需要生成完整静态 HTML 攻略，或用户要求后续可重复修改。

如果用户提供了 `rag-index.json`，优先按 [rag-workflow.md](rag-workflow.md) 走 RAG 分支，不进入本文件的 `resource-index.json`、`reading-queue.json`、`source-digest.json` 主路径。RAG 的路线解析规则直接读取 [info-rules.md](info-rules.md) 和 [data-contracts.md](data-contracts.md)。

目标是让 agent 只在事实判断阶段读取少量相关原文，避免在最终 HTML 编写时反复加载素材全文。共同 JSON 字段契约见 [data-contracts.md](data-contracts.md)，结构化分支专属契约见 [structured-data-contracts.md](structured-data-contracts.md)，事实取舍和字段填充规则见 [info-rules.md](info-rules.md)。

注意：本流程中的脚本不是语义事实抽取器。`scan_resources.mjs` 只做素材索引、短摘录、照片目录识别和候选关键词匹配；`create_fact_workspace.mjs` 只创建结构化工作区。景点事实、冲突判断、城市页取舍和正文表达仍必须由 agent 阅读相关原文后完成。

照片处理只依赖 `photos/` 下的目录名、文件名、扩展名和路径。Agent 不得打开、预览、OCR、视觉识别或解析图片画面内容；图片画面不能作为景点事实、路线判断、入口识别、看点描述或风险判断的来源。

结构化流程中，默认先按 `source-digest.json.files[]` 的唯一文件顺序读取原文；如果 digest 尚未生成，才按 `reading-queue.json.files[]` 读取。不要按地点或城市逐项重复打开同一素材。文件读完后先把可用事实、冲突和全局提醒沉淀到 `source-digest.json`，再分发到 `facts-workspace.json`；如果没有生成 queue 或 digest，也必须先手工去重 `source_files` 再读原文。

结构化分支优先复用 `source-digest.json` 判断是否需要回读原文。填完 digest 后先用脚本校验结构和目标字段，再用脚本机械分发到 `facts-workspace.json`；修改事实时优先写局部 facts patch，并用 `apply_facts_patch.mjs` 合并，再重新渲染。只有 HTML 结构规则变化时才改渲染脚本。命令输出应保持简短，只显示统计、异常和必要样例，避免把大段素材打印到对话里。

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

脚本会扫描 `.json`、`.md`、`.txt` 和 `photos/`，输出文本素材索引、短摘录、候选地点命中和本地照片目录索引。对照片只扫描目录名、文件名和路径，不读取或解析图片内容。使用索引决定下一步读取哪些原文；不要把大段素材直接打印进对话，只输出统计、异常和少量必要片段。

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

### 3.1 填充 source digest

随后 agent 读取 `source-digest.json` 中的 `files[]`，只打开与地点、城市、全局提醒或冲突判断相关的原文，并按 [info-rules.md](info-rules.md) 填充每个文件的 `facts`、`conflicts` 和 `global_notes`。

地点 `source_files` 来自 `candidate_places` 和明显同指的别名匹配，城市 `source_files` 来自 `candidate_cities`；文件路径或标题命中只作为兜底。若没有生成 `source-digest.json`，才直接读取 `reading-queue.json`；若也没有生成 `reading-queue.json`，才直接从 `facts-workspace.json` 汇总 `source_files` 后手工建立去重读取队列。

无论使用 `source-digest.json`、`reading-queue.json`，还是手工队列，读取原文前都必须保证 `places.*.source_files` 和 `cities.*.source_files` 已按唯一文件去重。每个文件项应记录该文件服务的所有目标，包括相关地点、城市、全局事项和可能的冲突判断。每次打开一个原文文件时，同时处理它对应的全部目标；不要按 `places` 或 `cities` 逐项重复读取同一文件。

### 3.2 校验并分发 digest

填完文件级 digest 后，先校验 digest 是否能路由到当前 facts 工作区：

```bash
node scripts/validate_source_digest.mjs \
  --digest <工作目录>/source-digest.json \
  --facts <工作目录>/facts-workspace.json \
  -o <工作目录>/source-digest-validation.json
```

校验失败时，优先修正 `source-digest.json` 中的 `target_type`、`target_name`、`field`、`items` 或 `reviewed` 状态；不要绕过校验手工把无效 fact 搬进 `facts-workspace.json`。

校验通过后，把已 reviewed 的 digest facts 机械分发到 `facts-workspace.json`：

```bash
node scripts/apply_source_digest_to_facts.mjs \
  --digest <工作目录>/source-digest.json \
  --facts <工作目录>/facts-workspace.json \
  -o <工作目录>/facts-workspace.json
```

`apply_source_digest_to_facts.mjs` 只做目标路由、追加、按文本去重和来源引用合并，不做事实取舍、冲突合并、表达优化或城市页 include 判断。分发后仍应保持 `needs_agent_review: true`。

### 3.3 语义修正和局部 patch

digest 分发后，由 agent 按 [info-rules.md](info-rules.md) 复核 `facts-workspace.json`：删除重复或弱相关内容，处理冲突，补齐每日 `summary`、`timeline`、`notes`、`confirmations`，判断城市 `include`，并整理 `global_notes` 和 `confirm_before_departure`。

填充或修改 facts 时，优先把语义判断结果写成局部 `facts-patch.json`，再用 `apply_facts_patch.mjs` 合并回 `facts-workspace.json`：

```bash
node scripts/apply_facts_patch.mjs \
  --facts <工作目录>/facts-workspace.json \
  --patch <工作目录>/facts-patch.json
```

### 3.4 可选读取日志

如果本次需要评估上下文成本、审计实际读取范围，或用户明确要求读取日志，可在 digest review 后生成 `read-log.json`：

```bash
node scripts/create_read_log.mjs \
  --index <工作目录>/resource-index.json \
  --digest <工作目录>/source-digest.json \
  -o <工作目录>/read-log.json
```

`read-log.json` 是评估和审计辅助文件，不是渲染 HTML 的必需输入。

## 阶段 4：渲染前收口

渲染 HTML 前必须读取 [pre-render-online-research.md](pre-render-online-research.md)，独立判断本次攻略是否触发被允许的联网查询项。除用户另行明确授权外，只能查询该 reference 白名单中列出的信息。对每个被允许查询的信息项，先检查 `facts-workspace.json` 是否已有明确且无冲突的可用事实；已有充分事实时直接复用，不再联网重复查询；只有 facts 缺失、覆盖不完整、存在冲突，或 reference 对该信息项明确要求核验时，才查询必要目标，并把查询结果、来源 URL 和查询日期写回 `facts-workspace.json` 的对应字段。

进入渲染前，必须完成字段级缺口检查：

- 每个 `route_places` 地点都有可用内容，或明确记录 `材料未说明` / `需出行前确认`。
- 每日 `summary`、`timeline`、`notes` 和 `confirmations` 已按本次路线整理，不保留素材审计旁白。
- 路线外地点不会进入每日景点详情。
- 城市页只为通过独立增量价值判断的城市设置 `include: true`。
- 高风险事实不被无来源地断言，冲突信息被保留而不是强行合并。
- 全局提醒和出发前确认只包含对本次路线有执行价值的信息。
- 图片只来自本地材料，并且只按目录名、文件名和路径归属。

通过 digest 校验、事实分发、字段级缺口检查、必要联网白名单检查和语义复核后，才可把 `facts-workspace.json.needs_agent_review` 改为 `false` 并进入 HTML 渲染。

## 阶段 5：渲染 HTML

填好 `facts-workspace.json` 后运行：

```bash
npm install
node scripts/render_travel_html.mjs <工作目录>/facts-workspace.json -o <输出目录>
```

如果当前仓库已经安装过依赖，可以直接运行渲染命令。

渲染脚本会生成 `index.html`、`day-XX.html` 和通过 `include: true` 的 `city-XX.html`，复制 `reading-first.css`，并把 `photos` 中存在的本地照片复制到 `<输出目录>/assets/photos/景点名/`。脚本不会替 agent 判断事实质量；若 JSON 中字段为空，对应小节会被跳过。

## 阶段 6：校验输出

运行：

```bash
node scripts/verify_output.mjs <输出目录>
```

校验失败时，优先确认输出目录是否为最新渲染结果，再修正 `facts-workspace.json` 或资源引用后重新渲染。

校验覆盖：

- 输出目录存在。
- `index.html` 存在。
- HTML 中的本地 `href` / `src` 目标存在。
- HTML 中不出现 `http://` 或 `https://` 远程资源引用。

校验脚本不能判断攻略事实是否正确、是否只使用授权材料、景点是否应出现在路线中、城市 `include` 是否合理、信息冲突是否处理充分、或内容是否有套话重复。这些仍按 [info-rules.md](info-rules.md) 和 `SKILL.md` 的人工检查执行。

提交完整攻略或 HTML 产物前，必须再读取 [manual-quality-check.md](manual-quality-check.md) 做人工质量检查。若脚本校验和人工检查都适用，先修正 `source-digest.json` 中未分发或需回读的问题，再修正文案和 `facts-workspace.json` 中的事实问题，最后重新渲染并运行脚本校验。

## 何时跳过脚本

只有在用户要求的是很小的文字整理、单页草稿、或不需要静态 HTML 产物时，才可以直接整理正文。只要要生成完整 HTML 攻略，就优先走结构化流程。
