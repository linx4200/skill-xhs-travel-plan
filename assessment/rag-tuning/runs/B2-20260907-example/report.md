# RAG 调参评估报告

- run_id: B2-20260907-example
- baseline_id: B2
- conclusion: PASS_WITH_NOTES

## Gate

| Gate | 状态 | 说明 |
| --- | --- | --- |
| G1 | PASS | HTML 机械校验。 |
| G2 | PASS | critical 条目零丢失。 |
| G3 | PASS | 高置信归位错误为 0。 |
| G4 | PASS | 关键类越界事实为 0。 |

## 核心指标

| 指标 | 值 |
| --- | --- |
| retrieval.CIR | {"critical_items":97,"retained":97,"lost":0,"rate":1} |
| retrieval.R1 | {"critical_source_chunks":485,"retrieved":485,"lost":0,"rate":1} |
| retrieval.R2 | {"source_chunks":1240,"retrieved":1240,"lost":0,"rate":1} |
| facts.N1 | {"critical_lost":0} |
| facts.N2 | {"noncritical_lost":0} |
| html.CIR | {"critical_items":97,"retained":97,"lost":0,"rate":1} |

## Notes

- 检索日志缺失或未接入，归因处于降级模式。

## 丢失明细

- 无

## 有效新增明细

- 无

## 调参建议

- Gate 已满足，按 notes 处理低置信项和软指标。
