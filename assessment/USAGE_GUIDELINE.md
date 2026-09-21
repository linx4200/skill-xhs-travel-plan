# Assessment 使用指南

本文档用于指导 agent 在 RAG 调参、质量回归和基准升级时使用 `assessment/` 评估体系。评估体系只服务于离线质量判断，不进入攻略生成主流程。

## 1. 使用入口

评估体系围绕 `assessment/rag-tuning/` 和 `scripts/assessment/rag-tuning/` 工作：

- `assessment/rag-tuning/baselines/`：保存已冻结的 checklist 基准。
- `assessment/rag-tuning/runs/`：保存每次评估运行的输入快照和输出报告。
- `scripts/assessment/rag-tuning/`：保存准备 run、执行评估、建立基准和升级基准的命令。

常用命令：

```bash
npm run assessment:baseline
npm run assessment:prepare
npm run assessment:evaluate
npm run assessment:upgrade
```

## 2. 场景选择

| 场景 | 使用方式 | 必需输入 | 主要输出 | 结论使用方式 |
|---|---|---|---|---|
| 日常参数快评 | 准备 B1 run 后执行评估 | `facts-workspace.json`、`retrieval-workspace.json`、`retrieval-log.json` | `report.md`、`report.json`、`deltas.json` | 用于判断参数改动是否造成检索层或 facts 层退化 |
| 里程碑全评 | 准备 B2 run 并传入 HTML 目录后执行评估 | 快评输入 + HTML 输出目录 | 完整三层评估报告 | 用于候选参数收敛、发布前检查和基准升级前检查 |
| 代码回归检查 | 复用对应基准执行快评或全评 | 与被检查能力位匹配的 run 输入 | 新 run 报告 | 用于确认 RAG 代码改动没有破坏满意基准 |
| 人工裁定 | 编辑 run 目录中的 `adjudications.json` 后重跑评估 | `adjudications.json` | 更新后的报告 | 用于确认低置信覆盖、语义评分和误判项 |
| Rerank A/B 全评 | 执行 rerank 开关对照并汇总两侧报告 | `rag-index.json`、两侧 `facts-workspace.json`、可选两侧 HTML 目录 | `comparison.md`、`comparison.json`、两侧完整 run 报告 | 用于判断 rerank 对检索、facts 和呈现指标的净影响 |
| 基准升级 | 从 `PASS` run 中接受有效新增项 | `report.json`、`deltas.json`、原 checklist | 新版本 checklist、CHANGELOG 记录 | 用于把稳定更好的信息点追加进基准 |
| 建立新基准 | 从满意产物生成 checklist | `facts-workspace.json`、证据来源 | 新 checklist | 用于新增能力位或新增固定评估样本 |

## 3. 基准选择

| 基准 | checklist | 能力位 | 适用场景 |
|---|---|---|---|
| `B1` | `assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json` | 检索层 + facts 层 | 日常快评、小样本参数试验、基础回归检查 |
| `B2` | `assessment/rag-tuning/baselines/B2-20260907.checklist.json` | 检索层 + facts 层 + 呈现层 | 全量验证、候选参数收敛、HTML 呈现检查、基准升级 |

选择规则：

- 只检查检索和资料整理效果时，优先用 `B1`。
- 需要检查 HTML 结构、链接、图片、本地资源、跨页归位和最终呈现覆盖时，使用 `B2`。
- 被评估产物必须与基准的输入样本一致；不要跨样本比较 `B1` 和 `B2`。
- 缺少 HTML 时，呈现层指标记为 `N/A`，不得把 HTML 缺失当作 facts 层内容缺失。
- 缺少 `retrieval-log.json` 时，评估只能给出降级归因；调参结论需要保守使用。

## 4. Run 目录规范

每次评估都落入一个独立 run 目录：

```text
assessment/rag-tuning/runs/<run_id>/
├── run.json
├── params.json
├── report.md
├── report.json
├── deltas.json
└── adjudications.json
```

推荐命名：

```text
<YYYYMMDD-HHmm>-<baseline_id>-<tag>
```

`tag` 使用短横线命名，表达本次参数变化或检查目的，例如：

- `rerank-threshold-092`
- `quota-place-60`
- `theme-risk-expanded`
- `regression-after-rag-refactor`

## 5. 快评流程

快评用于日常参数调整。执行前先确保新产出已经生成：

- `facts-workspace.json`
- `retrieval-workspace.json`
- `retrieval-log.json`

准备 run：

```bash
npm run assessment:prepare -- \
  --baseline-id B1 \
  --tag <tag> \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --retrieval-workspace output/rag-e2e-smoke/retrieval-workspace.json \
  --retrieval-log output/rag-e2e-smoke/retrieval-log.json \
  --params-from-config
```

执行评估：

```bash
npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json \
  --run assessment/rag-tuning/runs/<run_id>
```

使用结论：

- `PASS`：当前参数达到 B1 最低满意线，可继续扩大评估范围。
- `PASS_WITH_NOTES`：Gate 通过，但存在软性退化或低置信项；先处理 notes，再决定是否进入全评。
- `FAIL`：存在 critical 丢失、归位错误、越界事实或其他硬门槛失败；参数不进入下一阶段。

## 6. 全评流程

全评用于候选参数收敛、重要代码回归和基准升级前检查。执行前先确保新产出包含：

- `facts-workspace.json`
- `retrieval-workspace.json`
- `retrieval-log.json`
- HTML 输出目录

准备 run：

```bash
npm run assessment:prepare -- \
  --baseline-id B2 \
  --tag <tag> \
  --facts outputs/2026-guoqing-self-drive-plan-20260907/facts-workspace.json \
  --retrieval-workspace outputs/2026-guoqing-self-drive-plan-20260907/retrieval-workspace.json \
  --retrieval-log outputs/2026-guoqing-self-drive-plan-20260907/retrieval-log.json \
  --html-dir outputs/2026-guoqing-self-drive-plan-20260907 \
  --params-from-config
```

执行评估：

```bash
npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --run assessment/rag-tuning/runs/<run_id>
```

使用结论：

- `PASS`：当前产物达到完整基准要求，可作为候选参数或基准升级来源。
- `PASS_WITH_NOTES`：硬门槛通过，但需要处理非关键丢失、低置信裁定或语义评分不足。
- `FAIL`：不要升级基准；先根据 `deltas.json` 和 `report.md` 定位问题层级。

## 6.1 Rerank A/B 全评流程

Rerank A/B 全评用于比较同一读取配置下 `rerank=false` 与 `rerank=true` 的完整评估结果。严格全评使用两侧各自的 facts 产物和 HTML 产物：

```bash
npm run assessment:rerank-ab -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --rag-index outputs/<批次>/rag-index.json \
  --no-rerank-facts outputs/<no-rerank批次>/facts-workspace.json \
  --rerank-facts outputs/<rerank批次>/facts-workspace.json \
  --no-rerank-html-dir outputs/<no-rerank批次> \
  --rerank-html-dir outputs/<rerank批次> \
  --out-dir assessment/rag-tuning/runs/<run_id>-rerank-ab
```

输出：

- `comparison.md`：面向人工阅读的 A/B 指标表。
- `comparison.json`：机器可读的两侧 summary、差值和 verdict。
- `no-rerank/report.json` 与 `rerank/report.json`：两侧完整 assessment 结果。

只传一份 `--facts` 时，脚本生成两套 retrieval workspace 并共用同一份 facts。该模式只用于快速观察 rerank 的检索层影响；facts 层指标不作为 rerank 开关的独立效果。

## 7. 参数快照

`assessment:prepare` 会在 run 目录生成 `params.json`。需要记录 CLI 覆盖参数时，使用 `--set`：

```bash
npm run assessment:prepare -- \
  --baseline-id B1 \
  --tag rerank-threshold-092 \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --retrieval-workspace output/rag-e2e-smoke/retrieval-workspace.json \
  --retrieval-log output/rag-e2e-smoke/retrieval-log.json \
  --set rerank=true \
  --set rerank_threshold=0.92 \
  --set place_top_k=5
```

需要从文件记录覆盖参数时，使用 `--cli-overrides <json>`。

## 8. 报告阅读方法

优先阅读顺序：

1. `report.md` 的 `conclusion`。
2. Gate 表，确认是否存在硬门槛失败。
3. 核心指标，重点看 critical 保有率、chunk 召回率、主题空池、关键丢失数和归位错误数。
4. `丢失明细`，确认丢失发生在 `retrieval`、`facts` 还是 `render`。
5. `有效新增明细`，确认是否存在值得升级进基准的信息点。
6. `调参建议`，决定下一轮参数方向。

机器处理优先读取：

- `report.json`：结论、Gate、指标和汇总建议。
- `deltas.json`：逐条丢失、新增、归位错误、越界事实和归因。
- `adjudications.json`：低置信覆盖和语义评分裁定。

## 9. 人工裁定流程

评估脚本会在 run 目录生成 `adjudications.json`。需要人工裁定时，按以下方式处理：

1. 打开 `adjudications.json`。
2. 查看 `coverage_review_items` 中的低置信项。
3. 在 `coverage_overrides` 中填写覆盖结论。
4. 在 `semantic_scores` 中填写必要的 1-5 分语义评分。
5. 重新执行 `assessment:evaluate`。

覆盖裁定示例：

```json
{
  "item_id": "B2-place-0001",
  "facts_covered": true,
  "render_covered": null,
  "reason": "facts 中保留了该执行提醒。"
}
```

裁定规则：

- `facts_covered` 只判断 `facts-workspace.json` 是否覆盖该信息点。
- `render_covered` 只在存在 HTML 时填写；无 HTML 时使用 `null`。
- `reason` 直接说明判定依据，不写调参过程。
- 裁定后必须重跑评估，让报告和 JSON 输出保持一致。

## 10. 基准升级流程

基准只从 `PASS` run 中升级。升级前必须确认：

- Gate 全部通过。
- `deltas.json.new_items` 中的候选确实是有效新增。
- 新增项有证据 chunk 支撑。
- run 中没有未解决的越界事实、重复项或冲突项。

执行升级：

```bash
npm run assessment:upgrade -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --run assessment/rag-tuning/runs/<run_id> \
  --accept-new-items <new_item_id_1>,<new_item_id_2> \
  --out assessment/rag-tuning/baselines/B2-20260907.v<N>.checklist.json
```

升级输出：

- 新版本 checklist 文件。
- `assessment/rag-tuning/CHANGELOG.md` 中的升级记录。

升级规则：

- 不覆盖原 checklist 文件。
- 不从 `PASS_WITH_NOTES` 或 `FAIL` run 升级。
- 只追加人工接受的有效新增项。
- checklist 版本号递增。
- 历史评估报告继续引用原基准版本。

## 11. 建立新基准

新增稳定样本或能力位时，先从满意产物生成 checklist：

```bash
npm run assessment:baseline -- \
  --baseline-id <baseline_id> \
  --baseline-name <baseline_name> \
  --capability <retrieval_and_facts|full> \
  --source-dir <source_dir> \
  --facts <source_dir>/facts-workspace.json \
  --retrieval-workspace <source_dir>/retrieval-workspace.json \
  --rag-index <source_dir>/rag-index.json \
  --out assessment/rag-tuning/baselines/<baseline_name>.checklist.json
```

生成后执行人工审核：

- 信息块粒度保持为一条可独立决策的信息。
- `criticality` 必须合理区分 `critical`、`core-quality`、`mid` 和 `low`。
- `source_chunk_ids` 和 `evidence_ref` 必须能追溯到证据。
- 重复表达只保留一条 checklist item。
- 不把纯标题、语气词、无证据泛泛判断写入 checklist。

## 12. 常见处理规则

| 情况 | 处理方式 |
|---|---|
| `retrieval-log.json` 缺失 | 可以运行评估，但归因按降级模式使用；正式调参结论需要补齐日志后复评 |
| HTML 缺失 | 呈现层为 `N/A`；只使用检索层和 facts 层结论 |
| critical 条目丢失 | 结论为 `FAIL`；先定位 `retrieval`、`facts` 或 `render` 层 |
| facts 覆盖但 HTML 未覆盖 | 判定为呈现层问题，优先检查模板、页面归位和渲染逻辑 |
| retrieval 覆盖但 facts 未覆盖 | 判定为资料整理层吸收问题，优先检查 reading queue、facts 提取和字段映射 |
| retrieval 未覆盖 | 判定为检索层问题，优先检查主题词、打分、top-k、配额和 rerank |
| 发现有效新增 | 先保留在 `deltas.json.new_items`，只在 `PASS` run 中人工接受后升级基准 |

## 13. 交付检查清单

每次评估交付前确认：

- run 目录中存在 `run.json`、`params.json`、`report.md`、`report.json`、`deltas.json` 和 `adjudications.json`。
- `report.md` 中的结论与 `report.json` 一致。
- 低置信项已经在 `adjudications.json` 中裁定，或在报告 notes 中明确保留。
- `FAIL` run 附带明确的问题层级和下一步调参方向。
- `PASS` run 的有效新增候选已经明确接受或暂不升级。
- 基准升级只生成新 checklist 文件，并写入 `assessment/rag-tuning/CHANGELOG.md`。
