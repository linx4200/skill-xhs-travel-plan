# RAG 调参评估报告

- run_id: B1-rag-e2e-smoke-example
- baseline_id: B1
- conclusion: PASS

## Gate

| Gate | 状态 | 说明 |
| --- | --- | --- |
| G1 | N/A | 未提供 HTML，跳过呈现机械校验。 |
| G2 | PASS | critical 条目零丢失。 |
| G3 | PASS | 高置信归位错误为 0。 |
| G4 | PASS | 关键类越界事实为 0。 |

## 核心指标

| 指标 | 值 |
| --- | --- |
| retrieval.CIR | {"critical_items":12,"retained":12,"lost":0,"rate":1} |
| retrieval.R1 | {"critical_source_chunks":59,"retrieved":59,"lost":0,"rate":1} |
| retrieval.R2 | {"source_chunks":177,"retrieved":177,"lost":0,"rate":1} |
| facts.N1 | {"critical_lost":0} |
| facts.N2 | {"noncritical_lost":0} |
| html.CIR | {"critical_items":0,"retained":0,"lost":0,"rate":null} |

## Notes

- 无

## 丢失明细

- 无

## 有效新增明细

- 无

## 调参建议

- Gate 已满足，按 notes 处理低置信项和软指标。
