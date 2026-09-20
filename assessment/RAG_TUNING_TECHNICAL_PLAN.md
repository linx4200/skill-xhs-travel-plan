# RAG 调参评估体系技术方案

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

`package.json` 提供以下 scripts：

```json
{
  "assessment:params": "node scripts/assessment/rag-tuning/lib/params_snapshot.mjs",
  "assessment:prepare": "node scripts/assessment/rag-tuning/prepare_run.mjs",
  "assessment:baseline": "node scripts/assessment/rag-tuning/build_baseline_checklist.mjs",
  "assessment:evaluate": "node scripts/assessment/rag-tuning/evaluate_run.mjs",
  "assessment:upgrade": "node scripts/assessment/rag-tuning/upgrade_baseline.mjs"
}
```

正式基准资产：

- `B1-rag-e2e-smoke.checklist.json`：36 条，包含 `critical` 12 条、`core-quality` 17 条、`mid` 6 条、`low` 1 条；覆盖 place 19 条、city 9 条、day 8 条。
- `B2-20260907.checklist.json`：248 条，包含 `critical` 97 条、`core-quality` 108 条、`mid` 28 条、`low` 15 条；覆盖 place 141 条、city 55 条、day 47 条、global 5 条。
- `*.example.json` 和 `runs/*-example/` 只作为示例与 smoke fixture，不作为调参结论的冻结基准。

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
- 基准目录没有本地 `rag-index.json` 时，可以使用 `retrieval-workspace.json.chunks_by_id` 作为受控证据来源；访问方式仍限制为按 chunk id 读取。

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

实现约束：

- 已召回状态可使用内部码 `theme_selected`、`target_selected`、`log_selected`，但这些状态不写入丢失归因分布。
- day/global 条目没有直接 retrieval target 时，只要 chunk 已在 `retrieval-workspace.json.chunks_by_id` 中存在，即视为进入阅读池。
- 缺少 `retrieval-log.json` 时 `degraded_attribution` 为 `true`，召回结果照常输出，完整参数归因统一降级为 `unknown`。
- 检索层输出 `CIR`、`R1`、`R2`、`R3`、`R4`、`item_results`、`lost_items` 和 `attribution`；其中 `lost_items` 与 `attribution` 结构可直接合并到 `deltas.json`。

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
- `low_confidence_count`: 需要人工裁定的低置信覆盖数。
- `facts_drop_count`: facts 层归因丢失数。
- `retrieved_facts_drop_count`: 已召回但未被 facts 吸收的条目数。
- `adjudication_needed`: 需要写入 `adjudications.json` 的裁定待办。

`facts_drop` 只用于检索层已召回或检索状态未知但 facts 未覆盖的条目；检索层明确未召回的条目不在 facts 层重复归因。

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
- facts 层未覆盖的条目不在呈现层重复归因。
- 对 facts 中的 target 归属和 HTML 页面归属做一致性检查。
- 呈现层缺失标记为 `render_drop`，不反推为资料整理层缺失。
- 输出呈现层 `CIR`、`N3`、`N8`、`render_drop_count`、`low_confidence_count`、`item_results`、`lost_items` 和 `adjudication_needed`。

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
- 缺少可选日志导致归因降级时，Gate 可继续计算；报告必须明确标记降级归因范围。

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

升级约束：

- 只有 `PASS` 运行可进入基准升级。
- 新增条目必须有证据、非重复、无未裁定冲突。
- `assessment:upgrade` 按 `--accept-new-items` 逐条追加候选，拒绝覆盖原基准文件。
- 升级输出递增 checklist `version`，为新增项分配正式 ID，并向 `assessment/rag-tuning/CHANGELOG.md` 追加记录。

## 7. 测试策略

测试目录：

```text
test/assessment/
├── adjudication.test.mjs
├── checklist.test.mjs
├── evidence_access.test.mjs
├── evaluate_run.test.mjs
├── retrieval_metrics.test.mjs
├── facts_metrics.test.mjs
├── html_metrics.test.mjs
├── attribution.test.mjs
├── params_snapshot.test.mjs
├── report_writer.test.mjs
├── schemas.test.mjs
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
- adjudication：能生成裁定骨架，并应用 `coverage_overrides` 更新覆盖结果和 critical 指标。
- evaluate run：能串联检索层、facts 层、HTML 层并落盘报告产物。
- report 一致性：`report.md` 的结论与 `report.json.conclusion` 一致。
- 基准升级：只追加通过项，版本递增，`CHANGELOG.md` 写入记录。

## 8. 运行模式

### 8.1 B1 快评

B1 用于无 HTML 场景下的快速评估，覆盖检索层和资料整理层：

1. 使用 `assessment:prepare` 创建 run 目录并生成 `params.json`。
2. 使用 `assessment:evaluate` 对 `B1-rag-e2e-smoke.checklist.json` 执行评估。
3. 结论以 `report.json.conclusion` 和 `report.md` 为准。
4. HTML 不存在时，呈现层指标为 `N/A`，不触发内容失败。

### 8.2 B2 全评

B2 用于完整攻略产物评估，覆盖检索层、资料整理层和呈现层：

1. run 目录必须包含 `facts-workspace.json`、`retrieval-workspace.json` 和 `params.json`。
2. 推荐提供 `retrieval-log.json`，否则归因降级为 `unknown`。
3. 有 HTML 输出时，`assessment:evaluate` 必须传入 `--html-dir`。
4. Gate 全部通过且语义评分达标时输出 `PASS`；存在非关键问题或归因降级时输出 `PASS_WITH_NOTES`。

### 8.3 人工裁定闭环

低置信覆盖、语义评分和裁定覆盖都通过 `adjudications.json` 管理：

1. `evaluate_run.mjs` 在缺少人工裁定文件时生成裁定骨架。
2. agent 根据 checklist、facts 摘要、证据 chunk 和报告上下文填写裁定。
3. 重新执行 `assessment:evaluate` 后，报告应用 `coverage_overrides` 和 `semantic_scores`。
4. 裁定文件随 run 保留，保证结论可复查。

### 8.4 基准升级闭环

有效新增进入基准前必须通过人工选择和脚本升级：

1. `evaluate_run.mjs` 将可升级候选写入 `deltas.json.new_items`。
2. 候选必须包含可升级的 `checklist_item`、证据 chunk 和候选 ID。
3. 只有 `PASS` 运行可以调用 `assessment:upgrade`。
4. 升级只追加人工接受的候选项，不改写历史条目。
5. `CHANGELOG.md` 记录每次基准版本递增。

## 9. 维护规则

- `assessment/rag-tuning/baselines/` 保存冻结基准；正式基准文件只通过 `assessment:upgrade` 扩展。
- `assessment/rag-tuning/runs/` 保存评估运行产物；run 目录是一次评估的审计记录，不在原地改写结论来源文件。
- `scripts/assessment/rag-tuning/README.md` 和 `assessment/USAGE_GUIDELINE.md` 面向操作使用；本文档面向技术方案和长期 reference。
- 新增指标必须同步更新 schema、report writer、测试用例和 CLI 文档。
- 新增 Gate 必须在 `report.json` 中结构化输出，并在 `report.md` 中用相同结论解释。
- 新增数据字段必须遵守证据最小化原则，不在报告和基准中保存长段原文。
- 对项目规则和技术文档的维护，直接描述目标状态和未来执行方式，不写历史对比或迁移说明。
