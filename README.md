# skill-xhs-travel-plan
提取小红书笔记内容，一键生成对应的旅游攻略

## 快速生成流程

完整 HTML 攻略优先走结构化流程，减少反复读取素材和手写 HTML：

```bash
node scripts/scan_resources.mjs <输入材料文件夹> -o <工作目录>/resource-index.json --place <景点名>
node scripts/create_fact_workspace.mjs --route-json <工作目录>/route-structure.json --index <工作目录>/resource-index.json -o <工作目录>/facts-workspace.json
node scripts/render_travel_html.mjs <工作目录>/facts-workspace.json -o <输出目录>
node scripts/verify_output.mjs <输出目录>
```

`scan_resources.mjs` 只做素材索引和候选匹配，`create_fact_workspace.mjs` 只生成事实工作区；它们都不会自动补充攻略事实。后续应按 `SKILL.md` 和 `references/structured-generation-workflow.md` 读取相关原文，填好 `facts-workspace.json` 后再渲染。
