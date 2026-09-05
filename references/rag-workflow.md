# RAG 检索工作流

本流程用于用户提供 `rag-index.json` 时，先生成第一版 `facts-workspace.json`。它只减少素材阅读范围，不自动判断最终攻略事实。`retrieval-workspace.json` 中的内容必须由 agent 按 [info-rules.md](info-rules.md) 判断、去重、处理冲突后，才能写入 `facts-workspace.json`。

RAG 介入 facts 生成的总体设计见 [rag-facts-framework.md](rag-facts-framework.md)。共同 JSON 契约见 [data-contracts.md](data-contracts.md)，RAG 分支专属契约见 [rag-data-contracts.md](rag-data-contracts.md)。本文档记录当前可执行步骤。

## 输入

必须具备：

- 用户路线，或 agent 已创建的 `route-structure.json`。
- `rag-index.json`。
- 可选的原始资源目录。本流程不回读原始文本材料；如果需要本地照片，使用 `rag-index.resource_root/photos`。

`rag-index.json` 可以是 JSON 或旧版 JSONL。JSON 版本的每个 chunk 至少应包含：

```json
{
  "chunk_id": "resources/014-jiudongtian-note.json#note",
  "source_uri": "resources/014-jiudongtian-note.json",
  "title": "九洞天自驾喂饭教程",
  "text": "完整小红书笔记文本",
  "candidate_places": ["九洞天"],
  "candidate_cities": ["毕节"]
}
```

`candidate_places` 和 `candidate_cities` 必须是该条笔记实际命中的结果，不是候选全集。

## Step 1：创建 Route Structure

先由 agent 读取用户原始路线，按 [info-rules.md](info-rules.md) 的路线解析规则生成 `route-structure.json`。路线解析不要交给脚本用正则完成；脚本只接收 agent 已经判断过的结构。

`route-structure.json` 的结构和字段见 [data-contracts.md](data-contracts.md)。

## Step 2：校验 RAG Index

用脚本读取并校验 `rag-index.json`，不要直接打印或预览完整索引：

- 顶层应能解析为 JSON 或 JSONL。
- chunk 应包含可用于检索的 `chunk_id`、`source_uri`、`title`、`text`、`candidate_places` 和 `candidate_cities`。
- 如果需要渲染本地照片，`resource_root` 应指向可读资源目录，且照片应位于 `photos/` 下。

如果 `rag-index.json` 与用户描述不符，让后续工作区脚本自然失败并停止流程，向用户报告脚本错误即可。命令输出只保留统计、错误和少量标题级摘要；不要把 `chunks[].text` 或 `embedding` 打印到对话上下文。

RAG 主流程不生成 `resource-index.json`。`facts-workspace.json` 的地点/城市来源线索来自 RAG chunks 的 `source_uri`，照片归属由 `create_fact_workspace.mjs --rag-index` 直接扫描 `resource_root/photos` 得到。

## Step 3：创建 Skeleton Facts Workspace

运行：

```bash
node scripts/create_fact_workspace.mjs \
  --route-json <工作目录>/route-structure.json \
  --rag-index <rag-index.json> \
  -o <工作目录>/facts-workspace.json
```

脚本只创建空槽位，不补攻略事实。生成后 `needs_agent_review` 应为 `true`。

## Step 4：创建 Retrieval Workspace

运行：

```bash
node scripts/create_retrieval_workspace.mjs \
  --facts <工作目录>/facts-workspace.json \
  --rag-index <rag-index.json> \
  -o <工作目录>/retrieval-workspace.json \
  --log <工作目录>/retrieval-log.json
```

`retrieval-workspace.json` 应包含：

- 顶层 `chunks_by_id`，保存本次批量检索命中的唯一 chunk 原文。
- `places.<地点名>.target`、`unique_chunk_ids`、`retrieval_health` 和 `themes`。
- `cities.<城市名>.target`、`unique_chunk_ids`、`retrieval_health` 和 `themes`。
- `summary.attention_places`、`summary.attention_cities`、`summary.gap_places` 和 `summary.gap_cities`。

`--log` 是可选调试输出。`retrieval-log.json` 按每个 target/theme 记录全量 chunk 评估，包括 entity gate 是否通过、召回状态、candidate rank、selected rank、向量余弦相似度、评分信号、权重和分项贡献。日志不复制完整 embedding 数组；用 `vector_match.cosine_similarity` 和向量维度检查向量匹配。

## Step 5：填充第一版 Facts Workspace

Agent 读取 `retrieval-workspace.json` 后填充 `facts-workspace.json`：

1. 先做引用完整性检查：确认 facts 中的地点和城市都有对应 retrieval target，且 `unique_chunk_ids` / `themes.*[].chunk_id` 都能在 `chunks_by_id` 中找到。
2. 按每日 `route_places` 顺序处理 `places`，先读 `unique_chunk_ids`，再用 `themes` 辅助定位字段。
3. 将有效事实整理成局部 facts patch，只写判断后的执行信息，不复制 chunk 原文。
4. 基于已写地点内容整理 `trip.days[].summary`、`timeline`、`notes` 和 `confirmations`。
5. 所有地点处理完成后再处理 `cities`。城市页 `include` 判断必须先排除已经写进地点页、每日页、全局提醒或确认清单的内容。
6. 最后整理 `global_notes` 和 `confirm_before_departure`。
7. 用 `node scripts/apply_facts_patch.mjs --facts <工作目录>/facts-workspace.json --patch <工作目录>/facts-patch.json` 合并 patch。

第五步结束时只得到第一版 facts；`needs_agent_review` 仍保持 `true`。后续是否补检索、记录缺口、联网白名单查询或渲染 HTML，由第六步及之后流程决定。

## 缺口处理边界

RAG happy path 不创建 `resource-index.json`、`reading-queue.json`、`source-digest.json` 或 `read-log.json`；召回调试信息按需写入 `retrieval-log.json`。

以下情况不应继续无限 RAG 检索，应在后续步骤中转为定向补检索，或明确写入“材料未说明 / 出行前确认”：

- 某路线景点去重后的有效 note chunks 少于 3 条。
- 高风险执行字段被材料暗示会影响本次执行，但 RAG 结果缺少关键细节或互相冲突。
- 检索结果太泛、太营销，不能支持可执行建议。
- 同一 chunk 混合多个地点，归属不确定。
- 城市页是否 include 无法判断。
