# RAG 调参评估体系变更记录

## 未发布

- 建立 assessment 目录结构，后续基准清单和评估运行产物按版本归档。
- 建立 checklist schema、参数快照和评估 run manifest 基础设施。
- 增加基准清单构建工具和受控证据访问模块。
- 生成 `B1-rag-e2e-smoke.checklist.json` 和 `B2-20260907.checklist.json`。
- 增加检索层归因和 R 指标计算，支持 `keyword_miss`、`score_low`、`topk_cut`、`quota_dropped`、`rerank_drop` 和缺日志降级归因。
- 增加资料整理层覆盖评估和 adjudication 骨架，支持 `facts_drop`、低置信覆盖待裁定和 coverage override。
- 增加呈现层评估，复用 HTML 机械校验并支持 HTML 缺失 `N/A`、全站文本覆盖检查和 `render_drop`。
- 增加评估报告生成、有效新增候选输出和基准升级命令，支持只追加 `PASS` run 中人工接受的新增项。
- 增加 B1/B2 示例评估 run 和 assessment 使用说明，覆盖快评、全评、人工裁定和基准升级。
- 补齐 B1 smoke facts 并重建 `B1-rag-e2e-smoke.checklist.json`，使 B1 快评基准具备实际 checklist 覆盖。
- 新增天花板基准 B3：`build_ceiling_baseline.mjs` 由「基底批次 + 覆盖清单」合成 checklist，
  支持整格替换 / 条号选择 `#1,3` / `合并` / 整目标 `接管` / `删除` 五种动作，
  并派生检索池与逐行溯源（`ceiling-runs/<run_id>/`）。新增 `assessment:ceiling`、`assessment:ceiling-menu`。
- 新增 `capability: "ceiling"` 评估分支：Gate 全部 `SKIPPED`（数值保留）、`conclusion` 取 `CEILING`、
  判据改为 `report.coverage`（分层覆盖率 + 层内转化 + 按 criticality 权重的缺口清单）。
  非 ceiling 基准的 report 结构逐字段不变。新增 `test/assessment/ceiling_report.test.mjs`（8 条）。
