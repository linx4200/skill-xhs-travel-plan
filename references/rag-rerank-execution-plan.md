# RAG Rerank 分步骤执行方案

本文按实施顺序拆解 RAG rerank 落地工作。项目内只实现 rerank API client 和检索链路接入；`@huggingface/transformers`、Qwen3 reranker 模型和模型缓存安装在全局本地 rerank 服务中。

## 当前执行顺序

阶段 0-5 已完成 rerank 服务、项目内 rerank client 和 `rag_retrieve.mjs` 单点接入。阶段 6 及之后以 `references/rag-ranking-refactor-plan.md` 的 R1/R2/R3 核心契约为前置：

- `result.score` 改为纯相关性分。
- `score.breakdown` 只保留相关性信号。
- 业务状态由 `scored.business` 给出：`tier`、`tilt_multiplier`、`is_video`、`place_specific`。
- rerank 模块只消费 `scored.business.tier` 和 `scored.business.tilt_multiplier`，不再读取旧 `businessPenaltyMultiplier`。
- `create_retrieval_workspace.mjs` 的 `retrieval.scoring` 同步发布 `business_rules`。

阶段 6 及之后只按上述新契约实现和验收。

## 阶段 0：确认边界

目标状态：

- `skill-xhs-travel-plan` 不新增 `@huggingface/transformers`、`onnxruntime` 或模型文件。
- 项目通过 `--rerank-url` 或 `RAG_RERANK_URL` 调用本地 HTTP rerank 服务。
- embedding query 继续使用现有关键词 query。
- rerank query 使用固定模板表，不由模型或 agent 运行时改写。
- 默认只对高风险 theme 启用 rerank：景点 `highlights`、`nearby`、`facilities`，城市 `backup_places`。
- 阈值过滤后允许 theme 返回少于 `topK` 条结果。

完成判定：

- `package.json` 和 `package-lock.json` 不包含 `@huggingface/transformers`、`onnxruntime` 或 Qwen3 reranker 相关依赖。
- 仓库内不提交 `.onnx`、Qwen3 reranker、transformers 或 onnxruntime 模型/缓存文件。
- rerank 相关实现仅作为项目内 HTTP client、配置和检索链路接入存在。
- 全局 rerank 服务目录、模型下载和模型缓存由 `~/Documents/rag-reranker` 维护。
- 后续阶段新增配置、CLI 和测试时，默认路径保持不访问 rerank 服务；只有显式启用 `--rerank` 或等价调用参数时才访问本地 HTTP rerank 服务。

## 阶段 1：准备全局 rerank 服务目录

全局服务放在项目外，避免污染当前 skill 的依赖树。

推荐目录：

```bash
mkdir -p ~/Documents/rag-reranker
cd ~/Documents/rag-reranker
npm init -y
npm install @huggingface/transformers
```

推荐环境变量：

```bash
export RAG_RERANK_PORT=11435
export RAG_RERANK_MODEL=onnx-community/Qwen3-Reranker-0.6B-ONNX
export RAG_RERANK_HOST=127.0.0.1
```

如果运行环境访问 `huggingface.co` 不稳定，服务代码中固定设置：

```js
import { env } from "@huggingface/transformers";

env.remoteHost = "https://hf-mirror.com";
```

模型首次请求时由服务下载并缓存。缓存目录由全局服务维护，不写入项目仓库。

当前本机状态：

- 全局服务目录已创建：`~/Documents/rag-reranker`。
- 目录内已有 `package.json`、`package-lock.json`、`node_modules/`、`server.mjs`。
- `@huggingface/transformers` 已安装，版本范围为 `^4.3.0`。
- 当前 skill 仓库的 `package.json` 和 `package-lock.json` 未新增 rerank 服务依赖。

## 阶段 2：实现全局 rerank HTTP 服务

服务文件建议放在：

```text
~/Documents/rag-reranker/server.mjs
```

服务接口：

- `GET /health`
- `POST /rerank`

`POST /rerank` 请求：

```json
{
  "model": "onnx-community/Qwen3-Reranker-0.6B-ONNX",
  "query": "大山包有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？",
  "documents": [
    {
      "id": "020-dashanbao-note.md#1",
      "title": "大山包",
      "text": "玻璃跳台、峡谷云海、日出日落..."
    }
  ]
}
```

响应：

```json
{
  "model": "onnx-community/Qwen3-Reranker-0.6B-ONNX",
  "results": [
    {
      "id": "020-dashanbao-note.md#1",
      "probability": 0.9987
    }
  ]
}
```

服务实现要求：

- 进程启动后懒加载模型，第一次 `/rerank` 请求触发模型加载。
- 使用 singleton promise，避免并发请求重复加载模型。
- 对每个 document 返回一个同 id 的 probability。
- `probability` 必须是 `[0, 1]` 内的有限数字。
- 请求结果可以乱序；项目侧按 id 对齐。
- 服务内部负责 Qwen3 reranker 的 prompt、tokenizer、`yes/no` logits 和 softmax 逻辑。
- 服务日志记录模型加载耗时、请求 document 数、单次请求耗时和错误原因。

本地启动：

```bash
cd ~/Documents/rag-reranker
node server.mjs
```

健康检查：

```bash
curl http://127.0.0.1:11435/health
```

当前本机状态：

- `~/Documents/rag-reranker/server.mjs` 已实现 `GET /health` 和 `POST /rerank`。
- 服务使用 `env.remoteHost = "https://hf-mirror.com"`。
- Qwen3 reranker q4 ONNX 模型已缓存到：

```text
~/Documents/rag-reranker/node_modules/@huggingface/transformers/.cache/onnx-community/Qwen3-Reranker-0.6B-ONNX/onnx/model_q4.onnx
```

- `model_q4.onnx` 当前大小为 `995235866` bytes。
- 已完成一次 smoke rerank 验证，请求返回 `probability: 0.999796340326607`。
- 服务日志显示本地缓存加载耗时约 `2639ms`，单文档 smoke 请求耗时约 `2915ms`。

## 阶段 3：项目内新增 rerank 配置

修改 `scripts/rag/rag_retrieval_config.mjs`：

- 新增 `RAG_RERANK_DEFAULTS`。
- 写死 `queryTemplates` 固定模板表。
- 默认 `enabled: false`。
- 默认 `url: "http://127.0.0.1:11435/rerank"`。
- 默认 `recallWidth: 12`。
- 默认 `probThreshold: 0.9`。
- 默认 `timeoutMs: 120000`。

固定模板表：

| 类型 | theme | rerank query |
|---|---|---|
| 景点 | `highlights` | `{name}有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？` |
| 景点 | `nearby` | `{name}周边有哪些顺路、附近或可组合游玩的地点和路线建议？` |
| 景点 | `facilities` | `{name}现场有哪些厕所、补给、餐饮、休息区、游客中心等设施信息？` |
| 城市 | `backup_places` | `{name}有哪些可作为行程备选、顺路补充或城市周边的小众地点？` |

## 阶段 4：项目内新增 `rag_rerank.mjs`

新增文件：

```text
scripts/rag/rag_rerank.mjs
```

职责：

- 合并默认配置、环境变量和 CLI options。
- 判断当前 `entity.type + theme` 是否在启用范围内。
- 从 `rankedRows` 中取前 `recallWidth` 条。
- 使用固定模板表生成 `rerankQuery`。
- 调用 `RAG_RERANK_URL` 指向的 HTTP 服务。
- 校验 API 响应完整性。
- 按 probability 阈值过滤。
- 消费主流程给出的业务状态：先按 `tier` 分层，再用 `probability × tilt_multiplier` 得到 `final_rerank_score`。
- 返回重排后的 rows 和 diagnostics。

错误处理：

- 显式启用 `--rerank` 时，rerank API 不可用、超时、缺失结果、重复 id 或非法 probability 都直接报错。
- 未启用 `--rerank` 时不访问 rerank API。
- 非白名单 theme 返回原始 rows，并记录 `skipped_reason: "theme_not_in_scope"`。

### 执行结论（阶段 4）

产物：

- 新增 `scripts/rag/rag_rerank.mjs`，导出 `resolveRerankConfig`、`rerankThemeScope`、`isThemeInScope`、`buildRerankQuery`、`buildRerankDocument`、`rerankRows`。
- `rag_retrieval_config.mjs` 的 `RAG_RERANK_DEFAULTS` 补 `maxDocChars: 700`（技术方案配置块里有，阶段 3 的落地清单漏了，本阶段补齐）。

验证：

- mock 冒烟覆盖：未启用时零网络调用、非白名单 theme 不碰 client、重排 + 阈值过滤后结果可少于 `topK`、乱序结果按 id 对齐、缺失结果 / 重复 id / 非法概率 / NaN 抛错、`recallWidth < topK` 与越界阈值报错、窗口外不补位、业务状态由主流程提供、配置合并与模板兜底。
- 真实服务联调（`127.0.0.1:11435`）：`highlights` 三个候选中住宿 `0.079`、餐饮 `0.109` 被阈值过滤，真看点 `0.9999` 保留 —— 正是本方案要解决的「泛化触发词跨主题误排」。热模型单次 `861ms`。
- `npm test` 25/25 通过；`package.json` / `package-lock.json` 未新增任何 rerank 依赖。
- 验证脚本落在 `/tmp`，未进仓库（单元测试属阶段 7）。

实现偏离：

| # | 偏离项 | 方案原文 | 实际实现 | 原因 |
|---|---|---|---|---|
| 4-1 | 导出面 | 只导出 `rerankRows()` | 另导出 `resolveRerankConfig` / `rerankThemeScope` / `isThemeInScope` / `buildRerankQuery` / `buildRerankDocument` | 阶段 6 要直接取 `theme_scope` 元信息；模板与范围判定需要单独可测 |
| 4-2 | `config` 键名 | `url` / `recallWidth` / `probThreshold` / `timeoutMs` | 兼容 `rerankUrl` / `rerankModel` / `rerankRecallWidth` / `rerankThreshold` / `rerankTimeoutMs` / `rerankAllThemes` / `rerankTheme` 别名 | CLI 解析结果可原样透传；`resolveRerankConfig()` 保持幂等 |
| 4-3 | 注入点 | 只有 `reranker?`（模型层 mock） | 增 `httpClient({url, body, timeoutMs})` 传输层注入，注入时跳过 URL 校验 | 让 HTTP 契约与排序逻辑可分别测试 |
| 4-4 | `reranker` 入参 | `(pairs) => [{ probability }]` | `({ model, query, documents }) => ...`，返回项支持纯数字 / `{probability}` / `{id, probability}` | 与真实 `/rerank` 请求体同构；缺省 id 按 documents 顺序对齐 |
| 4-5 | 诊断字段 | `enabled`、`applied`、`skipped_reason`、`url`、`model_id`、`recall_width`、`probability_threshold`、`input_count`、`kept_count`、`duration_ms`、`items` | 另增 `rerank_query`、`filtered_count`、`out_of_window_count` | 窗口外丢弃是真实副作用，不记录则不可观测；`rerank_query` 便于回溯模板渲染结果 |
| 4-6 | `skipped_reason` 取值 | `theme_not_in_scope`、`empty_candidates` | 另增 `disabled`、`missing_entity` | 未启用与无实体检索套用 theme 原因会误导排查 |
| 4-7 | doc 构造 | 拼成 `标题：…\n正文：…` 单字符串 | `{ id, title, text }` 分字段传；`maxDocChars` 只截 `text`；`text` 为空退回 `title`；`id` 取 `chunk.chunk_id` | 拼装模型 prompt 属服务职责；服务要求 `text` 非空，否则整批 400 |
| 4-8 | 业务状态归属 | 公式 `businessPenalty = 1 + signal * weight …` 落在 rerank 侧 | **按 ranking refactor 新契约修正**：业务规则收回主流程 `rag_retrieve.mjs`，由 `scoreChunk()` 输出 `scored.business`；rerank 侧只读 `scored.business.tier` 与 `scored.business.tilt_multiplier`，非有限值按默认业务状态处理 | rerank 是旁支不是主流程，业务规则的定义权必须在主流程。旁支只消费业务状态，不持有权重常量 |
| 4-9 | 默认 URL | `http://localhost:11435/rerank` | `http://127.0.0.1:11435/rerank` | 与阶段 3 落地值统一，避免 localhost 解析歧义 |
| 4-10 | 兜底句 | 只定义 theme 兜底句 | theme 为空时另有 `请判断下面材料是否与「{name}」的旅行信息相关。` | `--query` 无 theme 检索同样需要稳定 query |
| 4-11 | 结果校验 | 缺失结果、重复 id、非法概率视为失败 | 另加 `results.length === documents.length` 严格等长 | 数量不符说明服务与请求已错位，靠 id 对齐兜不住 |
| 4-12 | `--rerank-theme` 生效语义 | 只在 CLI 列表里出现参数名，未定义语义；正文口径是「`highRiskThemes` 是第一阶段白名单」 | `extraThemes` **同时**并入 `place` 与 `city` 两套白名单，实际是否生效由请求时的 `entity.type` 决定；另兼容 `themes` / `extraThemes` 两个键 | 调参时常见需求是「把某个 theme 在景点和城市上都打开」，按域限定要多传一次；但这条扩展绕过了「按 entity.type 限定」的原始语义 |
| 4-13 | `theme_scope` 输出结构 | `theme_scope` 只有 `place` / `city` 两个列表 | `rerankThemeScope()` 另返回 `all_themes: boolean`（`--rerank-all-themes` 时为 `true`，白名单列表仍照常返回） | 全 theme 调参时白名单列表已不代表实际范围，不标出会误导 |

`4-12` / `4-13` 已确认采纳：双域语义写进技术方案「启用策略」，`all_themes` 字段写进 `theme_scope` 示例。两条保留在表中仅供追溯，不再是待决偏离。

`4-8` 的最终口径以 `references/rag-ranking-refactor-plan.md` 为准：`score.breakdown` 只描述相关性，业务规则统一由 `scored.business` 表达。rerank 侧不 import `CITY_PLACE_SPECIFIC_PENALTY_BY_THEME` / `DEFAULT_CITY_PLACE_SPECIFIC_PENALTY_WEIGHT`，也不自行折算城市地点级规则。

测试拆分：`test/rag_rerank.test.mjs` 只验证 rerank 消费 `tier` / `tilt_multiplier` 和缺省业务状态；业务状态本身的计算归 `test/rag_retrieve.test.mjs`。`backup_places` 的不可翻越用例必须覆盖 rerank-off 与 rerank-on 两条路径。

## 阶段 5：接入 `rag_retrieve.mjs`

修改 `scripts/rag/rag_retrieve.mjs`：

- CLI 新增：

```bash
--rerank
--rerank-url <url>
--rerank-all-themes
--rerank-theme <theme>
--rerank-recall-width <n>
--rerank-threshold <probability>
--rerank-model <model-name>
--rerank-timeout-ms <n>
```

- 在 `rankedRows` 生成后、`slice(0, topK)` 前调用 `maybeRerankRows()`。
- `result.score` 输出纯相关性分。
- rerank 细节只写入 diagnostics。
- `includeDiagnostics` 为 false 时不输出 rerank 明细。

### 执行结论（阶段 5）

产物：只改 `scripts/rag/rag_retrieve.mjs`。

验证：

- 新增 8 个 CLI 参数后，接入点固定在 `rankedRows` 排序完成之后、`slice(0, topK)` 之前。
- 真实索引对照（53 chunks，大山包 / `highlights` / top-k 5）：顺序变化，`020` 从候选 rank3 升到最终第 1，`005` 从窗口内 rank7 挤进 top5；ranking refactor 完成后按纯相关性 `result.score`、`tier` 和 `tilt_multiplier` 复验。
- 诊断：`input_count 9` / `kept 7` / `filtered 2` / `out_of_window 0`（9 条是通过 gate 的实际候选量，未达 `recallWidth 12`）；`recall_status` 分布 `selected 5 + reranked_filtered 2 + scored_not_selected 2 + filtered_by_entity_gate 44 = 53`。
- 跳过与失败路径：非白名单 theme → `theme_not_in_scope` 且不调服务；服务不可达 / 1ms 超时 / 非法 URL / 409 模型不匹配 → 全部 `exit=1` 并带 `Rerank failed for place 大山包 / highlights:` 上下文；`--top-k 20 --rerank` → 提示 recall-width 不足；`--rerank-recall-width abc` → 立即报错。
- `RAG_RERANK_URL` 生效，CLI 覆盖环境变量生效；`highlights` / `nearby` / `facilities` 三个 theme 依次 rerank 均 `applied`。
- 未启用 rerank 的 `--json` 输出零 rerank 字段；`npm test` 25/25 通过，默认路径行为零变化。

实现偏离：

| # | 偏离项 | 方案原文 | 实际实现 | 原因 |
|---|---|---|---|---|
| 5-1 | `maybeRerankRows()` 职责 | 独立函数，内含接入与短路 | 只做一行转发到 `rerankRows()` | 短路留在模块内，未启用时也能产出 `enabled:false` 诊断块；未启用路径本就不解析配置、零网络 |
| 5-2 | `rerankQuery` 生成方 | snippet 中 `retrieve()` 构造 `rerankQuery` 后传入 | `retrieve()` 只传 `{ query, entity, theme, topK }`，模板由 `rag_rerank.mjs` 生成并回填 `diagnostics.rerank.rerank_query` | 模板表单一来源，两处生成必然漂移 |
| 5-3 | CLI 默认值 | 未规定 | `rerankUrl` / `rerankModel` 默认 `""`，`rerankRecallWidth` / `rerankThreshold` / `rerankTimeoutMs` 默认 `undefined` | 空值表示「未显式指定」，避免 CLI 默认值遮住环境变量 |
| 5-4 | 数值范围校验位置 | 启动参数校验报错 | `parseArgs` 只校验「能否解析成有限数字」，范围规则统一留在 `validateRerankOptions()` | 规则单点维护，不重复实现 |
| 5-5 | `reranked_filtered` 判定来源 | 由 rerank 结果直接判定 | 从 `diagnostics.rerank.items` 中 `passed_threshold === false` 反推 | 不改动 `rerankRows()` 的返回值形状 |
| 5-6 | 诊断块写入时机 | rerank 细节只写入 diagnostics | `diagnostics.rerank` 恒写入（未启用时为 `skipped_reason: "disabled"`），但整体 diagnostics 仅在 `--log` 时输出 | 让日志能回答「这次为什么没走 rerank」 |

联调发现（待阶段 8 决策）：

- `facilities` 在阈值 `0.9` 下 9 个候选全部低于阈值，该 theme 返回 0 条。符合「不为凑名额引入弱内容」，但设施信息整体空掉是否可接受需要调参判断。
- 单 theme 约 `11.7–14.4s`（9 docs，CPU，≈`1.4s/doc`）；热模型单次 `861ms`。批量场景每个 target 4 个启用 theme → 50s+，10 景点 + 6 城市约 15 分钟量级。

## 阶段 6：接入 `create_retrieval_workspace.mjs`

前置条件：

- `references/rag-ranking-refactor-plan.md` 的 R1/R2 已完成。
- `retrieve()` 返回的 `results[]` 使用纯相关性 `score`，并在需要解释业务排序时输出 `place_specific: true` / `tier: 1`。
- `rag_rerank.mjs` 已按 `tier asc → final_rerank_score desc → relevance desc ...` 排序。

修改 `scripts/rag/create_retrieval_workspace.mjs`：

- 透传所有 rerank CLI 参数到 `retrieve()`。
- `retrieval.scoring` 增加 `rerank` 元信息和 `business_rules`。
- `themes.<theme>[]` 保持轻量阅读索引：`chunk_id`、`score`、`matched_by`，以及必要的解释事实字段 `place_specific` / `tier`。
- 不把 rerank probability、`tilt_multiplier` 或最终排序分写入普通 `retrieval-workspace.json` 阅读索引。

透传注意（承接阶段 4 的 4-12 / 4-13）：

- **不要用 `{ ...args }` 批量透传。** `resolveRerankConfig()` 会把 `themes` 键并入 `extraThemes`，而 workspace 脚本的 `args.themes` 是**检索用的 theme 列表**，直接展开会把该次生成涉及的全部 theme 意外拉进 rerank 白名单，静默放宽启用范围。必须逐字段映射（照 `rag_retrieve.mjs` 的 `rerankOptionsFromArgs()` 写法）。
- `retrieval.scoring.rerank.theme_scope` **按含 `all_themes` 的结构写入**（已定，见 4-13）。直接照抄 `rerankThemeScope()` 的返回值，不要只取 `place` / `city` 两个列表 —— `--rerank-all-themes` 时那两份列表不代表实际范围。
- `retrieval.scoring.business_rules` 从 `RAG_SCORING` 生成，至少包含 `city_tier_themes`、`video_tilt`、`city_tilt`。这里是批量产物解释 `place_specific` / `tier` 的唯一规则来源，不能手写第二份常量。

## 阶段 7：补测试

新增 `test/rag_rerank.test.mjs`：

- 固定模板表生成自然语言 query。
- mock rerank client 返回概率后 rows 被重排。
- 低于阈值的候选被过滤。
- 阈值过滤后结果数量可以少于 `topK`。
- `tilt_multiplier` 会降低 `final_rerank_score`。
- 城市 `backup_places` 下 `tier 0 + probability 0.91` 排在 `tier 1 + probability 0.99` 前面。
- 缺失 `scored.business` 时使用默认业务状态：`tier=0`、`tilt_multiplier=1`。
- API 乱序结果按 document id 对齐。
- API 缺失结果、重复 id、非法 probability 时抛错。
- 非白名单 theme 不调用 HTTP client。

修改 `test/rag_retrieve.test.mjs`：

- `highlights` fixture 包含景观、住宿、餐饮 chunk。
- mock rerank client 给景观 chunk 高分，给住宿和餐饮低分。
- 断言传入 mock client 的 query 是固定模板渲染结果。
- 断言最终 `results` 只包含过阈值 chunk。
- 断言 `result.score` 是纯相关性分。
- 断言 `backup_places` 的城市级 / 地点级档位不可翻越。
- 断言 `diagnostics.chunks[].business` 包含 `tier`、`tilt_multiplier`、`is_video`、`place_specific`。

修改 `test/create_retrieval_workspace.test.mjs`：

- 验证 rerank options 被透传。
- 验证 `retrieval.scoring.rerank` 元信息。
- 验证 `retrieval.scoring.business_rules` 元信息与 `RAG_SCORING` 一致。
- 验证 `themes.<theme>[]` 不包含 rerank probability。
- 验证 `themes.<theme>[]` 在需要时保留 `place_specific` / `tier`，但不包含 `tilt_multiplier`。
- 验证 theme 被阈值过滤为空时产生 `empty_theme:<theme>` warning。

## 阶段 8：联调与调参

先启动全局服务：

```bash
cd ~/Documents/rag-reranker
node server.mjs
```

单点对照：

```bash
node scripts/rag/rag_retrieve.mjs \
  --rag-index <rag-index.json> \
  --place 大山包 \
  --theme highlights \
  --top-k 5 \
  --json

node scripts/rag/rag_retrieve.mjs \
  --rag-index <rag-index.json> \
  --place 大山包 \
  --theme highlights \
  --top-k 5 \
  --rerank \
  --rerank-url http://127.0.0.1:11435/rerank \
  --rerank-recall-width 12 \
  --rerank-threshold 0.9 \
  --json
```

批量生成：

```bash
node scripts/rag/create_retrieval_workspace.mjs \
  --facts <facts-workspace.json> \
  --rag-index <rag-index.json> \
  -o <retrieval-workspace.json> \
  --rerank \
  --rerank-url http://127.0.0.1:11435/rerank \
  --rerank-recall-width 12 \
  --rerank-threshold 0.9
```

带诊断日志：

```bash
node scripts/rag/create_retrieval_workspace.mjs \
  --facts <facts-workspace.json> \
  --rag-index <rag-index.json> \
  -o <retrieval-workspace.json> \
  --log <retrieval-log.json> \
  --rerank \
  --rerank-url http://127.0.0.1:11435/rerank
```

### 调参工作项（阶段 8）

阶段 8 调参只在 ranking refactor 与阶段 6 接入完成后进行。调参日志同时看 rerank 概率分布和业务档位分布：`backup_places` 的地点级候选概率再高，也不能越过城市级候选；如果高优先档占满窗口，按 `references/rag-ranking-refactor-plan.md` 的已知限制评估是否引入档位配额。

`probThreshold` 默认 `0.9` 是预研期的经验值，只在 `highlights` 上验证过；`facilities` 在 0.9 下 9 个候选全部被切。**所以调参第一步不是试阈值，而是先扫概率分布** —— 不看清分布，分不出「阈值偏高」「query 模板不匹配」「笔记本来没这条信息」三种情况，试也是瞎试。

**第 1 步：扫分布。** 对 4 个启用 theme 各跑一次带 `--log` 的单点检索（`diagnostics.rerank.items` 始终记录窗口内**全部**候选的概率，含未过阈值的，不用把阈值调 0）：

```bash
node scripts/rag/rag_retrieve.mjs \
  --rag-index output/2026-guoqing-self-drive-plan/rag-index.json \
  --place <place> \
  --theme highlights --theme nearby --theme facilities \
  --top-k 5 --embedding-model qwen3-embedding:0.6b \
  --rerank --rerank-url http://127.0.0.1:11435/rerank \
  --rerank-recall-width 12 --rerank-threshold 0.9 \
  --log /tmp/threshold-scan.json --json > /dev/null
```

按 theme 打出降序概率串，看有没有断层：

```bash
node -e "
const log = require('/tmp/threshold-scan.json');
for (const r of log.requests) {
  const k = r.rerank ?? {};
  if (!k.applied) { console.log('---', r.theme || '(none)', '| skipped:', k.skipped_reason); continue; }
  const probs = (k.items ?? []).map((i) => i.rerank_probability).sort((a, b) => b - a);
  console.log('---', r.theme, '| n=' + probs.length, '| top', probs[0], '| tail', probs[probs.length - 1]);
  console.log('   ', probs.join('  '));
  console.log('    query:', k.rerank_query);
}
"
```

**第 2 步：按分布形态判读。** 这一步决定改什么，不要跳过：

| 分布形态 | 判读 | 动作 |
|---|---|---|
| 高位簇 + 低位簇，中间有明显断层 | 阈值机制有效，断层就是天然切点 | 把 `probThreshold` 放进断层里，别贴着簇边缘 |
| 整体高于阈值且无断层 | 该 theme 主题一致性本来就高 | 保持 0.9。**不要因为分数高就想用它精排** —— 饱和区内部差异仅 `0.0003`，不可靠 |
| 整体低于阈值（`facilities` 现状） | 三种可能，必须人工核对才能定 | 看窗口内概率最高的 3 条正文：① 确实是该 theme 内容 → 阈值偏高或 query 模板语域不匹配，改模板重跑对比；② 不是该 theme 内容 → 过滤正确，接受该 theme 为空；③ 相关内容压根没进窗口 → 是 gate / 召回问题，**阈值治不了** |
| 断层正好压在窗口边界 | `recallWidth` 太窄，切点被截断 | 提高 `recallWidth` 到 16 / 20 重扫 |

**第 3 步：按固定顺序调，一次只动一个变量。**

1. **先定阈值**：固定 `recallWidth 12`，只调 `--rerank-threshold`。
2. **再看窗口**：固定阈值，只调 `--rerank-recall-width`。判据：只有 `out_of_window_count > 0` **且**窗口末位概率仍高于阈值时才需要扩大。当前实测 `input_count 9` / `out_of_window_count 0`（候选不到 12），说明 12 在现有索引上根本不是瓶颈，调大只增加成本。
3. **最后看模板**：固定前两者，只改 `RAG_RERANK_DEFAULTS.queryTemplates` 的措辞。仅在判读结论落在「① 内容相关但整体低分」时才动。

**第 4 步：批量侧复核。** 用上面的批量命令跑全量，检查：

- `retrieval_health.warnings` 里 `empty_theme:<theme>` 的数量与分布（`facilities` 是否成为常态空 theme）。
- 总耗时，以及各 theme 的 `filtered_count` 汇总。
- 白名单本身是否选对：顺手用 `--rerank-all-themes` 跑一次 `drawbacks` / `tickets` 等非白名单 theme，看它们是否真的不需要 rerank。预研只按词表推断过泛化度，没实测核对过。

**阶段 8 待决事项**（前两条从阶段 4 / 5 带下来）：

1. `facilities` 在 0.9 下整段清空，是否接受？还是降阈值 / 改模板让它留下 1–2 条？
2. 单 theme 约 `11.7–14.4s`（9 docs，≈`1.4s/doc`）；批量 10 景点 + 6 城市 × 4 theme ≈ 15 分钟量级。是否接受？不接受只能降 `recallWidth` 或收紧白名单。
3. **是否需要 per-theme 阈值**：当前 `probThreshold` 是全局单一标量。若第 2 步结论是「各 theme 天然断层位置不同」，就必须改成可按 `entity.type + theme` 覆盖 —— 这是配置结构改动，属于新增工作项，不在阶段 8 顺手做，需要单独评估。
4. `facilities` 的 query 模板含「厕所、补给、餐饮、休息区、游客中心」，与野外景区笔记的语域可能不匹配，是候选改动。

## 阶段 9：验收

验收标准：

- 不启用 `--rerank` 时，现有测试全部通过，默认输出不访问 rerank 服务。
- 启用 `--rerank` 时，仅高风险 theme 调用 rerank API。
- rerank 服务日志中的请求数量符合 target/theme 范围。
- `highlights` 中住宿、餐饮、咖啡等非看点内容被过滤或降出 top results。
- 阈值过滤后 theme 可以少于 5 条。
- 阈值定稿能追溯到阶段 8 的概率分布扫描结论；`empty_theme` 只在人工核对确认「该 theme 确实无对应内容」时出现，不是阈值副产物。
- `result.score` 是纯相关性分，不包含视频、城市地点级等业务调整。
- `retrieval.scoring.business_rules` 能解释 `themes.<theme>[]` 中的 `place_specific` / `tier`。
- `retrieval-workspace.json` 不包含 rerank probability。
- `retrieval-log.json` 在 `--log` 时包含 rerank diagnostics。
- 视频来源软降权和城市 `backup_places` 档位在 rerank 后仍然影响最终排序。
- 项目仓库不出现 `@huggingface/transformers`、`onnxruntime` 或模型文件。

## 阶段 10：文档同步

更新文件：

- `references/rag-data-contracts.md`：补充启用 rerank 时的 `retrieval.scoring.rerank`、`retrieval.scoring.business_rules`、`themes.<theme>[]` 的 `place_specific` / `tier` 字段和 `retrieval-log.json` 字段。
- `references/rag-workflow.md`：补充 `--rerank`、`--rerank-url` 和全局服务前置条件。
- `README.md`：补充可选 rerank 运行方式，明确默认 RAG 流程不启用 rerank。

文档只描述目标流程和未来执行方式，不写迁移说明。
