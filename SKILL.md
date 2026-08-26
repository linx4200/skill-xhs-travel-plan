---
name: skill-xhs-travel-plan
description: Use when 用户希望根据已有资料生成旅游攻略；根据用户提供的旅行路线和本地材料，生成中文旅游攻略与适合移动端阅读的静态 HTML 页面；
metadata:
  short-description: 本地材料生成移动端旅游攻略
---

# 旅游攻略生成

当用户提供旅行路线和本地输入材料，并要求整理旅游攻略、行程页、城市页或移动端 HTML 攻略时，使用此 skill。最终内容默认使用中文。

## 参考文件路由

处理用户路线、输入材料、景点、城市、餐饮和整体旅程信息前，必须读取 [references/info-rules.md](references/info-rules.md)。

生成静态 HTML 攻略时，必须读取 [references/mobile-reading-html-output.md](references/mobile-reading-html-output.md)。

当满足以下任一条件时，还必须读取 [references/structured-generation-workflow.md](references/structured-generation-workflow.md)，并优先使用其中的 `resource-index.json`、`facts-workspace.json`、渲染脚本和校验脚本流程：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、用户需要完整静态 HTML 攻略、或用户希望后续可重复修改。

使用结构化流程读写 `route-structure.json`、`resource-index.json` 或 `facts-workspace.json` 时，必须遵守 [references/data-contracts.md](references/data-contracts.md)。

生成 HTML 前，必须读取 [references/pre-render-online-research.md](references/pre-render-online-research.md)，先判断本次攻略是否有被该 reference 明确列出的联网查询项；除了用户另行明确授权的信息，只有该 reference 白名单中列出的信息可以联网查询。

页面视觉语言沿用 [reading-first-design-spec.md](references/reading-first-design-spec.md) 和 [reading-first.css](templates/travel-html/reading-first.css)。手写 HTML 或修改样式时，必须读取 `reading-first-design-spec.md`；使用渲染脚本且不改样式时不需要额外读取完整设计规范。

## 工作原则

生成完整攻略时，不要默认把所有素材全文、页面规范和 HTML 草稿同时塞进上下文。优先使用低上下文的结构化流程；材料很少、用户只要文字整理或单页草稿时，可以直接整理，但仍要遵守资料边界。

结构化流程中，后续修改内容时优先改 `facts-workspace.json` 后重新渲染；只有 HTML 结构规则变化时才改渲染脚本。命令输出应保持简短，只显示统计、异常和必要样例，避免把大段素材打印到对话里。

优先输出可执行的旅行建议，删除套话、空话、重复信息和低价值占位内容。攻略应像给人看的执行清单，不要写成资料审计报告。

## 资料边界

攻略事实只能来自用户提供或明确授权使用的材料：

- 用户提供的本地输入文件夹。
- 输入文件夹中的 `.json`、`.md`、`.txt`、截图 OCR 文本、整理稿等文本材料。
- 输入文件夹中的本地照片。

除非用户明确要求并授权联网核验，或 [references/pre-render-online-research.md](references/pre-render-online-research.md) 明确允许，不要联网搜索、补充常识、猜测最新信息或自行扩写材料中没有的事实。不要声称信息“最新”“已确认”“正常开放”“价格有效”或“安全无风险”，除非材料中明确写明。

资料缺失或不确定时，只保留会影响实际出行决策的缺失项，标注为 `材料未说明` 或 `需出行前自行确认`。多份材料互相矛盾时，并列展示冲突信息，并说明来源文件名或材料线索；不要替用户武断选择。

## 开始前确认

生成攻略前应确认以下信息；如果缺失且无法合理推断，先询问用户：

1. 旅游路线规划，建议格式为 `日期 - 城市/地点 - 景点/活动`。
2. 输入材料文件夹路径；该文件夹是默认唯一事实来源。
3. 出行方式，例如自驾、高铁、包车、公共交通或步行为主。

如果路线不完整但已经足以开始整理，可以先基于已知信息处理，并在输出中只列出真正影响执行的缺失项。

## 人工质量检查

输出前人工检查脚本无法判断的内容：

- 是否只使用了用户提供、用户授权或 [references/pre-render-online-research.md](references/pre-render-online-research.md) 明确允许查询的材料。
- 是否已覆盖用户路线中的每个城市和真实景点/景区。
- 是否只为通过独立增量价值判断的城市生成 `city-XX.html`。
- 每日景点详情是否只包含用户路线中的真实景点/景区，且没有把停车场、游客中心、入口等设施拼进标题。
- 照片是否只来自输入材料文件夹，且按景点归属展示。
- 是否只保留对出行决策有帮助的 `材料未说明` 信息，并对关键冲突做并列说明。
- 是否删除重复内容、套话、资料来源旁白、弱相关背景和空小节。
- 当天行程安排中是否没有餐饮安排，除非用户明确要求。

HTML 文件存在性、互链、CSS、首页导航、生成时间、远程资源和图片路径等机械检查由结构化流程中的 `node scripts/verify_output.mjs` 执行。

## 禁止事项

- 未涉及到用户路线的景点，不要出现在每日景点详情中。
- 不要自主搜索任何资料，除非用户明确授权或 [references/pre-render-online-research.md](references/pre-render-online-research.md) 明确允许。
- 不要联网补图、使用占位图、使用远程图片链接或把其他景点照片挪作当前景点照片。
- 不要添加输入材料中没有的营业时间、票价、优惠政策、交通时长、天气或习俗。
- 不要声称资料“最新”或“已确认”，除非输入材料中明确写明。
- 不要输出带内联 CSS 或 JavaScript 的复杂页面。
