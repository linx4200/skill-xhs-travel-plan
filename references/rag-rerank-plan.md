# RAG Rerank（Cross-Encoder 重排）预研与方案

> **状态：预研完成，尚未实施。** 本文记录 2026-09-17 的方案讨论与实测结论，作为后续动工依据。
>
> **定位：本文不是已生效的流程规范。** [rag-workflow.md](rag-workflow.md) 描述的仍是当前线上流程；本文是它未来可能演化出的 rerank 分支的原料。

## 一、目标

**唯一目标：提高检索 top-5 的准确率。**（已确认）

**设计：在检索链的「theme 内」位置插入 cross-encoder 重排。**
每个 theme 当前的逻辑是「打分排序 → 取 5 条（`topK`）」，改为「打分排序 → 宽召回 N 条 → rerank → 压回 5 条」。

### 为什么不能加在 `scripts/` 那条链上

`skill-travel-plan-test/scripts/` 里的 `split → embed → match → merge` 是一条**离线索引链**，四个步骤都只接触文档、不接触 query。而 reranker 的输入是 `(query, doc)` 对，天生只能查询时计算。

真正的检索代码在**本项目**：

| 项 | 位置 |
|---|---|
| 检索主流程 | `scripts/rag/rag_retrieve.mjs` |
| 插入点 | `retrieve()` 内 `rankedRows.slice(0, topK)`（约第 779 行） |
| theme 循环调度 | `collectThemeResults()` |
| 配置 | `scripts/rag/rag_retrieval_config.mjs` |
| 上层入口 | `scripts/rag/create_retrieval_workspace.mjs` |

## 二、现状实测（基线）

| 项 | 实测值 |
|---|---|
| 索引 | `resources-chunk/rag-index.json`，**306 chunks**，**1024 维**，全部含向量 |
| chunk 长度 | min 29 / p50 142 / p90 188，**平均 131 字** |
| 检索策略 | `candidate_gated_embedding_keyword_entity_title` |
| 打分权重 | 向量 0.6 + 关键词 0.2 + 路由实体 0.15 + 标题 0.05 |
| 候选池 | place ≤ 50、city ≤ 25，最终 `top_k = 5` |
| theme 调用次数 | **8 景点 × 10 themes（`PLACE_THEMES`）+ 5 城市 × 5 themes（`CITY_THEMES`）= 105 次** |
| 现状 105 次检索耗时 | **10~20 秒**（每次仅一次 embedding HTTP 调用） |
| 20 条候选的分数分布 | **0.6200 ~ 0.7412，极差仅 0.12** ← 区分度很弱 |

按 `candidate_places` / `candidate_cities` 统计的 gate 后候选规模：

| 景点 | 候选数 | 城市 | 候选数 |
|---|---|---|---|
| 九洞天 | 73 | 毕节 | 83 |
| 兴文石海 | 55 | 昭通 | 57 |
| 盐津县城 | 40 | 盐津 | 40 |
| 大山包 | 37 | 威宁 | 35 |
| 百草坪 | 30 | 宜宾 | 13 |
| 草海 | 30 | | |
| 五尺道 | 29 | | |
| 豆沙关 | 29 | | |

**推论：「加大第一步候选池」这个优化空间很小。** `retrieve()` 已经对全部通过 gate 的 chunk 打分，`slice(0, topK)` 只是截断。能调整的不是「召回范围」，而是**截断前的宽度**。

## 三、可行性结论

### 3.1 不需要引入 Python

初步判断「必须 Python」是基于 Ollama 的限制推出来的，**不准确**。

| 路线 | 形态 | 新增依赖 | 判断 |
|---|---|---|---|
| **transformers.js + ONNX** | Node 进程内直接推理 | `@huggingface/transformers`（含 onnxruntime-node） | **采用**。无额外常驻服务，与现有纯 ESM 脚本同构 |
| llama.cpp server | 独立本地 HTTP 服务 `/rerank` | llama.cpp + GGUF 模型 | 与现有 Ollama 模式最像，但多一个常驻进程 |
| onnxruntime-node 裸用 | 进程内，自行管理 tokenizer | `onnxruntime-node` | 省内存，工作量最大 |
| Python CrossEncoder | 独立进程 | Python + torch | 无必要 |

**Ollama 路线已确认堵死**：本机 Ollama 0.33.3 `POST /api/rerank` 返回 **HTTP 404**；`/api/embed` 会做归一化 pooling，不返回相关性 logits。Node 侧不依赖它。

### 3.2 环境约束

| 项 | 实测 |
|---|---|
| `huggingface.co` | **不通（HTTP 000）** |
| `hf-mirror.com` | 通 |
| npm registry | 正常 |

走 transformers.js 必须设 `env.remoteHost = 'https://hf-mirror.com'`，或预先把模型下载到本地再指定本地路径。**不提前处理，第一次跑必然卡住。**

## 四、预研实测结果

### 4.1 依赖与模型

| 项 | 实测 |
|---|---|
| 依赖 | `@huggingface/transformers@4.3.0`，46 个包，安装约 3 分钟 |
| 模型 | `onnx-community/Qwen3-Reranker-0.6B-ONNX`（q4 量化） |
| 首次加载（含下载模型 ~400MB） | 216 秒 |
| **缓存后加载** | **3.9 秒** |
| 打分速度 | **0.62~0.91 秒/对**（单对波动 435ms ~ 2043ms） |

**关键实现事实：该模型是 CausalLM，不是 cross-encoder 分类器。**
它靠读末位 token 的 `yes` / `no` 两个 logits 做 softmax 打分，每对 query-doc 都要跑完整 **28 层前向**。这直接决定了性能量级——不能按轻量分类器估。

CPU-only：Node 环境下 `device` 只能是 `cpu`（webgpu 是浏览器路径）；模型只提供 q4 和 int8 两档量化，没有 fp16；chunk 平均 131 字已短到没有截断空间。**所以提速只能从「少跑几次」和「每次少几条」下手。**

### 4.2 效果：rerank 的 top-5 与现状只重合 1/5

用同批候选（大山包 × highlights，20 条）做前后对比：

| 指标 | 结果 |
|---|---|
| top-5 重合 | **1 / 5** |
| 现状分数极差 | 0.12（0.6200~0.7412） |
| rerank 分数极差 | 0.97（0.03~0.998） |
| rerank 后 top-5 内部差异 | **0.0003**（0.9995~0.9998） |

**最后一行很重要**：rerank 后 top-5 的分数挤在饱和区，差异小到不可靠。**它的可靠能力是区分「主题对得上 / 对不上」，不是排 1、2、3、4、5 的顺序。**

### 4.3 决定性发现：现状存在结构性召回缺陷

人工核对文本，rerank 的重排方向**是对的**，修正的错误很具体。

**highlights 主题**（query 是「看点/出片」），现状 top-5 里塞了 3 条美食住宿内容：

| chunk | 实际内容 | 现状排名 | 重排后 |
|---|---|---|---|
| `039-dashanbao-note.md#1` | 推荐民宿（**住宿**） | #4 | #19 |
| `039-dashanbao-note.md#2` | 推荐火锅（**吃饭**） | #3 | #16 |
| `昭通大山包.md#14` | 小肉串（**美食**） | #5 | #8 |

rerank 换进来的是真正讲机位与景观的：`020-dashanbao-note.md#1`（玻璃跳台、峡谷云海）、`020-dashanbao-note.md#2`（无人机、日出日落）、`013-dashanbao-note.md#1`（「下车即拍」）、`昭通大山包.md#1`（大河边瀑布「随手一拍就是一幅画」）。

**drawbacks 主题**同样：现状把「公路咖啡」「吃饭」排进 top-5，rerank 换成「路烂轿车不行」「路弯多注意安全」「玻璃跳台不用花钱了」。

**根因（两条，都是结构问题，调权重治不了）：**

1. theme 触发词里有「推荐 / 必去 / 值得 / 最佳」这类泛化词，会命中**任何推荐型内容**——不问它推荐的是景观还是火锅。
2. 一篇攻略被切成多个短 chunk（`039-dashanbao-note.md` 拆成住宿 / 吃饭 / 一日游 / 咖啡四段），短 chunk 的主题漂移被放大。

### 4.4 触发词的泛化度分级

泛化度 = 「是否会把跨主题内容误召回进该 theme」。**只有 `highlights` 和 `drawbacks` 两个 theme 做过实测核对**，其余是按词表推断，供选档参考。

**景点主题（`PLACE_THEMES`，10 个）**

| theme | 触发词 | 泛化度 |
|---|---|---|
| `highlights` | 看点 出片 宝藏 **必去 值得** 精华 机位 **推荐 最佳** 夯 | **严重** |
| `nearby` | 周边 附近 **景点** 顺路 路线 玩法 小众 打卡点 | **高** |
| `routes` | 路线 玩法 游览 顺序 环线 徒步 索道 游船 观光车 打卡点 | 中 |
| `facilities` | 厕所 卫生间 补给 **吃的 美食 餐饮** 小卖部 休息区 寄存 充电 游客中心 | 中 |
| `accessibility` | 无人机 老人 小孩 亲子 带娃 推车 无障碍 台阶 体力 | 低 |
| `safety` | 安全 注意 贴士 tips 防滑 风大 保暖 防晒 雨具 高反 海拔 温差 封路 | 低 |
| `crowds` | 人流 人少 人多 错峰 排队 拥挤 限流 早去 晚去 工作日 节假日 旺季 | 低 |
| `drawbacks` | 避雷 避坑 缺点 差评 不推荐 踩雷 失望 | 低 |
| `tickets` | 门票 票价 预约 开放 优惠 套票 免票 半价 购票 闭园 营业 | 低 |
| `transport` | 停车 导航 交通 路况 入口 自驾 高铁 塞车 包车 打车 班车 接驳 | 低 |

**城市主题（`CITY_THEMES`，5 个）**

| theme | 触发词 | 泛化度 |
|---|---|---|
| `backup_places` | **景点** 观景台 打卡点 冷门 **小众 顺路 附近 周边** 文创 手信 伴手礼 带娃 | **高** |
| `notes` | 风险 注意 安全 贴士 tips 天气 海拔 温差 高反 绕路 限流 堵车 物价 宰客 预约 关门 | 低 |
| `foods` | 美食 好吃 餐厅 小吃 夜市 宵夜 夜宵 早餐 早市 烧烤 火锅 蔬菜 咖啡 奶茶 特色菜 本地人 | 低 |
| `lodging` | 住宿 酒店 民宿 客栈 青旅 位置 商圈 隔音 性价比 | 低 |
| `transport` | 停车 路况 导航 限行 交通 自驾 高铁 大巴 包车 打车 拼车 公交 | 低 |

**一个反直觉的点**：触发词里出现「美食 / 咖啡 / 火锅」的 `facilities`、`foods` 看似危险，实际泛化度反而不如 `highlights`——因为它们是**内容类型词**，只会命中真正讲美食的 chunk；而 `highlights` 里的「推荐 / 必去 / 值得 / 最佳」是**评价词**，会无差别命中任何推荐型内容，包括推荐民宿、推荐火锅。**评价词比内容词危险得多。**

注意：实测中 `drawbacks` 出现的错排，根因是那些 chunk 文本里出现了「推荐 / 不用花钱」被 `highlights` 式泛化词命中，**不是它自己的词表有问题**——它的词表反而是最干净的之一。

## 五、方案相比最初判断的三处修正

| 最初判断 | 实测后修正 |
|---|---|
| 必须引入 Python | **不用**，Node + transformers.js 即可 |
| 要新写 14 个自然语言 query 模板 | **不用**。关键词堆 query（现状做法）与自然语言 query 的 top-5 高度接近，可先用现状 query 上线。自然语言版 logit 分离度略好（max 8.00 vs 6.03），留作后续优化 |
| 全量耗时 40~100 秒 | **错了**，是 22~32 分钟（CausalLM 每对跑完整 28 层前向） |

另有两条设计约束必须遵守：

1. **不能用 rerank 分数精排 top-5 内部顺序**（见 4.2）。建议改用 **prob 阈值过滤**：某 theme 只有 3 条过阈值就只给 3 条，比凑 5 条塞进无关内容好。
2. **业务状态不能被 rerank 冲掉**。主流程用 `scored.business.tier` 表达不可翻越档位，用 `scored.business.tilt_multiplier` 表达可翻越软降权。rerank 只消费这两个业务状态：先按 `tier` 分层，再按 `probability × tilt_multiplier` 排序。

### 位置 A 的边界：修不掉阅读池名额分配

theme 内重排只解决「同一 theme 内部排序不准」。另有一个跨 theme 的结构问题它治不了：

阅读池是 50 个名额、按 `PLACE_THEMES` / `CITY_THEMES` 的对象 key 书写顺序**先到先得**（见 `collectThemeResults()`）。排在前面的 theme 可能直接占满名额，后面的 theme（如 `safety`、`facilities`）一条都进不来——这不是排序问题，是配额问题。

要真正修复需要**位置 B 的全局重排 + 给每个 theme 保底名额**，属于独立的第二步。建议先把位置 A 做出来看实际收益，再决定要不要动配额逻辑（它牵动 `retrieval_health` / `unique_chunk_ids` 那一套机制，不宜与 A 同时改）。

## 六、成本档位

耗时 = **105 次 theme 检索** × 候选宽度 × 单对耗时。**12 条候选只是每一刀的宽度，105 才是乘数。**

| 策略 | 次数 | 对量 | 估算耗时 |
|---|---|---|---|
| 全量（10 + 5，全部 theme） | 105 | 1260 | 13~19 分钟 |
| **只跑高风险 theme**（highlights / nearby / facilities + 城市 backup_places） | 29 | 348 | **3.6~5.3 分钟** |
| 仅 highlights + nearby | 16 | 192 | 2.0~2.9 分钟 |
| 位置 B 全局重排（每景点 1 次） | 13 | ~390 | 4.0~5.9 分钟 |

对照：现状 105 次检索本身只花 10~20 秒。全量 rerank 会让这一步慢 **40~50 倍**。

**建议采用第二档（29 次 / 4~5 分钟）**：精准覆盖实测中真正会把美食住宿塞进 top-5 的 theme，而 `tickets` / `transport` / `crowds` 词表具体、本来没这个毛病，跑了是白花钱。

## 七、实现清单（尚未动工）

| 文件 | 改动 |
|---|---|
| `scripts/rag/rag_rerank.mjs` | **新增**：模型加载、批量打分、阈值过滤 |
| `scripts/rag/rag_retrieve.mjs` | `retrieve()` 内 `slice(0, topK)` 前插入 rerank，开关控制 |
| `scripts/rag/rag_retrieval_config.mjs` | 加 rerank 配置块（`modelId` / `dtype` / `recallWidth` / `probThreshold` / 高风险 theme 白名单） |
| `scripts/rag/create_retrieval_workspace.mjs` | 透传 `--recall-width`、`--rerank` 参数 |
| `package.json` | 加 `@huggingface/transformers` 依赖 + `rag:rerank` 脚本 |
| 环境 | 必须设 `env.remoteHost = 'https://hf-mirror.com'`，否则拉不到模型 |

## 八、待决策

1. **成本档位**：全量 97 次，还是高风险 theme 29 次？（建议后者）
2. **是否加 prob 阈值过滤**（如 < 0.9 丢弃，允许某 theme 少于 5 条）？

候选宽度建议 **12**：实测 20 条里前 12 条都 > 0.98，后 8 条才拉开差距，12 条够用且省三分之一成本。

## 九、复现方式

预研环境在 `skill-travel-plan-test/rerank-spike/`（独立的 spike 目录，未触碰本项目）：

| 文件 | 作用 |
|---|---|
| `verify.mjs` | 加载模型、对候选打分、报告单对耗时与 token 数 |
| `compare.mjs` | 取同批候选做重排前后对比（churn / rescued 统计） |

```bash
# 1. 预研环境（独立于本项目）
cd <skill-travel-plan-test>/rerank-spike
npm install @huggingface/transformers        # @4.3.0，46 个包

# 2. 打分与测速（首次会从 hf-mirror 下载模型 ~400MB，约 216 秒）
node verify.mjs 大山包 20

# 3. 用本项目检索脚本产出 baseline（同为 20 条候选）
node <本项目>/scripts/rag/rag_retrieve.mjs \
  --rag-index <skill-travel-plan-test>/resources-chunk/rag-index.json \
  --place 大山包 --theme highlights --top-k 20 --json \
  > baseline-dashanbao-highlights.json

# 4. 同批候选的重排前后对比
node compare.mjs "大山包这个景点有什么值得看的亮点和出片机位？" ./baseline-dashanbao-highlights.json
```

## 十、下一步节奏

**先拿大山包单个景点跑全 theme 试点 → 与 `outputs/2026-guoqing-self-drive-plan-20260907` 对照 `facts-patch.json` 的实际变化 → 确认无误再全量。**

## 附：对照实验设计（待执行）

- 只改 rerank 一件事，其余参数全部锁死，同一份 `facts-workspace.json` 输入
- 三个指标，由易到难：
  1. **churn**：rerank 后 top-5 与 baseline top-5 的重合度
  2. **rescued**：rerank 后进 top-5、但 baseline 排在 6~20 名的条数 ← rerank 价值的核心证据
  3. **人工抽检**：挑 10~15 个「景点 × theme」组合，标注 top-5 里真正相关的条数（baseline vs rerank）
- 端到端最后再看 `facts-patch.json` 的差异

**参照基线**：`outputs/2026-guoqing-self-drive-plan-20260907`（17 个文件，含 236KB 的 `retrieval-workspace.json`）。注意 `...-20260908` 是空目录，不可用。
