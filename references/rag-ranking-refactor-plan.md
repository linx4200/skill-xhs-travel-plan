# 检索排序流程重构方案

> 目标：把「一次融合分排到底」拆成四段单一职责，让业务规则只在一处生效，并把「档位」与「软降权」两种业务语义分开表达。
>
> 关联文档：
> - `references/rag-rerank-technical-design.md`（rerank 技术方案）
> - `references/rag-rerank-execution-plan.md`（rerank 执行方案；本方案落地后需在其中阶段 6/8 回写）
>
> 状态：**已确认，待执行**（2026-09-18 拍板；第 7 节 5 项决策已锁定，分阶段执行见第 6 节）

---

## 1. 触发原因

`city_place_specific_penalty` 的真实意图是**档位**——「城市级查询应优先拿无具体景点的笔记」。当前实现用加性分数项（`-0.115 ~ -0.3`）表达，这种形式下档位**可以被相关性或 rerank 概率翻越**，与意图不符。

顺着这条查下去，发现排序流程还有一类共同病因：**业务规则和相关性信号混在同一条公式里**，导致业务规则在不同阶段以不同形式重复生效。

---

## 2. 现状问题清单（含实测严重度）

实测环境：真实索引 `output/2026-guoqing-self-drive-plan/rag-index.json`（53 chunks，全部带 1024 维 embedding）+ 本地 Ollama `qwen3-embedding:0.6b` + 本地 rerank 服务 127.0.0.1:11435。

| # | 问题 | 实测证据 | 当前严重度 |
|---|---|---|---|
| P1 | 业务 penalty 参与 rerank 窗口选择（加性），又在最终排序乘一次 | 昭通 `backup_places`：窗口内 12 条里 11 条同带 `city -0.3`，窗口外 2 条也是 `-0.3`。penalty 在该 theme 内近乎同质 → **去掉 penalty 窗口成员不变** | 结构存在，当前不触发。仅当某 theme 候选池内 penalty 不同质（如视频笔记占比高）时才咬人 |
| P2 | rerank 窗口由「我们不信的那条线性分」决定 | 毕节 `backup_places`：eligible **19 > 窗口 12**，7 条被截掉，其中没有城市级候选（巧合，非保证） | 已触发 |
| P3 | 业务降权同时降召回 | 扫 15 组（3 城市 × 5 theme）：`zero_score` 全为 0，**未触发**。但 `rankedRows` 的过滤条件 `score > 0` 使「relevance 低 + 重 penalty」的 chunk 会被整条丢弃 | 理论风险（relevance 0.15 以下 + `-0.3` 即触发） |
| P4 | 对外 `result.score` 与最终顺序不一致 | 启用 rerank 后 `020-dashanbao-note` 原分 0.3333 却排第 1（概率 0.9957） | 已触发 |
| P5 | **档位可被翻越**（本方案核心） | 毕节 `backup_places`：城市级第 4 名 relevance **0.5267** < 地点级第 5 名 relevance **0.6532**——纯靠 `-0.3` 才排在前面。rerank 下更脆：`prob 0.99 × 0.7 = 0.693 < prob 0.9 × 1 = 0.9` | 已触发 |
| P6 | 6 信号 × 4 profile 手工权重，业务项与相关性项混在一起调 | — | 调参负担 |

**P5 的量化**：`backup_places` 用加性 `-0.3`，当城市级 relevance 落在 0.5 附近、地点级落在 0.65 附近时就已经翻转。毕节实测两者只差 0.126，一个稍高的 embedding 相似度就能翻过来。乘子形式（rerank 路径）更差——0.7 的乘子挡不住 0.1 以上的概率差。

---

## 3. 目标流程

```
① gate（布尔硬过滤）        → 候选池
② 混合召回（纯相关性）       → rerank 窗口
③ rerank（精排 + 阈值准入）  → 主题相关集合
④ 业务重排（档位 + 软降权）  → 最终顺序 → topK
```

| 段 | 做什么 | 明确不做什么 |
|---|---|---|
| ① 硬过滤 | 实体归属判定（`candidate_places` / `candidate_cities` 命中） | 不参与打分 |
| ② 混合召回 | gate 内「向量 + 词法/实体命中」融合，按排序键取 `recallWidth` | 不掺任何**软降权** |
| ③ 精排 + 准入 | cross-encoder 打分；阈值只看原始 `probability` | 业务规则不影响准入 |
| ④ 业务重排 | 档位分层 + 档内按相关性/概率排序，输出 `topK` | 不独立产生新排序维度 |

### 3.1 三个数字的分工

| 数字 | 当前值 | 职责 |
|---|---|---|
| `recallWidth` | 12 | 召回宽度，宁滥勿缺 |
| — | — | 精排吃满整个窗口，无独立参数 |
| `topK` | 5 | 输出条数，宁缺勿滥 |

**不要用同一个 K 串起来。** 若召回宽度 = 输出条数，阈值一卡就只剩 2 条，且窗口外的语义候选永远进不来。

### 3.2 一条必须写进代码注释的判据

> **凡「不可翻越」的约束必须在召回层生效；凡「可翻越」的调整只在排序层生效。**

推论：
- **档位（tier）** 是硬分层，意图是「这类必须优先被看到」→ **参与段②**。否则窗口截断本身就是一次翻越，档位自相矛盾。
- **软降权（tilt）** 是连续倾斜，意图是「同类中略微靠后」→ **不参与段②**。这样降权不再有「顺手降低召回」的副作用（消 P3）。
- **硬过滤（gate）** 是「不属于」→ 段①。

### 3.3 为什么不采用「纯 embedding 召回」

实测：用 `大山包/highlights` 的 rerank query 对全量 53 chunks 算余弦排序，**9 条 gate 命中里只有 7 条进得了 12 宽窗口**：

| 掉出窗口的 gate 命中 | 纯 embedding 名次 |
|---|---|
| `034-zhaotong-note` | 26 / 53 |
| `015-zhaotong-comments` | 36 / 53 |

原因不是模型差，是**文本稀释**——这两条是「昭通综合笔记」，提到大山包只占一小段。向量召回天生惩罚「顺带提到」的笔记，而这类笔记不能丢。同时纯 embedding top-12 里混进了 5 条其他地点的笔记（盐津 / 九洞天 / 石海 / 百草坪 / 毕节）。

结论：**gate 必须前置，词法/实体命中的角色是「保召回」而不是「排序权重」**。

---

## 4. 关键设计

### 4.1 评分分层：`breakdown` 纯相关性，业务状态单列

`scoreChunk()` 的返回值重构为：

```js
{
  score,                        // 相关性总分（= breakdown.total），对外即 result.score
  matches,
  breakdown: {                  // 只有 4 个相关性信号
    profile, weights, signals, contributions, total
  },
  business: {                   // 业务状态，全部是「读出来的事实 + 折算结果」
    tier,                       // 0 = 高优先档，1 = 降档
    tilt_multiplier,            // 视频 tilt × 城市 tilt；档位由 tier 表达，不折进这一项
    is_video,                   // 布尔事实
    place_specific,             // 布尔事实
  },
}
```

配套改动：

- `scoreWeights()` 的 4 个 profile 权重表**删掉** `video_source_penalty` / `city_place_specific_penalty` 两项，只留 `query_embedding_similarity` / `keyword_match` / `route_entity_match` / `title_source_match`。
- 新增 `businessState(chunk, entity, theme)` → `{ tier, tilt_multiplier, is_video, place_specific }`。
- `businessPenaltyMultiplier(signals, weights)`（阶段 4-8 刚搬进来的）**改名为** `tiltMultiplier(...)`，只算软降权；档位不参与该折算，由 `tier` 单独表达。
- `rankedRows` 的过滤条件 `row.result.score > 0` 现在只受相关性影响（消 P3 的理论风险）。

### 4.2 三种业务规则、两种形式

| 规则 | 适用 theme | 形式 | 段② | 段④ |
|---|---|---|---|---|
| 实体归属（已有 gate） | 全部 | 布尔硬过滤 | 是（段①） | — |
| city 地点级 · **档位** | `backup_places` | 分层 `tier ∈ {0,1}` | **是**（第一排序键） | 是 |
| city 地点级 · **软降权** | `foods` / `lodging` / `transport` / `notes` + 未列 theme | 乘子 `1 - tilt` | 否 | 是 |
| video 来源 · **软降权** | 全部 | 乘子 `1 - tilt` | 否 | 是 |

**为什么只有 `backup_places` 走档位**：用户已明确该 theme 的意图是「优先拿无具体景点的笔记」，这是不可翻越的约束。

**为什么其余 city theme 不一起改档位**：`notes` 的地点级内容（「大山包风大」）对城市查询仍有价值，而城市级风险提示可能根本不存在——昭通 `notes` 的城市级候选只有 `008` 一条。硬档位会让这些 theme 在缺城市级材料时输出质量骤降。它们的当前权重（`-0.115 ~ -0.18`）与 video（`-0.15`）同量级，本来就是「轻微降权」的定位。

**`lodging`（-0.18）归软降权**，理由同上：地点级住宿笔记（山上民宿）对去该景点的行程是有用信息，不该被硬压到城市级之后。

**`backup_places` 的 `tilt_multiplier` 只剩 video 那一项**（城市级 / 地点级的差异已由 `tier` 表达），所以该 theme 内：城市级视频笔记 = `tier 0 × 0.85`，地点级视频笔记 = `tier 1 × 0.85`（先降档，再在同档内降权）。

### 4.3 排序键（统一）

**段② 窗口选择键**

```
tier asc → relevance_total desc → matched_by.length desc → 稳定字段
```

**段④ 业务重排键**

rerank off：
```
tier asc → (relevance_total × tilt_multiplier) desc → matched_by.length desc → cityLevelPriority desc → 稳定字段
```

rerank on：
```
tier asc → (probability × tilt_multiplier) desc → relevance_total desc → matched_by.length desc → cityLevelPriority desc → 稳定字段
```

两种模式**只有「相关性分量」不同**（`relevance_total` vs `probability`），业务部分的定义完全共用。这是本方案要达成的核心一致性。

`cityLevelPriority`（已有的 tie-breaker）保留，作为同档同分时的偏好。

### 4.4 配置结构

```js
export const RAG_SCORING = {
  // 档位语义：这些 theme 的「城市级 / 地点级」是硬分层
  cityTierThemes: ["backup_places"],

  // 软降权语义：降权幅度（0~1），乘子 = 1 - tilt
  videoTilt: 0.15,
  defaultCityTilt: 0.10,
  // 当前四个值相同；保留 map 结构作为阶段 8 分化调参的入口
  cityTiltByTheme: { foods: 0.10, lodging: 0.10, transport: 0.10, notes: 0.10 },
};
```

**旧常量处理**：`CITY_PLACE_SPECIFIC_PENALTY_BY_THEME` / `DEFAULT_CITY_PLACE_SPECIFIC_PENALTY_WEIGHT` **直接删除**，不留旧名。当前只有 `rag_retrieve.mjs` import 它们（`rag_rerank.mjs` 已在阶段 4-8 清理），改动面可控。避免「一个东西两个名字」。

**加性权重换算子必须重新标定，不能直接搬数值。** 加性项的相对力度依赖 relevance 大小：`-0.15` 在 relevance `0.5` 时相当于降 30%，在 `1.0` 时只相当于降 15%。直接把 `-0.15` 当 tilt `0.15`（降 15%）会在低 relevance 区间**静默变轻**。

**标定结果（已定：策略 A）**

| 信号 | 旧形式 | 新 tilt | 新乘子 | 说明 |
|---|---|---|---|---|
| video | 加性 `-0.15`（4 个 profile 一致） | `0.15` | `×0.85` | 与 rerank 路径今天的乘子**完全相同**，rerank-on 侧零变化 |
| city · 非档位 theme | `foods -0.115` / `lodging -0.18` / `transport -0.12` / `notes -0.12` / 默认 `-0.12` | `0.10` | `×0.90` | 统一收敛到 `0.10`；在乘性折算下旧值相当于 `×0.82~×0.885`，新值略轻，定位收窄为「同档内轻微倾斜」 |
| city · `backup_places` | `-0.3` → `×0.7` | — | — | **不再有 tilt**，由档位接管（不可翻越），旧值作废 |

`lodging` 由 `0.18` 降到 `0.10` 是刻意的——决策 4 已确认地点级住宿信息对去该景点的行程有价值，不该被压得比其他 city theme 更重。若阶段 8 实测发现住宿笔记仍在挤占前排，改 `cityTiltByTheme.lodging` 单值即可，结构已预留。

未采纳的策略 B（video `0.30` / city `0.24~0.36`，按「relevance ≈ 0.5 处与旧加性等值」反推）能让 rerank-off 顺序更接近今天，但数值不可解释、且与 rerank 路径现成的 `×0.85` 脱节。记录备查，不实现。

### 4.5 诊断字段

`diagnostics.chunks[]` 增加 `business` 块（`tier` / `tilt_multiplier` / `is_video` / `place_specific`）。

`diagnostics.rerank.items[]` 增加 `tier`；`penalty_multiplier` **保留原名**，语义收窄为「软降权乘子」（= `tilt_multiplier`）。改名会波及阶段 6 的 `retrieval.scoring` 元信息与已有文档，收益不足。

新增 `recall_status` 取值：无。档位不改变准入，只改排序，现有 5 种取值够用。

### 4.6 对外输出（已定）

- `result.score` **改为相关性总分**（`= breakdown.total`，即 4 个相关性信号的加权和），消 P4。agent 拿到的是「材料对目标有多相关」，不再是被业务规则揉过的数。
- 跨档时 score 仍不单调（高 relevance 的降档项可能排在低 relevance 的升档项之后），所以 `results[]` **暴露两个事实字段**：
  - `place_specific: true` —— 城市查询下该 chunk 绑定了具体景点；不为真时不输出（缺省即「城市级 / 非城市查询」）。
  - `tier: 1` —— 该 chunk 在档位 theme 里被降档；为 0 时不输出。
  两者都只陈述事实、不含任何权重数值。agent 要还原「为什么这么排」还需要规则本身，所以 R3 把 `business_rules`（`city_tier_themes` / `video_tilt` / `city_tilt`）发布到 `retrieval.scoring` 元信息——**事实字段 + 规则元信息一起才构成可解释性**，缺任一半 agent 仍会看到「分低却排前面」而无从判断。
- rerank 概率、tilt 数值一律不写入 `retrieval-workspace.json` 的常规阅读索引（沿用现有约定）。

### 4.7 已知限制

- **档位占满窗口的风险**：若某 theme 的城市级候选数 ≥ `recallWidth`（12），窗口会被城市级占满，地点级完全进不了 rerank。当前城市级候选数只有 1~4（昭通 1、毕节 4），不触发。**触发条件**：`城市级候选数 ≥ recallWidth` 时需引入档位配额（每档保底 N 条）。现阶段只记录，不实现。
- 档位粒度是二元的。若将来需要三档，`tier` 改成整数即可，排序键不用动。

---

## 5. 影响面

| 文件 | 改动 |
|---|---|
| `scripts/rag/rag_retrieval_config.mjs` | 新增 `RAG_SCORING`；删除两个 `CITY_PLACE_SPECIFIC_*` 常量 |
| `scripts/rag/rag_retrieve.mjs` | `scoreWeights()` 权重表（4 profile）、`scoreBreakdown()`、`scoreChunk()` 返回值、新增 `businessState()` / `tiltMultiplier()`、删除 `businessPenaltyMultiplier()`、`cityPlaceSpecificPenaltyWeight()` / `cityPlaceSpecificPenaltySignal()` 并入 `businessState()` 后删除、`rankedRows` 过滤条件与排序键、rerank-off 最终排序、`resultForChunk()`、`diagnosticForRow()` |
| `scripts/rag/rag_rerank.mjs` | `penaltyMultiplierOf()` → 读 `scored.business.tilt_multiplier`（R1 阶段先加 `?? scored.businessPenaltyMultiplier ?? 1` 兼容读取，避免排序键切换前的空窗）；新增 `tierOf()`；`compareRerankedRows()` 首键改 tier；items 增 `tier`；文件头职责说明 |
| `test/rag_retrieve.test.mjs` | 8 处评分断言（`score.contributions.city_place_specific_penalty` × 5、`score.weights.city_place_specific_penalty` × 1、`score.total` × 1、`score.signals.video_source_penalty` × 1）改为断言 `business.tier` / `business.tilt_multiplier` |
| `scripts/rag/create_retrieval_workspace.mjs` | **不改**；仅回归验证（`--rerank` 透传属 rerank 阶段 6，本次不碰） |
| `references/rag-rerank-*.md` | 回写：penalty 折算位置、排序键、诊断字段、`business_rules` 元信息 |

---

## 6. 分阶段执行

**提交粒度**：R1~R4 各自独立提交。R1 与 R2 之间存在一个「rerank 暂时只读到兼容字段」的空窗（见 R1 第 8 步），但该空窗只在 CLI `--rerank` 路径可见 —— rerank 尚未接入 `create_retrieval_workspace.mjs` 生产链路，可接受；不过 R2 要紧接 R1 做完再跑联调，不要停在中间态上评估 rerank 效果。

### R1 · 评分分层 + 排序键统一（`rag_retrieval_config.mjs` + `rag_retrieve.mjs` + `rag_rerank.mjs` 兼容读取）

1. config 新增 `RAG_SCORING`，删除 `CITY_PLACE_SPECIFIC_PENALTY_BY_THEME` / `DEFAULT_CITY_PLACE_SPECIFIC_PENALTY_WEIGHT`。
2. `scoreWeights()` 4 个 profile 删掉 `video_source_penalty` / `city_place_specific_penalty` 两项权重。
3. 新增 `businessState(chunk, entity, theme)` → `{ tier, tilt_multiplier, is_video, place_specific }`；`businessPenaltyMultiplier()` 改名为 `tiltMultiplier(...)`，只算软降权。
4. `scoreChunk()` 返回 `{ score, matches, breakdown, business }`，其中 `score` = `breakdown.total`（纯相关性）。
5. `resultForChunk()` 改用相关性分，并按 4.6 输出 `place_specific` / `tier` 两个事实字段（缺省不写）。
6. `rankedRows` 排序键改 `tier asc → relevance_total desc → …`；过滤条件只剩相关性（消 P3）。
7. rerank-off 时在 `retrieve()` 里按 `(tier, relevance × tilt)` 重排一次；rerank 启用时交给 rerank。
8. `rag_rerank.mjs` 的 `penaltyMultiplierOf()` 临时加兼容读取 `scored.business.tilt_multiplier ?? scored.businessPenaltyMultiplier ?? 1`——**本步不改 rerank 排序键**，避免在排序键切换前把业务约束整段丢掉。
9. 更新 `test/rag_retrieve.test.mjs`（8 处评分断言）。

**为什么结构与排序键必须同一步做完**：只改结构不改排序键会落到「业务约束被整段移除」的中间态（`score` 已不含 penalty，比较器却还在读 `score`），比改前更差；只改排序键不改结构则无处取 `tier`。两者不可分割。

**验收**：`npm test` 全绿；`breakdown` 只剩 4 个信号；`business` 块字段齐全；**构造 fixture（城市级 relevance 0.4 / 地点级 relevance 0.9）→ 城市级仍排第一，档位不可翻越**；档内 `result.score` 与顺序单调。

### R2 · rerank 消费新契约（`rag_rerank.mjs`）

1. `penaltyMultiplierOf(row)` 收敛为只读 `scored.business.tilt_multiplier`，非有限数按 1。
2. 新增 `tierOf(row)` 读 `scored.business.tier`，缺省 0。
3. `compareRerankedRows()` 第一键 = `tier` 升序，第二键 = `final_rerank_score` 降序。
4. items 增 `tier`；文件头职责说明更新（补「档位由主流程给出，本模块只消费」）。

**验收**：rerank 启用下，城市级候选即使概率低也排在地点级之前（fixture 固定概率验证）；R3 的兼容分支已删除。

### R3 · 诊断与文档

1. `diagnosticForRow()` 输出 `business` 块。
2. 回写 `references/rag-rerank-technical-design.md`（排序键、penalty 折算位置、档位与 tilt 语义、对外字段）与 `references/rag-rerank-execution-plan.md`（新增「实现偏离 / 已修正」条目）。
3. 在 rerank 阶段 6 的 `retrieval.scoring` 元信息里预留 `business_rules`（`city_tier_themes` / `video_tilt` / `city_tilt`），与 4.6 的对外事实字段配套。

### R4 · 验证

| 项 | 内容 |
|---|---|
| 单测 | 更新后的 `rag_retrieve.test.mjs` + 新增「档位不可翻越」用例 |
| 冒烟 | 现有 10 组 rerank 冒烟（`tier` 加入后 fixture 需补 `scored.business`） |
| 端到端 · 档位 | 毕节 `backup_places`（19 eligible / 4 城市级）、昭通（1 城市级）：城市级全部在窗口内且排在档内首位 |
| 端到端 · 全扫 | 3 城市 × 5 theme，对照改前/改后的 `results` 顺序 diff 与 eligible 数。**顺序变化需逐条确认属于「修意图偏离」而非新缺陷**（决策 5 已接受该变化） |
| 端到端 · rerank | `大山包/highlights` 真实服务联调（住宿 0.079 / 餐饮 0.109 仍被过滤） |
| 回归 | `npm test`；打包路径 `create_retrieval_workspace.mjs` 无回归 |

---

## 7. 已定决策（2026-09-18）

| # | 决策点 | 采纳 | 理由 / 落地位置 |
|---|---|---|---|
| 1 | tilt 标定：A 还是 B | **策略 A** —— video `0.15`、city `0.10` | 数值可解释；video 乘子与 rerank 路径现状 `×0.85` 完全一致；`backup_places` 旧值 `×0.7` 随档位作废。→ 4.4 |
| 2 | `result.score` 是否改为相关性分 | **改**（`= breakdown.total`） | 消 P4；agent 需要的是「材料有多相关」，不是被业务规则揉过的数。→ 4.6 |
| 3 | `results[]` 是否暴露可解释字段 | **暴露** `place_specific: true` / `tier: 1`，缺省不写 | 否则跨档时 agent 会看到「分数更低却排前面」而无从判断；配合 R3 发布 `business_rules` 元信息才是完整可解释性。→ 4.6 |
| 4 | `lodging`（`-0.18`）归软降权还是升为档位 | **软降权**（tilt `0.10`） | 地点级住宿信息（山上民宿）对去该景点的行程有价值；硬档位会让缺城市级材料的 theme 输出质量骤降。→ 4.2 / 4.4 |
| 5 | rerank-off 默认输出顺序会变（当前是生产路径） | **接受** | 当前排序本就偏离已确认意图（P5），改动集中在城市 theme；R4 全扫逐条确认变化属于「修意图偏离」。→ R4 |

被否决的方案（策略 B 的标定数值、其余 city theme 一起升档位）分别记录在 4.4 / 4.2，不另立条目。

---

## 8. 不做的事

- 不引入档位配额（当前档位候选数远小于窗口，触发条件已记录在 4.7）。
- 不做「档位的三档细分」。
- 不做 per-theme tilt 差异化数值（`cityTiltByTheme` 四个值统一 `0.10`，结构保留给阶段 8 调参）。
- 不改 `recallWidth` / `probThreshold` 数值（属阶段 8 调参）。
- 不改 rerank 的 query 模板表。
- 不动 `gate` 判定逻辑。
- 不把 tilt / 概率 / 权重数值写入 `results[]`（只写事实字段）。
