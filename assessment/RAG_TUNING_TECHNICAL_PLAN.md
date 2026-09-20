# RAG 调参评估体系技术方案与分步执行计划

## 1. 目标状态

项目提供一套独立于攻略生成主流程的离线评估体系，用于评估 `scripts/rag/` 参数调整后的新产出是否达到已冻结满意基准，并定位信息丢失发生在检索层、资料整理层还是呈现层。

评估体系满足以下目标：

- 基于 `B1` 和 `B2` 分别维护独立、版本化的基准清单。
- 对一次新产出给出 `PASS`、`PASS_WITH_NOTES` 或 `FAIL`。
- 对 critical 条目执行零丢失检查。
- 基于 `retrieval-log.json` 输出可解释归因。
- 在没有 HTML 的评估中跳过呈现层，并保留资料整理层评价。
- 输出人读报告 `report.md` 和机器读结果 `report.json`、`deltas.json`。
- 支持有效新增的候选提取、人工裁定和基准只升不降升级。

## 2. 总体架构

评估体系作为 assessment 层实现，目录与主流程隔离：

```text
assessment/rag-tuning/
├── baselines/
│   ├── B1-rag-e2e-smoke.checklist.json
│   └── B2-20260907.checklist.json
├── runs/
│   └── <YYYYMMDD-HHmm>-<baseline_id>-<tag>/
│       ├── report.md
│       ├── report.json
│       ├── deltas.json
│       ├── params.json
│       ├── adjudications.json
│       ├── facts-workspace.json
│       └── retrieval-log.json
└── CHANGELOG.md

scripts/assessment/rag-tuning/
├── build_baseline_checklist.mjs
├── evaluate_run.mjs
├── prepare_run.mjs
├── upgrade_baseline.mjs
├── lib/
│   ├── schemas.mjs
│   ├── params_snapshot.mjs
│   ├── checklist.mjs
│   ├── retrieval_metrics.mjs
│   ├── facts_metrics.mjs
│   ├── html_metrics.mjs
│   ├── attribution.mjs
│   ├── adjudication.mjs
│   ├── evidence_access.mjs
│   └── report_writer.mjs
└── README.md
```

新增 `package.json` scripts：

```json
{
  "assessment:prepare": "node scripts/assessment/rag-tuning/prepare_run.mjs",
  "assessment:baseline": "node scripts/assessment/rag-tuning/build_baseline_checklist.mjs",
  "assessment:evaluate": "node scripts/assessment/rag-tuning/evaluate_run.mjs",
  "assessment:upgrade": "node scripts/assessment/rag-tuning/upgrade_baseline.mjs"
}
```

## 3. 数据流

### 3.1 建立基准

输入：

- 基准产物目录，例如 `output/rag-e2e-smoke/` 或 `outputs/2026-guoqing-self-drive-plan-20260907/`
- 对应的 `facts-workspace.json`
- 可选最终 HTML 目录
- 对应 `rag-index.json`
- 可选 `retrieval-workspace.json`、`retrieval-log.json`

流程：

1. `build_baseline_checklist.mjs` 从 `facts-workspace.json` 提取候选信息块。
2. 按字段和主题规则生成 `domain`、`place` 或 `city`、`theme`、`criticality` 初判。
3. 通过 evidence access 模块按 `source_chunk_ids` 受控读取 chunk 原文，用于核验 `evidence_ref`。
4. 生成 `*.draft.checklist.json`。
5. agent 审核粒度、重要性、证据引用和重复项。
6. 审核通过后写入正式 `*.checklist.json`，并在 `CHANGELOG.md` 记录版本。

### 3.2 准备评估运行

输入：

- `baseline_id`
- 新产出的 `facts-workspace.json`
- 新产出的 `retrieval-workspace.json`
- 新产出的 `retrieval-log.json`
- 可选 HTML 输出目录
- 当前参数来源：`scripts/rag/rag_retrieval_config.mjs` 和 CLI 参数

流程：

1. `prepare_run.mjs` 创建 `assessment/rag-tuning/runs/<run_id>/`。
2. 复制或记录本次评估使用的 `facts-workspace.json`、`retrieval-workspace.json`、`retrieval-log.json`。
3. 生成 `params.json`，记录主题词表、评分配置、top-k、总配额、rerank 默认配置和 CLI 覆盖项。
4. 校验必需文件存在性；缺少 `retrieval-log.json` 时将运行模式标记为 `degraded_attribution`。

### 3.3 执行评估

`evaluate_run.mjs` 读取基准清单和 run 目录，执行三层评估：

1. 检索层：计算 chunk 召回、主题空池、配额丢弃和归因。
2. 资料整理层：以 `facts-workspace.json` 为主，判断基准信息块是否被吸收。
3. 呈现层：HTML 存在时检查结构、链接、图片、本地资源、内容丢失和归位错误。

输出：

- `deltas.json`：逐条丢失、新增、归位错误、越界事实。
- `report.json`：机器可读结论、Gate、指标、语义评分、归因建议。
- `report.md`：面向用户阅读的评估报告。

## 4. 核心数据契约

### 4.1 baseline checklist

```json
{
  "schema_version": 1,
  "baseline_id": "B1",
  "baseline_name": "rag-e2e-smoke",
  "capability": "retrieval_and_facts",
  "version": 1,
  "created_at": "2026-09-20T00:00:00+08:00",
  "source_run": "output/rag-e2e-smoke/",
  "items": [
    {
      "id": "B1-place-001",
      "text": "九洞天需要保留门票或开放状态的出行前确认提醒。",
      "domain": "execution_fact",
      "target_type": "place",
      "target_name": "九洞天",
      "theme": "tickets",
      "criticality": "critical",
      "source_chunk_ids": ["chunk-001"],
      "evidence_ref": {
        "rag_index": "rag-index.json",
        "chunk_ids": ["chunk-001"],
        "note": "只保存引用，不复制大段原文"
      },
      "match_hints": ["门票", "开放", "确认"],
      "added_at": "2026-09-20T00:00:00+08:00",
      "source_run": "output/rag-e2e-smoke/"
    }
  ]
}
```

字段规则：

- `criticality` 取值为 `critical`、`core-quality`、`mid`、`low`。
- `domain` 取值为 `execution_fact`、`experience_value`、`decision_support`、`risk_avoidance`、`supporting_info`。
- `source_chunk_ids`、`evidence_ref`、`criticality` 为正式清单必填项。
- 清单条目只表达一条可独立决策的信息，不保存长段证据。

### 4.2 params.json

```json
{
  "schema_version": 1,
  "captured_at": "2026-09-20T00:00:00+08:00",
  "config_source": "scripts/rag/rag_retrieval_config.mjs",
  "place_themes": {},
  "city_themes": {},
  "rag_scoring": {},
  "retrieval_defaults": {},
  "rerank_defaults": {},
  "cli_overrides": {
    "place_top_k": 5,
    "city_top_k": 5,
    "max_place_chunks": 50,
    "max_city_chunks": 25,
    "rerank": true,
    "rerank_threshold": 0.9
  }
}
```

### 4.3 deltas.json

```json
{
  "schema_version": 1,
  "baseline_id": "B1",
  "run_id": "20260920-1530-B1-rerank-test",
  "lost_items": [],
  "new_items": [],
  "misplaced_items": [],
  "unsupported_facts": [],
  "duplicates": [],
  "attribution": []
}
```

每条 delta 必须包含：

- `item_id`
- `target_type`
- `target_name`
- `theme`
- `criticality`
- `layer`: `retrieval`、`facts` 或 `render`
- `attribution_code`
- `evidence`
- `suggestion`

### 4.4 adjudications.json

语义评分和低置信匹配由 agent 在结构化文件中裁定，保证评估可复查：

```json
{
  "schema_version": 1,
  "run_id": "20260920-1530-B1-rerank-test",
  "coverage_overrides": [
    {
      "item_id": "B1-place-001",
      "facts_covered": true,
      "render_covered": null,
      "reason": "facts 中保留了开放状态需确认的执行提醒。"
    }
  ],
  "semantic_scores": [
    {
      "target_type": "place",
      "target_name": "九洞天",
      "scores": {
        "information_coverage": 4,
        "travel_value": 3,
        "decision_support": 4,
        "risk_avoidance": 4,
        "evidence_absorption": 4,
        "actionability": 4
      },
      "evidence": "资料可直接支持门票、交通和停留判断。",
      "deductions": []
    }
  ]
}
```

## 5. 评估实现细节

### 5.1 受控证据访问

`evidence_access.mjs` 只提供按 chunk id 访问证据的接口：

- `loadEvidenceIndex(ragIndexPath)`
- `getEvidenceByChunkIds(index, chunkIds)`
- `verifyEvidenceRefs(checklist, ragIndexPath)`

限制：

- 不提供全文搜索接口。
- 不输出 embedding。
- 报告只保存 chunk id、标题、短摘要或短摘录，不保存长段原文。
- 只有基准构建、有效新增核验、越界事实核验会调用该模块。

### 5.2 检索层指标

检索层以 `retrieval-workspace.json` 和 `retrieval-log.json` 为输入。

指标计算：

- `CIR.retrieval`: critical 条目的 `source_chunk_ids` 是否进入对应 target 的阅读池或对应 theme 结果。
- `R1`: critical 条目 source chunk 召回率。
- `R2`: 全部清单 source chunk 召回率。
- `R3`: target/theme 空池率，基于 `retrieval_health.warnings` 中的 `empty_theme:*` 和空数组计算。
- `R4`: 丢失归因分布，按 `keyword_miss`、`score_low`、`topk_cut`、`quota_dropped`、`rerank_drop`、`facts_drop`、`render_drop`、`unknown` 聚合。

召回判断优先级：

1. chunk 出现在 `places/cities.<target>.themes.<theme>[]`，记为主题召回。
2. chunk 出现在 `unique_chunk_ids`，记为 target 召回。
3. chunk 出现在 `retrieval-log.json` 且 `recall_status` 为 `selected`，但未进入阅读池，结合 `retrieval_quota` 判断为 `quota_dropped`。
4. chunk 在日志中被 rerank 过滤，记为 `rerank_drop`。
5. chunk 在日志中通过实体 gate 但 `zero_score`，记为 `keyword_miss`。
6. chunk 有正分但未入选，按 `candidate_rank`、`top_k` 和入选最低分判断 `topk_cut` 或 `score_low`。
7. 缺少日志时只输出降级召回状态，不输出完整参数归因。

### 5.3 资料整理层指标

资料整理层以 `facts-workspace.json` 为主对象。

实现方式：

1. 将目标地点或城市的相关 facts 字段展开成可匹配文本：
   - place: `summary`、`highlights`、`drawbacks`、`opening_hours`、`tickets`、`duration`、`routes`、`play_options`、`practical_info`、`notes`、`conflicts`
   - city: `summary`、`overview`、`backup_places`、`foods`、`lodging`、`transport`、`shopping`、`notes`
   - day/global: `trip.days[].summary`、`timeline`、`notes`、`confirmations`、`global_notes`、`confirm_before_departure`
2. 对每条 checklist item 执行规则匹配：
   - `target_name` 定位 facts 节点。
   - `theme` 映射候选字段。
   - `match_hints`、数字、专名和风险词用于归一化匹配。
3. 高置信命中直接标记 covered。
4. 低置信、core-quality、语义判断类条目进入 `adjudications.json`。
5. 已召回但未进入 facts 的条目标记 `facts_drop`。

资料整理层输出：

- `N1`: critical 条目丢失数。
- `N2`: 非关键主题丢失数。
- `N3`: facts 高置信归位错误数。
- `N4`: 有效新增候选数。
- `N5`: 关键类越界事实数。
- `N6`: 冗余率。
- `N7`: 可执行性 1-5 分。

### 5.4 呈现层指标

HTML 存在时执行呈现层评估。

机械校验复用 `scripts/verify_output.mjs` 的 `verifyOutput(outDir)`：

- `index.html` 存在。
- 本地链接存在。
- 图片资源存在。
- 不引用远程资源。

内容校验：

- 将 HTML 文本抽取为纯文本。
- 对 facts 已覆盖的 checklist item 检查是否进入最终呈现。
- 对 facts 中的 target 归属和 HTML 页面归属做一致性检查。
- 呈现层缺失标记为 `render_drop`，不反推为资料整理层缺失。

HTML 不存在时：

- G1 标记 `N/A`。
- 呈现层指标标记 `N/A`。
- facts 层照常评价。

### 5.5 Gate 判定

Gate 结果由 `evaluate_run.mjs` 统一计算：

- G1 呈现机械校验：HTML 存在时必须通过。
- G2 critical 零丢失：检索层和 facts 层必须 100%；HTML 存在时呈现层也必须 100%。
- G3 高置信归位错误为 0：facts 层优先，HTML 存在时同步检查。
- G4 关键类越界事实为 0：关键事实必须能被 evidence access 核验。

结论规则：

- 任一适用 Gate 失败，结论为 `FAIL`。
- Gate 通过且语义评分不低于最低满意线，结论为 `PASS`。
- Gate 通过但存在非关键主题超容差丢失、软指标下滑、语义评分不足或低置信待复查，结论为 `PASS_WITH_NOTES`。

### 5.6 语义评分

语义评分采用 1-5 分，按 target 或能力位汇总。

评分维度：

- 信息覆盖
- 游玩价值
- 实用决策
- 风险避坑
- 证据吸收
- 可执行性

执行方式：

1. 脚本生成评分工作区，列出每个 target 的基准条目、facts 摘要、丢失项和新增项。
2. agent 在 `adjudications.json` 中写入分数、证据和扣分理由。
3. `evaluate_run.mjs` 校验分数完整性和取值范围。
4. `report.md` 和 `report.json` 使用相同评分数据。

### 5.7 有效新增与越界事实

有效新增检测：

1. 从 facts 中提取未匹配任一 checklist item 的候选信息块。
2. 去除标题、导航、泛泛语气和重复表达。
3. 通过 evidence access 核验 `source_chunk_ids`。
4. 与现有 checklist 做语义去重。
5. 写入 `deltas.json.new_items`，并在报告中标记为基准升级候选。

越界事实检测：

1. 聚焦 critical 和 core-quality 字段中的数值、开放、门票、交通、安全、风险判断。
2. 检查是否能被 `source_chunk_ids` 或已召回证据支撑。
3. 不可证实的关键事实进入 `unsupported_facts`。
4. critical 越界事实触发 G4 失败。

## 6. CLI 设计

### 6.1 建立基准

```bash
npm run assessment:baseline -- \
  --baseline-id B1 \
  --capability retrieval_and_facts \
  --source-dir output/rag-e2e-smoke \
  --facts output/rag-e2e-smoke/facts-workspace.json \
  --retrieval-workspace output/rag-e2e-smoke/retrieval-workspace.json \
  --rag-index output/rag-e2e-smoke/rag-index.json \
  --out assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json
```

### 6.2 准备评估运行

```bash
npm run assessment:prepare -- \
  --baseline-id B1 \
  --tag rerank-threshold-090 \
  --facts output/candidate/facts-workspace.json \
  --retrieval-workspace output/candidate/retrieval-workspace.json \
  --retrieval-log output/candidate/retrieval-log.json \
  --params-from-config \
  --out-root assessment/rag-tuning/runs
```

### 6.3 执行评估

```bash
npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json \
  --run assessment/rag-tuning/runs/20260920-1530-B1-rerank-threshold-090
```

有 HTML 时：

```bash
npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B2-20260907.checklist.json \
  --run assessment/rag-tuning/runs/20260920-1600-B2-full \
  --html-dir output/candidate/html
```

### 6.4 升级基准

```bash
npm run assessment:upgrade -- \
  --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json \
  --run assessment/rag-tuning/runs/20260920-1530-B1-rerank-threshold-090 \
  --accept-new-items B1-new-001,B1-new-002
```

## 7. 测试策略

新增测试目录：

```text
test/assessment/
├── checklist.test.mjs
├── retrieval_metrics.test.mjs
├── facts_metrics.test.mjs
├── html_metrics.test.mjs
├── attribution.test.mjs
├── report_writer.test.mjs
└── upgrade_baseline.test.mjs
```

测试覆盖：

- checklist schema 校验：缺少 `criticality`、`source_chunk_ids`、`evidence_ref` 时失败。
- critical 零丢失：critical item 缺失时结论为 `FAIL`。
- 降级归因：缺少 `retrieval-log.json` 时不输出完整参数归因。
- rerank 归因：`reranked_filtered` 映射为 `rerank_drop`。
- 配额归因：日志选中但阅读池未收录时映射为 `quota_dropped`。
- facts drop：chunk 已召回但 facts 未覆盖时映射为 `facts_drop`。
- render drop：facts 覆盖但 HTML 未呈现时映射为 `render_drop`。
- HTML 缺失：呈现层指标为 `N/A`，不触发内容失败。
- report 一致性：`report.md` 的结论与 `report.json.conclusion` 一致。
- 基准升级：只追加通过项，版本递增，`CHANGELOG.md` 写入记录。

## 8. 分步执行计划

### Phase 1：目录、schema 与参数快照

交付物：

- `assessment/rag-tuning/` 目录结构。
- `scripts/assessment/rag-tuning/lib/schemas.mjs`。
- `scripts/assessment/rag-tuning/lib/params_snapshot.mjs`。
- `package.json` assessment scripts。
- schema 单元测试。

验收：

- 能校验 checklist、run、delta、report、adjudication 的基本结构。
- 能从 `rag_retrieval_config.mjs` 生成完整 `params.json`。

### Phase 2：基准清单构建

交付物：

- `build_baseline_checklist.mjs`。
- `checklist.mjs`。
- `evidence_access.mjs`。
- B1 draft checklist。
- B2 draft checklist。

验收：

- 能从 facts 中抽取候选信息块。
- 每个正式条目都包含 `criticality`、`source_chunk_ids`、`evidence_ref`。
- evidence access 只按 chunk id 取证据。

### Phase 3：检索层评估与归因

交付物：

- `retrieval_metrics.mjs`。
- `attribution.mjs` 的检索层归因。
- `retrieval_metrics.test.mjs`、`attribution.test.mjs`。

验收：

- 能计算 CIR、R1、R2、R3、R4。
- 能区分 `keyword_miss`、`score_low`、`topk_cut`、`quota_dropped`、`rerank_drop`。
- 缺少 `retrieval-log.json` 时进入降级评估。

### Phase 4：资料整理层评估

交付物：

- `facts_metrics.mjs`。
- `adjudication.mjs`。
- `facts_metrics.test.mjs`。

验收：

- 能把 facts 字段展开成 target 级可匹配文本。
- 能判断 critical 条目在 facts 中是否覆盖。
- 能生成低置信 adjudication 待办。
- 能识别 `facts_drop`。

### Phase 5：呈现层评估

交付物：

- `html_metrics.mjs`。
- 复用 `verifyOutput(outDir)` 的 G1 机械校验。
- `html_metrics.test.mjs`。

验收：

- HTML 存在时能校验链接、图片、本地资源和 index。
- HTML 缺失时呈现层为 `N/A`。
- facts 覆盖但 HTML 未出现时标记 `render_drop`。

### Phase 6：评估运行与报告生成

交付物：

- `prepare_run.mjs`。
- `evaluate_run.mjs`。
- `report_writer.mjs`。
- `report.md` 模板。
- `report_writer.test.mjs`。

验收：

- 一次运行能产出 `report.md`、`report.json`、`deltas.json`、`params.json`。
- Gate、指标、语义评分、丢失明细、有效新增、调参建议都出现在报告中。
- `report.md` 和 `report.json` 的核心结论一致。

### Phase 7：有效新增与基准升级

交付物：

- `upgrade_baseline.mjs`。
- 有效新增候选生成逻辑。
- `CHANGELOG.md` 写入逻辑。
- `upgrade_baseline.test.mjs`。

验收：

- 只有 `PASS` 运行可进入升级。
- 新增条目必须有证据、非重复、无未裁定冲突。
- checklist 版本递增。
- 历史版本不被改写。

### Phase 8：B1/B2 落地与回归验证

交付物：

- `B1-rag-e2e-smoke.checklist.json`。
- `B2-20260907.checklist.json`。
- 至少各一次示例评估 run。
- `scripts/assessment/rag-tuning/README.md`。

验收：

- B1 可在无 HTML 情况下完成检索层和资料整理层评估。
- B2 可执行完整评估。
- `npm test` 通过。
- assessment README 能指导 agent 完成快评、全评和基准升级。

## 9. 实施顺序建议

优先顺序：

1. 先实现 schema、params snapshot 和 run 目录管理，保证产物稳定。
2. 再实现检索层指标和归因，因为这些依赖现有 `retrieval-log.json`，自动化程度最高。
3. 然后实现 facts 覆盖检测和 adjudication 文件，让语义判断可复查。
4. 最后实现 HTML 层、有效新增和基准升级。

首个可用里程碑：

- 完成 Phase 1、Phase 3、Phase 4 的 critical 覆盖部分后，即可支持 B1 快评。

完整验收里程碑：

- 完成 Phase 1 到 Phase 8 后，支持 PRD 要求的快评、全评、报告输出和基准升级。
