# P3 调参报告 —— B3 天花板口径

- **轮次**：P3（2026-09-20 起）
- **目标函数**：`assessment/rag-tuning/baselines/B3-ceiling.checklist.json` 的 `report.coverage`
  （273 条 item / **123 条去重证据 chunk** / **84 条 critical 证据 chunk**）
- **被测对象**：检索层。facts / 呈现层本轮不评（理由见 §7）
- **工作目录**：`output/rag-b3-tuning/`（本地保留，不入库）
- **执行流水**：[`LOG.md`](./LOG.md)｜**候选全表**：[`P3-SWEEP.json`](./P3-SWEEP.json)

---

## 0. 结论先行

**一句话**：天花板口径下，**配额是唯一有效的主轴；rerank 的主题范围与召回窗口两个旋钮零增益或负增益。**

| # | 结论 | 证据 |
|---|---|---|
| 1 | **抬配额是唯一正收益**，且很快饱和 | 默认 → 每主题 10 条 / 帽 100：证据 chunk **108 → 118**（硬上限 121），critical 证据 **82 → 83**（已触硬上限），**facts 层可写上界 78.8% → 91.4%** |
| 2 | **全主题 rerank 是灾难**，必须继续保持默认白名单 | 池 180 → **153**，证据 chunk 108 → **84**，critical 证据 82 → **62**，可写上界 78.8% → **43.7%** |
| 3 | **召回窗口单独放宽是负收益** | 窗口 24 → 48（其余默认）：池 180 → 173，证据 chunk 108 → 106 |
| 4 | **定向追加主题**（点名 3 个）**打平但更贵**，不值得 | 与纯配额同为 118 上限内 117、可写上界同为 91.4%，但耗时 **1509s vs 682s**（2.2×），unique 还少 1 条 |
| 5 | **推荐配置 = 只抬配额，rerank 一切默认** | `placeMaxThemeChunks 5→10`、`cityMaxThemeChunks 5→10`、`maxPlaceChunks 50→100`、`maxCityChunks 25→50` |
| 6 | **本轮不落地**（写入 `rag_retrieval_config.mjs`） | 见 §6 —— 天花板不是落地的充分理由，且会破坏 B1 基线的可复现性 |

---

## 1. 为什么本轮不是 P2 的延长线

| | P2（B1 地板） | **P3（B3 天花板）** |
|---|---|---|
| 判据 | Gate 全过 + R2 不降 + 省读/增密二选一 | `coverage` 分层覆盖率，**不做通过判定** |
| 读取量 | **硬约束**（省读型要 −10%，增密型要 ±10% 以内） | **不是约束**，材料广度越大越好 |
| 单组成本 | 检索层秒级 + facts 层长文阅读 | 本轮只跑检索层，故可放开扫描 |

**关键推论**：P2 判 F2（全主题 rerank）不可采纳的理由是「池容下降 + 桶被清空」。
在天花板口径下这两点**仍然是坏消息**（都是材料广度损失），但「读量上升」不再是负面项。
因此 P2 的两个有效旋钮必须在天花板口径下重测 —— 本轮测了，结论一致（见 §4.2），
且在这一口径下退化幅度**大得多**，机制也定位到了（§5）。

---

## 2. 结构性上限：任何参数都翻不过去的墙

天花板要 123 条去重证据 chunk，逐条核对索引后：

| 项 | 数量 | 说明 |
|---|---|---|
| 证据 chunk **在索引中不存在** | **2** | `037-shihai-note.md#6`（兴文石海·交通）、`049-jdt-note.md#6`（九洞天·缺点）—— 该 `rag-index.json` 的切分结果里没有这两条 |
| unique 覆盖**硬上限** | **121 / 123** | 这两条永远捞不到 |
| critical 证据**硬上限** | **83 / 84** | 上述 2 条里有 1 条是 critical |

**先验结论（后面所有排序都受它约束）**：critical 面在 t0 之后就基本到顶
（t0 已 82/84，抬一次配额即 **83/84 = 硬上限**）。本轮**全部**提升空间都在非 critical 长尾材料上，
而 unique 的可用空间只有 **13 条**（108 → 121），实际最高只做到 118（见 §4.1）。

---

## 3. t0 缺口归因：15 条为什么没进池

对 t0 的 `retrieval-log.json` 逐条反查，15 条缺失**互不重叠**地落在四类失因里：

| 失因 | 条数 | 机制 | 旋钮可救 |
|---|---|---|---|
| `index_absent` | 2 | 索引里没有这条 chunk | ❌ |
| `cut_by_topk` | 7 | 已进 rerank 窗口、已过 0.9 阈值，最终排序落在 top-k=5 之外 | ✅ 抬 top-k |
| `rerank_theme_skipped` | 5 | 主题不在 rerank 白名单 → 整条请求跳过 rerank，纯一阶段排序落在 top-5 外 | ⚠️ 理论上 `--rerank-all-themes` / `--rerank-theme`，实测见 §4.2 |
| `outside_recall_window` | 1 | 一阶段排名落在窗口 24 之外 | ⚠️ 抬 `recallWidth`，实测见 §4.2 |

**白名单的覆盖面是最大的一处结构性缺口**：默认只覆盖景点
`highlights` / `nearby` / `routes` / `facilities` 与城市 `backup_places`，
100 个检索请求里 **67 个被 `theme_not_in_scope` 跳过**；
而天花板缺口恰好集中在被跳过的主题上（`drawbacks` 3 条、`transport` 2 条、`foods` 2 条）。
「把白名单补全」看起来是天经地义的事 —— **但实测是灾难**，原因见 §5。

**同时排除两个假设**（都不必再试）：

1. **L3 降权不是失因**：15 条缺失 chunk 的 `tier` 全为 0、`penalty_multiplier` 全为 1，
   没有吃到任何档位惩罚。P2 判 L3 是承重结构，本轮在天花板样本上再次确认。
2. **总量帽未触顶**：t0 全部目标 `retrieval_quota.dropped_total = 0`，
   「每主题 top-5」的候选没有被总量帽截掉（P2 §2.3 第 4 条继续成立）。

---

## 4. 候选对比

指标口径**必须看清**（两套「入池」语义实测差 1 条，详见 §4.5）：
`证据 chunk` / `critical 证据` / `部分分` / `可写上界` 四列是**阅读池口径**
（chunk 在 `chunks_by_id` 里 = agent 能读到），`R1` / `R2` 是评估体系原有的**归属口径**。
§4.1 的配额轴候选只列前两列，因为早期版本的扫描驱动没有落池快照，
无法补算部分分与可写上界（两个口径在 unique 上只差 1 条，不影响该表的排序结论）；
§4.2 的候选都有池快照，四列齐全。除 R1/R2 外，本报告出现的覆盖率数字**一律是池口径**。

### 4.1 配额轴（本轮唯一正收益方向）

rerank 全部保持默认（白名单默认、窗口 24、阈值 0.9），只动配额：

| 候选 | 每主题 top-k（景点/城市） | 总量帽（景点/城市） | 阅读池 | **证据 chunk** | **critical 证据** | R1 | R2 | 墙钟耗时 |
|---|---|---|---|---|---|---|---|---|
| **t0（基线）** | 5 / 5 | 50 / 25 | 180 | **108 / 123**（87.8%） | **82 / 84** | 96.9% | 89.8% | 459s |
| Q-p3c3（省读方向） | 3 / 3 | 30 / 15 | 131 | 84 / 123（68.3%） | 67 / 84 | 83.1% | 77.0% | 1100s |
| Q-c10（只抬城市） | 5 / 10 | 50 / 50 | 196 | 110 / 123（89.4%） | 82 / 84 | 96.9% | 91.4% | 1102s |
| Q-p8 | 8 / 5 | 80 / 25 | 208 | 114 / 123（92.7%） | 83 / 84 | 97.8% | 92.8% | 1103s |
| **Q-p10** | 10 / 5 | 100 / 25 | 220 | 116 / 123（94.3%） | 83 / 84 | 97.8% | 94.3% | 812s |
| Q-p8c8 | 8 / 8 | 80 / 40 | 221 | 116 / 123（94.3%） | 83 / 84 | 97.8% | 94.1% | 813s |
| **Q-p10c10 ← 推荐** | **10 / 10** | **100 / 50** | 235 | **118 / 123（95.9%）** | **83 / 84** | 97.8% | 95.9% | 916s |
| Q-p15 | 15 / 5 | 150 / 25 | 251 | 118 / 123（95.9%） | 83 / 84 | 97.8% | 95.0% | 917s |

**读法**：

1. **critical 面在第 2 档（p8）就到硬上限 83/84**，此后任何配额都无差别 —— 硬门槛面撑住了。
2. **unique 在 118/123 饱和**：`p15`（池 251）与 `p10c10`（池 235）同分，
   再往上加配额只增成本不增覆盖。剩余 5 条 = 2 条索引缺失 + 3 条见 §4.3。
3. **只抬城市配额几乎免费**：`c10` 单独就把 108 → 110（+2 条），而城市总量帽从 25 → 50 只多 16 条 chunk。
4. **省读方向代价明确**：`p3c3` 把池压到 131（−27%），证据 chunk 掉到 84/123（−24 条），
   critical 证据 67/84（−15 条）—— 天花板口径下这是不可接受的，但 P1/P2 的省读目标本就要求牺牲广度，
   两者不矛盾，只是坐标系不同。
5. **可写上界**（在端点处测）：t0 **78.8%** → p10c10 **91.4%**（+12.6pp）。
   即「读全池能写多满」从约 3/4 提到约 9/10，这是配额轴最值钱的一项收益。

> ⚠️ **耗时列不可直接比较**：多次扫描并发运行，互相争抢 Ollama / rerank 服务，墙钟耗时被显著放大
> （t0 是单独跑，682s~2178s 的差异有一部分来自并发度）。只能看量级。

### 4.2 rerank 轴（主题范围 / 召回窗口）—— 全部无正收益

| 候选 | rerank 主题范围 | 窗口 | 配额 | 阅读池 | **证据 chunk** | **critical 证据** | 部分分 | **可写上界** | R1 | R2 | 墙钟耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t0（基线） | 默认白名单 | 24 | 默认 | 180 | 108 / 123 | 82 / 84 | 94.1% | 78.8% | 96.9% | 89.8% | 459s |
| **T-A 全主题** | **全部 100 个请求** | 24 | 默认 | **153** | **84 / 123** | **62 / 84** | 81.4% | **43.7%** | **76.9%** | **76.4%** | 2178s |
| **T-C 只放宽窗口** | 默认白名单 | **48** | 默认 | 173 | 106 / 123 | 82 / 84 | 93.0% | 78.8% | 96.9% | 88.6% | 1213s |
| **T-E 定向追加 3 主题** | 默认 + `drawbacks`/`transport`/`foods` | 24 | 10/10 | 239 | 117 / 123 | 83 / 84 | 98.1% | 91.4% | 98.2% | 95.5% | **1509s** |
| **T-F 纯配额对照** | 默认白名单 | 24 | 10/10 | 235 | **118 / 123** | 83 / 84 | 98.3% | 91.4% | 97.8% | 95.9% | **682s** |

**三条结论，每条都有干净的对照**：

1. **全主题 rerank（T-A）比 t0 差得离谱**：unique −24 条、critical −20 条、可写上界 −35.1pp、
   R1 −20.0pp。这不是「收益小」，是**结构性破坏** —— 与 P2 观察到的「桶被清空」完全一致，
   只是天花板口径把它量化了。**`--rerank-all-themes` 应从此排除在搜索空间之外**（P2 判「不采纳」，
   本轮升级为「有害」）。
2. **窗口单开（T-C vs t0）是负收益**：池 180 → 173、unique 108 → 106。
   与 P2 §2.3 第 5 条「窗口不是越大越好：24→30→56 反向退化」一致 —— 该结论在天花板口径下同样成立。
   **窗口 24 就是当前最优，不要再动。**
3. **定向追加（T-E vs T-F）严格劣于纯配额**：`T-F` 是 `T-E` 去掉那 3 个主题、其余参数完全相同。
   结果 T-F 在 unique（118 vs 117）、部分分（98.3% vs 98.1%）、R2（95.9% vs 95.5%）上**都不差**，
   可写上界与 critical 打平，而**耗时只有 T-E 的 45%**。
   逐条核对缺失集也证实：T-E 比 T-F **多丢** `049-jdt-note.md#5` ——
   这条在纯配额下被一阶段捞回来了，加 rerank 反而被过滤掉。

   > 也就是说：**「补全 rerank 白名单以救回 5 条缺口」这个看起来最合理的想法，实测是净负。**
   > 原因见 §5 —— 缺口主题没有专用 rerank query，走兜底句会被阈值大量误杀。

### 4.3 最终缺失的 5 条（推荐配置下）

| chunk | 目标 · 主题 | 为什么还缺 | 可救性 |
|---|---|---|---|
| `037-shihai-note.md#6` | 兴文石海 · transport | 该 chunk **不在索引里** | ❌ 只能重建索引 |
| `049-jdt-note.md#6` | 九洞天景区 · drawbacks | 该 chunk **不在索引里** | ❌ 只能重建索引 |
| `030-jdt-note.md#6` | 九洞天景区 · highlights | 进过 rerank 窗口也过了 0.9 阈值，但最终排序 > 10 | ⚠️ 理论可救 |
| `昭通大山包.md#14` | 大山包 · highlights | 同上（t0 时最终排名第 19） | ⚠️ 理论可救 |
| `034-zhaotong-note.md#3` | 昭通 · backup_places | 一阶段排名落在召回窗口 24 之外 | ⚠️ 窗口已判负 |

**关键点：唯一那条仍缺的 critical 证据就是 `037-shihai-note.md#6`，它在索引里不存在 ——
critical 面已到 83/84 的绝对上限，任何参数都补不上。**

剩下 3 条「理论可救」的，各自需要「rerank 最终排名 ≤ 19」或「一阶段排名 ≤ 24」，
而唯一能改善这两者的两个旋钮（`recallWidth`、主题范围）已实测为负收益（§4.2）。
**结论：在现有索引 + 现有 rerank 配置下，118/123 就是实际可达上限，剩余 5 条不是调参问题。**

### 4.4 正式 run 与口径端到端交叉验证

上表 t0 与推荐配置两行都另建了**正式评估 run**（走 `assessment:prepare` + `assessment:evaluate`，
被测产出是真实落盘的 retrieval-workspace，不是扫描驱动的内存快照）：

| run | 参数 | 报告读数（`report.coverage.layers.retrieval.chunk_level`） |
|---|---|---|
| `runs/20260920-2312-B3-p3-t0-default/` | 默认（5/5，50/25，rerank 默认） | 证据 **108/123**（87.8%）；critical **82/84**；部分分 **94.1%**；可写上界 **78.8%** |
| `runs/20260921-0122-B3-p3-p10c10/` | 10/10，100/50，rerank 默认 | 证据 **118/123**（95.9%）；critical **83/84**；部分分 **98.3%**；可写上界 **91.4%** |

**四个数字与扫描驱动的结果逐位一致** —— 说明 E3 新增的 chunk 粒度口径
（以及它依赖的阅读池判定）在两条独立路径上可复现，不是扫描脚本的自造数字。

### 4.5 两套「入池」口径的差异（用数之前必须知道）

同一个「证据 chunk 是否算被捞到」，项目里有**两套语义**，t0 实测差 **1 条**：

| 口径 | 定义 | t0 证据 chunk | t0 critical 证据 | t0 可写上界 | 实现位置 |
|---|---|---|---|---|---|
| **阅读池口径** | chunk 在 `chunks_by_id` 里，agent 能读到 | **108 / 123** | **82 / 84** | **78.8%** | 本轮扫描驱动 / 新 `chunk_level` |
| **归属口径** | chunk 被「它所属条目的目标 / 主题」自己选中 | 107 / 123 | 81 / 84 | **65.8%** | `lib/attribution.mjs`，B1/B2 的 CIR/N1/N2/Gate 用它 |

差异来源已逐条定位到：`盐津.md#7` —— 它由**城市:盐津**的池带进来，但引用它的条目属于
**景点:盐津老县城**，而该景点的主题列表里没有它，于是归属口径判 `retrieved: false`。

**这条差异在 123 条证据的尺度上很小（1 条 = 0.8pp），但在「可写上界」上放大了 13.0 个百分点** ——
因为它会让 6 条盐津老县城的条目**同时**从「证据齐全」掉成「证据不齐」。

- 归属口径是**归属正确性**（这条材料该不该记在这个目标名下），B1/B2 的判定链路建立在它上面，**本轮不动它**。
- 天花板口径要的是**材料广度**（agent 打开池子能读到什么），所以**阅读池口径才是对的**，
  可写上界尤其如此 —— 用归属口径算会系统性低估。
- 新增的 `chunk_level` 优先用阅读池口径（`source: "reading_pool"`），
  拿不到阅读池时才回退并标注 `source: "attribution"`。详见 `CEILING-INTENT.md` §6.2.1。

> 实务提醒：**引用天花板数字时一定要写明口径**。本报告除 R1/R2 外全部是阅读池口径。

---

## 5. 机制：为什么全主题 rerank 会崩

### 5.1 rerank query 模板只覆盖 5 个主题

`RAG_RERANK_DEFAULTS.queryTemplates` 只有：
景点 `highlights` / `nearby` / `routes` / `facilities` + 城市 `backup_places` ——
**恰好等于默认白名单**。

白名单之外的 23 个主题（`drawbacks` / `tickets` / `transport` / `crowds` / `accessibility` /
`safety` / `foods` / `lodging` / `notes` …）一旦启用 rerank，query 只能走 `buildRerankQuery` 的兜底句：

```text
请判断下面材料是否有助于回答「{目标名} 的 {主题名} 相关旅行信息」。
```

### 5.2 兜底句 + 0.9 阈值 = 大量误杀

T-A（全主题）相对 t0 的读数说明问题不在「多读了」而在「读丢了」：
池 180 → 153、R1 96.9% → 76.9%、可写上界 78.8% → 43.7%。

而对比 T-E（只加 3 个主题）：同样是兜底句，却**没有崩**（117/123）。
两者差别只在**加了多少个主题** —— 加 3 个时，误杀量小、一阶段兜底还在；
加到 100 个请求全 rerank 时，几乎所有主题桶都被阈值削一遍，一阶段排序的兜底作用消失，
于是池容崩塌。

**该机制可被一个已知的旁证交叉验证**：即使是有专用模板的主题，rerank 的过滤也已经很狠 ——
t0 日志里 `place|五尺道|routes` 送 24 条只留 **1 条**、`place|大山包|facilities` 只留 6 条。
模板齐全时这种削法还能靠「留下的确实是精华」站稳；
**模板缺失时削掉的顺序没有依据，于是变成净损失。**

### 5.3 由此得到的两条硬规则（建议写回文档）

1. **不要用 `--rerank-all-themes`**。要么保持默认白名单，要么**先为该主题补 `queryTemplates` 再启用**，
   不能只加白名单。
2. **不要在没有实测的前提下上调 `recallWidth`**。P2 已写过一次，本轮在天花板口径下再次复现。

---

## 6. 推荐与落地

### 6.1 推荐参数

| 字段 | 现值 | 建议值 | 说明 |
|---|---|---|---|
| `RAG_RETRIEVAL_DEFAULTS.placeMaxThemeChunks` | 5 | **10** | 唯一有正收益的旋钮 |
| `RAG_RETRIEVAL_DEFAULTS.cityMaxThemeChunks` | 5 | **10** | 单独抬就有 +2 条，几乎免费 |
| `RAG_RETRIEVAL_DEFAULTS.maxPlaceChunks` | 50 | **100** | 同步抬到 10 主题 × 10 = 100 的精确上限；否则会触发末尾主题丢弃 |
| `RAG_RETRIEVAL_DEFAULTS.maxCityChunks` | 25 | **50** | 同步抬到城市侧 5 主题 × 10 = 50 的精确上限 |
| `RAG_RERANK_DEFAULTS`（全部） | — | **不动** | 主题范围与窗口实测均无正收益 |

预期效果（天花板口径，B3 检索层）：
证据 chunk **108 → 118**（+10 条）、critical 证据 **82 → 83**（触硬上限）、
facts 层可写上界 **78.8% → 91.4%**（+12.6pp）。
代价：阅读池 180 → 235 条（+30.6%）。

两点实测补充：

- **总量帽在本轮两档下均未触发**（`dropped_total = 0`）：p10c10 里单目标最大池是 52 条（九洞天景区），
  远低于 100/50。抬 `maxPlaceChunks` / `maxCityChunks` 是**防御性同步**（值恰为「主题数 × 每主题配额」），
  不是本轮收益来源。
- **配额是单调旋钮**（证据 chunk 随配额递增、无反转），且 p10c10 是达到 118 的**最小池**
  （p15c5 同为 118 但池 251 条，比 235 更大）。

### 6.2 本轮**不落地**，理由三条

1. **天花板不是落地的充分理由。** `CEILING-INTENT.md` §1 明确「B3 只回答『离理想还差多少』」，
   §9.4 更直接写着「**不修改 `scripts/rag/rag_retrieval_config.mjs`**（天花板不调参，只是度量）」。
   本轮的任务是用天花板口径**做调参实验并给出结论**，不等于默认参数应当按天花板结果改。
   落地属于「改默认行为」，需要按 B1 地板复核后由用户拍板。
2. **会破坏 B1 基线的可复现性。** P2 §2.6 的复现验证（「不带 `--rerank-recall-width` 的默认调用 ≡ F3」）
   建立在「默认值 = P2 落地值」之上。本轮若同时改掉 4 个配额默认值，
   P2 的 t0 / F3 都不能再靠默认值复现，必须改用显式 CLI。
3. **B1 复核未做。** 抬配额会把 B1 的读取量从 83 抬到约 110（+32%），
   直接违反 §1.3 省读型的 −10% 要求，增密型也超出 ±10% 窗口。
   按 B1 判据它是**退化的**；按 B3 判据它是**最优的**。
   这正是「两套基准并存」要防的场景 —— 结论必须由用户在两套判据之间取舍，不能由 agent 单方面落地。

### 6.3 若用户决定落地，落地方式

```bash
# 1) 改 scripts/rag/rag_retrieval_config.mjs 的 RAG_RETRIEVAL_DEFAULTS 四个值（见 §6.1）
# 2) 显式复核 B1（地板）：用参数覆盖跑一遍，读 Gate / R1 / R2 / M1 / N2
npm run rag:workspace -- \
  --facts <B1 facts> --rag-index <扩容索引> \
  --place-top-k 10 --city-top-k 10 --max-place-chunks 100 --max-city-chunks 50 \
  -o <工作目录>/retrieval-workspace.json --rerank --log <工作目录>/retrieval-log.json
npm run assessment:prepare -- --baseline-id B1 --run-dir <run 目录> ...
npm run assessment:evaluate -- --baseline assessment/rag-tuning/baselines/B1-*.checklist.json --run <run 目录>
# 3) 只有当 B1 与 B3 两套结果都被接受，才改默认值
```

**回滚方式**：把四个字段改回 `5 / 5 / 50 / 25`，无其他耦合。

### 6.4 B1 落地复核结论（2026-09-21 补跑）

**复核已完成，结论：不落地。** 完整记录见 [`B1-RECHECK.md`](./B1-RECHECK.md)。

| 指标 | 基线（5/5/50/25） | 广度模式（10/10/100/50） |
|---|---|---|
| 阅读量 | 82 | **110（+34.1%）** ⚠ |
| retrieval.R1 | 0.7797 | **0.9153** |
| retrieval.R2 | 0.8136 | **0.9153** |
| facts.N1 / N2 | 0 / 2 | 0 / **0** |
| Gate | 全过 | 全过 |

按 §1.3 复合判据：条件 1、2 通过，条件 3 **不通过**（读量 +34.1%，省读型与增密型两条路径都要求读量不涨或下降），
条件 4 无可比 B2 基线。→ **不达成「明确优于基线」**。

因此 §6.2 的三条不落地理由**全部成立且已被实测确认**，本轮维持默认值 5/5/50/25 不变。

复核还产出一个必须记住的机制结论：**改检索配额必须同步补写 facts** ——
池变大后，原本归因在检索层的条目会批量转为归因在 facts 层（「已召回但未写」），
不补写则 Gate G2 直接 FAIL（实测 N1 0→11）。详见 [`B1-RECHECK.md`](./B1-RECHECK.md) §1.2。

若用户仍希望默认走广度路线，前置条件（修订 §1.3 增设「广读型」路径，或显式改 skill 定位）
见 [`B1-RECHECK.md`](./B1-RECHECK.md) §5.2。

---

## 7. 为什么不评 facts 层

天花板口径下 facts 层的分母是「全部 273 条」，而 facts 层能不能覆盖，取决于**生成阶段有没有被读出并写下来** ——
那需要每轮让 agent 重读整个阅读池并产出 `facts-patch`（长文阅读成本）。本轮不做的理由：

1. 检索层是 facts 层的**唯一上游**：证据没进池的信息不可能被写对（写了就是幻觉、触发 G4）。
   先把上游调到上限是 facts 层调参的**前置条件**，顺序上应该先做这一步。
2. 本轮新增的 `fully_evidenced_weighted_rate`（= **facts 层可写上界**）已经把两者的关系量化：
   它给出「若 agent 读全池，facts 层最多能覆盖多少」。有了这条上界，检索层调参不必每轮都付一次阅读成本。
   本轮实测该上界从 78.8% 提到 91.4%，即**facts 层的理论天花板被抬高了 12.6 个百分点**；
   实际能兑现多少，是下一轮的问题。

---

## 8. 复现命令

```bash
# 全部命令都在项目根目录（<PROJECT_ROOT>）下执行
cd <PROJECT_ROOT>

# --- 0) 工作目录与输入（一次性）---
mkdir -p output/rag-b3-tuning
cp <用户提供的 rag-index.json>                     output/rag-b3-tuning/rag-index.json
cp outputs/2026-guoqing-self-drive-plan-20260907/route-structure.json \
                                                   output/rag-b3-tuning/route-structure.json
npm run create-workspace -- --route-json output/rag-b3-tuning/route-structure.json \
  --rag-index output/rag-b3-tuning/rag-index.json -o output/rag-b3-tuning/facts-skeleton.json

# --- 1) t0 基线检索（默认配额 + rerank 默认）---
npm run rag:workspace -- --facts output/rag-b3-tuning/facts-skeleton.json \
  --rag-index output/rag-b3-tuning/rag-index.json \
  -o output/rag-b3-tuning/retrieval-workspace-t0.json \
  --rerank --log output/rag-b3-tuning/retrieval-log-t0.json

# --- 2) 推荐配置检索（只抬配额）---
npm run rag:workspace -- --facts output/rag-b3-tuning/facts-skeleton.json \
  --rag-index output/rag-b3-tuning/rag-index.json \
  --place-top-k 10 --city-top-k 10 --max-place-chunks 100 --max-city-chunks 50 \
  -o output/rag-b3-tuning/retrieval-workspace-p10c10.json \
  --rerank --log output/rag-b3-tuning/retrieval-log-p10c10.json

# --- 3) 阶段 A 扫描（每流一个候选文件，逐候选出池快照）---
node output/rag-b3-tuning/sweep.mjs output/rag-b3-tuning/c-A.json output/rag-b3-tuning/sweep-A.json
#   其他流：c-B / c-C / c-W1 / c-W2 / c-W3 / c-W4，用法相同
node output/rag-b3-tuning/collect.mjs <out.json> output/rag-b3-tuning/sweep-*.json

# --- 4) 正式评估 run（天花板模式）---
npm run assessment:prepare -- --baseline-id B3 --tag p3-t0-default \
  --run-dir assessment/rag-tuning/runs/20260920-2312-B3-p3-t0-default \
  --facts output/rag-b3-tuning/facts-skeleton.json \
  --retrieval-workspace output/rag-b3-tuning/retrieval-workspace-t0.json \
  --retrieval-log output/rag-b3-tuning/retrieval-log-t0.json \
  --set place_top_k=5 --set city_top_k=5 --set max_place_chunks=50 --set max_city_chunks=25 \
  --set rerank=true --set rerank_threshold=0.9 --set rerank_recall_width=24 --set rerank_all_themes=false
npm run assessment:evaluate -- \
  --baseline assessment/rag-tuning/baselines/B3-ceiling.checklist.json \
  --run assessment/rag-tuning/runs/20260920-2312-B3-p3-t0-default
```

> ⚠️ 上游 rerank 服务（`http://127.0.0.1:11435/rerank`，返回 400 即在线的探活方式）与
> Ollama（`http://127.0.0.1:11434`，`qwen3-embedding:0.6b`）必须在线；两者是本轮全部耗时的来源。

---

## 9. 已知限制

1. **样本小**：B3 检索层只覆盖 17 个目标（7 景点 + 5 城市 + 5 天 + 全局），
   且 2 条证据 chunk 在索引里不存在，实际可比证据只有 **121 条**。
   因此「118/123」与「121/123」之间的差别只有 3 条 chunk，**接近噪声量级**，
   §4.1 中 p10 与 p15 同分这类现象不要过度解读。
2. **索引不可由调参修复**：`037-shihai-note.md#6` / `049-jdt-note.md#6` 缺失说明该索引的切分结果
   与天花板基准**不同源**。要救回这 2 条只能重建索引后重跑天花板派生（`npm run assessment:ceiling`）。
3. **未做 B1 地板复核**：见 §6.2 第 3 条，这是本轮**刻意**留下的缺口，不是遗漏。
4. **未做 B2 交叉验证**：项目内当前无同源 B2 可比 run（P2 §2.1 已记录同一限制）。
5. **耗时不可跨候选比较**：并发扫描导致墙钟耗时被争抢放大，只用于「贵/便宜」的量级判断。
6. **T-D 提前终止**：原计划的「全主题 + 窗口 48 + 配额 10/10」组合候选在 T-A 出来后终止
   （已运行 73 分钟未完成）。终止理由三条：
   ① all-themes 轴已被 T-A 决定性判负，且损伤来自**阈值过滤**而非 top-k 帽
   （T-A 的池 153 < t0 的 180，而它的 top-k 更小），抬配额补不回被过滤掉的内容；
   ② `--rerank-all-themes` **无法持久化**（`INTENT.md` §2.1.1 已记录：`RAG_RERANK_DEFAULTS`
   里没有 `allThemes` 字段），即使它更好也不能成为推荐配置；
   ③ 「定向追加」这个可持久化的替代方案已被 T-E 对 T-F 的对照证否。
   该候选无落盘产物，故不在 `P3-SWEEP.json` 内 —— 这是本轮**唯一**已知的覆盖缺口。
