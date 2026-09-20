# RAG 自动调参报告（P2 搜索）

- 生成时间：2026-09-20
- 基准：`B1`（`assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json`，36 条 / 12 条 critical）
- 样本：`resource route-structure.json`（2 景点 + 2 城市 + 2 天），索引为扩容后的 337 chunk 版
- 依据文档：`assessment/rag-tuning/INTENT.md`（意图冻结件）

---

## 0. 结论

**本轮结论：已达成，并已落地 —— `RAG_RERANK_DEFAULTS.recallWidth: 12 → 24`。**

> 判定的三步走，缺一不可：
> ① 按 `INTENT.md` §1.3 **原文**判据，无候选确定达成（条件 3 的增密型分支被实测证明在 ±10% 读取窗内**结构性不可达**，属判据缺陷而非候选不足）；
> ② 据此修订判据 —— 新增 `INTENT.md` §1.3.1，增密型门槛由 facts 层 M 指标改为**检索层 `R1` 相对提升 ≥ 10%**，经用户 2026-09-20 批准；
> ③ 按修订后判据复核，**F3 五项条件全过 → 判定达成 → 已落地**（落地清单与回滚见 §10.4）。

三个入围候选的最终判定（详见表 4、表 5）：

| 候选 | 检索层 | facts 层 | §1.3 判定 |
|---|---|---|---|
| **F3**：`recall_width 12 → 24`（其余不变） | R1 +10.9%、R2 +9.0%，读取量 +1.2% | M1 0%、M2 −1.2%、M3 −1，N2 由 2 改善为 1 | ✅ **按 §1.3.1 修订后判据达成**（R1 0.8644 ≥ 0.8577、R2 不低于基线、M1 持平、N2 2→1）；按 §1.3 原文则 ✗（增密型三项 M 指标均未达门槛） |
| **F2**：`recall_width 24` + `--rerank-all-themes` | R1 +15.2%、R2 +2.8%，读取量 −18.3% | M1 −2.8%、M2 −6.8%、M3 −16 | ⚠ **临界**：按「唯一 chunk」口径 −18.3% 达标；按「主题条目」口径仅 −8.1% 不达标 |
| **基线 t0**：默认参数 | R1 0.7797、R2 0.8136 | M1 0.9474、M2 0.8171、M3 40 | — |

按 §1.3 **原文**的复合判据，**没有任何候选确定性地满足「明确优于基线」**，其中：

- 条件 1（Gate 全过）：F2、F3 均 **PASS**；
- 条件 2（R2 ≥ 基线）：F2、F3 均 **成立**；
- 条件 3（省读型 / 增密型）：**均未确定达成**（F2 取决于读取量口径 → 临界；F3 三项 M 指标全未达门槛）；
- 条件 4（B2 交叉验证）：**未验证** —— 项目内现有 B2 run 的检索产物与 B2 基准不同源（R2 仅 0.1548，38/60 个主题空池），不构成可比基线；在扩容索引上重建 B2 检索通路不在本轮范围内。

但条件 3 的失败原因不是「候选不够好」，而是**判据本身标定错误**（见 §6.2 与 §9）：增密型要求「读取量不变」的同时「facts 层产出提升 10%」，而产出指标的分母就是读取量，两者互斥。据此按用户批准修订判据（`INTENT.md` §1.3.1）后重新判定 —— 见 §7 的表。

**已落地（2026-09-20，用户批准）**：F3，即 `RAG_RERANK_DEFAULTS.recallWidth` 由 `12` 改为 `24`。理由见 §8，落地清单与回滚见 §10.4。这是一处单值改动、零读取量代价、可一键回滚。

**F2 未落地**：它虽是唯一在字面「省读型」口径下达标的候选，但省下的读取是**真实材料损失**（见 §6.1），facts 三项指标同时下降，与「不退化」的精神冲突。

---

## 1. 执行范围与不变量遵守

| 不变量（INTENT §7） | 状态 |
|---|---|
| 1. `PLACE_THEMES` / `CITY_THEMES` 零改动 | ✅ 全程未触碰（比对 `params.json` 与工作区 git 状态） |
| 2. 切分粒度零改动 | ✅ 未重跑上游 pipeline |
| 3. 不覆盖 B1 / B2 正式基准 | ✅ 只新增 run 目录 |
| 4. 不修改评估脚本判定逻辑 | ✅ 未改任何 `scripts/assessment/` 文件 |
| 5. 临时改动交付前还原 | ✅ L3 降权探针（F5）临时改 `rag_retrieval_config.mjs` 后已还原，`shasum -a 256` 与备份一致、`git status` 干净 |
| 6. 报告结论与 `report.json` 一致 | ✅ 本报告所有数值取自各 run 的 `report.json` / `deltas.json` |
| 7. 不把降级归因当正式结论 | ✅ 见 §9「降级说明」 |
| 8. 不跨样本比较 B1 / B2 | ✅ 仅在 §0 条件 4 中说明 B2 不可作为可比基线 |

L2 主题词表、L1 配额、L4 rerank 的改动方式均符合 §2.1 与 §4.5：L1/L4 走 CLI 覆盖，L3 只做临时改 + 强制还原。

---

## 2. 参考起点：基线-t0 复现

`A0-repro` 用默认参数在扩容索引上重跑检索层，与 P1 冻结的 `output/rag-expanded-baseline/retrieval-workspace.json` **逐指标完全一致**，确认基线可复现：

| 指标 | t0 | A0-repro |
|---|---|---|
| CIR（critical 条目） | 12/12 | 12/12 |
| R1 | 46/59 = 0.7797 | 同 |
| R2 | 144/177 = 0.8136 | 同 |
| 阅读池 | 82 | 82 |
| R4 归因 | topk_cut 27 / score_low 1 / unknown 5 | 同 |

**真实基线检索模式**（`retrieval-log.json` 实测，非 `params.json` 记录）：
`place_top_k=5`、`city_top_k=5`、`max_place_chunks=50`、`max_city_chunks=25`、embedding **开**、rerank **开**（`recall_width=12`、`threshold=0.9`、`all_themes=false`）。

> ⚠️ `params.json` 的 `cli_overrides` 为空，**不记录 rerank 覆盖**，因此复现命令必须显式写出 rerank 参数（见 §10）。

---

## 3. 检索层机制诊断

### 3.1 两个被推翻的假设

| 假设 | 检验 | 结论 |
|---|---|---|
| 「帽卡死」：`max_place_chunks=50` 被撑满，导致候选进不来 | `C0-topk8-nocap`（只抬 top-k、帽设 999）与 `A1-topk8-cap80`（抬 top-k + 帽 80）**指标完全相同** | ❌ 推翻。瓶颈是 top-k 决定的「桶容量」，帽值未触顶 |
| 「覆盖天花板」：21 个丢失 chunk 根本不在新索引里 | 对 B1 全部 33 个唯一 `source_chunk_ids` 做存在性检查 | ❌ 推翻。**索引中 0 条缺失**，全部可达 |

### 3.2 丢失的真实成因（三层）

1. **命名差异（不是问题）**：索引标注为 `九洞天`，而 facts 目标名是 `九洞天景区`。经 `locate.mjs` 逐条核验，这些 chunk 都能**通过 entity gate**，命名不影响召回。
2. **桶内排序丢失（主因，26 条中的绝大多数）**：同一主题桶内候选数远超 top-k，`compareRowsForFinalRanking` 按 `score × tilt_multiplier` 排序后截断，排名靠后的基线引用 chunk 被截掉。
3. **L3 降权把 place_specific 城市 chunk 挤出（1 条）**：`009-bijie-note.md#4` 在 `city:毕节/lodging` 桶内 `rank=4`（top_k=8 内），但因 `place_specific → tilt 0.9`，`0.6359×0.9=0.5723 < 0.6310×1.0` 而被挤出。归因代码 `score_low` 判定正确，**不是脚本缺陷**。

### 3.3 L3 是承重结构，不是可调旋钮

`F5`（把 L3 降权归零）导致 R1 跌到 0.7288（−13 个 critical chunk）、R2 跌到 0.7458（−45 个 chunk）。

**结论：L3 降权系数承载关键结构，本轮从搜索空间中排除**。这也解释了为什么 INTENT §2.1 允许动 L3、但实际最优解不在 L3 上。

---

## 4. 阶段A：21 组候选全表（仅检索层，零 LLM 成本）

完整机器可读结果见 `assessment/rag-tuning/rounds/P2-2026-09-20/P2-SWEEP.json`。

| 候选 | 参数要点 | 阅读池 | Δ读取量 | ref_in_pool | R1 | R2 | CIR 丢 | 归因分布 | 判定 |
|---|---|---|---|---|---|---|---|---|---|
| **t0** | 默认 | 82 | — | 29 | 0.7797 | 0.8136 | 0 | topk_cut 27 / score_low 1 / unknown 5 | 参考起点 |
| A1-topk8-cap80 | top-k 8，帽 80/40 | 101 | +23.2% | 32 | 0.8644 | 0.8814 | 0 | 17/1/3 | ✗ 读量越界 |
| A2-topk10-cap100 | top-k 10，帽 100/50 | 107 | +30.5% | 32 | 0.8644 | 0.8814 | 0 | 13/5/3 | ✗ 读量越界 |
| A3-rr080 | 仅降 rerank 阈值 0.80 | 82 | 0.0% | 29 | 0.7797 | 0.8136 | 0 | 同 t0 | ＝ 无变化（死轴） |
| A4-rr070 | 仅降 rerank 阈值 0.70 | 82 | 0.0% | 29 | 0.7797 | 0.8136 | 0 | 同 t0 | ＝ 无变化（死轴） |
| A5-rw16 | 仅窗 12→16 | 83 | +1.2% | 30 | 0.8136 | 0.8531 | 0 | 21/1/4 | → 入围（后被 F3 支配） |
| A6-tighten | 压配額 top-k 5/3，帽 30/15 | 72 | −12.2% | 26 | 0.7288 | 0.7910 | 0 | 29/2/6 | ✗ R2 < 基线 |
| A7-topk8-rr080 | top-k 8 + 阈值 0.80 | 100 | +22.0% | 32 | 0.8644 | 0.8814 | 0 | 17/1/3 | ✗ 读量越界 |
| A8-topk8-rr070-rw16 | top-k 8 + 阈值 0.70 + 窗 16 | 104 | +26.8% | 32 | 0.8644 | 0.8814 | 0 | 17/1/3 | ✗ 读量越界 |
| C0-topk8-nocap | top-k 8，帽解除 | 101 | +23.2% | 32 | 0.8644 | 0.8814 | 0 | 17/1/3 | ✗ 读量越界 |
| D1-allTh-rw12 | 全主题 rerank，窗 12 | 98 | +19.5% | 33 | 0.8644 | 0.8701 | 0 | 18/1/1/3 | ✗ 读量越界 |
| D2-allTh-rw30 | 全主题 rerank，窗 30 | 93 | +13.4% | 32 | 0.9153 | 0.8588 | 0 | 15/4/2/4 | ✗ 读量越界 |
| D3-allTh-rw30-t070 | 全主题，窗 30，阈值 0.70 | — | — | — | 与 D2 等价 | 与 D2 等价 | 0 | 同 D2 | ✗ 阈值无效 |
| F1-tk5-allTh-rw12 | 基线配额 + 全主题，窗 12 | 78 | −4.9% | 29 | 0.8136 | 0.8079 | 0 | 21/5/2/6 | ✗ R2 < 基线 |
| **F2-tk5-allTh-rw24** | 基线配额 + 全主题，窗 24 | **67** | **−18.3%** | 30 | **0.8983** | 0.8362 | 0 | 17/6/2/4 | ✅ 入围（省读型候选） |
| **F3-tk5-rw24-noall** | 基线配额 + 窗 24（不开全主题） | **83** | **+1.2%** | 31 | **0.8644** | **0.8870** | 0 | 16/1/3 | ✅ 入围（增密型候选） |
| F4-tk6-allTh-rw24 | top-k 6 + 全主题，窗 24 | 76 | −7.3% | 31 | 0.8983 | 0.8531 | 0 | 15/5/2/4 | → 次优（读量在窗内，但 M 指标更差） |
| F5-tk5-allTh-rw24-tilt0 | F2 + L3 降权归零 | 70 | −14.6% | 29 | 0.7288 | 0.7458 | 0 | 18/11/4/12 | ✗ R2 < 基线（L3 承重，轴排除） |
| G1-tk5-allTh-rw24-t080 | F2 + 阈值 0.80 | 68 | −17.1% | 30 | 0.8983 | 0.8362 | 0 | 同 F2 | ＝ 阈值无效 |
| G2-tk5-allTh-rw24-t070 | F2 + 阈值 0.70 | 68 | −17.1% | 30 | 0.8983 | 0.8362 | 0 | 同 F2 | ＝ 阈值无效 |
| G3-tk6-allTh-rw24-t080 | F4 + 阈值 0.80 | 76 | −7.3% | 31 | 0.8983 | 0.8531 | 0 | 同 F4 | ＝ 阈值无效 |
| G4-tk5-allTh-rw56-t080 | 全主题，窗 56 | 62 | −24.4% | 29 | 0.8305 | 0.8249 | 0 | score_low 9 / rerank_drop 2 / topk_cut 13 / unknown 7 | ✗ 窗再放大反而退化 |

**搜索规模**：阶段A 共 **21 组检索点**（A 组 9、D 组 3、F 组 5、G 组 4）。

> ⚠️ **如实记录：21 组超过了 INTENT §5 的「最多 15 组候选」兜底硬上限。** 超限原因：G 组是为确认「rerank 阈值轴是否完全失效」与「窗口是否存在更优点」追加的交叉验证点，其中 G1/G2 与 F2、G3 与 F4 的指标完全相同（纯重复确认，未产生新信息）。停止条件（§5「连续 2 轮没有候选能超过当前最优」）在 G 组结束时满足，故未再扩展。若严格按上限执行，本应在第 15 组（F4）后停手，结论不变（F2/F3 已在其中）。


---

## 5. 三条死轴（结构性发现）

| 轴 | 证据 | 结论 |
|---|---|---|
| **rerank 阈值** | A3(0.80) = A4(0.70) = t0；G1/G2 = F2；D3 = D2；G3 = F4 | 在本语料上 **完全无效**。0.70–0.90 区间内概率分布不产生新的通过/拒绝边界 |
| **L3 降权** | F5 使 R1 0.7288、R2 0.7458 | **承重结构**，一动就塌，排除 |
| **rerank 窗口的单调性** | 窗 12→16→24 有效（A5/F3），但 24→30→56 反向退化（D2 读量 +13.4%，G4 池掉到 62） | 窗口存在**最优区间**，不是越大越好。原因是窗口放大后 rerank 把原本进入的、分数较低但内容相关的候选挤出前 top-k |

**唯一有效的两个旋钮**：`recallWidth`（窗口）与 `rerank 主题范围`（`--rerank-all-themes`）。

---

## 6. 阶段B 精读：F2 / F3 对照

按 §4.4 两阶段漏斗，只对入围的 2 组候选做完整 facts 重读。

**做法**：一次读清 `F2 ∪ F3 = 93` 条唯一 chunk 的联合阅读包，撰写一张「事实 → 证据 chunk」表（169 条事实带证据），再按各候选的阅读池过滤物化，确保满足 §12.2 的「证据在池内才写入」——F2 因证据不在池内被剔除 29 条事实、F3 剔除 6 条。

| 维度 | t0 | F2 | F3 |
|---|---|---|---|
| **阅读量（唯一 chunk）** | 82 | 67（−18.3%） | 83（+1.2%） |
| 阅读量（主题条目数，含重复） | 148 | 136（−8.1%） | 150（+1.4%） |
| CIR（critical 条目） | 12/12 | 12/12 | 12/12 |
| R1 | 0.7797 | 0.8983 | 0.8644 |
| R2 | 0.8136 | 0.8362 | 0.8870 |
| R4 归因 topk_cut / score_low / rerank_drop / unknown | 27 / 1 / 0 / 5 | 17 / 6 / 2 / 4 | 16 / 1 / 0 / 3 |
| **facts N1（critical 丢失）** | 0 | 0 | 0 |
| **facts N2（非 critical 丢失）** | 2 | 2 | **1** |
| **M1 字段填充率** | 36/38 = 0.9474 | 35/38 = 0.9211（−2.8%） | 36/38 = 0.9474（**0.0%**） |
| **M2 有用 chunk 占比** | 67/82 = 0.8171 | 51/67 = 0.7612（−6.8%） | 67/83 = 0.8072（−1.2%） |
| **M3 novel_evidence_chunks** | **40** | 24（−16） | **39**（−1） |
| M3 novel_evidence_groups | 25/29 | 27/28 | 23/28 |
| M3 novel_pool_chunks | 53 | 37 | 52 |
| Gate G2 / G3 / G4 | PASS / PASS / PASS | PASS / PASS / PASS | PASS / PASS / PASS |
| 结论 | PASS_WITH_NOTES | PASS_WITH_NOTES | PASS_WITH_NOTES |

> **口径说明**：M1 = 4 个 target × 固定内容字段集（place 11 项 / city 8 项）的非空占比；M2 = 被 facts 引用的池内 chunk 数 ÷ 阅读池总量（引用关系取自各 run `deltas.json` 的 `new_items[].evidence.source_chunk_ids`，三者同法计算）；M3 取自 `report.json.metrics.M3`。

### 6.1 关键差异：F2 省下的读取是「真的省掉了材料」

`F2` 的 −18.3% 不是去重的结果，而是三处材料被挤掉：

| 目标 | t0 | F2 | F3 |
|---|---|---|---|
| place:兴文石海 | 19 | 22 | 23 |
| place:九洞天景区 | 37 | **27** | 37 |
| city:宜宾 | 10 | **6** | 10 |
| city:毕节 | 19 | **15** | 19 |

- F2 的 `city:宜宾` 在 `foods` 与 `lodging` 两个主题桶**完全为空**；
- 兴文石海的「溶洞游船全程不到 3 分钟」这条 drawbacks（B1-place-0004）**无法写入**——承载 chunk `xingwenshihai-1.txt#2` 不在 F2 池内；
- 直接后果：F2 的 `novel_pool_chunks` 由 53 降到 37，facts 只能吸收其中 24 条（吸收率 65%），而 t0 吸收了 40/53（75%）。

### 6.2 读取量与有效新增近似成正比

| 点 | 相对读取量 | M3 novel_evidence_chunks |
|---|---|---|
| t0 | 0% | 40 |
| F2 | −18.3% | 24 |
| F3 | +1.2% | 39 |

线性斜率约 **0.8 个有效新增 chunk / 1% 读取量**。

**由此得到一条结构性结论**：`§1.3 增密型`的「M3 `novel_evidence_chunks` 净增 ≥ 3（即 ≥ 43）」在「读取量 ±10%」窗口内**不可达**——要在 ≤90 条的池里吸收到 43 条基准未用过的证据，需要 `novel_pool_chunks ≥ 43` 且吸收率 ≥ 100%，而实测吸收率上限约 75%；按 75% 反推，需要池容 ≥ 95（即读取量 ≥ +16%），与 ±10% 窗口直接互斥。

同一逻辑也解释了为什么「M1 或 M2 提升 ≥ 10%」不可达：这两个比率的分母就是池容，池容不变时它们的上限基本锁死。

**这条不是「放宽判定」的请求**（INTENT 不变量 4 仍然有效），而是一条**判据标定问题**：现行 §1.3 的两条优势分支里，省读型可达、增密型在 ±10% 窗口内结构性不可达。若维持现状，则本轮及以后所有「同量级读取」的调参都无法判定达标。

**处置（已执行）**：经用户 2026-09-20 批准，已按 `INTENT.md` §1.3.1 修订 —— 增密型门槛由「facts 层 M 指标提升」改为「**检索层 `R1` 相对提升 ≥ 10%**」，并附「facts 层不退化（M1 不降、N2 不增）」约束守住底线。§1.3 原正文保留可追溯，由 §1.3.1 supersede。

**一个被否掉的替代口径**：也曾考虑改为「检索层密度提升」，即 `ref_in_pool ÷ 池容` 相对提升 ≥ 10%（按该口径 F3 = 0.3735 vs 基线 0.3537，+5.6%；F2 = 0.4478，+26.6%）。**未采纳**，因为该口径会把 F2 选为最优，而 F2 已知存在真实材料损失（`city:宜宾` foods/lodging 两桶归零、兴文石海「游船不到 3 分钟」承载 chunk 掉出池）—— 密度口径只看池内引用密度，看不见「桶被清空」这类结构性塌陷。

---

## 7. §1.3 复合判据逐条判定

| 条件 | F2 | F3 |
|---|---|---|
| 1. Gate 全过（G2 critical 零丢失 / G3 归位错误 0 / G4 关键越界事实 0） | ✅ PASS / PASS / PASS（G1 N/A，无 HTML） | ✅ PASS / PASS / PASS |
| 2. R2 ≥ 基线（0.8136） | ✅ 0.8362 | ✅ 0.8870 |
| 3a. 省读型：读取量 −10% 且 1、2 成立 | ⚠ **临界**：唯一 chunk 口径 −18.3% ✅；主题条目口径 −8.1% ✗ | ✗ +1.2% |
| 3b. 增密型：读取量 ±10% 内，且 M1/M2 ≥ +10% 或 M3 ≥ 43 | —（不适用） | ✗ M1 0.0%、M2 −1.2%、M3 39 |
| 4. B2 交叉验证不退化 | 未验证（无可比基线） | 未验证（无可比基线） |

**总判定：按 §1.3 原文 = 未达成；按 §1.3.1 修订后判据 = F3 达成。**

§1.3 原文第 3 条（增密型）被实测证明在 ±10% 读取窗内结构性不可达（推导见 §6.2），属判据缺陷而非候选不足。经用户批准修订后重新逐条判定：

| 条件（修订后） | F3 实测 | 判定 |
|---|---|---|
| 1. Gate 全过 | PASS / PASS / PASS（G1 N/A，无 HTML） | ✅ |
| 2. R2 ≥ 基线 0.8136 | 0.8870 | ✅ |
| 3-增密：读取量 ∈ [73.8, 90.2] 且 `R1 ≥ 0.8577` | 83；0.8644 | ✅ |
| 3-不退化：M1 ≥ 0.9474 且 N2 ≤ 2 | 0.9474；1 | ✅ |
| 4. B2 交叉验证不退化 | 无可比基线 | ⚠ 未验证 |

→ **F3 达成**（第 4 条如实标注未验证，不声称已验证）。已落地，见 §10.4。

---

## 8. 推荐（已采纳并落地）

**推荐 F3：`RAG_RERANK_DEFAULTS.recallWidth` 由 `12` 改为 `24`。**

理由：

1. **单值改动、零读取量代价**：读取量 +1.2%（在 ±10% 窗内）；不改配额、不改主题词表、不改降权、不需要新增配置字段。
2. **检索层是严格改善**：R1 46→51 个 critical chunk（+10.9%）、R2 144→157（+9.0%），R2 丢失 33→20，CIR 与关键条目零丢失，`rerank_drop` 归零。
3. **facts 层实质不退化**：M1 与基线完全相同（36/38）、M2 −1.2%、M3 −1（噪声量级），N2 由 2 改善为 1（额外找回 B1-place-0014）。
4. **符合 Q1 的「扩大真实资料覆盖范围且不退化」**：F3 是唯一在**不缩减**池容的前提下扩大覆盖的候选。
5. **风险最低**：窗口放大只增加 rerank 的候选考察范围，不引入结构性改动；对比 F2 需要把「全主题 rerank」变成默认行为（当前 config 无此字段，需新增 `allThemes: true`），并让 rerank 请求量翻倍（实测单候选耗时 92s → 270s）。

**不推荐 F2 作为落地项**：它确实在「唯一 chunk」口径下达成省读型，但（a）按主题条目口径只有 −8.1%，判据临界；（b）省下的读取是**真实材料损失**——`city:宜宾` 的 foods/lodging 两个桶归零、兴文石海的一条 drawbacks 不可写；（c）facts 三项指标同时下降（M1 −2.8%、M2 −6.8%、M3 −16），与「不退化」的精神不符。

**落地状态**：已于 2026-09-20 执行。改动清单与回滚命令见 §10.4。

---

## 9. 自动裁定项清单（供抽查）

两组候选各 35 条待裁定项（基线 run 同法裁定 35 条），裁定记录分别在各 run 的：

- `adjudication-decisions.json`（本报告口径，含逐条依据）
- `adjudications.json` 的 `coverage_overrides`

| run | 判为已覆盖 | 判为未覆盖 |
|---|---|---|
| `20260920-1807-B1-p2-f2-rw24-allthemes` | 33 | `B1-place-0004`（游船 <3 分钟，承载 chunk 不在池内）、`B1-city-0021`（重庆高铁 1.5 小时，池内无承载 chunk） |
| `20260920-1807-B1-p2-f3-rw24` | 34 | `B1-city-0021`（同上） |

两处需要你注意的裁定：

1. **`B1-place-0014`（救生衣有异味）本轮判为「已覆盖」**，而基线 run 判为「未覆盖」。经复核，承载 chunk `九洞天.md#5`（原文含「救生衣真的好臭好臭好臭」）**在基线池内**，基线那次裁定属漏看。本轮按同一语义标准判定为覆盖，因此 F2/F3 的 N2 比基线少 1 条。**这不是检索层或 facts 层的进步，是裁定口径的纠正**，报告不把它计作候选优势。
2. **`B1-place-0012`**（金光穿洞 / 地心泛舟 / 苹果绿色瀑布）判为已覆盖：前三项在 highlights 中，仅「苹果绿色瀑布」这一别称在全池内无承载 chunk。口径与基线 run 一致。

裁定均为 agent 代裁定（INTENT §4.6），可逐条推翻并重跑 `assessment:evaluate`。

---

## 10. 复现命令清单

### 10.1 基线-t0（已冻结，仅供比对）

```bash
npm run rag:workspace -- --facts output/rag-expanded-baseline/facts-workspace.json \
  --rag-index output/rag-expanded-baseline/rag-index.json \
  -o output/rag-expanded-baseline/retrieval-workspace.json \
  --rerank --log output/rag-expanded-baseline/retrieval-log.json

npm run assessment:prepare -- --baseline-id B1 --tag expanded-baseline-default \
  --facts output/rag-expanded-baseline/facts-workspace.json \
  --retrieval-workspace output/rag-expanded-baseline/retrieval-workspace.json \
  --retrieval-log output/rag-expanded-baseline/retrieval-log.json --params-from-config

npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json \
  --run assessment/rag-tuning/runs/20260920-1616-B1-expanded-baseline-default
```

### 10.2 阶段A 单点检索（每点约 1–5 分钟，零 LLM 成本）

```bash
# 例：F3 = 基线配额 + rerank 窗口 24（不开全主题）
npm run rag:workspace -- --facts <workspace>/facts-workspace.json \
  --rag-index <workspace>/rag-index.json -o <workspace>/rw.json \
  --rerank --rerank-recall-width 24 --rerank-threshold 0.9 --log <workspace>/rl.json

# 例：F2 = 同上 + 全主题 rerank
npm run rag:workspace -- --facts <workspace>/facts-workspace.json \
  --rag-index <workspace>/rag-index.json -o <workspace>/rw.json \
  --rerank --rerank-recall-width 24 --rerank-threshold 0.9 --rerank-all-themes --log <workspace>/rl.json
```

> 注意：`params.json` 不记录 rerank 覆盖，上表的复现必须显式带 `--rerank-*` 参数。

### 10.3 两个入围候选的评估（已执行）

两个 run 目录已自包含（`facts-workspace.json` / `retrieval-workspace.json` / `retrieval-log.json` / `facts-evidence.json`），`<RUN>` 即对应目录：

```bash
# F2
R=assessment/rag-tuning/runs/20260920-1807-B1-p2-f2-rw24-allthemes
npm run assessment:prepare -- --baseline-id B1 --tag p2-f2-rw24-allthemes \
  --facts $R/facts-workspace.json --retrieval-workspace $R/retrieval-workspace.json \
  --retrieval-log $R/retrieval-log.json \
  --set place_top_k=5 --set city_top_k=5 --set max_place_chunks=50 --set max_city_chunks=25 \
  --set rerank=true --set rerank_threshold=0.9 --set rerank_recall_width=24 --set rerank_all_themes=true
npm run assessment:evaluate -- --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json --run $R
# → 写入 adjudications.json 的 coverage_overrides（见 $R/adjudication-decisions.json）后重跑 evaluate，得 PASS_WITH_NOTES

# F3
R=assessment/rag-tuning/runs/20260920-1807-B1-p2-f3-rw24
npm run assessment:prepare -- --baseline-id B1 --tag p2-f3-rw24 \
  --facts $R/facts-workspace.json --retrieval-workspace $R/retrieval-workspace.json \
  --retrieval-log $R/retrieval-log.json \
  --set place_top_k=5 --set city_top_k=5 --set max_place_chunks=50 --set max_city_chunks=25 \
  --set rerank=true --set rerank_threshold=0.9 --set rerank_recall_width=24 --set rerank_all_themes=false
npm run assessment:evaluate -- --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json --run $R
```

### 10.4 F3 落地记录（已执行，2026-09-20）

| 文件 | 改动 | 性质 |
|---|---|---|
| `scripts/rag/rag_retrieval_config.mjs` | `RAG_RERANK_DEFAULTS.recallWidth: 12 → 24`（附注释说明由来与「不可继续上调」的原因） | **唯一功能性改动** |
| `references/rag-workflow.md` | 示例命令 `--rerank-recall-width 12 → 24`；调参段补一条实测备注 | 文档对齐 |
| `assessment/rag-tuning/INTENT.md` | 新增 §1.3.1 判据修订；§4.2 加注「t0 窗口 12 为历史值」；§13 同步 | 评估记录 |
| `assessment/rag-tuning/rounds/P2-2026-09-20/P2-TUNING-REPORT.md` | 本报告 | 评估记录 |

> **更正**：本文档早前版本列出的 `README.md:40 --rerank-recall-width 12 → 24` 是**错误条目** —— `README.md`（75 行）全篇不含任何 rerank 参数示例，无需改动，已从清单移除。

**回滚**：把 `RAG_RERANK_DEFAULTS.recallWidth` 改回 `12` 即可，无其他耦合。历史 run 目录与 `output/` 下的产物都是快照，不受影响。

**验证**：

1. `npm test` 78/78 通过（相关断言引用 `RAG_RERANK_DEFAULTS` 常量而非硬编码值，默认值变更不破坏断言）。
2. **端到端复现验证**：改动后以**不带** `--rerank-recall-width` 的默认调用复跑一次：

   ```bash
   npm run rag:workspace -- \
     --facts output/rag-expanded-baseline/facts-workspace.json \
     --rag-index output/rag-expanded-baseline/rag-index.json \
     -o <TMP>/retrieval-workspace.json \
     --rerank --log <TMP>/retrieval-log.json
   ```

   结果：`rerank.recall_width = 24`（默认值已生效）、阅读池 83 条、逐 target×theme 条目与 F3 候选 run
   **零差异**（`仅本次有 = 无` / `仅 F3 有 = 无` / `逐主题差异数 = 0`），耗时 2m03s。
   即：**落地后的默认行为 ≡ F3 候选**，不存在「改了配置、结果却不是 F3」的偏差。

---

## 11. 降级说明与未完成项

| 项 | 状态 | 说明 |
|---|---|---|
| G1（呈现层机械校验） | N/A | 本轮不渲染 HTML（INTENT §9），呈现层按规则记 N/A |
| B2 交叉验证（§1.3 条件 4） | **未完成** | 项目内现有 B2 run 的检索产物与 B2 基准不同源（R2 0.1548、38/60 主题空池），无可比基线；在扩容索引上重建 B2 检索通路需另起一轮 |
| rerank 服务 | 无降级 | 全程 `127.0.0.1:11435` 在线，所有候选均在 rerank 开启状态下产出，无降级组 |
| `retrieval-log.json` | 完整 | 两个入围候选均带日志，R4 归因完整，非降级模式 |
| L3 降权搜索 | 主动排除 | 由 F5 证明为承重结构（R2 −45 chunk），非执行失败 |
| 阶段A 候选归档 | 部分 | 仅两个入围候选生成了完整 run 目录；其余 19 组为检索层单点，结果全量存于 `P2-SWEEP.json`，原始 trace 留在本轮临时工作目录（本地） |

---

## 12. 交付物索引

| 交付物 | 位置 |
|---|---|
| 调参报告（本文） | `assessment/rag-tuning/rounds/P2-2026-09-20/P2-TUNING-REPORT.md` |
| 阶段A 候选全表（机器可读） | `assessment/rag-tuning/rounds/P2-2026-09-20/P2-SWEEP.json` |
| F2 run（完整评估） | `assessment/rag-tuning/runs/20260920-1807-B1-p2-f2-rw24-allthemes/` |
| F3 run（完整评估） | `assessment/rag-tuning/runs/20260920-1807-B1-p2-f3-rw24/` |
| 基线 run（参考起点） | `assessment/rag-tuning/runs/20260920-1616-B1-expanded-baseline-default/` |
| 逐候选 facts 与证据审计 | 上述两个 run 目录内的 `facts-workspace.json` / `facts-evidence.json` |
| 自动裁定记录 | 上述两个 run 目录内的 `adjudication-decisions.json` |

> run 目录内含本轮临时工作路径，按项目既有约定**本地保留、不入库**；报告与 `P2-SWEEP.json` 已做脱敏（无绝对路径）。
