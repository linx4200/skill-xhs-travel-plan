---
name: skill-xhs-travel-plan
description: Use when 用户希望根据已有资料生成旅游攻略；根据用户提供的旅行路线和本地材料，生成中文旅游攻略与适合移动端阅读的静态 HTML 页面；
metadata:
  short-description: 本地材料生成移动端旅游攻略
---

# 旅游攻略生成

当用户提供旅行路线和本地输入材料，并要求整理旅游攻略、行程页、城市页或移动端 HTML 攻略时，使用此 skill。最终内容默认使用中文。

## 入口判断

任务开始时先判断材料形态，选择一个主流程。不要同时走 RAG 和结构化读取流程。

### RAG 流程

用户提供的核心材料是 `rag-index.json`，或 JSON 顶层包含 `chunks`、`source_chunks`、`resource_root`、`embedding` 等 RAG 索引字段时，走 RAG 流程。

RAG 分支只把 `rag-index.json` 交给项目脚本读取，不走 `resource-index.json`、`reading-queue.json`、`source-digest.json`、`read-log.json` 主路径。默认也不生成 `retrieval-log.json`，除非用户明确要求召回日志、检索日志或召回原因诊断。

进入 RAG 分支后读取：

- [references/info-rules.md](references/info-rules.md)：路线解析、事实边界、字段取舍和城市页 include 判断。
- [references/data-contracts.md](references/data-contracts.md)：`route-structure.json` 和 `facts-workspace.json` 共同字段。
- [references/rag-data-contracts.md](references/rag-data-contracts.md)：RAG 专属 JSON 契约。
- [references/rag-workflow.md](references/rag-workflow.md)：RAG 可执行步骤。

不要为了 RAG 主流程读取结构化流程 reference；只有需要回看非 RAG 的完整结构化链路时才读取 [references/structured-generation-workflow.md](references/structured-generation-workflow.md)。

### 结构化流程

用户没有提供 `rag-index.json`，但输入材料规模较大、需要完整 HTML 攻略或后续可重复修改时，走结构化流程：`resource-index.json` 建素材索引，`facts-workspace.json` 建事实工作区，`reading-queue.json` 按唯一原文文件去重读取，`source-digest.json` 保存文件级事实摘要，最后用渲染脚本和校验脚本生成 HTML。

满足以下任一条件时，读取 [references/data-contracts.md](references/data-contracts.md)、[references/structured-data-contracts.md](references/structured-data-contracts.md) 和 [references/structured-generation-workflow.md](references/structured-generation-workflow.md)：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、用户需要完整静态 HTML 攻略，或用户希望后续可重复修改。

材料很少、用户只要文字整理或单页草稿时，可以直接整理正文，但仍必须遵守事实边界和资料来源规则。

## Reference 路由

不要在任务开始时一次性读取所有 reference。先按当前流程和当前阶段读取最小必要文件。

- 处理路线、景点、城市、餐饮和整体旅程事实前，必须先读取 [references/info-rules.md](references/info-rules.md)。
- 首次创建或修改 `route-structure.json` 或 `facts-workspace.json` 前，读取 [references/data-contracts.md](references/data-contracts.md)。
- 首次创建或修改 RAG 分支专属 JSON 前，读取 [references/rag-data-contracts.md](references/rag-data-contracts.md)。
- 首次创建或修改结构化分支专属 JSON 前，读取 [references/structured-data-contracts.md](references/structured-data-contracts.md)。
- 准备渲染 HTML 前，读取 [references/pre-render-online-research.md](references/pre-render-online-research.md)，独立判断是否触发白名单联网查询项。
- 提交完整攻略或 HTML 产物前，读取 [references/manual-quality-check.md](references/manual-quality-check.md)，完成人工质量检查。

## HTML 与样式

常规完整 HTML 攻略应通过 `scripts/render_travel_html.mjs` 和 `templates/travel-html/*.ejs` 生成，并用 `scripts/verify_output.mjs` 校验。HTML 页面结构由模板、渲染脚本和校验脚本固化；使用渲染脚本且不改结构/样式时，不需要读取完整设计规范。

手写 HTML、修改 HTML 结构、修改模板或修改样式前，必须读取 [references/reading-first-design-spec.md](references/reading-first-design-spec.md)，并同步检查 `templates/travel-html/*.ejs` 和 [templates/travel-html/reading-first.css](templates/travel-html/reading-first.css)。

## 工作原则

生成完整攻略时，不要默认把所有素材全文、页面规范和 HTML 草稿同时塞进上下文。优先按入口分支使用 RAG 流程或结构化流程。

无论走 RAG 流程还是结构化流程，`photos/` 下的图片都只作为本地展示素材和文件名/目录名线索。Agent 不得打开图片、截图预览、使用视觉模型、OCR 或其他方式读取和解析图片画面内容；照片归属、`alt` 和 `caption` 只能根据 `photos/地点名/文件名`、明显别名、扩展名和已由文本材料确认的地点信息生成。仅图片画面看起来包含的信息不能作为攻略事实。

修改事实时优先写局部 `facts-patch.json`，用 `scripts/apply_facts_patch.mjs` 合并回 `facts-workspace.json`，再重新渲染。命令输出保持简短，只显示统计、异常和必要样例，避免把大段素材打印到对话里。

优先输出可执行的旅行建议，删除套话、空话、重复信息和低价值占位内容。攻略应像给人看的执行清单，不要写成资料审计报告。

## 资料边界

攻略事实只能来自用户提供或明确授权使用的材料：

- 用户提供的本地输入文件夹。
- 输入文件夹中的 `.json`、`.md`、`.txt`、截图 OCR 文本、整理稿等文本材料。
- 输入文件夹中的本地照片文件名、目录名和路径；照片画面内容不作为可读取或可推断的事实来源。

除非用户明确要求并授权联网核验，或 [references/pre-render-online-research.md](references/pre-render-online-research.md) 明确允许，不要联网搜索、补充常识、猜测最新信息或自行扩写材料中没有的事实。不要声称信息“最新”“已确认”“正常开放”“价格有效”或“安全无风险”，除非材料中明确写明。

资料缺失或不确定时，只保留会影响实际出行决策的缺失项，标注为 `材料未说明` 或 `需出行前自行确认`。多份材料互相矛盾时，并列展示冲突信息，并说明来源文件名或材料线索；不要替用户武断选择。

## 开始前确认

生成攻略前应确认以下信息；如果缺失且无法合理推断，先询问用户：

1. 旅游路线规划，建议格式为 `日期 - 城市/地点 - 景点/活动`。
2. 输入材料文件夹路径；该文件夹是默认唯一事实来源。
3. 出行方式，例如自驾、高铁、包车、公共交通或步行为主。

如果路线不完整但已经足以开始整理，可以先基于已知信息处理，并在输出中只列出真正影响执行的缺失项。

## 禁止事项

- 未涉及到用户路线的 `route_places` 地点，不要出现在每日景点详情中。
- 不要自主搜索任何资料，除非用户明确授权或 [references/pre-render-online-research.md](references/pre-render-online-research.md) 明确允许。
- 不要打开、预览、OCR、视觉识别或解析 `photos/` 下的图片内容；只按目录名、文件名和路径处理照片。
- 不要联网补图、使用占位图、使用远程图片链接或把其他景点照片挪作当前景点照片。
- 不要添加输入材料中没有的营业时间、票价、优惠政策、交通时长、天气或习俗。
- 不要声称资料“最新”或“已确认”，除非输入材料中明确写明。
- 不要输出带内联 CSS 或 JavaScript 的复杂页面。
