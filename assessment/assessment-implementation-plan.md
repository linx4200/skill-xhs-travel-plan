# Assess 评估实现方案

## 目标

建立一套可重复运行的评估流程，用来比较以下流程版本的成本和质量变化：

- `baseline`：当前结构化流程。
- `source_digest`：新增 reading queue/source digest 后的去重读取流程。
- `rag`：后续加入向量检索后的流程。

评估不只看 token 和耗时，还要保留事实质量检查。成本侧尽量自动化；质量侧先自动生成候选风险和结构性指标，核心事实质量仍由人工抽查。

指标定义见：

- `assessment/assessment-cost-metrics.json`
- `assessment/assessment-quality-metrics.json`

## 输出产物

建议每次评估运行输出到单独目录：

```text
output/<case-name>/assess/<run-id>/
  run-config.json
  cost-metrics.json
  quality-metrics.json
  read-log.json
  stage-timings.json
  quality-review.md
```

其中：

- `run-config.json` 记录 case、variant、输入材料路径、路线文件、输出目录、模型和运行时间。
- `cost-metrics.json` 保存自动或半自动计算出的成本指标。
- `quality-metrics.json` 保存自动或半自动计算出的质量指标。
- `read-log.json` 记录 agent 或脚本实际读取的文件/chunk。
- `stage-timings.json` 记录 scan、workspace、digest、rag、render、verify 等阶段耗时。
- `quality-review.md` 给人工复核使用，列出关键事实候选、冲突候选、疑似城市噪声和最终人工评分。

## 分步实现

### 阶段 1：指标定义落地

已完成：

1. 新增 `assessment/assessment-cost-metrics.json`。
2. 新增 `assessment/assessment-quality-metrics.json`。

这两份文件只定义指标，不计算指标。后续 assess 脚本应优先读取这些 JSON，避免指标含义散落在脚本里。

### 阶段 2：实现 source 结构指标脚本

新增脚本：

```text
script/assessment/assess_sources.mjs
```

输入：

```text
node script/assessment/assess_sources.mjs \
  --index <resource-index.json> \
  --facts <facts-workspace.json> \
  -o <cost-metrics.json>
```

第一版自动计算：

- `raw_material_file_count`
- `raw_material_chars`
- `photo_count`
- `source_ref_count`
- `unique_source_file_count`
- `unique_source_chars`
- `repeated_source_chars`
- `read_amplification`

如果存在 `reading-queue.json`，额外计算：

- `reading_queue_file_count`
- `reading_queue_chars`

如果存在 `source-digest.json`，额外计算：

- `source_digest_file_count`
- `source_digest_reviewed_count`
- `source_digest_fact_count`

这一阶段不需要 agent instrumentation，也不依赖 RAG。它可以先复现当前样例中的 53 文件、104 引用、50 唯一文件、17.9 万字符读取放大等结果。

执行记录（2026-08-29）：

- 已实现 `script/assessment/assess_sources.mjs`。计划原先写作 `scripts/assess`，实际按本仓库本轮约定统一放在 `script/assessment`。
- 脚本读取 `resource-index.json` 和 `facts-workspace.json`，输出 `schema_version`、生成时间、输入路径、`metrics`、来源引用明细、未解析来源和 warnings。
- 已兼容可选 `--reading-queue <reading-queue.json>` 与 `--source-digest <source-digest.json>`；未提供且相邻目录不存在时，对应指标输出 `null`，用于区分“未接入”和“数量为 0”。
- 已用当前样例运行：

```text
node script/assessment/assess_sources.mjs \
  --index output/2026-guoqing-self-drive-plan/resource-index.json \
  --facts output/2026-guoqing-self-drive-plan/facts-workspace.json \
  -o output/2026-guoqing-self-drive-plan/cost-metrics.json
```

- 样例结果：`raw_material_file_count=53`、`raw_material_chars=73159`、`photo_count=12`、`source_ref_count=104`、`unique_source_file_count=50`、`unique_source_chars=71070`、`repeated_source_chars=179444`、`read_amplification=2.5249`。未出现未解析 source file。

### 阶段 3：实现 HTML 和结构质量检查脚本

新增脚本：

```text
script/assessment/assess_quality.mjs
```

输入：

```text
node script/assessment/assess_quality.mjs \
  --route <route-structure.json> \
  --facts <facts-workspace.json> \
  --output-dir <html-output-dir> \
  -o <quality-metrics.json>
```

第一版自动或半自动计算：

- `route_place_coverage`
- `empty_required_place_count`
- `wrong_attribution_candidate_count`
- `city_noise_candidate_count`
- `duplicate_content_count`
- `final_verify_pass`
- `broken_link_count`
- `missing_photo_count`
- `remote_resource_count`
- `forbidden_section_count`
- `source_traceability_ratio`

注意：这一步只输出结构性指标和候选风险，不宣称产物事实正确。脚本生成的 `wrong_attribution_candidate_count`、`city_noise_candidate_count` 和 `duplicate_content_count` 必须由人工抽查。

执行记录（2026-08-29）：

- 已实现 `script/assessment/assess_quality.mjs`。
- 脚本读取 `route-structure.json`、`facts-workspace.json` 和 HTML 输出目录，生成 `quality-metrics.json`。输出包含 `metrics`、候选风险明细、机械校验错误明细和 warnings。
- `final_verify_pass`、`broken_link_count`、`missing_photo_count`、`remote_resource_count`、`forbidden_section_count` 复用现有 `verify_output.mjs` 的主要规则口径。
- `wrong_attribution_candidate_count` 当前按“其他 route_place 出现在非当天 day page”及“route_place 出现在疑似无关 city page”生成候选。
- `city_noise_candidate_count` 当前按城市页低价值短语、城市条目提到 route_place、城市条目与景点事实精确重复生成候选。
- `duplicate_content_count` 当前只统计最终 HTML 中 `p`、`li`、`figcaption` 的精确重复，避免把 facts 与 HTML 的正常渲染关系误算为重复。
- `source_traceability_ratio` 当前以 `places.*.source_files` 和 `cities.*.source_files` 作为父级追溯依据；`global_notes` 和 `confirm_before_departure` 暂无字段级 source，现阶段会被记为未追溯。
- 已用当前样例运行：

```text
node script/assessment/assess_quality.mjs \
  --route output/2026-guoqing-self-drive-plan/route-structure.json \
  --facts output/2026-guoqing-self-drive-plan/facts-workspace.json \
  --output-dir output/2026-guoqing-self-drive-plan \
  -o output/2026-guoqing-self-drive-plan/quality-metrics.json
```

- 样例结果：`route_place_coverage=1`、`empty_required_place_count=0`、`wrong_attribution_candidate_count=0`、`city_noise_candidate_count=17`、`duplicate_content_count=0`、`final_verify_pass=true`、`broken_link_count=0`、`missing_photo_count=0`、`remote_resource_count=0`、`forbidden_section_count=0`、`source_traceability_ratio=0.9497`。
- 已额外运行 `npm run verify -- output/2026-guoqing-self-drive-plan`，现有机械校验通过。

### 阶段 4：实现 run wrapper

新增脚本：

```text
script/assessment/assess_run.mjs
```

目标是把现有流程包起来，统一记录耗时和产物路径。

输入示例：

```text
node script/assessment/assess_run.mjs \
  --case 2026-guoqing-self-drive-plan \
  --variant baseline \
  --resource-dir <input-resource-dir> \
  --route <route-structure.json> \
  --work-dir output/2026-guoqing-self-drive-plan \
  --html-output-dir output/2026-guoqing-self-drive-plan/html
```

职责：

1. 记录 `run-config.json`。
2. 运行或接收已有 `resource-index.json`。
3. 运行或接收已有 `facts-workspace.json`。
4. 调用 `assess_sources.mjs` 生成成本指标。
5. 调用 `render_travel_html.mjs` 和 `verify_output.mjs`，记录耗时和退出码。
6. 调用 `assess_quality.mjs` 生成质量指标。
7. 汇总 `stage-timings.json`。

第一版可以不自动驱动 agent 填写 facts，只评估已有产物。这样实现成本低，也便于复盘历史输出。

执行记录（2026-08-29）：

- 已实现 `script/assessment/assess_run.mjs`。
- 必填参数为 `--case`、`--variant`、`--route`、`--work-dir`；可选参数包括 `--resource-dir`、`--html-output-dir`、`--resource-index`、`--facts`、`--run-id`、`--model`、`--reading-queue`、`--source-digest`、`--skill-root`。
- 运行目录默认写到 `<work-dir>/assess/<run-id>/`；如果不传 `--html-output-dir`，HTML 默认写到 run 目录下的 `html/`。
- wrapper 会优先使用显式传入的 `--resource-index` / `--facts`，其次使用 `<work-dir>/resource-index.json` 和 `<work-dir>/facts-workspace.json`。缺失时才调用 `scan_resources.mjs` 或 `create_fact_workspace.mjs` 生成对应文件。
- 第一版仍不自动驱动 agent 填写 facts。若 facts 缺失，脚本只能生成空 facts shell，后续渲染和质量指标会反映内容未填充，而不是替代人工/agent 事实抽取。
- 已串联执行：`assess_sources.mjs`、`render_travel_html.mjs`、`verify_output.mjs`、`assess_quality.mjs`。
- `stage-timings.json` 会记录每个阶段的开始时间、结束时间、耗时、退出码、状态和输出摘要；复用已有索引或 facts 时，对应 `scan` / `workspace` 阶段记为 `skipped`。
- 已用当前样例运行：

```text
node script/assessment/assess_run.mjs \
  --case 2026-guoqing-self-drive-plan \
  --variant baseline \
  --route output/2026-guoqing-self-drive-plan/route-structure.json \
  --work-dir output/2026-guoqing-self-drive-plan \
  --html-output-dir output/2026-guoqing-self-drive-plan/assess/baseline-smoke/html \
  --run-id baseline-smoke
```

- 样例 run 目录：`output/2026-guoqing-self-drive-plan/assess/baseline-smoke/`。
- 样例结果：`run-config.json` 状态为 `passed`；`stage-timings.json` 中 `scan` 和 `workspace` 为 `skipped`，`assess_sources`、`render`、`verify`、`assess_quality` 均为 `passed`；成本和质量指标与阶段 2、阶段 3 单独运行结果一致。
- 已运行 `node --check script/assessment/assess_run.mjs`，语法检查通过。

### 阶段 5：增加读取日志

为了计算 `actual_loaded_chars` 和 `actual_loaded_tokens_estimated`，需要建立读取日志：

```text
read-log.json
```

建议结构：

```json
{
  "schema_version": 1,
  "events": [
    {
      "path": "019-caohai-comments.md",
      "mode": "full_file",
      "chars": 14258,
      "reason": "source_digest_review",
      "targets": [
        { "type": "place", "name": "威宁百草坪" },
        { "type": "place", "name": "威宁草海" }
      ]
    }
  ]
}
```

source digest 流程中，读取 queue 时可以让 agent 或辅助脚本记录每次完整文件读取。RAG 流程中，检索器记录 chunk 读取和 fallback 回读。

自动计算：

- `actual_loaded_chars`
- `actual_loaded_tokens_estimated`
- RAG 的 `retrieved_chunk_count`
- RAG 的 `retrieved_chunk_chars`
- RAG 的 `fallback_full_file_reads`
- RAG 的 `fallback_full_file_chars`

执行记录（2026-08-31）：

- 已新增 `scripts/create_read_log.mjs` 和 `npm run create-read-log`。
- 脚本支持从 `--digest <source-digest.json>` 生成读取日志；默认只记录 `reviewed=true` 的文件，并把事件标记为 `inferred=true` / `inferred_from=source_digest.reviewed_files`。
- 也支持从 `--queue <reading-queue.json>` 生成计划读取日志，用于还没有 digest 时估算完整队列阅读成本。
- 已修改 `script/assessment/assess_sources.mjs`，支持 `--read-log <read-log.json>`，并输出 `read_log_event_count`、`full_file_read_count`、`unique_loaded_file_count`、`actual_loaded_chars`、`actual_loaded_tokens_estimated`。
- 已修改 `script/assessment/assess_run.mjs`，支持 `--read-log`；`source_digest` variant 如果没有显式传入 read log，会从已 review 的 source digest 自动生成一份推断日志并纳入成本评估。

### 阶段 5.1：收紧 reading queue 路线范围过滤

执行记录（2026-08-31）：

- 已修改 `scripts/create_reading_queue.mjs`，对城市 `source_files` 增加路线范围过滤。
- 过滤只作用于城市消费者：如果某个城市来源文件的路径/标题明确指向路线外地点，且没有命中本次 `route_places`，则跳过该城市 source ref。
- 队列输出新增 `stats.input_source_refs`、`stats.filtered_source_refs`、`stats.filtered_unique_files` 和 `filtered_refs[]`，保留被过滤明细，方便人工恢复边界案例。
- 景点消费者不受该过滤影响；命中本次路线景点的文件仍会进入队列。

### 阶段 6：增加 RAG 检索日志

RAG 上线时，每次检索都必须写日志，否则无法判断省 token 是否来自真实少读。

建议结构：

```json
{
  "schema_version": 1,
  "queries": [
    {
      "query": "九洞天 门票 预约 游船 排队",
      "target": { "type": "place", "name": "九洞天景区" },
      "retrieved_chunks": [
        {
          "chunk_id": "014-jiudongtian-note.json#0003",
          "path": "014-jiudongtian-note.json",
          "chars": 620,
          "score": 0.82
        }
      ],
      "fallback_full_file_reads": []
    }
  ]
}
```

RAG 评估重点：

- 检索 chunk 字符数是否显著低于 source digest 的唯一文件字符数。
- fallback 回读是否过多。
- 高风险字段是否触发额外复核。
- 质量指标是否没有明显下降。

### 阶段 7：生成人工质量复核模板

新增脚本或在 `assess_quality.mjs` 中生成：

```text
quality-review.md
```

模板包含：

```text
## 人工复核

- critical_fact_recall_eval_scope:
- critical_fact_recall:
- conflict_recall_eval_scope:
- conflict_recall:
- hallucination_eval_scope:
- hallucination_count:
- sampled_scope:
- sampled_findings:
- wrong_attribution_count:
- city_noise_count:
- manual_quality_pass:
- overall_usefulness_score:

## 关键事实候选

...

## 冲突候选

...

## 疑似归因错误

...

## 疑似城市噪声

...
```

人工只需要围绕脚本列出的候选风险抽查，同时补充脚本漏掉的关键问题。

人工复核口径：

- `critical_fact_recall`、`conflict_recall`、`hallucination_count` 如果严格评估，需要通读全部原始材料并逐条对齐最终攻略，人工成本高；baseline 第一版不强制做全文精确评估。
- 对上述三项新增对应的 `*_eval_scope` 字段，统一使用 `not_evaluated`、`sampled`、`full` 标注评估深度。
- `not_evaluated` 表示本轮未评估，不参与质量结论的精确比较。
- `sampled` 表示只抽查部分景点、页面和 source files；必须在 `sampled_scope` 里写清楚抽样范围，并在 `sampled_findings` 中记录发现。后续 candidate 版本需要使用相同抽样范围，才可以做相对比较。
- `full` 才表示已经建立完整关键事实清单、冲突清单或幻觉核对清单，可以填写精确比例或精确数量。
- 未做 `full` 时，`critical_fact_recall` 和 `conflict_recall` 不应填写精确比例，可填 `not_evaluated`、`sampled_pass` 或 `sampled_risk`。
- 未做 `full` 时，`hallucination_count` 不应填写精确数量，可填 `not_evaluated`、`sampled_0_found` 或 `sampled_risk_found`。
- `wrong_attribution_count` 和 `city_noise_count` 可以优先围绕脚本候选和易混地点人工判断，不要求通读全部原始材料。
- `manual_quality_pass` 是综合判断字段；即使前三项只做抽样，也可以给出 `true`/`false`，但必须保留抽样范围和主要风险说明。

已同步到当前 baseline 文件：

- `output/2026-guoqing-self-drive-plan/assess/baseline-001/quality-review.md`

### 阶段 8：建立对比报告

新增脚本：

```text
script/assessment/assess_compare.mjs
```

输入：

```text
node script/assessment/assess_compare.mjs \
  --baseline <baseline-run-dir> \
  --candidate <candidate-run-dir> \
  -o <comparison.md>
```

输出：

- 成本指标差异。
- 读取放大变化。
- token 估算变化。
- RAG chunk/fallback 变化。
- 质量指标变化。
- 是否达成成功标准。

source digest 成功标准建议：

- `actual_loaded_chars` 相比 baseline 降低 40% 以上。
- 同一原文文件完整读取次数不超过 1。
- `critical_fact_recall` 不下降；只有 baseline 和 candidate 都是 `full` 时才比较精确比例，都是 `sampled` 时必须使用相同 `sampled_scope` 做相对判断。
- `hallucination_count` 不增加；只有 `full` 时才比较精确数量，`sampled` 时只比较相同抽样范围内是否发现新增风险。
- `wrong_attribution_count` 不增加。
- `final_verify_pass = true`。

RAG 成功标准建议：

- `actual_loaded_tokens_estimated` 比 source digest 再降 30% 以上。
- `fallback_full_file_reads` 控制在唯一 source 文件数的 20% 以内。
- `critical_fact_recall` 至少达到 source digest 版本的 95%；该数值标准只适用于双方都是 `full` 的评估结果，抽样评估只做同范围风险比较。
- `hallucination_count = 0`；该数值标准只适用于 `full`，抽样评估记录为 `sampled_0_found` 或 `sampled_risk_found`。
- `wrong_attribution_count = 0`。
- `final_verify_pass = true`。

## 推荐实施顺序

1. 先实现 `assess_sources.mjs`，因为它最稳定、最能量化当前重复读取问题。
2. 再实现 `assess_quality.mjs` 的结构性检查，不碰复杂语义判断。
3. 再实现 `assess_run.mjs`，统一记录 run 目录和阶段耗时。
4. 做 source digest 优化，并接入 `reading-queue.json` 指标。
5. 增加 `read-log.json`，开始记录实际读取量。
6. 做 RAG 时强制输出 retrieval log 和 fallback log。
7. 最后实现 `assess_compare.mjs`，生成 baseline/source_digest/rag 对比报告。

## 注意事项

- 自动化指标只能证明成本和结构变化，不能证明攻略事实正确。
- RAG 评估必须同时看质量，不允许只以 token 降低作为成功标准。
- 所有指标都应保留 `null` 状态，表示当前流程尚未记录或无法自动计算，避免用 0 混淆未知值。
- 人工复核字段应和自动指标放在同一个 run 目录中，方便复盘。
- `critical_fact_recall`、`conflict_recall`、`hallucination_count` 不应默认要求全文人工核对；每次必须记录 `not_evaluated`、`sampled` 或 `full`，避免把抽样结论伪装成完整结论。
- 如果 baseline 使用抽样质量评估，后续 source digest/RAG candidate 必须沿用同一 `sampled_scope`，否则不能直接比较前三项人工指标。
- 每个 case 至少跑 baseline 和 candidate 两版；重要优化建议同一 case 跑 3 次取均值。
