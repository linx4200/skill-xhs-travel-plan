# P3 推荐参数的 B1 落地复核（2026-09-21）

> 本文件回答一个问题：**P3 天花板口径推荐的「广度模式」配额（10/10/100/50），
> 能不能按 B1（地板）判据落地为默认值？**
> 结论先说：**不能落地 —— 地板没破，但读量超窗，不满足 §1.3「明确优于基线」。**
> 复核 run：`../../runs/20260921-0815-B1-wide-quota/`

---

## 1. 复核设置

| 项 | 值 |
|---|---|
| 被测参数 | `placeMaxThemeChunks=10`、`cityMaxThemeChunks=10`、`maxPlaceChunks=100`、`maxCityChunks=50`（rerank 全套不动） |
| 覆盖方式 | CLI 覆盖，`scripts/rag/rag_retrieval_config.mjs` 运行时**零改动** |
| 索引 | `output/rag-expanded-baseline/rag-index.json`（337 chunk，与基线同一份） |
| 检索模式 | embedding 开 + rerank 开 + `recallWidth=24`（与 P2 落地后一致） |
| 基线对照 | `runs/20260920-1616-B1-expanded-baseline-default/`（默认 5/5/50/25） |
| 评估基准 | `baselines/B1-rag-e2e-smoke.checklist.json`（36 条，其中 12 条 critical） |

### 1.1 facts 层的处理（关键，不是可选项）

按 §4.4 两阶段漏斗纪律，**改检索配额必须同步重跑 facts 层**。本轮的 facts 处理：

1. 以 `output/rag-expanded-baseline/facts-workspace.json` 为底（**未覆盖 B1 基准文件**），
   补写 2 条本轮首次入池的证据 → `output/rag-b3-tuning/facts-workspace-b1-wide.json`；
2. 复用基线 35 条语义裁定，其中 2 条由 `false` 改判 `true`（理由见 §4）；
3. 重新评估。裁定记录：`runs/20260921-0815-B1-wide-quota/adjudication-decisions.json`。

### 1.2 为什么必须重跑 facts —— 一个会误判的机制

**只改检索配额、不补 facts，评估会直接 FAIL，且这个 FAIL 是归因切换的假象。**

实测过程（`runs/20260921-0815-B1-wide-quota/` 的首版报告）：

| 指标 | 首版（只换参数，facts 未动） | 补 facts 后 |
|---|---|---|
| retrieval.R1 / R2 | 0.9153 / 0.9153 | 0.9153 / 0.9153 |
| facts.N1 | **11** | **0** |
| facts.N2 | **15** | **0** |
| G2 | **FAIL** | PASS |

原因：facts 层判定分两步 —— 先看「条目证据是否入池」，入池了才检查「有没有写进 facts」。
池从 82 涨到 110（新增 28 chunk）后，原本归因在**检索层**（未召回，不计入 facts 欠账）的条目，
批量转为归因在 **facts 层**（已召回但未写）。于是 N1/N2 从 0/2 暴涨到 11/15 ——
**这不是 facts 质量退化，而是归因层级上移**。

> 📌 反过来说：**读取池越大，「应当写入 facts」的条目就越多**。
> 抬配额却不更新 facts，等价于同时抬高「应写量」而不动「已写量」→ 必然表现为 facts 层崩塌。
> 这解释了为什么 P2 的 F3 也是重跑了 facts（stageB）才通过。

---

## 2. 指标对照

| 指标 | 基线（5/5/50/25） | 广度模式（10/10/100/50） | 变化 |
|---|---|---|---|
| **阅读量（阅读池 chunk）** | **82** | **110** | **+34.1%** ⚠ |
| retrieval.R1 | 0.7797（46/59） | **0.9153**（54/59） | +17.4% 相对 |
| retrieval.R2 | 0.8136（144/177） | **0.9153**（162/177） | +12.5% 相对 |
| retrieval.CIR | 12/12（1.0） | 12/12（1.0） | — |
| facts.CIR | 12/12（1.0） | 12/12（1.0） | — |
| facts.N1 | 0 | 0 | — |
| facts.N2 | 2 | **0** | 改善 |
| Gate G2 / G3 / G4 | PASS / PASS / PASS | PASS / PASS / PASS | — |
| M3.novel_evidence_chunks | 40 | 39 | −1 |
| 阅读池中基准未使用 chunk | 53 | 77 | +24 |
| conclusion | PASS_WITH_NOTES | PASS_WITH_NOTES | — |

**一句话**：检索层大幅改善、facts 层反而不退化（N2 2→0）、Gate 全过 —— 唯一变贵的是读量。

---

## 3. 按 §1.3 判据逐条复核

| # | 条件 | 要求 | 广度模式实测 | 判定 |
|---|---|---|---|---|
| 1 | Gate 全过 | G2/G3/G4 全 PASS | 全 PASS | ✅ |
| 2 | R2 ≥ 基线 | ≥ 0.8136 | 0.9153 | ✅ |
| 3-省读 | 读量 ≤ 73.8（−10%） | — | **110** | ❌ |
| 3-增密 | 读量 ∈ [73.8, 90.2] 且 R1 ≥ 0.8577 | — | 读量 **110**（超窗）；R1 0.9153 ✅ | ❌ |
| 4 | B2 交叉验证不退化 | — | 项目内无可比 B2 基线 | ⚠ 未验证 |

**判定：不达成「明确优于基线」。唯一失败项 = 读取量（+34.1%，两条优势路径都要求读量不涨或下降）。**

> ⚠️ 不要把 `conclusion: PASS_WITH_NOTES` 误读为「优于基线」。
> `conclusion` 只反映 Gate 与 notes（这一层确实全过）；
> 「明确优于基线」是更严的**落地门槛**，由 §1.3 复合判据单独裁决。
> 两者不可混用。

### 3.1 与 P3 天花板口径的对照

同一组参数在两套基准下的结论相反，这不是矛盾，是两套目标函数：

| 基准 | 广度模式表现 | 说明 |
|---|---|---|
| B3（天花板，管**覆盖**） | facts 可写上界 78.8% → **91.4%**，证据 chunk 108 → 118 | 显著更优 |
| B1（地板，管**省读**） | 读量 82 → 110（+34.1%），不满足 §1.3 | 明确不达标 |

这正是 `INTENT.md` §13 注记要防的场景：**天花板不是落地的充分理由**。

---

## 4. facts 层补齐的实质收益

基线（82 chunk 池）有 2 条条目被裁定为 `false`，理由是「该信息在**本次阅读池中不存在**，
无法在不引入幻觉的前提下补齐」。本轮池扩到 110 后，这两条的证据**首次入池**，于是补齐：

| 条目 | 基线裁定 | 本轮变化 |
|---|---|---|
| `B1-place-0014`（救生衣有异味） | false —— 池内无该体感反馈 | 新入池 `九洞天.md#5`「救生衣真的好臭好臭」→ 已补写进 `places.九洞天景区.drawbacks` |
| `B1-city-0021`（重庆高铁 1.5h） | false —— 无任何 chunk 记录该时长 | 新入池 `007-xingwenshihai-note.md#1`「重庆高铁出发1.5h」→ 已补写进 `cities.宜宾.notes` |

→ **N2 从 2 降到 0。这是扩容带来的真实资料覆盖改善，不是调参数字游戏**：
读得多，才写得全。

---

## 5. 落地决定

**不落地为默认值。** 三条理由：

1. **不满足既定门槛。** §1.3 是用户明确批准的落地判据（Q20「必须明确优于基线」），
   广度模式在「读量」这一项上明确不达标（+34.1% vs 要求 −10% 或不超 ±10%）。
   agent 无权在判据未通过时单方面改默认行为。
2. **会改变 skill 定位。** 省读型 −10% 是 Q11「省着读不退化」的量化表达。
   读量 +34% 等于把默认行为从「省读」改成「广读」—— 这是定位变更，必须由用户拍板。
3. **收益是真实的，但归属另一套目标。** R1 +17.4% / R2 +12.5% / N2 2→0 都是真实收益，
   它们服务的是 B3 的覆盖目标；在 B1 的地板上，它们以读量为代价。

### 5.1 保留的能力（已落为具名档位）

2026-09-21 用户拍板：把这组参数落成**显式可选的读取档位** `--read-scope wide`
（定义在 `scripts/rag/rag_retrieval_config.mjs` 的 `RAG_READ_PROFILES.wide`），
默认档仍为 `default`（5/5/50/25），一个数字没动。

```bash
npm run rag:workspace -- \
  --facts <facts> --rag-index <索引> \
  --read-scope wide \
  -o <工作目录>/retrieval-workspace.json --rerank --log <工作目录>/retrieval-log.json
```

档位只是批量预设，四个原子参数仍然可用且优先级更高（显式传哪个就只覆盖哪一个）：

```bash
--place-top-k 10 --city-top-k 10 --max-place-chunks 100 --max-city-chunks 50
```

`SKILL.md` 已授权 agent 在用户明确表达「多读一点 / 尽量多读 / 别省 token」时传 `wide`；
没有这类明确要求时不得自行加宽。生效档位记录在输出 `retrieval.read_scope`。

⚠️ 用广度模式时**必须同步补写 facts**（见 §1.2），否则评估会因归因切换而 FAIL；
运行时会表现为攻略缺失材料其实覆盖到的信息。

### 5.2 落地决定记录

**没有改默认值**，理由是 §1.3 判据未通过（读量 +34.1%），agent 无权在判据未通过时单方面改默认行为。

原方案里的二选一（A 修订 §1.3 / B 改 skill 定位）**没有被采用**：
新增一个显式可选档位既不改默认行为，也不触发 §1.3，因此不需要修订判据、也不需要改定位 ——
这是第三条路。判据本身保持原样。

代价：`wide` 是一次「非默认路径」，默认档的 B1 基线仍可靠默认参数复现，
但任何 `wide` 上的对比都必须显式传档位。

`full` 档（去掉配额门控 = 索引全量）本轮**未开放**。若将来要开，量级参考：
整个索引 337 chunk / 43,666 字 ≈ 37.6k token（o200k），是成本上限。

---

## 6. 复现命令

```bash
cd <PROJECT_ROOT>

# 1) 广度模式检索（1m53s）
npm run rag:workspace -- \
  --facts output/rag-expanded-baseline/facts-workspace.json \
  --rag-index output/rag-expanded-baseline/rag-index.json \
  --place-top-k 10 --city-top-k 10 --max-place-chunks 100 --max-city-chunks 50 \
  -o output/rag-b3-tuning/retrieval-workspace-b1-wide.json \
  --rerank --log output/rag-b3-tuning/retrieval-log-b1-wide.json

# 2) 补写 2 条新入池证据 → output/rag-b3-tuning/facts-workspace-b1-wide.json（见 §4）

# 3) 准备 + 评估，再注入裁定后复评
npm run assessment:prepare -- --baseline-id B1 --tag b1-wide-quota \
  --run-dir assessment/rag-tuning/runs/20260921-0815-B1-wide-quota \
  --facts output/rag-b3-tuning/facts-workspace-b1-wide.json \
  --retrieval-workspace output/rag-b3-tuning/retrieval-workspace-b1-wide.json \
  --retrieval-log output/rag-b3-tuning/retrieval-log-b1-wide.json \
  --set place_top_k=10 --set city_top_k=10 --set max_place_chunks=100 --set max_city_chunks=50 \
  --set rerank=true --set rerank_threshold=0.9 --set rerank_recall_width=24 --set rerank_all_themes=false
npm run assessment:evaluate -- --baseline assessment/rag-tuning/baselines/B1-rag-e2e-smoke.checklist.json --run assessment/rag-tuning/runs/20260921-0815-B1-wide-quota
# 写入 coverage_overrides 后再跑一次 evaluate，使报告与裁定一致
```

**回滚**：本复核未改动任何源文件；`scripts/rag/rag_retrieval_config.mjs` 保持默认 5/5/50/25，
无需回滚操作。
