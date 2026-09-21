# RAG 调参评估命令

本目录提供独立于攻略生成主流程的 RAG 调参评估工具。评估流程固定为准备 run、执行评估、人工裁定、按需升级基准。

## 快评

快评用于日常参数调整，适合只检查检索层和 facts 层。

```bash
npm run assessment:prepare -- \
  --baseline-id B1 \
  --tag rag-e2e-smoke \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --retrieval-workspace output/rag-e2e-smoke/retrieval-workspace.json \
  --retrieval-log output/rag-e2e-smoke/retrieval-log.json \
  --params-from-config \
  --run-dir assessment/rag-tuning/runs/B1-rag-e2e-smoke-example

npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json \
  --run assessment/rag-tuning/runs/B1-rag-e2e-smoke-example
```

HTML 未提供时，报告中的 G1 和呈现层指标为 `N/A`，检索层和 facts 层照常评估。

## 全评

全评用于里程碑验证和基准升级前检查，必须传入 HTML 输出目录。

```bash
npm run assessment:prepare -- \
  --baseline-id B2 \
  --tag 20260907 \
  --facts outputs/2026-guoqing-self-drive-plan-20260907/facts-workspace.json \
  --retrieval-workspace outputs/2026-guoqing-self-drive-plan-20260907/retrieval-workspace.json \
  --params-from-config \
  --run-dir assessment/rag-tuning/runs/B2-20260907-example \
  --html-dir outputs/2026-guoqing-self-drive-plan-20260907

npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --run assessment/rag-tuning/runs/B2-20260907-example
```

完整评估输出：

- `report.md`：面向人工阅读的结论、Gate、指标、丢失项和新增候选。
- `report.json`：机器可读结论和指标。
- `deltas.json`：丢失项、新增候选、归位错误、越界事实和归因。
- `adjudications.json`：低置信覆盖和语义评分的人工裁定骨架。

## Rerank A/B 全评

Rerank A/B 全评用于比较同一组读取配额下，关闭 rerank 与开启 rerank 对检索层、facts 层和可选 HTML 呈现层的影响。

严格全评模式传入两侧各自的 `facts-workspace.json`：

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

快照对照模式可以只传一份 `--facts`。此时脚本仍会生成两套 retrieval workspace、retrieval log 和评估报告，但 facts 层共用同一份输入，只能作为一致性参考：

```bash
npm run assessment:rerank-ab -- \
  --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json \
  --rag-index output/rag-expanded-baseline/rag-index.json \
  --facts output/rag-expanded-baseline/facts-workspace.json
```

可选参数与 `rag:workspace` 保持一致：

- 读取配额：`--read-scope`、`--place-top-k`、`--city-top-k`、`--max-place-chunks`、`--max-city-chunks`
- embedding：`--embedding-url`、`--embedding-model`、`--no-embedding`
- rerank：`--rerank-url`、`--rerank-model`、`--rerank-all-themes`、`--rerank-theme`、`--rerank-recall-width`、`--rerank-threshold`、`--rerank-timeout-ms`

输出目录：

```text
assessment/rag-tuning/runs/<run_id>-rerank-ab/
├── no-rerank/
│   ├── retrieval-workspace.json
│   ├── retrieval-log.json
│   ├── run.json
│   ├── report.json
│   └── report.md
├── rerank/
│   ├── retrieval-workspace.json
│   ├── retrieval-log.json
│   ├── run.json
│   ├── report.json
│   └── report.md
├── comparison.json
└── comparison.md
```

`comparison.md` 固定输出核心对比表：结论、阅读池 chunk 数、R1、R2、R3 空主题数、facts critical 丢失、facts noncritical 丢失、lost_items、M3 新增证据 chunk 和 rerank 日志统计。

## 天花板评估（`capability: ceiling`）

B3 是**天花板基准**（各批次优点的并集），用来当**调参目标函数**，不是验收线。
它的 checklist 带 `capability: "ceiling"`，评估走专用分支：**4 个 Gate 全部跳过、永不判 FAIL**，
`conclusion` 取新值 `CEILING`，判据是 `report.coverage`。

```bash
npm run assessment:ceiling        # 由覆盖清单合成 B3-ceiling.checklist.json
npm run assessment:ceiling-menu   # 就地重写两份 md 的 §3 可选格子菜单

npm run assessment:prepare -- \
  --baseline-id B3 \
  --tag ceiling-smoke \
  --facts outputs/<批次>/facts-workspace.json \
  --retrieval-workspace outputs/<批次>/retrieval-workspace.json \
  --html-dir outputs/<批次>

npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B3-ceiling.checklist.json \
  --run assessment/rag-tuning/runs/<run_id>
```

报告标题为「RAG 天花板覆盖率报告」，含三节：**分层覆盖率 / 按 criticality 分解 / 缺口清单（按权重排序）**。
Gate 表保留但降级为「跳过判定，仅记录数值」（数值仍在 `report.gates.*`，可用于诊断）。

口径要点（完整说明见 `assessment/rag-tuning/CEILING-INTENT.md` §6.2）：

| 指标 | 分母 | 读法 |
|---|---|---|
| `layers.<L>.rate` / `weighted_rate` | 全部天花板条目 | 材料广度：离理想并集有多远。**跨参数组比较看这个** |
| `layers.<L>.conditional.rate` | 上游已覆盖的条目 | 本层自己的漏损。呈现层用它，才能把「模板问题」和「上游没给材料」分开 |
| `gaps.items[]` | — | 每条缺口只记**最上游**那一层（`first_missing_layer`），按 criticality 权重降序 |

`critical` 在此模式下是**缺口权重**（critical 4 / core-quality 3 / mid 2 / low 1），不是门槛。
调 RAG 参数时只看检索层与 facts 层；呈现层受模板影响，会污染参数排序。

> 非 `ceiling` 的基准（B1/B2）**完全不受影响**：report 结构与改动前逐字段一致，不新增 `coverage` 字段。

## 人工裁定

评估脚本会在 run 目录生成 `adjudications.json`。人工裁定低置信覆盖时，填写 `coverage_overrides`：

```json
{
  "schema_version": 1,
  "run_id": "B2-20260907-example",
  "coverage_overrides": [
    {
      "item_id": "B2-place-0001",
      "facts_covered": true,
      "render_covered": null,
      "reason": "facts 中保留了该执行提醒。"
    }
  ],
  "semantic_scores": []
}
```

裁定后重新执行 `assessment:evaluate`，报告会应用覆盖结果。

## 基准升级

基准只追加从 `PASS` run 中人工接受的有效新增项。先查看 `deltas.json.new_items`，确认候选的 `item_id`、`checklist_item` 和证据 chunk，再执行：

```bash
npm run assessment:upgrade -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --run assessment/rag-tuning/runs/B2-20260907-example \
  --accept-new-items B2-new-0001,B2-new-0002 \
  --out assessment/rag-tuning/baselines/B2-20260907.v2.checklist.json
```

升级命令会：

- 拒绝 `PASS_WITH_NOTES` 或 `FAIL` run。
- 拒绝覆盖原基准文件。
- 为新增项分配正式 checklist id。
- 递增 checklist `version`。
- 向 `assessment/rag-tuning/CHANGELOG.md` 写入升级记录。

## 当前示例 Run

- `assessment/rag-tuning/runs/B1-rag-e2e-smoke-example`：无 HTML 快评，结论 `PASS`。
- `assessment/rag-tuning/runs/B2-20260907-example`：带 HTML 全评，Gate 全部通过；由于 20260907 基准产物未提供 `retrieval-log.json`，结论为 `PASS_WITH_NOTES`。
