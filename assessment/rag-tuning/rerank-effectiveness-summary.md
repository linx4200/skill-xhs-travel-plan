# Rerank 效果

## 当前结论

在 B1 扩展索引样本上，默认 rerank 值得开启。它把关键证据召回率从 `0.7627` 提到 `0.8644`，把总体证据召回率从 `0.7740` 提到 `0.8870`，没有增加 critical 丢失或总丢失项。

这次对照的直接读法是：rerank 让阅读池更像“该读的材料池”，尤其能把关键证据往前拉。它不是让最终 facts 自动变好的魔法；如果 facts 生成没有基于两套阅读池分别重写，facts 层指标只能作为参考。

本次 run：

- 对比报告：`assessment/rag-tuning/runs/20260921-1119-B1-rerank-ab-expanded-index/comparison.md`
- 索引：`/Users/xinran.lliu/Downloads/skill-travel-plan-test/resources-chunk/rag-index.json`
- 基准：`assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json`
- 模式：两侧共用 `output/rag-expanded-baseline/facts-workspace.json`，因此检索层结论有效，facts 层不是独立全评结论。

## 默认使用方式

RAG 检索在需要提升高风险主题相关性时开启 rerank。默认只对高风险主题执行 rerank，不对所有主题一刀切。

默认 rerank 范围：

- 景点：`highlights`、`nearby`、`routes`、`facilities`
- 城市：`backup_places`

默认策略：

- `recallWidth = 24`
- `probThreshold = 0.9`
- 非白名单 theme 不访问 rerank 服务，保留一阶段排序。
- rerank 只重排和过滤候选窗口，不改写对外输出的 `result.score`。
- 需要诊断时必须写 `retrieval-log.json`，否则无法解释 chunk 是被 top-k、窗口、阈值还是主题范围挡住。

## 人话判断规则

调参时不要只看“开 rerank 后读了多少 chunk”，要按以下顺序判断：

1. Gate 有没有变差：`PASS` 不能变成 `FAIL`，critical 丢失不能增加。
2. 关键证据有没有变好：优先看 `R1 critical chunk 召回率`。
3. 总体材料有没有变好：看 `R2 总体 chunk 召回率`。
4. 有没有把主题清空：看 `R3 空主题数` 和 `retrieval-log.json` 里的 `theme_not_in_scope`、`rerank_drop`。
5. 新材料有没有价值：看 `M3 新增证据 chunk` 和 `M3 池内基准未用 chunk`。
6. facts 层是否独立：只有两侧分别基于各自阅读池重写 facts，facts 丢失和最终呈现指标才用于判断 rerank 对输出质量的真实影响。

## 本次对照结果

| 指标 | 不开 rerank | 开 rerank | 差值 |
|---|---:|---:|---:|
| 结论 | FAIL | FAIL | RERANK_IMPROVED |
| 阅读池 chunk 数 | 74 | 83 | +9 |
| R1 critical chunk 召回率 | 0.7627 | 0.8644 | +0.1017 |
| R2 总体 chunk 召回率 | 0.7740 | 0.8870 | +0.1130 |
| R3 空主题数 | 0 | 0 | 0 |
| facts critical 丢失 | 11 | 11 | 0 |
| facts noncritical 丢失 | 15 | 15 | 0 |
| lost_items | 26 | 26 | 0 |
| M3 新增证据 chunk | 40 | 39 | -1 |
| M3 池内基准未用 chunk | 47 | 52 | +5 |

本次 rerank 日志：

- 请求数：30
- 实际执行 rerank：10
- 因 theme 不在 rerank 范围而跳过：20
- 阈值过滤 item：90

## 工程边界

Rerank 服务是本地外部服务，项目内不安装模型依赖，也不提交模型文件。显式开启 rerank 时，本地服务不可用应直接失败，不静默降级为不开 rerank；否则 A/B 结果会失真。

全主题 rerank 不作为默认策略。它会显著增加请求量，并可能因为 query 模板不适配低风险主题而误伤材料池。扩大 rerank 范围必须通过 A/B 报告验证，不能只凭单个主题的局部收益落地。

## 后续评估方式

严格全评使用两套独立 facts：

```bash
npm run assessment:rerank-ab -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --rag-index <rag-index.json> \
  --no-rerank-facts <no-rerank/facts-workspace.json> \
  --rerank-facts <rerank/facts-workspace.json> \
  --no-rerank-html-dir <no-rerank/html-dir> \
  --rerank-html-dir <rerank/html-dir> \
  --out-dir assessment/rag-tuning/runs/<run_id>-rerank-ab
```

只传一份 `--facts` 的对照用于检索层判断。报告会标记 `facts_layer_independent: false`，这时不要把 facts 层丢失当成 rerank 的最终输出效果。
