# RAG Rerank 分步骤执行方案

本文按实施顺序拆解 RAG rerank 落地工作。项目内只实现 rerank API client 和检索链路接入；`@huggingface/transformers`、Qwen3 reranker 模型和模型缓存安装在全局本地 rerank 服务中。

## 阶段 0：确认边界

目标状态：

- `skill-xhs-travel-plan` 不新增 `@huggingface/transformers`、`onnxruntime` 或模型文件。
- 项目通过 `--rerank-url` 或 `RAG_RERANK_URL` 调用本地 HTTP rerank 服务。
- embedding query 继续使用现有关键词 query。
- rerank query 使用固定模板表，不由模型或 agent 运行时改写。
- 默认只对高风险 theme 启用 rerank：景点 `highlights`、`nearby`、`facilities`，城市 `backup_places`。
- 阈值过滤后允许 theme 返回少于 `topK` 条结果。

## 阶段 1：准备全局 rerank 服务目录

全局服务放在项目外，避免污染当前 skill 的依赖树。

推荐目录：

```bash
mkdir -p ~/.local/share/rag-reranker
cd ~/.local/share/rag-reranker
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

## 阶段 2：实现全局 rerank HTTP 服务

服务文件建议放在：

```text
~/.local/share/rag-reranker/server.mjs
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
cd ~/.local/share/rag-reranker
node server.mjs
```

健康检查：

```bash
curl http://127.0.0.1:11435/health
```

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
- 乘回业务 penalty，得到 `final_rerank_score`。
- 返回重排后的 rows 和 diagnostics。

错误处理：

- 显式启用 `--rerank` 时，rerank API 不可用、超时、缺失结果、重复 id 或非法 probability 都直接报错。
- 未启用 `--rerank` 时不访问 rerank API。
- 非白名单 theme 返回原始 rows，并记录 `skipped_reason: "theme_not_in_scope"`。

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
- `result.score` 保留原始综合分。
- rerank 细节只写入 diagnostics。
- `includeDiagnostics` 为 false 时不输出 rerank 明细。

## 阶段 6：接入 `create_retrieval_workspace.mjs`

修改 `scripts/rag/create_retrieval_workspace.mjs`：

- 透传所有 rerank CLI 参数到 `retrieve()`。
- `retrieval.scoring` 增加 `rerank` 元信息。
- `themes.<theme>[]` 保持只包含 `chunk_id`、`score`、`matched_by`。
- 不把 rerank probability 写入普通 `retrieval-workspace.json` 阅读索引。

## 阶段 7：补测试

新增 `test/rag_rerank.test.mjs`：

- 固定模板表生成自然语言 query。
- mock rerank client 返回概率后 rows 被重排。
- 低于阈值的候选被过滤。
- 阈值过滤后结果数量可以少于 `topK`。
- 视频来源 penalty 会降低 `final_rerank_score`。
- 城市 `backup_places` 下地点级 chunk 的 city penalty 保留。
- API 乱序结果按 document id 对齐。
- API 缺失结果、重复 id、非法 probability 时抛错。
- 非白名单 theme 不调用 HTTP client。

修改 `test/rag_retrieve.test.mjs`：

- `highlights` fixture 包含景观、住宿、餐饮 chunk。
- mock rerank client 给景观 chunk 高分，给住宿和餐饮低分。
- 断言传入 mock client 的 query 是固定模板渲染结果。
- 断言最终 `results` 只包含过阈值 chunk。
- 断言 `result.score` 仍是原始综合分。

修改 `test/create_retrieval_workspace.test.mjs`：

- 验证 rerank options 被透传。
- 验证 `retrieval.scoring.rerank` 元信息。
- 验证 `themes.<theme>[]` 不包含 rerank probability。
- 验证 theme 被阈值过滤为空时产生 `empty_theme:<theme>` warning。

## 阶段 8：联调命令

先启动全局服务：

```bash
cd ~/.local/share/rag-reranker
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

## 阶段 9：验收

验收标准：

- 不启用 `--rerank` 时，现有测试全部通过，默认输出不访问 rerank 服务。
- 启用 `--rerank` 时，仅高风险 theme 调用 rerank API。
- rerank 服务日志中的请求数量符合 target/theme 范围。
- `highlights` 中住宿、餐饮、咖啡等非看点内容被过滤或降出 top results。
- 阈值过滤后 theme 可以少于 5 条。
- `result.score` 保留原始检索分。
- `retrieval-workspace.json` 不包含 rerank probability。
- `retrieval-log.json` 在 `--log` 时包含 rerank diagnostics。
- 视频来源和城市地点级 penalty 在 rerank 后仍然影响最终排序。
- 项目仓库不出现 `@huggingface/transformers`、`onnxruntime` 或模型文件。

## 阶段 10：文档同步

更新文件：

- `references/rag-data-contracts.md`：补充启用 rerank 时的 `retrieval.scoring.rerank` 和 `retrieval-log.json` 字段。
- `references/rag-workflow.md`：补充 `--rerank`、`--rerank-url` 和全局服务前置条件。
- `README.md`：补充可选 rerank 运行方式，明确默认 RAG 流程不启用 rerank。

文档只描述目标流程和未来执行方式，不写迁移说明。
