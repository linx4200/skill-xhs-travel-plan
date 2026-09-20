# RAG 自动调参 — Agent 执行意图说明书

本文档是「启动一个 agent 自动调参」任务的**意图冻结件**。面向执行 agent，记录用户的目标、约束、决策授权和交付要求。与 `USAGE_GUIDELINE.md`（怎么用评估体系）、`RAG_TUNING_TECHNICAL_PLAN.md`（技术方案）并列：本文档回答的是**「为什么调、调到什么算好、哪些不许动、谁拍板」**。

---

## 0. 任务一句话

在**扩大后的 RAG 索引**上，用「配额 + 降权系数 + rerank」三层旋钮自动搜索，找到一组参数，使其在 B1 基准上**明确优于默认参数基线**；交出一份带对照表的调参报告，并把最优参数落地到 `scripts/rag/rag_retrieval_config.mjs`。

---

## 1. 目标函数

### 1.1 用户原话定义

> 「在同等读取数据的量级下，能提取到更多有用信息。」

本质是**提高信噪比 / 单位 chunk 的信息产出**，硬约束是**不退化**。

### 1.2 可测化后的三把尺子（同时使用）

用户明确要求三把尺子**都算、都写进报告**，由 agent 综合判断并给出推荐。

| 编号 | 尺子 | 含义 | 计算方式 |
|---|---|---|---|
| M1 | facts 字段填充率 | 同样读取 N 条 chunk，facts 里被填满的字段数 | 统计 `facts-workspace.json` 中各 target 的 `summary`/`highlights`/`tickets`/`routes`/`practical_info`/`notes` 等字段的非空占比 |
| M2 | 有用 chunk 占比 | 信噪比 | 阅读池中被 facts 实际引用/吸收的 chunk ÷ 阅读池总 chunk 数 |
| M3 | 有效新增（单位＝证据 chunk） | 基准外被捞到的有价值信息 | `report.json.metrics.M3`，见 §1.2.1。**不是 `deltas.json.new_items` 条数** |

#### 1.2.1 M3 的度量单位（2026-09-20 修订，见 §12 索引）

M3 原先定义为 `deltas.json.new_items` 条数，实测不可用：B1 基准条目是**粗粒度摘要**，生成层按字段展开，一条基准 ≈ 3~4 个候选条，导致条数虚增（P1 基线 162 条，其中 146 条只是既有信息的细化拆分）。且「某条候选是否携带基准没有的新事实」是**阅读理解判断**，实测字符 bigram、整段命中、embedding 余弦三种自动比较全部无法区分真实重复与真实新增（已知重复项与已知新增项得分重叠）。

因此 M3 改为以**证据 chunk** 为单位，按 `(target_type, target_name, theme)` 分组聚合。证据是分组级的，把一条基准拆成 3 条候选 chunk 集合不变，**天然免疫粒度虚增**。

| M3 字段 | 含义 | P1 基线-t0 实测 |
|---|---|---|
| `novel_evidence_chunks` | 候选证据中「基准从未使用过」的 chunk 数（产出侧，**主计分项**） | 40 |
| `novel_evidence_groups` / `candidate_groups` | 含新增证据的分组数 / 候选总分组数 | 25 / 29 |
| `new_topic_groups` | 基准完全没有对应分组的全新覆盖数 | 5 |
| `novel_pool_chunks` | 阅读池中「基准从未使用过」的 chunk 数（池侧，对配额敏感） | 53 |
| `read_pool_chunks` | 阅读池总 chunk 数 | 82 |
| `raw_candidate_items` / `effective_new_items` | **诊断用，不计分**（粒度不齐，跨轮不可比） | 162 / 146 |

> 与 §12 索引中 E2 的关系：E2 只**新增度量层**，未改动 `new_items` 的生成逻辑、覆盖判定、Gate 判定或任何既有指标。

### 1.3 「明确优于基线」的判定门槛

用户选择的标准是**必须明确优于基线**，不接受「有可比结论就算完成」。落地为如下**复合判据**（全部满足才算达成）：

1. Gate 全过（G2 critical 零丢失、G3 归位错误 0、G4 关键越界事实 0）。
2. 检索层全量召回率（R2）不低于基线。
3. 满足以下**任一**优势条件：
   - **省读型**：总读取 chunk 数相比基线下降 ≥ 10%，且上述 1、2 成立；
   - **增密型**：总读取 chunk 数量级不变（±10% 以内），但 M1 或 M2 提升 ≥ 10% 相对值，或 M3 的 `novel_evidence_chunks` 净增 ≥ 3 个（= 候选 ≥ 基线-t0 + 3）。
     > ⚠️ 本条「增密型」的量化口径经实测证明结构性不可达，已于 2026-09-20 修订，**以 §1.3.1 为准**。
4. 优势必须可复现：在 B2 交叉验证下不出现退化。

> 门槛数值（10% / 3 条）为 agent 依用户意图设定的初始值。若实际数据落在边界附近，agent 需在报告中显式标注"临界"，不得含糊判定。

#### 1.3.1 判据修订：增密型改用检索层口径（2026-09-20，P2 后生效）

**修订对象**：§1.3 第 3 条的「增密型」分支。第 1、2、4 条**不变**。

**修订原因（实测，非推测）**：原增密型用 facts 层产出指标（M1/M2 相对提升、M3 净增）做门槛，但 M1/M2 的分母、M3 的基数都是读取池容本身，而增密型又要求池容变动不超过 ±10% —— 判据同时锁死分子与分母，**在窗口内数学上不可达**。实测斜率：读取量每 +1%，`novel_evidence_chunks` 约 +0.8；要在 ±10% 窗口内达到 M3 ≥ 基线+3，需要池容 ≥ 95（= +16%），与窗口互斥。实测数据见 `rounds/P2-2026-09-20/LOG.md` §2.4。

**修订后第 3 条**：

- **省读型**（表述不变）：总读取 chunk 数相比基线下降 ≥ 10%，且第 1、2 条成立。
- **增密型**（新口径）：总读取 chunk 数量级不变（±10% 以内），且**检索层关键召回率相对提升 ≥ 10%**（即 `R1 ≥ 基线 R1 × 1.10`），同时第 1、2 条成立，并且 **facts 层不退化**（`M1 ≥ 基线 M1` 且 `N2 ≤ 基线 N2`）。

**换口径的理由**：增密的本意是「同样的读取预算下，读到更多关键材料」。R1 是 critical 条目的承载 chunk 命中率，正是这个量，且它随窗口/排序改善而变动，不被池容锁死。facts 层不再当门槛，改用「不退化」约束守住底线——这与 §7 不变量 4 的意图一致。

**按修订后判据复核 F3（`recallWidth: 12 → 24`）**：

| 条件 | 要求 | F3 实测 | 判定 |
|---|---|---|---|
| 1 | Gate 全过 | PASS | ✅ |
| 2 | R2 ≥ 基线 0.8136 | 0.8870 | ✅ |
| 3-增密 | 读取量 ∈ [73.8, 90.2] 且 R1 ≥ 0.8577 | 83；0.8644 | ✅ |
| 3-不退化 | M1 ≥ 0.9474 且 N2 ≤ 2 | 0.9474；1 | ✅ |
| 4 | B2 交叉验证无退化 | 项目内无可比 B2 基线 | ⚠ 未验证 |

**结论：F3 按修订后判据达成**（第 4 条如实标注未验证，不声称已验证）。

**修订授权**：用户于 2026-09-20 明确批准（选择「落地 F3（推荐）」，并同意一并修正判据标定问题）。

---

## 2. 搜索空间

### 2.1 允许动的三层

| 层 | 内容 | 是否有 CLI 入口 | 写入方式 |
|---|---|---|---|
| L1 配额 | `placeMaxThemeChunks`、`cityMaxThemeChunks`、`maxPlaceChunks`、`maxCityChunks` | 有（`--place-top-k` / `--city-top-k` / `--max-place-chunks` / `--max-city-chunks`） | CLI 覆盖，零侵入 |
| L3 降权系数 | `RAG_SCORING.videoTilt`、`defaultCityTilt`、`cityTiltByTheme`、`cityTierThemes` | **无** | 临时改 `rag_retrieval_config.mjs` + 强制还原 |
| L4 rerank | 开关、`probThreshold`、`recallWidth` | 有（`--rerank` / `--rerank-threshold` / `--rerank-recall-width`） | CLI 覆盖，零侵入 |

### 2.2 严格禁止动的一层

- **L2 主题词表完全冻结**：`PLACE_THEMES`、`CITY_THEMES` 的**词条内容、词条增删、主题顺序**一个字都不许改。
- 理由：改主题顺序会改变「名额先到先得」的分配结果，属于结构性变更，不在本轮授权范围。

### 2.3 未纳入搜索的旋钮（本轮）

`keywordScoreTermCap`、`minHealthyPlaceChunks`、`minHealthyCityChunks`、`ragRetrieveResultChunks` —— 保持默认不动。

### 2.4 runner 可用性

- rerank 服务 `http://127.0.0.1:11435/rerank` **已探活通过**（返回 400 表示服务在线）。
- Ollama `http://127.0.0.1:11434` **在线**（embedding 走 `qwen3-embedding:0.6b`，1024 维）。
- rerank 纳入搜索；每轮开始前探活，服务不可用则该组候选自动跳过 rerank 维度并在报告中记录降级。

---

## 3. 索引扩容方案

### 3.1 背景数据

| 项 | 扩容前 | 扩容后（目标） |
|---|---|---|
| 原始素材 `<UPSTREAM_ROOT>/resources/` | 53 个（46 json + 6 md/txt + photos） | 不变 |
| 已转 markdown `resources-md/` | **仅 7 个文件** | 全部素材 |
| `rag-index.json` chunk 数 | **61** | 数百（预计 ≥300） |

> `<UPSTREAM_ROOT>` 为上游素材与索引生成项目根目录（实机绝对值记录在 `.workbuddy/memory/`，按项目脱敏约定不入库）。上游 pipeline：`01 convert_resources → 02 apply-md-frontmatter → 03 split-md → 04 embed_chunks → 05 merge-chunks-to-jsonl`，脚本输出路径**全部硬编码**到 `<UPSTREAM_ROOT>` 根下。

### 3.2 扩容规则

1. **只补素材，绝不改切分粒度。** chunk id 格式为 `<源文件名>#<序号>`，是确定性格式；只新增文件时，已有 7 个文件的 chunk 序号不变，B1 基准引用的 38 个唯一 `source_chunk_ids` 依然指向同一段正文。
2. **photos 图片目录不入索引**（图片本来不产生 chunk）。
3. **样本路线不扩**：`route-structure.json` 仍是 B1 对应的 2 景点 + 2 城市 + 2 天。新增素材中其他目的地的内容，通过 entity gate 自然成为干扰/竞争项。
4. **不动上游产物就地覆盖的风险**：重建会覆盖 `<UPSTREAM_ROOT>/resources-md/`、`resources-chunk/chunks/`、`resources-chunk/rag-index.json`。因此必须先整目录备份。

### 3.3 强制保险：chunk id 对账

重建索引后、开始调参前，**必须**执行对账：

- 校验 B1 checklist 全部 **38 个唯一 `source_chunk_ids`**（跨 36 条共 177 次引用）在新索引中**全部存在**。
- 校验这些 chunk 的 `text` 正文**未发生变化**（逐条哈希比对）。
- 对账不通过 → **立即中止，恢复备份索引**，不得进入调参阶段。

### 3.4 预期副作用（已知并接受）

素材从 7 个文件扩到 53 个后，同一景点的竞争 chunk 暴增（九洞天相关笔记 11 份、兴文石海 4 份），**默认参数很可能在新索引下直接掉出 PASS**。这不视为故障，而是本轮调参要解决的真实问题。

---

## 4. 执行流程

### 4.1 输入契约（P1 启动前置）

| 输入 | 要求 | 来源 |
|---|---|---|
| 扩容后的 `rag-index.json` | 必须是**路径未脱敏的原件**（`resource_root` 为真实路径）。仓库内 `output/rag-e2e-smoke/rag-index.json` 已被脱敏为 `<RESOURCE_ROOT>/...`，**不可直接复用于跑链路**，只可用于对账比对 | 用户提供 |
| `route-structure.json` | 复用 `output/rag-e2e-smoke/route-structure.json`（2 城 2 景点 2 天），与 B1 样本一致 | 项目内，除非用户要求更换 |
| 工作目录 | **必须新建独立目录**，不得复用 `output/rag-e2e-smoke/` —— 该目录是 B1 的溯源依据，覆盖将导致基准不可复查 | agent 新建 |
| photos 目录 | 本轮不渲染 HTML，**非必需** | — |
| `retrieval-log.json` | 由 agent 用 `rag:workspace --log` 生成，**不需要用户提供** | agent 生成 |

### 4.2 基线检索模式（必须与 B1 一致）

现有 `output/rag-e2e-smoke/retrieval-workspace.json` 显示 B1 基线产物的实际检索模式为：

- `scoring.strategy` = `candidate_gated_embedding_keyword_entity_title_rerank`
- **embedding 开启**（非 `--no-embedding`）
- **rerank 开启**（`rerank.enabled: true`，`recall_width: 12`，`probability_threshold: 0.9`，且存在 `retrieval-log.json`）
- 配额为默认值：`place_top_k=5`、`city_top_k=5`、`max_place_chunks=50`、`max_city_chunks=25`

> 📌 上面的 `recall_width: 12` 是 **t0 冻结当时**的窗口值，属历史事实，不得回溯修改。P2 结束后默认窗口已上调为 **24**（落地记录见 `rounds/P2-2026-09-20/LOG.md` §2.6），因此**新候选与新基线**在窗口维度上不再与 t0 同参数。比较时必须拿 t0 的独立复现记录（`output/rag-expanded-baseline/`）当基准，不能用「当前默认值」反推 t0。

> ⚠️ `output/rag-e2e-smoke/README.md` 中「第一轮验证使用 `--no-embedding`，不启用 rerank」是**首次跑通的临时说明，已过时**，与最终冻结产物不一致。以本节为准。
> P1 基线必须复现该模式（embedding + rerank 全开），否则与 B1 基准不可比。

### 4.3 阶段划分

```text
P0 准备
   ├─ 备份上游 resources-md/ 与 resources-chunk/
   ├─ 跑上游 pipeline 全量重建索引
   ├─ chunk id 对账（38 个唯一 id：存在性 + 正文哈希）—— 不通过则中止回滚
   └─ 建立本轮工作目录，落地新 rag-index.json

P1 基线
   ├─ 用「默认参数 + 新索引」跑一遍完整链路
   ├─ 产出基线的 facts-workspace / retrieval-workspace / retrieval-log
   ├─ 执行 B1 快评，得到「参考起点」的 Gate / 三把尺子数值
   └─ 记录为 baseline-t0

P2 搜索（两阶段漏斗）
   ├─ 阶段 A（粗筛，廉价）：只跑检索层，用 R1/R2/R3/R4、主题空池、配额丢弃
   │   淘汰明显不行的候选；每次几秒钟、零 LLM 成本
   ├─ 阶段 B（精读，昂贵）：只对入围的 1-2 组候选完整重跑 facts 层
   │   （agent 读阅读池 → 产出 facts-patch → apply → facts-workspace）
   └─ 循环，直到触发停止条件

P3 交叉验证
   └─ 对 P2 的最优候选补跑一次 B2 全评，确认无退化

P4 交付
   ├─ 生成调参报告
   ├─ 把最优参数永久写入 scripts/rag/rag_retrieval_config.mjs
   └─ 还原所有临时改动，校验工作区干净
```

### 4.4 facts 层重跑策略（agent 决策）

采用**两阶段漏斗**：先用零成本的检索层指标粗筛，只对最有希望的 1-2 组做昂贵的 facts 重读。理由：检索层指标几秒钟出结果，足以淘汰明显不行的候选；把 LLM 阅读预算留给真正要定胜负的候选，既不牺牲最终结论可信度，又避免每组候选都付一次长文阅读成本。

### 4.5 每轮参数应用纪律

- L1 配额、L4 rerank：一律走 **CLI 覆盖**，`rag_retrieval_config.mjs` 一字不动。
- L3 降权系数：先备份原值 → 临时改文件 → 本轮跑完**立即按 diff 校验还原**。
- 每组候选的完整参数集写入该 run 的 `params.json`（通过 `assessment:prepare` 的 `--set` / `--cli-overrides`）。

### 4.6 裁定纪律

`adjudications.json` 的 `coverage_overrides` 与 `semantic_scores` **由 agent 代裁定**，但：

- 每一条代裁定必须在报告中单独标注为「自动裁定项」，并附判定依据。
- 用户可事后抽查任意一条并推翻，推翻后需重跑评估。
- 不得把代裁定结果说成人工确认结论。

### 4.7 失败与回滚

| 情况 | 处理 |
|---|---|
| 单组候选执行失败 | 记录该组失败原因，跳过，不阻塞整体搜索 |
| chunk id 对账不通过 | 立即中止，恢复备份索引，报告说明，不进入调参 |
| rerank 服务探活失败 | 该组候选降级为「不含 rerank 维度」，报告中标注 |
| 搜索结束后 | `rag_retrieval_config.mjs` 必须处于「已落地最优参数」状态；其他一切临时改动必须还原；工作区用 git status 校验 |
| 全部候选都不优于基线 | 如实报告「未调到明确更优」，保留基线参数，不虚报达成 |

---

### 4.8 每轮事实层的标准作业（P2 起适用）

1. 生成 facts 时逐条对照阅读池，**证据在池内就必须写入**；证据不在池内的信息不得凭空补写（否则构成幻觉并触发 G4）。
2. 每轮生成后走 `assessment:evaluate`，从 `adjudications.json.coverage_review_items` 读全部待裁定项。
3. 对每条按语义裁定 `facts_covered`，理由要写明「语义对应关系」或「该信息在阅读池中不存在」。
4. 裁定记录另存为 run 目录下的 `adjudication-decisions.json`（可审计），再合并进 `adjudications.json`。
5. 重跑 `assessment:evaluate` 使报告与裁定一致。

## 5. 停止条件

- **收敛即停**：连续 2 轮没有候选能超过当前最优，即停止搜索。
- **兜底硬上限**：最多 15 组候选（agent 依用户意图补充的安全阀，防止不收敛时无界运行）。到上限即停并如实说明未收敛。

---

## 6. 交付物

| 交付物 | 内容要求 |
|---|---|
| 调参报告（md） | 候选对比表（逐组列 Gate / R1 / R2 / N1 / N2 / M1 / M2 / M3 / 总读取量）、基线对照、最优参数、推荐理由、回滚方式、自动裁定项清单、降级说明 |
| 逐候选 run 目录 | 每组候选一个 `assessment/rag-tuning/runs/<run_id>/`，含 `report.md` / `report.json` / `deltas.json` / `params.json` / `adjudications.json`，结论可追溯 |
| 参数落地 | 最优参数写入 `scripts/rag/rag_retrieval_config.mjs`，永久生效（用户事后 review） |
| 复现命令清单 | 报告中附本轮完整命令序列，保证可重跑 |

B1 能力位只到检索层 + facts 层，**本轮不渲染 HTML**，报告中呈现层指标按既定规则记为 `N/A`。

---

## 7. 不变量清单（违反即视为执行错误）

1. `PLACE_THEMES` / `CITY_THEMES` 词条内容、增删、顺序 **零改动**。
2. 切分粒度 **零改动**（只新增素材文件）。
3. 不覆盖 B1 / B2 正式基准文件。
4. 不修改评估脚本的判定逻辑来「让结果好看」。
5. 任何临时改动必须在交付前还原（除最优参数落地这一项）。
6. 报告结论必须与 `report.json` 一致；不得出现脚本算 A、报告说 B。
7. 不得把降级归因（缺 `retrieval-log.json`）的结果当正式调参结论。
8. 不得跨样本比较 B1 与 B2 的数值。

---

## 8. 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 重建索引导致旧 chunk id 错位 | B1 基准全面失效 | 对账保险 + 立即回滚 |
| 上游 pipeline 就地覆盖既有产物 | 原始 61 chunk 索引丢失 | P0 整目录备份 |
| 小样本过拟合（B1 仅 2 景点 2 城 2 天） | 参数换到真实全量样本退化 | P3 用 B2 交叉验证 |
| 扩容后默认参数直接 FAIL | 「优于基线」基线本身不可用 | 以 P1 实测结果为参考起点，不预设成败 |
| rerank 服务中途掉线 | 候选间不可比 | 每组探活 + 报告中标注降级 |
| 配额压缩与「有效新增」目标天然互斥 | 单一指标导向会顾此失彼 | 三把尺子同时记录，复合判据判定 |

---

## 9. Agent 自行决定的条目（用户授权）

用户对以下问题明确授权 agent 决策，记录以备复核：

| 议题 | 决策 | 依据 |
|---|---|---|
| facts 层重跑次数 | 两阶段漏斗，只对入围候选精读 | 成本与可信度的最优折中 |
| 收敛兜底上限 | 15 组候选 | 防止无界运行 |
| 本轮是否渲染 HTML | 不渲染 | B1 能力位不含呈现层 |
| 「明确更优」的量化门槛 | R2 不降 + 读取量降 ≥10% 或信息密度提升 ≥10% / 新增 ≥3 条 | 用户选择「必须明确优于基线」并给出 10% 示例 |
| 每轮参数写入方式 | CLI 覆盖优先，无入口的临时改+还原 | 最小化对源文件的侵入 |

---

## 10. 采访记录（意图原始出处）

| # | 议题 | 用户回答 |
|---|---|---|
| Q1 | 一组参数凭什么比另一组「更好」 | 更精准优先级更高，但也要能扩大真实资料覆盖范围且不退化 |
| Q2 | 「扩大真实资料覆盖」指哪一层 | 换个说法：在同等读取数据的量级下，能提取到更多有用信息 |
| Q3 | 允许动哪几层 | 配额（L1）、降权系数（L3）、rerank（L4） |
| Q4 | 主题词表怎么处理 | 完全冻结，不增不删不改顺序 |
| Q5 | 交付形态 | 先手动跑通一轮，验证后再决定是否固化成 Skill / 脚本 |
| Q6 | 调参决策权 | Agent 自主决策，连续跑完再交最优解 |
| Q7 | adjudications 裁定 | Agent 代裁定 + 在报告中标注供抽查 |
| Q8 | facts 层重跑策略 | 用户授权 agent 决定 → 采纳两阶段漏斗 |
| Q9 | rerank 用法 | 主动纳入搜索（开关、阈值、候选窗口都搜） |
| Q10 | 降权系数写入方式 | 临时改文件 + 强制还原 |
| Q11 | 「调到更好」看哪一头 | 两个都看：省着读不退化 + 拿到定量有效新增 |
| Q12 | 停止条件 | 收敛即停（连续 2 轮无候选超过当前最优） |
| Q13 | 信息密度用什么尺子 | 三个都看（字段填充率 / 有用 chunk 占比 / 有效新增条数） |
| Q14 | 交付物 | 报告 + 逐候选 run 目录 + 最优参数直接落地 config |
| Q15 | 样本范围 | 扩充样本：重建一个「更多 chunk」的 rag-index 来跑 |
| Q16 | 怎么变多 | 只补素材，不改切分颗粒度 |
| Q17 | 补素材范围 | 全部补（46 json + 6 md/txt，photos 不索引） |
| Q18 | 默认参数退化怎么办 | 先跑基线，把结果当新索引下的参考起点，再定目标 |
| Q19 | 结论文档位置 | `assessment/rag-tuning/INTENT.md` |
| Q20 | 本轮验收标准 | 必须明确优于基线 |

---

## 11. 领域用词对照（用户原话 → 代码字段）

| 用户说法 | 对应代码 |
|---|---|
| 第 1 层「配额」 | `RAG_RETRIEVAL_DEFAULTS.placeMaxThemeChunks` / `cityMaxThemeChunks` / `maxPlaceChunks` / `maxCityChunks` |
| 第 2 层「主题词表」 | `PLACE_THEMES` / `CITY_THEMES`（本轮冻结） |
| 第 3 层「降权系数」 | `RAG_SCORING.videoTilt` / `defaultCityTilt` / `cityTiltByTheme` / `cityTierThemes` |
| 第 4 层「rerank」 | `RAG_RERANK_DEFAULTS.enabled` / `probThreshold` / `recallWidth` |
| 阅读池 | `retrieval-workspace.json` |
| 第 2 段（重读） | agent 读阅读池 → facts-patch → `facts-workspace.json` |

---

## 12. 评估体系修订索引

评估体系（度量口径、裁定分流）的历次修订，**过程记录**放在对应轮次日志里；本节只保留索引。
每条修订的**当前有效规则**已并入上文对应章节，不在此重复。

| 编号 | 日期 | 一句话 | 当前有效规则的位置 | 过程记录 |
|---|---|---|---|---|
| E1 | 2026-09-20 | facts 层补上裁定分流（`adjudication_needed` 增收「未覆盖但已召回」项） | §4.6 裁定纪律、§4.8 每轮事实层的标准作业 | `rounds/P2-2026-09-20/LOG.md` §A1 |
| E2 | 2026-09-20 | M3 改用「证据 chunk」为单位（主计分项 `novel_evidence_chunks`） | §1.2.1 M3 的度量单位 | `rounds/P2-2026-09-20/LOG.md` §A2 |

> **收录口径**：判定链路的修订（度量口径、裁定分流、Gate 相关）必须记入本索引；
> 与判定链路无关的工程改动记在 `CHANGELOG.md`。
> 判据本身的修订（如 §1.3.1 的增密型口径）直接写在 §1.3 下方，不另立索引条目。

---

## 13. 轮次记录索引

每轮自动调参的**执行流水、调参报告与候选全表**，统一放在 `rounds/<轮次目录>/`，与本文件分离。
**本文件（INTENT.md）不记录任何单轮的执行流水。**

| 轮次 | 日期 | 一句话结论 | 目录 |
|---|---|---|---|
| P2 | 2026-09-20 | 落地 `RAG_RERANK_DEFAULTS.recallWidth: 12 → 24`（按修订后 §1.3.1 判据达成） | `rounds/P2-2026-09-20/` |

**轮次目录约定**（`rounds/<轮次目录>/`）：

| 文件 | 内容 |
|---|---|
| `LOG.md` | 执行流水：结论、入围候选、机制事实、纪律记录、落地记录 |
| `P2-TUNING-REPORT.md` | 调参报告（文件名随轮次命名） |
| `P2-SWEEP.json` | 阶段A 候选全表（文件名随轮次命名） |

逐候选评估记录仍在 `runs/<run_id>/` —— 那是评估脚本的**固定输出目录**，不随轮次移动，
按 `.gitignore` 约定本地保留、不入库。
