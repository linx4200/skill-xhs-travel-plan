# 评估报告模板

> 复制本文件到 `runs/<run-id>/report.md` 后填写。章节顺序**不得调整、不得删减**；`N/A` 必须显式写出，不允许留空。
> 规则依据：[../01-scoring-rules.md](../01-scoring-rules.md)

---

## 1. 结论

**<PASS | PASS_WITH_NOTES | FAIL>** —— 一句话说清这次参数改动是变好、持平还是退化。

## 2. 基准与能力位

| 项 | 值 |
|---|---|
| `baseline_id` | |
| `baseline_version` | |
| `baseline_capability` | `full` / `retrieval_only` |
| `checklist_fidelity` | `fine` / `coarse` |
| 评估档位 | 快评 / 全评 |
| run-id | |
| 评估时间 | |

## 3. 参数变更

只列与上一次评估**不同**的项；首次评估写「基准组（默认参数）」。

| 参数 | 上次 | 本次 |
|---|---|---|
| | | |

> 若本次无变更，写「无变更」并说明复跑目的。

## 4. Gate 结果

| Gate | 条件 | 结果 | 证据 |
|---|---|---|---|
| G1 机械校验 | M2=M3=M4=0 | | |
| G2 关键主题零丢失 | CIR = 100% | | 丢失条目： |
| G3 归位错误 = 0 | 仅 high 置信计数 | | |
| G4 关键类越界事实 = 0 | 需回材料核对 | | |

## 5. 指标面板

### 检索层

| 指标 | 值 | 相对基准 |
|---|---|---|
| R1 `critical_chunk_recall` | | |
| R2 `overall_chunk_recall` | | |
| R3 `theme_dropout_rate` | | |
| R4 归因分布 | `keyword_miss:` / `score_low:` / `topk_cut:` / `quota_dropped:` / `rerank_drop:` / `generation_drop:` / `unknown:` | |

### 生成层

| 指标 | 值 | 相对基准 |
|---|---|---|
| N1 `critical_item_loss` | | |
| N2 非关键分主题丢失 | | |
| N3 `misplacement_count` | | |
| N4 `effective_new_items` | | |
| N5 `hallucination_new_items` | | |
| N6 `redundancy_rate` | | |
| N7 `executability_score` | | |
| N8 `structure_completeness` | | |

### 头条

- **CIR（关键信息保有率）**：
- **R2（总体 chunk 召回）**：

## 6. 丢失条目明细

按主题分组。每条一行。

| 主题 | 分档 | 归因码 | 缺失信息块 | source_chunk |
|---|---|---|---|---|
| | | | | |

### 容差对账

| 主题 | 分档 | 条目数 n | 丢失数 | 允许值 | 是否超限 |
|---|---|---|---|---|---|
| | | | | | |

## 7. 有效新增明细（仅全评）

| 信息块 | 主题 | 材料证据（chunk） | 判定 |
|---|---|---|---|
| | | | 有效新增 |

## 8. 归因 → 参数建议

每个出现 ≥1 次的归因码都必须给出一条建议：

| 归因码 | 涉及主题 | 涉及参数 | 建议方向 |
|---|---|---|---|
| | | | |

> 若出现 `generation_drop`，必须显式写明「该项与 RAG 参数无关，不要靠调参解决」。

## 9. 基准变更

本次是否触发基准升级：

- 否 / 是（`from_version` → `to_version`，新增条目 id 列表，待裁定冲突列表）
