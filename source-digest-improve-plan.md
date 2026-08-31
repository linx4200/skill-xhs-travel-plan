# Source Digest 落实改进计划

## 背景

本轮 `source_digest` 评估相比 `baseline-001` 有改善，但体感不明显：

- `read_amplification`: `2.5249 -> 2.2008`，仅下降约 `12.8%`。
- `source_ref_count`: `104 -> 86`，减少 `18` 个引用。
- `city_noise_candidate_count`: `17 -> 15`，仅减少 `2` 个候选。
- `source_traceability_ratio`: `0.9497 -> 0.9339`，略有下降。
- `source_digest_file_count`: `50`，但 `source_digest_reviewed_count=0`、`source_digest_fact_count=0`。

结论：当前流程已经生成了 `reading-queue.json` 和 `source-digest.json` 壳，但没有把 source digest 真正作为事实缓存使用。现状更接近“baseline + 读取队列 + 少量 source_files 修剪”，不是完整的 digest 分发流程。

## 目标

把 source digest 从“结构化中间产物”落实成事实生成主链路：

```text
原始素材
  -> agent 按唯一文件阅读
  -> source-digest.json 文件级事实缓存
  -> 脚本机械分发到 facts-workspace.json
  -> HTML 渲染与评估
```

目标不是让脚本自动抽取事实，而是让 agent 抽取事实后，脚本只负责结构化搬运、去重、校验和统计。

## 原则边界

### Agent 负责事实判断

以下工作必须由 agent 完成，不能由脚本正则或关键词匹配替代：

- 阅读原始素材全文或必要片段。
- 判断哪些内容是可用事实。
- 判断事实归属到哪个地点、城市、日期或全局提醒。
- 判断冲突、缺失、不确定性和出行前确认项。
- 把可执行事实写入 `source-digest.json.files[].facts`。
- 写出事实的短证据，供复核使用。

### 脚本只做机械处理

脚本可以做：

- 创建读取队列和 digest 壳。
- 校验 digest 是否完整。
- 按 `target_type`、`target_name`、`field` 把 digest facts 分发到 facts workspace。
- 合并去重。
- 保留 `source_refs`。
- 渲染 HTML。
- 计算评估指标。

脚本不可以做：

- 从原始素材中用正则抽取攻略事实。
- 根据关键词命中生成事实结论。
- 判断哪个冲突说法更可信。
- 自动补充材料中没有的营业时间、票价、开放状态、交通时间、餐厅或图片。

## 数据结构改造

### source-digest.json

把 `source-digest.json.files[].facts[]` 从宽松数组升级为可校验结构。

建议字段：

```json
{
  "id": "030-jdt-note-json-f001",
  "target_type": "place",
  "target_name": "九洞天景区",
  "field": "notes",
  "items": [
    "洞内偏凉、地面湿滑，薄外套和防滑运动鞋是刚需。"
  ],
  "evidence": [
    {
      "quote": "洞内整体比较阴凉，建议带件薄外套，但部分石阶湿滑，不建议穿拖鞋。",
      "note": "短证据，仅用于复核，不进入最终 HTML。"
    }
  ]
}
```

要求：

- `id` 在 digest 内唯一。
- `target_type` 只能是 `place`、`city`、`day`、`global`、`confirmation`。
- `target_name` 必须能解析到 facts workspace 中的目标；`global` 可为空或使用小节名。
- `field` 必须是 facts workspace 已支持字段。
- `items` 必须是非空数组。
- `evidence.quote` 只保留短证据，不进入最终页面。
- 每个已处理文件必须设置 `reviewed: true`。

### facts-workspace.json

支持 item-level source refs。为了兼容旧模板，可以允许列表项同时支持字符串和对象。

建议新结构：

```json
{
  "text": "洞内偏凉、地面湿滑，薄外套和防滑运动鞋是刚需。",
  "source_refs": ["source-digest:030-jdt-note.json#030-jdt-note-json-f001"]
}
```

优先覆盖字段：

- `places.*.highlights`
- `places.*.drawbacks`
- `places.*.tickets`
- `places.*.routes`
- `places.*.play_options`
- `places.*.practical_info`
- `places.*.notes`
- `places.*.conflicts`
- `cities.*.*`
- `trip.days[].notes`
- `trip.days[].confirmations`
- `global_notes`
- `confirm_before_departure`

保留父级 `source_files`，但它只作为粗粒度回溯和兼容字段，不再作为核心追溯指标。

## 需要新增或修改的脚本

### 1. scripts/validate_source_digest.mjs

新增脚本，职责：

- 检查 `source-digest.json` 结构。
- 检查每个 `reviewed: true` 文件是否至少有 facts、conflicts 或 global_notes。
- 检查 fact `id` 唯一。
- 检查 `target_type`、`target_name`、`field` 是否合法。
- 检查 `items` 非空。
- 输出 reviewed completion、fact count、invalid fact count。

在 `source_digest` variant 下，以下情况应失败：

- `source_digest_file_count > 0` 但 `source_digest_reviewed_count === 0`。
- `source_digest_fact_count === 0`。
- 存在 invalid facts。

### 2. scripts/apply_source_digest_to_facts.mjs

新增脚本，职责：

- 输入 `--digest <source-digest.json>`、`--facts <facts-workspace.json>`、`-o <facts-workspace.json>`。
- 只读取 digest 和 facts，不读取原始素材目录。
- 根据 digest facts 的 `target_type / target_name / field` 机械分发。
- 合并数组字段并按 `text` 去重。
- 给分发后的事实项挂 `source_refs`。
- 更新 facts 的 `needs_agent_review`，提示仍需最终人工复核。

禁止事项：

- 不读取 `.json`、`.md`、`.txt` 原始素材。
- 不使用 `resource-index.excerpt` 当事实来源。
- 不根据关键词生成新事实。
- 不自行决定城市 `include=true`；城市是否 include 仍由 agent 写入 digest 或 facts。

### 3. scripts/render_travel_html.mjs

修改 `textOf()` 和 `textList()`，兼容对象列表项：

- 如果 item 是 `{ text, source_refs }`，最终 HTML 只展示 `text`。
- `source_refs` 不进入最终页面。

### 4. scripts/assessment/assess_sources.mjs

新增指标：

- `digest_review_completion`
- `digest_usage_ratio`
- `item_level_source_ref_count`
- `untraced_fact_count`
- `untraced_global_fact_count`
- `actual_original_read_chars`
- `avoided_repeated_chars`

调整口径：

- 旧 `read_amplification` 保留，标注为 legacy parent-source metric。
- 新增 `source_file_read_amplification`，继续衡量父级 source_files 放大。
- 新增 `digest_based_read_amplification`，按 digest fact source refs 衡量分发后的实际重复读取。

### 5. scripts/assessment/assess_quality.mjs

修改来源追溯逻辑：

- 优先识别 item-level `source_refs`。
- 父级 `places.*.source_files` / `cities.*.source_files` 只作为 fallback。
- `global_notes` 和 `confirm_before_departure` 必须纳入追溯检查。
- 对 `source_digest` variant，如果全局提醒和确认清单没有来源，应输出明确失败或高风险 warning。

### 6. scripts/assessment/assess_run.mjs

在 `--variant source_digest` 时新增阶段：

```text
validate_digest
apply_digest_to_facts
render
verify
assess_sources
assess_quality
```

第一版可以要求用户或 agent 先填好 digest，再运行 wrapper。wrapper 不负责驱动 agent 阅读原文。

## 推荐落地阶段

### Phase 1：强校验，防止空壳 digest 通过

改动：

- 新增 `validate_source_digest.mjs`。
- 修改 `assess_run.mjs`：`source_digest` variant 下 digest 为空时失败。
- 修改 `assess_sources.mjs`：输出 `digest_review_completion`。

验收：

- 当前这次运行应被识别为“不完整 source_digest”，因为 `reviewed_count=0`、`fact_count=0`。
- baseline 不受影响。

### Phase 2：实现 digest 到 facts 的机械分发

改动：

- 新增 `apply_source_digest_to_facts.mjs`。
- 修改 renderer 兼容 `{ text, source_refs }`。
- 手工填 3-5 个代表性源文件的 digest，用于小样验证。

验收：

- 脚本不读取原始素材目录。
- 分发后的 facts 中，相关事实项带 `source_refs`。
- HTML 渲染内容不显示 source refs。
- `verify_output.mjs` 仍通过。

### Phase 3：扩大 digest 覆盖到全量路线

改动：

- agent 按 `reading-queue.json.files[]` 唯一文件顺序填满 source digest。
- 对低价值城市候选只在有城市级增量事实时写入 digest。
- 全局提醒和出发前确认必须从 digest facts 分发，不再手写无来源条目。

验收：

- `digest_review_completion >= 0.95`。
- `digest_usage_ratio >= 0.8`。
- `source_digest_fact_count > 0`，且覆盖所有 route places。
- `untraced_global_fact_count = 0` 或只有明确说明的低风险项。

### Phase 4：评估指标和 baseline 对齐

改动：

- 同一 case 重新跑 baseline 与 source_digest。
- 生成自动 comparison report。
- 人工复核使用相同抽样范围，例如都抽查九洞天、威宁草海/百草坪、大山包。

验收：

- `read_amplification` 或新 digest 口径指标至少比 baseline 降低 `30%`。
- route coverage、broken links、missing photos、remote resources、forbidden sections 不退化。
- city noise candidates 不高于 baseline。
- source traceability 不低于 baseline；最好高于 baseline。

## 验收指标

source digest 优化只有满足以下条件，才算真正落实：

- `source_digest_reviewed_count > 0`。
- `source_digest_fact_count > 0`。
- `digest_review_completion >= 0.95`。
- `digest_usage_ratio >= 0.8`。
- `read_amplification` 比 baseline 下降至少 `30%`，或新 digest 口径显示重复原文读取显著减少。
- `source_traceability_ratio >= baseline`。
- `global_notes` 和 `confirm_before_departure` 不再成为主要未追溯来源。
- HTML 机械校验通过。
- 人工抽查未发现关键事实召回、冲突召回、归因错误明显退化。

## 风险与注意事项

- 首次生成仍需要 agent 阅读大量原始素材；digest 的最大收益在后续修改、复核和多页面分发。
- 如果继续用父级 `source_files` 作为主要成本指标，即使实际读取减少，指标也可能不敏感。
- 城市页很容易制造重复引用。城市 `include=true` 必须由 agent 判断，不能由城市名命中自动决定。
- source refs 不应进入最终 HTML；它们是内部追溯信息。
- 短证据 quote 只用于复核，不应大量复制原文。

## 下一步建议

先做 Phase 1 和 Phase 2。它们能最快暴露“空壳 digest”问题，并验证 digest 分发链路是否可行。Phase 3 再投入 agent 时间填全量 digest，否则会继续出现指标小幅改善但体感不明显的问题。
