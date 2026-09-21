# P3 轮次日志（2026-09-20 起）

> **本文件是执行流水，不是规范。** 规范（目标、约束、搜索空间、判据、交付要求）见
> [`../../INTENT.md`](../../INTENT.md)；天花板基准的契约见 [`../../CEILING-INTENT.md`](../../CEILING-INTENT.md)。
> 逐候选评估记录在 `../../runs/<run_id>/`（评估脚本的固定输出目录，按 `.gitignore` 约定**本地保留、不入库**）。

**本轮一句话**：B3 天花板**首次调参**。目标函数从「地板（B1 不退化）」换成「天花板（离理想并集的覆盖率）」，
坐标系不同、结论也不同。**结果：配额是唯一有效主轴（证据 chunk 108 → 118，facts 层可写上界 78.8% → 91.4%）；
rerank 的主题范围与召回窗口两个旋钮零增益或负增益，全主题 rerank 是灾难性退化。本轮不落地。**

> **补充（2026-09-21）**：已按用户指令补跑 **B1 落地复核** —— 广度模式配额在 B1 地面上**不破地板**
> （Gate 全过、R1 0.78→0.92、R2 0.81→0.92、N2 2→0），但**读量 +34.1% 超窗**，
> 不满足 §1.3「明确优于基线」→ **维持不落地，默认值仍为 `5/5/50/25`**。
> 详见 [`B1-RECHECK.md`](./B1-RECHECK.md)。

> 执行跨度：2026-09-20 23:29 → 2026-09-21（目录名沿用轮次起始日）。

| 本目录文件 | 内容 |
|---|---|
| `LOG.md` | 本文件 —— 第一部分：本轮所做的评估体系修订；第二部分：P3 执行记录 |
| `P3-TUNING-REPORT.md` | 调参报告：候选对比、t0 对照、推荐理由、复现命令、落地与回滚 |
| `P3-SWEEP.json` | 阶段A 候选全表（机器可读，12 个扫描点；每个候选含池快照与缺失 chunk 清单，并附**池口径**的 `chunk_level_pool`） |
| `B1-RECHECK.md` | P3 推荐参数的 B1 落地复核（2026-09-21）：指标对照、§1.3 判据逐条复核、落地决定 |

| 相关外部位置 | 说明 |
|---|---|
| `../../../output/rag-b3-tuning/` | 本轮工作目录（**本地保留、不入库**）：事实骨架、索引副本、扫描驱动 `sweep.mjs`、汇总脚本 `collect.mjs`、逐流结果 `sweep-*.json` |
| `../../runs/20260920-2312-B3-p3-t0-default/` | t0 评估 run（默认参数 + 骨架 facts） |
| `../../runs/20260921-0122-B3-p3-p10c10/` | 推荐候选评估 run（配额 10/10，帽 100/50，rerank 默认） |
| `../../runs/20260921-0815-B1-wide-quota/` | **B1 落地复核 run**（广度模式配额 + 补写 facts + 35 条语义裁定） |
| `../../baselines/B3-ceiling.checklist.json` | 天花板基准清单（本地保留，不入库） |
| `../../runs/20260920-2048-B3-ceiling-smoke/` | 上一轮的 ceiling 分支验收 run（被测产出 = `20260918-3`） |

> 两个 run 的 chunk 粒度读数与扫描驱动**逐位一致**，构成 E3 新口径的端到端交叉验证（见报告 §4.4）。

---

# 第一部分 · 本轮所做的评估体系修订

## A3. E3：检索层补 chunk 粒度口径（2026-09-21）

**背景（实测，非推测）**：天花板模式上线后，检索层的唯一数字是**条目级**覆盖率 ——
一条天花板条目只要有任意 1 条证据入池就算命中。这条口径在**扩容后的 337-chunk 索引**上会**饱和**：

| 候选 | 配额 | 阅读池 | 条目级检索覆盖率 |
|---|---|---|---|
| t0 | top-k 5 / 帽 50 | 180 | 273 / 273 = 100.0% |
| 抬配额（p8 / p10 / p8c8） | top-k 8~10 / 帽 80~100 | 208~221 | **273 / 273 = 100.0%** |

同一批条目、四组不同配额，条目级读数**完全相同**，无法给参数排序 ——
这与 `CEILING-INTENT.md` §6.2 已经写下的要求直接冲突：
「**绝对值不是问题，区分度才是** —— 跨参数组比较时看的是同一批条目上的相对高低」。
保留这条口径就等于本轮**没有可用的主分数**。

**修订决定**（agent 自主决策，授权见 §A3.2）：在 `coverage.layers.retrieval` 下**新增** `chunk_level` 块，
只在天花板模式产出，不动任何既有字段。

| 字段 | 定义 | 用途 |
|---|---|---|
| `unique_evidence_chunks` | 天花板要求的证据 chunk **去重**后有多少条进了池 | 材料广度；本轮主排序依据 |
| `unique_critical_evidence_chunks` | 同上，限 critical 条目 | 硬门槛面是否被撑住 |
| `partial_credit_weighted_rate` | 逐条目按「已入池证据 ÷ 该条目全部证据」给部分分，再按 criticality 加权 | 容忍「一条条目只捞到部分证据」的中间态 |
| `fully_evidenced_weighted_rate` | 证据 **全部** 入池的条目加权占比 | **facts 层可写上界**（见下） |

`fully_evidenced_weighted_rate` 是本轮引入的最重要一个数字：检索层是 facts 层的唯一上游，
**证据没进池的信息不可能被写对**（写了就是幻觉，会触发 G4）。它把「检索层调参」与「facts 层能写到多满」
用一条不等式连起来，使天花板口径下也能对参数做排序，而不必每轮都付一次长文阅读成本。

**改动范围（仅新增字段与渲染段）**：

| 文件 | 改动 |
|---|---|
| `scripts/assessment/rag-tuning/lib/report_writer.mjs` | 新增 `ceilingChunkLevel()`；`layers.retrieval` 增加 `chunk_level`；`renderCeilingSections` 增加「检索层 chunk 粒度」小节 |
| `test/assessment/ceiling_report.test.mjs` | 新增 2 条回归：chunk 粒度数值正确（含部分分与可写上界的算术）、`chunk_level` 空输入不抛错 |

**未改动**：条目级覆盖率的任何字段、facts / 呈现层口径、Gate 判定、`CEILING_CRITICALITY_WEIGHTS`、
非 ceiling 能力位的全部输出。数据源只用 `retrievalEvaluation.item_results` 里**原本就有**的
`retrieved_chunk_ids` / `missing_chunk_ids` / `source_chunk_count`，因此**不改变 `computeCeilingCoverage` 的入参契约**。

**不变量核对**：`CEILING-INTENT.md` §9.3「ceiling 模式只新增分支，不得改变 B1/B2 现有模式的任何输出」——
本轮改动全部落在 `capability === "ceiling"` 的返回块与渲染分支内，非 ceiling 路径无 `coverage` 字段，
输出逐字段不变（既有回归用例继续覆盖）。§9.4「不修改 `rag_retrieval_config.mjs`」未触碰。

### A3.2 授权与可推翻性

本轮任务由用户明确授权自主决策（原话：「如果中途有问题你自己根据你的想法做出选择就好了，不需要问我跑完全流程」）。
E3 属**新增诊断字段**、不放松任何判定（`INTENT.md` 不变量 4 仍然有效），但确实改动了
`report.coverage` 的形状，因此：

- 已记入 `INTENT.md` §12 修订索引，当前有效规则写在 `CEILING-INTENT.md` §6.2 与本节；
- **可一键回退**：删除 `layers.retrieval.chunk_level` 赋值与 `renderCeilingSections` 里的 `chunkLines` 即可，
  无其他耦合；
- 用户事后若不认可这条口径，可推翻并重跑，本轮所有结论的原始数字（池快照、缺失清单）都已落在
  `output/rag-b3-tuning/sweep-*.json`，不依赖这条新口径也能复算。

**验证**：`npm test` 88/88 通过（新增 2 条，原 86 条无回归）。

---

# 第二部分 · P3 执行记录

> 本节在扫描跑完后补全。

## 2.1 目标函数换坐标系（本轮的前提）

| | B1 / P2 | **B3 / P3** |
|---|---|---|
| 语义 | 地板：验收线，critical 丢失即 FAIL | **天花板：目标函数**，没人能全覆盖是正常状态 |
| 主分数 | Gate + 三把尺子（M1/M2/M3）+ 读取量 | `report.coverage` 分层覆盖率（本轮加 chunk 粒度） |
| 典型结论 | 「F2 读量 −18.3%，但 city:宜宾 foods/lodging 两桶归零 → 不采纳」 | 读量**不是**约束；看离理想并集还差多少材料 |

**这直接意味着 P2 的部分结论不能平移**：P2 判 F2（全主题 rerank）不达标，理由是**池容下降 + 桶被清空**。
「桶被清空」在天花板口径下仍然是坏消息（那正是材料广度损失），但「读量上升」不再是负面项。
本轮因此把 P2 的两个有效旋钮（窗口、rerank 主题范围）在**天花板口径下重新测一遍**，而不是直接沿用结论。

## 2.2 结构性上限（任何参数都翻不过去的墙）

天花板共 **273 条 item / 123 个去重证据 chunk / 84 个 critical 证据 chunk**。
逐条核对索引后：

| 项 | 数量 | 说明 |
|---|---|---|
| 证据 chunk 在索引中**根本不存在** | **2** | `037-shihai-note.md#6`（兴文石海·交通）、`049-jdt-note.md#6`（九洞天·缺点）—— 源文件的切分结果里没有这一条 |
| 因此 unique 覆盖硬上限 | **121 / 123** | 99 条里的 2 条永远捞不到 |
| critical 证据硬上限 | **83 / 84** | 上述 2 条里有 1 条是 critical |

> 结论：**critical 面在 t0 之后就基本到顶**（t0 已 82/84，抬一次配额即 83/84 = 硬上限）。
> 本轮的提升空间**几乎全在非 critical 的长尾材料**上 —— 这是本轮最重要的先验。

## 2.3 t0 缺口归因（15 条为什么没进池）

对 t0 的 `retrieval-log.json` 逐条反查，15 条缺失全部落在四类失因里，且**互不重叠**：

| 失因 | 条数 | 机制 | 能否用旋钮救 |
|---|---|---|---|
| `index_absent` | 2 | 该 chunk 在索引里不存在 | ❌ 需重建索引 |
| `cut_by_topk` | 7 | **已进 rerank 窗口、已过 0.9 阈值**，但最终排序落在 top-k=5 之外 | ✅ 抬 `placeTopK` / `cityTopK` |
| `rerank_theme_skipped` | 5 | 该主题**不在 rerank 白名单**里 → 整条请求跳过 rerank，纯一阶段排序落在 top-5 外 | ✅ `--rerank-all-themes` |
| `outside_recall_window` | 1 | 一阶段排名落在召回窗口 24 之外，**根本没进 rerank** | ✅ 抬 `recallWidth` |

**关键机制发现（本轮最硬的一条）**：默认 rerank 白名单只覆盖
景点 `highlights` / `nearby` / `routes` / `facilities` 与城市 `backup_places`，
100 个检索请求里 **67 个被 `theme_not_in_scope` 跳过**。而天花板缺口恰好集中在被跳过的主题上：

| (目标, 主题) | 缺失 chunk 数 | 是否在 rerank 白名单 |
|---|---|---|
| 九洞天景区 / drawbacks | 3 | ❌ |
| 九洞天景区 / highlights | 3 | ✅（另一失因） |
| 大山包 / highlights | 1 | ✅（另一失因） |
| 大山包 / routes | 1 | ✅（另一失因） |
| 大山包 / transport | 1 | ❌ |
| 昭通 / foods | 1 | ❌ |
| 毕节 / foods | 1 | ❌ |
| 兴文石海 / transport | 1 | ❌（且该 chunk 索引里没有） |
| 威宁百草坪 / highlights、九洞天 / routes、昭通 / backup_places | 各 1 | 混合 |

**同时排除了两个假设**（都不必再试）：

1. **L3 降权不是失因**：15 条缺失 chunk 的 `tier` 全为 0、`penalty_multiplier` 全为 1，
   在 `compareRerankedRows` 里没有吃到任何档位惩罚。P2 已判 L3 是承重结构，本轮再次确认**不要动它**。
2. **配额帽未触顶**：t0 全部目标的 `retrieval_quota.dropped_total` **均为 0**，
   即「每主题 top-5」的候选没有被总量帽截掉。P2 §2.3 第 4 条的结论在天花板样本上继续成立。

## 2.4 本轮扫描点与结果

> 扫描驱动：`output/rag-b3-tuning/sweep.mjs`（本地，不入库）。每个候选只跑检索层，
> 同一份 B3 checklist 评一次，读取 `pool_chunk_ids` / `missing_ceiling_chunks` / `chunk_level` / `R1`~`R4`。
> 结果汇总脚本：`output/rag-b3-tuning/collect.mjs`（用池快照补算**阅读池口径**的四个 chunk 粒度数字，
> 修正驱动脚本里那几个走归属口径的字段）。

共 **12 个扫描点**（< INTENT §5 的 15 组兜底上限），分三个方向：

| 方向 | 候选 | 结论 |
|---|---|---|
| 配额轴 | t0 / Q-p3c3 / Q-c10 / Q-p8 / Q-p10 / Q-p15 / Q-p8c8 / Q-p10c10 | **唯一正收益，且在 118/123 饱和** |
| rerank 主题范围 | T-A（全主题）、T-E（定向追加 3 个） | 全主题**灾难性退化**；定向追加**净负**（劣于同参数纯配额） |
| rerank 召回窗口 | T-C（单开 48） | **负收益**（池 180→173、证据 108→106） |

主结论与对照表见 [`P3-TUNING-REPORT.md`](./P3-TUNING-REPORT.md) §0 / §4；候选全表见 [`P3-SWEEP.json`](./P3-SWEEP.json)。

**指标口径提示**：`P3-SWEEP.json` 每个候选带两个字段 ——
`chunk_level_pool`（阅读池口径，有池快照的候选才有）与 `chunk_level`（驱动脚本原样输出，
`partial_credit_weighted_rate` 是归属口径）。报告 §4 的表用**池口径**，与本文件 §5 的说明一致。

## 2.5 本轮确认的机制事实（供后续轮次复用）

1. **配额是天花板口径下唯一有效的主轴**：证据 chunk 去重覆盖 108 → 118（硬上限 121），
   critical 证据 82 → 83（**已触硬上限**），facts 层可写上界 78.8% → 91.4%。
2. **`--rerank-all-themes` 是有害旋钮，不只是无效**：池 180 → 153、证据 108 → 84、
   critical 证据 82 → 62、可写上界 78.8% → 43.7%、R1 96.9% → 76.9%。
   P2 判它「不采纳」，本轮升级为「**应排除出搜索空间**」。
3. **机制是 rerank query 模板缺失**，不是「rerank 本身不好」：
   `RAG_RERANK_DEFAULTS.queryTemplates` 只覆盖默认白名单那 5 个主题，
   其余主题走兜底句 `请判断下面材料是否有助于回答「{名称} 的 {主题} 相关旅行信息」。`，
   在 `probThreshold 0.9` 下被大量误杀，且**顺序无依据** → 净损失。
   旁证：即使有模板的主题，过滤也很狠（t0 日志里 `五尺道|routes` 送 24 条只留 1 条）。
   → **要扩主题范围，必须先补 `queryTemplates`，不能只加白名单。**
4. **定向追加主题也不划算**：`T-E`（追加 `drawbacks`/`transport`/`foods`）与 `T-F`（纯配额、
   其余参数完全相同）对照 —— unique 117 vs 118、部分分 98.1% vs 98.3%、可写上界打平，
   耗时 **1509s vs 682s**。逐条核对：T-E 比 T-F **多丢** `049-jdt-note.md#5`。
5. **窗口 24 仍是当前最优**（P2 §2.3 第 5 条在天花板口径下复现）：单开 48 → 池 173、证据 106。
6. **L3 降权与总量帽继续被排除**：15 条缺失 chunk 的 `tier`/`penalty_multiplier` 全为中性；
   t0 全部目标 `dropped_total = 0`。
7. **条目级检索覆盖率在扩容索引上会饱和**（8 个配额档位同为 273/273），
   跨参数组排序必须用 chunk 粒度（E3，见 §A3）。

## 2.6 缺口终局（推荐配置下的 5 条）

| chunk | 类型 | 可救性 |
|---|---|---|
| `037-shihai-note.md#6`（兴文石海·交通） | **索引里不存在** | ❌ 唯一仍缺的 critical 证据 |
| `049-jdt-note.md#6`（九洞天·缺点） | **索引里不存在** | ❌ |
| `030-jdt-note.md#6`（九洞天·看点） | rerank 最终排名 > 10 | ⚠️ 理论可救 |
| `昭通大山包.md#14`（大山包·看点） | rerank 最终排名 19 | ⚠️ 理论可救 |
| `034-zhaotong-note.md#3`（昭通·备选景点） | 一阶段排名 > 召回窗口 24 | ⚠️ 窗口已判负 |

**critical 面已到绝对上限（83/84）**：唯一缺的那条在索引里不存在，任何参数都补不上。
**118/123 是本索引 + 本 rerank 配置下的实际可达上限**，剩余 3 条「理论可救」依赖的两个旋钮已实测为负收益。

## 2.7 B1 落地复核（2026-09-21，用户指令触发）

用户指令：用「广度模式」参数跑一次 B1 复核，结论可接受则直接改默认值。
完整记录见 [`B1-RECHECK.md`](./B1-RECHECK.md)；run = `../../runs/20260921-0815-B1-wide-quota/`。

**设置**：`place_top_k=10` / `city_top_k=10` / `max_place_chunks=100` / `max_city_chunks=50`，
rerank 全套不动；索引与检索模式同 B1 基线（337 chunk、embedding + rerank、rw24）。

**结果**：

| 指标 | 基线 5/5/50/25 | 广度模式 10/10/100/50 |
|---|---|---|
| 阅读量 | 82 | **110（+34.1%）** |
| R1 / R2 | 0.7797 / 0.8136 | **0.9153 / 0.9153** |
| facts.N1 / N2 | 0 / 2 | 0 / **0** |
| Gate | 全过 | 全过 |

**判定：不落地。** §1.3 条件 1、2 通过；条件 3 **不通过**（读量超窗，省读型与增密型两条路径都不通）；
条件 4 无可比 B2 基线。默认值维持 `5/5/50/25`。

**本轮最重要的机制发现（后续轮次必看）**：
改检索配额**必须同步补写 facts**。池 82→110 后，26 条原本归因在**检索层**（未召回）的条目
批量转为归因在 **facts 层**（已召回但未写）→ 不补写则 N1 0→11、Gate G2 直接 FAIL。
这是**归因层级上移**，不是 facts 质量退化。首版报告因此在未补 facts 时报 FAIL。

**实质收益（扩容的真实价值）**：基线 2 条被裁定为 `false` 的条目，理由是「该信息在本次阅读池中不存在」；
本轮证据首次入池后均已补齐 → **N2 2→0**。读得多才写得全，这是扩容不可被调参替代的收益。

## 2.8 执行纪律记录

- 索引副本落在 `output/rag-b3-tuning/rag-index.json`（用户提供的原件拷贝），**未就地覆盖上游产物**。
- 骨架 facts 由 `npm run create-workspace` 基于批次 `20260907` 的 `route-structure.json` 生成，
  **未复用 B1/B2 的既有基线文件**。
- 全程只用 CLI 覆盖参数，`scripts/rag/rag_retrieval_config.mjs` 的**运行时参数零改动**
  （E3 改的是评估脚本的报告口径，不是检索参数）。**本轮未落地任何参数**（理由见报告 §6.2）。
- 一个候选（T-D「全主题 + 窗口 48 + 配额 10/10」）在 T-A 出来后**提前终止**（已运行 73 分钟），
  理由：all-themes 轴已被 T-A 决定性判负；损伤来自阈值过滤而非 top-k 帽，抬配额补不回；
  且该旋钮无法持久化（`INTENT.md` §2.1.1）。该候选无落盘产物，不在 `P3-SWEEP.json` 内 ——
  这是本轮唯一已知的覆盖缺口（报告 §9.6）。
- 临时文件全部在 `output/rag-b3-tuning/`（不入库），交付前核查 `git status`。
- **B1 落地复核（09-21）全程只走 CLI 覆盖**，`scripts/rag/rag_retrieval_config.mjs` 的默认值
  **保持 `5/5/50/25` 未改动**（经 `git diff` 校验为零改动）—— 复核结论是不落地，故无需回滚。
  B1 基准 facts 文件 `output/rag-expanded-baseline/facts-workspace.json` **未被覆盖**：
  补写落在新文件 `output/rag-b3-tuning/facts-workspace-b1-wide.json`，符合 §7 不变量 3。

## 2.9 后续（09-21）：广度模式落为具名可选档位

复核结论「不落地」之后，用户决定走**第三条路**：不修订 §1.3、也不改 skill 定位，
而是把该配额组落成**显式可选档位** `RAG_READ_PROFILES.wide` + CLI `--read-scope wide`。

- `default` 档数值一字未动（仍 5/5/50/25）。上一节「默认值零改动」在**数值层面**依然成立；
  但 `rag_retrieval_config.mjs` 本身**不再是零 diff**（新增档位表 + 四个配额字段改为由 default 档派生）。
  默认行为已实测等价：用 `output/rag-expanded-baseline/` 复现既有产物，与旧产物逐字段对比
  仅差新增的 `retrieval.read_scope` 与 `source` 路径簿记，阅读池 82 条与 chunk id 集合完全一致。
- `--read-scope wide` 与复核时手传的四个原子参数**逐字段等价**：把它跑在本轮 B1 的同一份
  facts + 索引上，产物与 `output/rag-b3-tuning/retrieval-workspace-b1-wide.json` 对比
  仅差 `retrieval.read_scope` 与 `source.retrieval_log`（未传 `--log`），阅读池同为 110 条、id 集合一致。
- 判据层面**没有变化**：只有默认档受 §1.3 约束，可选档不进默认值判定。§1.3 未修订。
- 新增 `test/read_scope.test.mjs`（13 条），含一条针对「CLI 漏转发档位字段导致静默失效」的回归。

