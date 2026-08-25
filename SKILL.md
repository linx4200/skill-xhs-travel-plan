---
name: skill-xhs-travel-plan
description: Use when 用户希望根据已有资料生成旅游攻略；根据用户提供的旅行路线和本地材料，生成中文旅游攻略与适合移动端阅读的静态 HTML 页面；
metadata:
  short-description: 本地材料生成移动端旅游攻略
---

# 旅游攻略生成

当用户提供旅行路线和本地输入材料，并要求整理旅游攻略、行程页、城市页或移动端 HTML 攻略时，使用此 skill。最终内容默认使用中文。

## 参考文件

生成静态 HTML 攻略时，必须先读取 [references/mobile-reading-html-output.md](references/mobile-reading-html-output.md)。

当满足以下任一条件时，还必须读取 [references/structured-generation-workflow.md](references/structured-generation-workflow.md)，并优先使用其中的 `resource-index.json`、`facts-workspace.json`、渲染脚本和校验脚本流程：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、用户需要完整静态 HTML 攻略、或用户希望后续可重复修改。

页面视觉语言沿用 [reading-first-design-spec.md](references/reading-first-design-spec.md) 和 [reading-first.css](templates/travel-html/reading-first.css)。手写 HTML 或修改样式时，必须读取 `reading-first-design-spec.md`；使用渲染脚本且不改样式时不需要额外读取完整设计规范。

处理用户路线、输入材料、景点、城市、餐饮和整体旅程信息前，必须读取 [references/info-rules.md](references/info-rules.md)，并遵守其中的解析和提取规则。

## 处理流程

生成完整攻略时，不要默认把所有素材全文、页面规范和 HTML 草稿同时塞进上下文。优先使用低上下文的结构化流程；材料很少时可直接整理，但仍要遵守资料边界。

1. 按 [references/info-rules.md](references/info-rules.md) 解析用户原始路线，提取每天的日期、城市、景点和活动，得到真实景点/景区清单、候选城市和出行方式；不要把城市名、住宿点、停车场、游客中心、入口、车站、餐厅等非景点设施当作景点。
2. 用 `node scripts/scan_resources.mjs` 扫描输入材料，生成 `resource-index.json`。运行素材索引脚本时，把第 1 步得到的每个景点/景区名称作为独立的 `--place` 参数传入，把每个候选城市作为独立的 `--city` 参数传入；不要把城市名塞进 `--place`。这个索引只做文件统计、短摘录、照片目录识别和候选关键词匹配，不代表已经完成事实抽取。
3. 由 agent 根据第 1 步的路线解析结果生成 `route-structure.json`，再用 `node scripts/create_fact_workspace.mjs` 根据结构化路线和索引生成 `facts-workspace.json` 工作区。路线解析不要交给脚本用正则完成。
   - `route-structure.json.days`：由 agent 提取每天的 `day`、`date`、`title`、`route_places`、`source_line` 等字段；`route_places` 只放真实景点/景区。
   - `route-structure.json.mode`：只根据用户明确说明的出行方式填写，例如 `self-drive`、`rail`、`charter`、`public-transit`、`walking`；未明确说明时填 `unknown`，不要默认成自驾。
   - `route-structure.json.cities`：从路线中的城市、住宿地、中转地或连续游玩基地提取候选城市名；不要放景点名、停车场、游客中心、餐厅或酒店名。
4. 只读取与当前景点、城市或冲突判断相关的原文，由 agent 把事实、照片和城市页取舍填入 `facts-workspace.json`。
5. 按天聚合行程，整理路线顺序、当天关键执行提醒和对应景点信息。
6. 按景点聚合信息，只处理用户行程线路中明确出现的真实景点/景区；景点详情拆入对应 `day-XX.html`，不要在首页生成集中“景点汇总”。
7. 按城市聚合信息，排除已在每日详情、整体准备或确认清单中完整出现过的内容，再判断城市是否有独立增量价值；只有通过判断的城市才生成 `city-XX.html`。结构化流程中用 `cities.<城市名>.include` 固化这个判断。
8. 整理跨天共用的准备事项、风险、衣物、天气、海拔、文化习俗、安全提醒、预约和出行前确认。
9. 按 [references/mobile-reading-html-output.md](references/mobile-reading-html-output.md) 生成静态 HTML 文件；使用结构化流程时由 `node scripts/render_travel_html.mjs` 渲染，再用 `node scripts/verify_output.mjs` 校验。

后续修改内容时，优先改 `facts-workspace.json` 后重新渲染；只有 HTML 结构规则变化时才改渲染脚本。命令输出应保持简短，只显示统计、异常和必要样例，避免把大段素材打印到对话里。

优先输出可执行的旅行建议，删除套话、空话、重复信息和低价值占位内容。攻略应像给人看的执行清单，不要写成资料审计报告。

## 资料边界

攻略事实只能来自用户提供或明确授权使用的材料：

- 用户提供的本地输入文件夹。
- 输入文件夹中的 `.json`、`.md`、`.txt`、截图 OCR 文本、整理稿等文本材料。
- 输入文件夹中的本地照片。

除非用户明确要求并授权联网核验，不要联网搜索、补充常识、猜测最新信息或自行扩写材料中没有的事实。不要声称信息“最新”“已确认”“正常开放”“价格有效”或“安全无风险”，除非材料中明确写明。

资料缺失或不确定时：

- 只保留会影响实际出行决策的缺失项，标注为 `材料未说明` 或 `需出行前自行确认`。
- 不要为了凑完整性列出低价值缺失项。
- 多份材料互相矛盾时，并列展示冲突信息，并说明来源文件名或材料线索；不要替用户武断选择。

## 开始前确认

生成攻略前应确认以下信息；如果缺失且无法合理推断，先询问用户：

1. 旅游路线规划，建议格式为 `日期 - 城市/地点 - 景点/活动`。
2. 输入材料文件夹路径；该文件夹是默认唯一事实来源。
3. 出行方式，例如自驾、高铁、包车、公共交通或步行为主。

如果路线不完整但已经足以开始整理，可以先基于已知信息处理，并在输出中只列出真正影响执行的缺失项。

## HTML 输出规则

生成 HTML 时，页面结构、文件命名、互链、timeline、折叠状态、照片输出和禁用资源规则必须遵守 [references/mobile-reading-html-output.md](references/mobile-reading-html-output.md)。

结构化流程中由 `node scripts/render_travel_html.mjs` 负责渲染文件，再用 `node scripts/verify_output.mjs` 校验输出。非结构化手写 HTML 时也必须沿用同一 reference。

## 人工质量检查

输出前人工检查：

- 是否只使用了用户提供或明确授权的材料。
- 是否覆盖了用户路线中的每个城市和景点。
- 是否只为通过独立增量价值判断的城市生成 `city-XX.html`。
- 首页是否只包含总览信息，没有集中输出长篇“景点汇总”。
- 每日景点详情标题是否只包含真实景点/景区，没有把停车场、游客中心、入口等设施拼进标题。
- 每日景点详情是否只包含用户路线中的景点。
- 城市详情页备选景点库是否已排除每日景点详情中完整出现过的地点。
- 城市详情页备选景点库是否只介绍景点本身，没有评价它是否应该加入本次行程。
- 不同玩法/游玩方式是否拆成独立方案。
- 照片是否只来自输入材料文件夹，是否按景点归属展示；无照片的景点是否已跳过照片区域。
- 是否只保留对出行决策有帮助的 `材料未说明` 信息。
- 是否对冲突信息做了并列说明。
- 是否删除重复内容、套话、资料来源说明、弱相关背景和空小节。
- 当天行程安排中是否没有餐饮安排，除非用户明确要求。

HTML 文件存在性、互链、CSS、首页导航、生成时间、远程资源和图片路径等机械检查由结构化流程中的 `node scripts/verify_output.mjs` 执行；详见 [references/structured-generation-workflow.md](references/structured-generation-workflow.md) 的“阶段 4：校验输出”。

## 禁止事项

- 未涉及到用户路线的景点，不要出现在每日景点详情中。
- 不要自主搜索任何资料，除非用户明确授权。
- 不要联网补图、使用占位图、使用远程图片链接或把其他景点照片挪作当前景点照片。
- 不要添加输入材料中没有的营业时间、票价、优惠政策、交通时长、天气或习俗。
- 不要声称资料“最新”或“已确认”，除非输入材料中明确写明。
- 不要输出带内联 CSS 或 JavaScript 的复杂页面。
