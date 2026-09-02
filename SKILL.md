---
name: skill-xhs-travel-plan
description: Use when 用户希望根据已有资料生成旅游攻略；根据用户提供的旅行路线和本地材料，生成中文旅游攻略与适合移动端阅读的静态 HTML 页面；
metadata:
  short-description: 本地材料生成移动端旅游攻略
---

# 旅游攻略生成

当用户提供旅行路线和本地输入材料，并要求整理旅游攻略、行程页、城市页或移动端 HTML 攻略时，使用此 skill。最终内容默认使用中文。

## 流程入口分支

任务开始时先判断用户给的材料类型，并选择一个主流程。不要同时走两套读取流程。

### 分支 A：RAG 流程

当用户提供的核心材料是 `rag-index.json`，或 JSON 顶层包含 `chunks`、`source_chunks`、`resource_root`、`embedding` 等 RAG 索引字段时，直接走 RAG 流程，不走原来的 `reading-queue.json` / `source-digest.json` 结构化读取流程。

RAG 流程先跑到第一版 `facts-workspace.json`：

1. 读取用户路线，按 [references/info-rules.md](references/info-rules.md)、[references/data-contracts.md](references/data-contracts.md) 和 [references/rag-data-contracts.md](references/rag-data-contracts.md) 人工创建 `route-structure.json`。
2. 用脚本校验 `rag-index.json` 可解析和必要字段完整；不要为了“看一眼”而直接打印或预览完整索引。后续脚本失败时停止当前流程，并把失败原因告诉用户。如果后续需要本地照片，使用 `rag-index.resource_root/photos`；若 `resource_root` 不存在或不可读，只影响照片归属，不进入原材料回读流程。
3. 运行 `create_fact_workspace.mjs --rag-index` 创建带 schema 和路线骨架的 skeleton `facts-workspace.json`。
4. 运行 `create_retrieval_workspace.mjs`，基于 `facts-workspace.json` 和 `rag-index.json` 批量创建 `retrieval-workspace.json`。
5. Agent 读取 `retrieval-workspace.json`，按景点、城市和主题整理 facts patch，再用 `apply_facts_patch.mjs` 合并到第一版 `facts-workspace.json`；此时 `needs_agent_review` 仍保持 `true`，等待后续字段级 checklist、补检索、缺口处理或渲染前评估。

RAG 分支的第 1 步复用结构化流程的路线解析规则；不生成 `resource-index.json`。第 3 步复用事实工作区骨架脚本，但输入改为 `rag-index.json`；第 4、5 步按 [references/rag-facts-framework.md](references/rag-facts-framework.md) 和 [references/rag-workflow.md](references/rag-workflow.md) 执行。

RAG happy path 中不要创建 `resource-index.json`、`reading-queue.json`、`source-digest.json` 或 `read-log.json`。若用户明确不做原材料回读，则后续缺口只通过 facts checklist、定向 RAG 或“材料未说明 / 出行前确认”处理。

### 分支 B：结构化流程

当用户没有提供 `rag-index.json`，但输入材料规模较大、需要完整 HTML 攻略或后续可重复修改时，走结构化流程：`resource-index.json` 建素材索引，`facts-workspace.json` 建事实工作区，`reading-queue.json` 按唯一原文文件去重读取，`source-digest.json` 保存文件级事实摘要，最后用渲染脚本和校验脚本生成 HTML。

材料很少、用户只要文字整理或单页草稿时，可以直接整理正文，但仍必须遵守事实边界和资料来源规则。

## 参考文件路由

不要在任务开始时一次性读取所有 reference。先根据用户目标和当前步骤选择最小必要文件；流程推进到对应阶段时再读取对应 reference。

### 必读入口

处理用户路线、输入材料、景点、城市、餐饮和整体旅程信息前，必须先读取 [references/info-rules.md](references/info-rules.md)。它是事实边界、路线解析、信息取舍、城市页 include 判断和内容去重的主规则。

### RAG 流程

选择 RAG 分支时，在创建或读取 `rag-index.json`、`facts-workspace.json` 或 `retrieval-workspace.json` 前，必须读取 [references/data-contracts.md](references/data-contracts.md)、[references/rag-data-contracts.md](references/rag-data-contracts.md)、[references/rag-facts-framework.md](references/rag-facts-framework.md) 和 [references/rag-workflow.md](references/rag-workflow.md)。RAG 第 1 步仍按 [references/structured-generation-workflow.md](references/structured-generation-workflow.md) 的路线解析规则执行，但不要生成 `resource-index.json`，也不要进入结构化流程的 `reading-queue.json` / `source-digest.json` 主路径。

### 结构化流程

当满足以下任一条件且没有提供 `rag-index.json` 时，在生成 `route-structure.json` 前读取 [references/data-contracts.md](references/data-contracts.md)、[references/structured-data-contracts.md](references/structured-data-contracts.md) 和 [references/structured-generation-workflow.md](references/structured-generation-workflow.md)，并优先使用其中的结构化低上下文流程。触发条件包括：输入材料包含 8 个及以上文本文件、文本总量约 30,000 字及以上、本地照片 20 张及以上、行程 3 天及以上、路线景点 5 个及以上、用户需要完整静态 HTML 攻略、或用户希望后续可重复修改。

首次创建或修改 `route-structure.json` 或 `facts-workspace.json` 前，读取 [references/data-contracts.md](references/data-contracts.md)。首次创建或修改 RAG 分支专属 JSON 前，读取 [references/rag-data-contracts.md](references/rag-data-contracts.md)。首次创建或修改结构化分支专属 JSON 前，读取 [references/structured-data-contracts.md](references/structured-data-contracts.md)。后续只改正文表达、不触碰 JSON 结构时，不需要重复读取。

### 渲染前检查

准备渲染 HTML 前，必须读取 [references/pre-render-online-research.md](references/pre-render-online-research.md)，独立判断本次攻略是否触发白名单联网查询项。除用户另行明确授权外，只能查询该 reference 明确允许的信息。

### 输出前检查

提交完整攻略或 HTML 产物前，必须读取 [references/manual-quality-check.md](references/manual-quality-check.md)，完成人工质量检查。HTML 文件存在性、互链、CSS、首页导航、生成时间、远程资源和图片路径等机械检查由 `node scripts/verify_output.mjs` 执行。

### HTML 与样式

常规完整 HTML 攻略应通过 `scripts/render_travel_html.mjs` 和 `templates/travel-html/*.ejs` 生成，并用 `scripts/verify_output.mjs` 校验。HTML 页面结构由模板、渲染脚本和校验脚本固化；使用渲染脚本且不改结构/样式时，不需要读取完整设计规范。

手写 HTML、修改 HTML 结构、修改模板或修改样式前，必须读取 [references/reading-first-design-spec.md](references/reading-first-design-spec.md)，并同步检查 `templates/travel-html/*.ejs` 和 [templates/travel-html/reading-first.css](templates/travel-html/reading-first.css)。

## 工作原则

生成完整攻略时，不要默认把所有素材全文、页面规范和 HTML 草稿同时塞进上下文。优先根据入口分支使用 RAG 流程或结构化流程；材料很少、用户只要文字整理或单页草稿时，可以直接整理，但仍要遵守资料边界。

RAG 流程中，默认先按 `retrieval-workspace.json` 的 target 和 `unique_chunk_ids` 读取 chunks，再用 `themes` 辅助定位字段。不要把 chunk 原文、score、`matched_by` 或大段 evidence 写入 `facts-workspace.json`；只写 agent 判断后的可执行事实、冲突和待确认事项。

结构化流程中，默认先按 `source-digest.json.files[]` 的唯一文件顺序读取原文；如果 digest 尚未生成，才按 `reading-queue.json.files[]` 读取。不要按地点或城市逐项重复打开同一素材。文件读完后先把可用事实、冲突和全局提醒沉淀到 `source-digest.json`，再分发到 `facts-workspace.json`；如果没有生成 queue 或 digest，也必须先手工去重 `source_files` 再读原文。

后续修改内容时，RAG 分支优先复用 `retrieval-workspace.json` 的 target、`unique_chunk_ids` 和 `themes` 定位相关 chunks；结构化分支优先复用 `source-digest.json` 判断是否需要回读原文。修改事实时优先写局部 facts patch，并用 `apply_facts_patch.mjs` 合并回 `facts-workspace.json`，再重新渲染；只有 HTML 结构规则变化时才改渲染脚本。命令输出应保持简短，只显示统计、异常和必要样例，避免把大段素材打印到对话里。

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

## 质量检查

完整攻略或 HTML 产物提交前，按 [references/manual-quality-check.md](references/manual-quality-check.md) 完成人工质量检查；不要只依赖 `node scripts/verify_output.mjs`。

## 禁止事项

- 未涉及到用户路线的 `route_places` 地点，不要出现在每日景点详情中。
- 不要自主搜索任何资料，除非用户明确授权或 [references/pre-render-online-research.md](references/pre-render-online-research.md) 明确允许。
- 不要联网补图、使用占位图、使用远程图片链接或把其他景点照片挪作当前景点照片。
- 不要添加输入材料中没有的营业时间、票价、优惠政策、交通时长、天气或习俗。
- 不要声称资料“最新”或“已确认”，除非输入材料中明确写明。
- 不要输出带内联 CSS 或 JavaScript 的复杂页面。
