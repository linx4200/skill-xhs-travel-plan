# skill-xhs-travel-plan

根据本地旅行材料、路线和照片生成中文旅游攻略与移动端静态 HTML。

## 快速生成流程

如果用户提供 `rag-index.json`，优先走 RAG 流程；契约见 `references/data-contracts.md` 和 `references/rag-data-contracts.md`。先生成第一版 `facts-workspace.json`：

```bash
npm install
npm run create-workspace -- --route-json <工作目录>/route-structure.json --rag-index <rag-index.json> -o <工作目录>/facts-workspace.json
npm run rag:workspace -- --facts <工作目录>/facts-workspace.json --rag-index <rag-index.json> -o <工作目录>/retrieval-workspace.json --log <工作目录>/retrieval-log.json
```

`rag:retrieve` / `rag:workspace` 会在 `rag-index.json` 的 chunks 含有 `embedding` 向量时调用真实 embedding API 生成查询向量。默认接口为 `http://localhost:11434/api/embed`，模型优先读取 `rag-index.json` 的 `embedding.model`，也可用 `--embedding-url`、`--embedding-model` 或环境变量 `RAG_EMBEDDING_URL`、`RAG_EMBEDDING_MODEL` 覆盖。需要临时关闭向量排序时传 `--no-embedding`。

影响 RAG 召回范围的默认参数集中在 `scripts/rag_retrieval_config.mjs`，包括 `rag:retrieve` 的默认返回 chunk 数、批量检索每个 theme 保留的 chunk 数，以及单个地点/城市跨 theme 的最大阅读池大小。CLI 参数仍可临时覆盖这些默认值。

需要检查召回原因时传 `--log <工作目录>/retrieval-log.json`。日志会按每个 target/theme 记录所有 chunk 的 entity gate、召回状态、向量余弦相似度、分项得分权重和贡献；不会复制完整 embedding 数组。

随后 agent 读取 `retrieval-workspace.json`，按地点、城市和主题整理 `facts-patch.json`，再合并、检查、渲染：

```bash
npm run apply-facts-patch -- --facts <工作目录>/facts-workspace.json --patch <工作目录>/facts-patch.json
npm run render -- <工作目录>/facts-workspace.json -o <输出目录>
npm run verify -- <输出目录>
```

RAG happy path 不创建 `resource-index.json`、`reading-queue.json`、`source-digest.json` 或 `read-log.json`；检索调试信息按需写入 `retrieval-log.json`。

没有 `rag-index.json` 时，完整 HTML 攻略优先走结构化流程，减少反复读取素材和手写 HTML。先按 `SKILL.md`、`references/info-rules.md`、`references/data-contracts.md` 和 `references/structured-data-contracts.md` 人工解析用户路线，生成 `<工作目录>/route-structure.json`；再运行脚本：

```bash
npm install
npm run scan -- <输入材料文件夹> --route-json <工作目录>/route-structure.json -o <工作目录>/resource-index.json
npm run create-workspace -- --route-json <工作目录>/route-structure.json --index <工作目录>/resource-index.json -o <工作目录>/facts-workspace.json
npm run create-queue -- --index <工作目录>/resource-index.json --facts <工作目录>/facts-workspace.json -o <工作目录>/reading-queue.json
npm run create-digest -- --queue <工作目录>/reading-queue.json -o <工作目录>/source-digest.json
npm run create-read-log -- --index <工作目录>/resource-index.json --digest <工作目录>/source-digest.json -o <工作目录>/read-log.json
```

agent 填完 digest 并整理 `facts-patch.json` 后，再合并、检查、渲染：

```bash
npm run apply-facts-patch -- --facts <工作目录>/facts-workspace.json --patch <工作目录>/facts-patch.json
npm run render -- <工作目录>/facts-workspace.json -o <输出目录>
npm run verify -- <输出目录>
```

`scan_resources.mjs` 默认从 `route-structure.json` 读取 `days[].route_places` 和 `cities`；只有需要临时补充路线 JSON 之外的匹配词时，才追加 `--place` 或 `--city`，且两者不要混用。`scan_resources.mjs` 只做素材索引和候选匹配，`create_fact_workspace.mjs` 只生成事实工作区，`create_reading_queue.mjs` 只生成按唯一文件去重的读取队列，并会过滤明显路线外的城市来源；`create_source_digest_workspace.mjs` 只生成文件级摘要工作区；它们都不会自动补充攻略事实。后续应按 `source-digest.json`、`references/structured-generation-workflow.md`、`references/info-rules.md`、`references/data-contracts.md` 和 `references/structured-data-contracts.md` 读取相关原文，填好文件级 digest 和 `facts-workspace.json` 后再渲染。digest 填完后可用 `create-read-log` 生成评估用读取日志。
