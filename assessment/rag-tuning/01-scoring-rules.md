---
title: RAG 调参评分规则
doc_type: scoring-spec
audience: agent
version: v1.0
status: active
depends_on: ./00-intent.md
scope_repo: skill-xhs-travel-plan
---

# RAG 调参评分规则 v1.0

> 本文件是 **可执行的判定规则**。所有取值均为硬性规定，agent 按此执行，不得临场发挥。
> 意图依据见 [00-intent.md](./00-intent.md)；本文档与该文件冲突时，以本文档的数值规定为准，以该文件的语义规定为准。

---

## 0. 适用范围

- 适用对象：`scripts/rag/` 四类参数（主题词表 / 打分与降权 / 配额与 top-k / rerank）。
- 评估输入：**冻结**。固定使用国庆自驾材料（`rag-index.json` + `route-structure.json`），只变参数。
- 评估模式：**只做「新产出 vs 基准」两两对比**，不做多组参数排行榜。
- 本规则**不进入** `SKILL.md` 主流程，不修改 `assessment/assessment-quality-metrics.json` 与 `scripts/assessment/*.mjs`。
- 忽略本项目 `data/` 目录。

---

## 1. 总体架构

三层评分 + 一层门槛：

```
L0 门槛层   Gate   ── 布尔判定，任一不过即 FAIL，不再计算后续分数
L1 机械层   M-*    ── 确定性脚本可算（复用 verify_output.mjs）
L2 检索层   R-*    ── chunk 是否进阅读池
L3 生成层   N-*    ── 事实是否进最终输出
```

**核心设计约束：清单条目必须携带 `source_chunk_ids`。** 否则"生成层漏了某条信息"无法归因到"检索层没召回"，分层评估就退化成单一层评估。这是整个体系的承重结构。

---

## 2. 基准与清单

### 2.1 两份基准

| ID | 路径 | 能力位 | 清单来源产物 |
|---|---|---|---|
| `B1` | `output/rag-e2e-smoke/` | `retrieval_only` | `retrieval-workspace.json` + `facts-workspace.json` |
| `B2` | `outputs/2026-guoqing-self-drive-plan-20260907/` | `full` | `day-*.html` / `city-*.html` / `index.html`（主）+ `facts-workspace.json`（对齐用） |

- 两份基准**各自独立**，各有各的清单，**不共用阈值、不互相比较**。
- 基准语义 = **地板**。目标不是对齐，是"只能更好"。
- `B1` 无最终 HTML ⇒ 生成层指标在 B1 上为 `N/A`，**不得记为 0、不得记为缺失、不得用"对齐 facts-workspace"冒充生成层评分**。报告中必须显式输出 `baseline_capability: retrieval_only`。
- `B1` 的清单粒度天然比 B2 粗（源头是小样本），报告需标注 `checklist_fidelity: coarse`。

### 2.2 一条"信息块"的切分准则

清单条目 = **一条可独立成立、可独立决策的出行信息**。判定边界：

**算作独立一条：**
- 一个可执行要点：「XX 景点停车建议走 A 入口」
- 一个数值事实：「门票 80 元」
- 一条风险提示：「老人不建议走全程台阶」
- 一条体验理由：「XX 观景台日出机位值得专门早起」

**合并为同一条：**
- 同一事实的同义复述（出现在多处只记一条，另记 `duplicate_in_baseline: true`）
- 同一句里的主从关系（「停车在 A 入口，8 点前有位」= 一条，不拆两条）

**不收入清单：**
- 纯排版文本、标题、导航、免责声明、确认清单里的重复条目
- 情感词、语气助词、「值得一去」这类无信息量的判断

**长度参考：** 一条对应 1 个自然语句单位（约 15–60 字），超过 80 字的候选必须拆或判为"非原子"退回重切。

### 2.3 清单覆盖面：全收

- **执行类**（tickets / transport / safety / crowds / accessibility / facilities / lodging）与**体验类**（highlights / nearby / foods / backup_places / routes / drawbacks / notes）**全部收入**。
- 覆盖面全收 ≠ 权重相同。权重与容差按 §5.2 分层。

### 2.4 清单条目必填字段

见 §11 清单 JSON 契约。**`criticality`、`source_chunk_ids`、`evidence_ref` 三项缺一不可**，缺任一项该条目不得进入清单。

---

## 3. 指标定义

### 3.1 机械层（M）

| ID | 名称 | 计算 | 门槛 |
|---|---|---|---|
| M1 | `verify_pass` | `node scripts/verify_output.mjs` 退出码 === 0 | Gate |
| M2 | `broken_link_count` | 断链数 | = 0 |
| M3 | `missing_photo_count` | 缺失照片引用数 | = 0 |
| M4 | `remote_resource_count` | 远程资源数 | = 0 |

M1 仅在产物含 HTML 时运行；`B1` 及纯检索层评估时 M1–M4 记为 `N/A`。

### 3.2 检索层（R）

| ID | 名称 | 计算 | 用途 |
|---|---|---|---|
| R1 | `critical_chunk_recall` | 关键主题条目中 `source_chunk_ids` 命中阅读池的条目数 / 关键主题条目总数 | 联动 Gate G2 |
| R2 | `overall_chunk_recall` | 全部条目中 `source_chunk_ids` 命中阅读池的条目数 / 条目总数 | 主指标 |
| R3 | `theme_dropout_rate` | 阅读池为空（该 place/city × theme 无 chunk）的格子数 / 应有格子数 | 观察项 |
| R4 | `miss_reason_distribution` | 丢失条目按 §6.1 六类归因的计数分布 | 诊断主入口 |

"命中阅读池"的判定：条目的任一 `source_chunk_id` 出现在新产出的 `retrieval-workspace.json` 对应 place/city 的 chunk 集合中。

### 3.3 生成层（N）

| ID | 名称 | 计算 | 性质 |
|---|---|---|---|
| N1 | `critical_item_loss` | 关键主题清单条目在最终输出中消失的条数 | Gate |
| N2 | `normal_item_loss_by_theme` | 非关键主题分主题丢失条数 | 容差判定 |
| N3 | `misplacement_count` | 事实写在错误日期/景点下的条数（高置信） | Gate |
| N4 | `effective_new_items` | 材料可证实、且不在基准清单中的有效新增条数 | 正向 |
| N5 | `hallucination_new_items` | 材料无法证实的越界事实条数 | Gate（关键类）/ 扣分（普通类） |
| N6 | `redundancy_rate` | 跨页重复事实数 / 事实总数 | 软性 |
| N7 | `executability_score` | 1–5 分，LLM 主观（参照 `references/manual-quality-check.md`） | 软性 |
| N8 | `structure_completeness` | 每日页/城市页/首页必要区块齐全的页数 / 总页数 | 软性 |

### 3.4 头条数字

**关键信息保有率 CIR** = 1 − (N1 / 基准清单关键条目总数)。

- 这是唯一需要"稳定不抖动"的硬结论（对应意图文档 §6.3）。
- 门槛：**CIR = 100%**。
- 不设单一综合总分。**若必须给一个用于两两对比趋势的数字，只报两个：CIR 与 R2，并标明二者都不是加权总分。**

---

## 4. 硬门槛（Gate）

按顺序判定，任一不过即 `FAIL`，后续分数不再作为通过依据（仍可输出供诊断）。

| Gate | 条件 | 判定方式 | 数据 |
|---|---|---|---|
| **G1** | M1 通过，M2 = M3 = M4 = 0 | 脚本退出码 | 新产出 HTML |
| **G2** | 关键主题条目丢失数 = 0（即 CIR = 100%） | 清单枚举比对，**确定性** | 清单 + 最终输出 |
| **G3** | 归位错误 = 0 | LLM 判定，**仅 `confidence: high` 才计入**；medium/low 降级为观察项 | 清单 `place`/`city` 字段 + 最终输出 |
| **G4** | 关键类越界事实 = 0 | LLM 判定 + **必须回 `rag-index.json` 核对** | `rag-index.json` chunk 原文 |

- Gate 判定**禁止使用 LLM 自由裁量的软分**。
- G1 在无 HTML 的评估中跳过并记 `N/A`，不作为通过条件。

---

## 5. 容差与判定

### 5.1 判定档位

| 档位 | 条件 |
|---|---|
| `PASS` | 所有适用 Gate 通过，且每个主题的丢失数 ≤ 该主题允许值 |
| `PASS_WITH_NOTES` | Gate 通过，但存在超出允许值的**非关键**主题丢失，或 N6/N7/N8 出现下滑 |
| `FAIL` | 任一 Gate 不通过 |

### 5.2 主题分档、权重与容差

主题 ID 使用 `place:<theme>` / `city:<theme>` 全限定形式（`transport` 在两个域下含义不同，必须区分）。

| 分档 | 主题 | 权重 | 允许丢失条数 |
|---|---|---|---|
| **critical** | `place:tickets` `place:transport` `city:transport` `place:safety` `place:crowds` `place:accessibility` | 3 | **0** |
| **mid** | `place:routes` `place:drawbacks` `city:lodging` `city:notes` `city:backup_places` | 2 | `min(2, ceil(n × 10%))` |
| **low** | `place:highlights` `place:nearby` `place:facilities` `city:foods` | 1 | `min(3, ceil(n × 20%))` |

`n` = 该主题在清单中的条目数。`n = 0` 时该主题不参与判定。

- **归位错误不受容差保护**：G3 零容忍。
- 未收入任何分档的新增主题默认 `low`。

### 5.3 "不能比基准差"的完整形式

```
不比基准差  ⟺  G1–G4 全通过
             ∧  ∀theme: loss(theme) ≤ allowed(theme)
             ∧  软性指标无显著下滑（N6 不上升超 5pp，N7 不下降超 0.5 分）
```

---

## 6. 归因规则与参数映射

### 6.1 归因分类（六类，互斥，按顺序命中即止）

对每一条"清单条目丢失"，先做检索层归因，再做生成层归因：

| 归因码 | 判定条件 | 指向的参数 |
|---|---|---|
| `keyword_miss` | 该条目 `source_chunk` 未出现在该 theme 的候选集里 | `PLACE_THEMES` / `CITY_THEMES` 触发词 |
| `score_low` | chunk 进入候选但分数低于截断阈值 | `RAG_SCORING.tilt` 系列、`keywordScoreTermCap` |
| `topk_cut` | chunk 有分，但排在该 theme 的 `*-top-k` 之外 | `placeMaxThemeChunks` / `cityMaxThemeChunks` |
| `quota_dropped` | chunk 属于该 theme 但被总量配额挤掉 | `maxPlaceChunks` / `maxCityChunks`、`PLACE_THEMES` key 顺序 |
| `generation_drop` | chunk **已进阅读池**但未写进最终输出 | 检索参数无关，属生成层问题 |
| `rerank_drop` | 启用 rerank 时被 `probThreshold` 过滤 | `probThreshold` / `probThresholdByTheme` |
| `unknown` | 以上均不匹配 | 需人工核查，禁止当作可忽略 |

- `quota_dropped` 必须与 `retrieval-workspace.json` 的 `retrieval_quota.dropped_by_theme` 对账后确认，不得凭猜。
- `rerank_drop` 仅在本次运行 `RAG_RERANK_DEFAULTS.enabled = true` 时可能命中。

### 6.2 归因 → 建议的强制性

**报告必须为每一个出现 ≥1 次的归因码给出：涉及的主题、涉及的参数名、建议调整方向（升/降/增词/减词）。** 不允许只列归因码不解释。

### 6.3 分层责任判定

| 情况 | 结论 |
|---|---|
| 检索层丢失 ≥ 1 条关键条目 | 检索参数问题，优先调参 |
| 检索层无丢失、生成层有丢失 | 生成层问题，**不要靠调 RAG 参数解决** |
| 两层都丢 | 分别报告，检索层问题优先 |

---

## 7. 两档评估

### 7.1 指标裁剪

| 项 | 快评 | 全评 |
|---|---|---|
| G1 机械校验 | ✅（有 HTML 时） | ✅ |
| G2 关键主题丢失 | ✅ | ✅ |
| G3 归位错误（高置信） | ✅ | ✅ |
| G4 关键类越界事实 | ❌ | ✅ |
| R1 关键 chunk 召回 | ✅ | ✅ |
| R2 总体 chunk 召回 | ✅ | ✅ |
| R3 主题空池率 | ✅ | ✅ |
| R4 归因分布 | ✅ | ✅ |
| N1 关键条目丢失 | ✅ | ✅ |
| N2 非关键分主题丢失 | 只计数，不判定 | ✅ 判定 |
| N3 归位错误 | ✅ | ✅ |
| N4 有效新增（回材料核对） | ❌ | ✅ |
| N5 越界事实 | ❌ | ✅ |
| N6 冗余率 | ❌ | ✅ |
| N7 可执行性 | ❌ | ✅ |
| N8 结构完整 | ❌ | ✅ |

### 7.2 触发时机

- **快评**：日常调参循环，每改一组参数跑一次。目标是"分钟级出 PASS/FAIL"。**关键条目必须全量核对，不得抽样。**
- **全评**：里程碑前、确定收敛前、以及**基准升级的候选评审**必须走全评。

### 7.3 参数快照

每次评估（两档都要）落盘 `params.json`，记录本次生效的完整参数：
`PLACE_THEMES`、`CITY_THEMES`、`RAG_SCORING`、`RAG_RETRIEVAL_DEFAULTS`、`RAG_RERANK_DEFAULTS`，以及本次 CLI 覆盖值。
缺少参数快照的评估结果**不得进入对比**。

---

## 8. 基准升级（逐条合并最优）

### 8.1 触发条件

候选产出同时满足：`PASS` **且** `effective_new_items > 0`。

### 8.2 升级流程

```
1. 候选产出走一次全评
2. 对每条有效新增，生成清单条目候选（必含 source_chunk_ids + evidence_ref）
3. 去重：与现有清单语义重复的丢弃（同义表述不算新增）
4. 冲突检查：与现有条目内容矛盾时，标记 conflict，不自动合并，列入「待用户裁定」
5. 追加进清单；写 added_at / added_by / source_run
6. checklist.version += 1，写 CHANGELOG
```

### 8.3 不可逆约束

- 清单**只升不降**。任何条目一经加入不得因某次跑不出而删除；确需删除必须由用户显式确认，并在 CHANGELOG 记录删除原因。
- 升级后**历史报告的基准版本号不得改写**。每条报告记录 `baseline_version`。

### 8.4 留痕格式

`assessment/rag-tuning/CHANGELOG.md` 每条记录：

| 字段 | 内容 |
|---|---|
| `checklist_id` | 如 `B2-20260907` |
| `from_version` → `to_version` | 如 v1 → v2 |
| `source_run` | 触发升级的 run-id |
| `added_items` | 新增条目 id 列表 |
| `conflicts_pending` | 待裁定冲突条目 id |
| `upgraded_at` | 时间戳 |

---

## 9. 复现性要求

| 项 | 规定 |
|---|---|
| Gate 判定 | **必须确定性**。同一份产出两次评估，Gate 结论必须完全一致 |
| G2 | 清单枚举比对，天然确定 |
| G3 / G4 | LLM 判定，**必须带证据 + confidence**；`confidence: high` 才计入 Gate |
| N4 有效新增 | LLM 判定允许抖动 → 采用**两次独立采样取交集**，降低误报 |
| 软性指标（N6/N7/N8） | 允许小幅抖动，只用于 `PASS_WITH_NOTES` 提示，**不参与 Gate** |
| 禁止 | 禁止用 LLM 自由裁量结果推翻 Gate 结论 |

---

## 10. 报告与落盘

### 10.1 位置

```
assessment/rag-tuning/
├── 00-intent.md
├── 01-scoring-rules.md          ← 本文件
├── CHANGELOG.md                 ← 基准升级留痕
├── baselines/
│   ├── B1-rag-e2e-smoke.checklist.json
│   └── B2-20260907.checklist.json
├── templates/
│   └── report-template.md
└── runs/
    └── <YYYYMMDD-HHmm>-<baseline_id>-<tag>/
        ├── report.md            ← 人看
        ├── report.json          ← 机器读
        ├── deltas.json          ← 丢失/新增条目逐条明细
        └── params.json          ← 参数快照
```

`<tag>` 由用户或 agent 给本次调参一个短标识（如 `topk6`、`theme-v2`）。

### 10.2 report.md 结构（顺序固定）

1. **结论**：`PASS` / `PASS_WITH_NOTES` / `FAIL`，一行说清
2. **基准与能力位**：`baseline_id`、`baseline_version`、`baseline_capability`、`checklist_fidelity`
3. **参数变更**：本次 vs 上次的差异项（只列变化的）
4. **Gate 结果表**：G1–G4 逐项通过/不通过 + 证据
5. **指标面板**：CIR、R1–R4、N1–N8 数值，`N/A` 明确标注
6. **丢失条目明细**：按主题分组，每条带 `theme / criticality / 归因码 / 缺失文本`
7. **有效新增明细**（全评）
8. **归因 → 参数建议**：按 §6.2 强制给出
9. **基准变更**：若本次触发升级，附 CHANGELOG 摘要

### 10.3 人工介入点

仅两处：
1. 清单首次建立后用户审核一次（**一次性**）
2. 每次评估结论出来后用户看结论

报告不得要求用户逐条核对。

---

## 11. 附录：清单 JSON 契约

```jsonc
{
  "checklist_id": "B2-20260907",
  "baseline_id": "B2",
  "baseline_path": "outputs/2026-guoqing-self-drive-plan-20260907/",
  "baseline_capability": "full",              // full | retrieval_only
  "checklist_fidelity": "fine",               // fine | coarse
  "version": 1,
  "updated_at": "2026-09-20T11:00:00+08:00",
  "source_artifacts": ["day-01.html", "city-01.html", "facts-workspace.json"],
  "items": [
    {
      "id": "b2-d3-tickets-001",
      "text": "XX 景点门票 80 元，需提前一天线上预约",
      "domain": "place",                       // place | city
      "place": "XX 景点",
      "city": "XX 市",
      "day": 3,
      "theme": "tickets",                      // 对应 PLACE_THEMES / CITY_THEMES 的 key
      "criticality": "critical",               // critical | mid | low
      "source_chunk_ids": ["chunk-0412"],      // 必填，不可为空数组
      "evidence_ref": "rag-index.json#chunk-0412",
      "duplicate_in_baseline": false,
      "added_at": "2026-09-20T11:00:00+08:00",
      "added_by": "agent",
      "source_run": "20260920-1100-B2-init"
    }
  ],
  "conflicts_pending": []
}
```

**校验规则（建清单时必须自检）：**
- `source_chunk_ids` 为空数组 → 条目非法，退回补证或剔除
- `theme` 不属于 `PLACE_THEMES` / `CITY_THEMES` 的 key → 条目非法
- `criticality` 与 §5.2 分档不一致 → 以 §5.2 为准强制纠正
- `text` 超过 80 字 → 退回拆分

---

## 12. 本版新增的数值决定（对应 00-intent.md §12 的开放问题）

| # | 开放问题 | 本版取值 |
|---|---|---|
| 1 | "一条信息块"的切分准则 | §2.2：15–60 字，原子可独立决策，同义合并，超 80 字退回拆分 |
| 2 | 分值刻度 | §3.4：不设综合总分，只报 CIR 与 R2；判定用 §5.1 三档 |
| 3 | 非关键主题波动幅度 | §5.2：mid ≤ `min(2, ceil(n×10%))`，low ≤ `min(3, ceil(n×20%))` |
| 4 | 有效新增记分 | §5.1/§3.3：+1/条，同 place×theme 格子封顶 2，全局封顶 20；普通类越界 −1/条 |
| 5 | 快评/全评裁剪 | §7：快评不跑 N4–N8；全评全跑 |
| 6 | 基准升级流程与留痕 | §8 + `CHANGELOG.md` 字段表 |
| 7 | B1 无 HTML 的处理 | §2.1：生成层记 `N/A`，`baseline_capability: retrieval_only`，`checklist_fidelity: coarse` |
| 8 | 报告落盘与命名 | §10.1：`assessment/rag-tuning/runs/<YYYYMMDD-HHmm>-<baseline_id>-<tag>/` |
