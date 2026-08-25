# skill-xhs-travel-plan
根据本地旅行材料、路线和照片生成中文旅游攻略与移动端静态 HTML。

## 快速生成流程

完整 HTML 攻略优先走结构化流程，减少反复读取素材和手写 HTML。先按 `SKILL.md` 和 `references/info-rules.md` 人工解析用户路线，生成 `<工作目录>/route-structure.json`，并得到真实景点/景区清单和候选城市清单；再运行脚本：

```bash
npm install
npm run scan -- <输入材料文件夹> -o <工作目录>/resource-index.json --place <景点名> --city <城市名>
npm run create-workspace -- --route-json <工作目录>/route-structure.json --index <工作目录>/resource-index.json -o <工作目录>/facts-workspace.json
npm run render -- <工作目录>/facts-workspace.json -o <输出目录>
npm run verify -- <输出目录>
```

`--place` 只传真实景点/景区，`--city` 只传候选城市；两者不要混用。`scan_resources.mjs` 只做素材索引和候选匹配，`create_fact_workspace.mjs` 只生成事实工作区；它们都不会自动补充攻略事实。后续应按 `SKILL.md` 和 `references/structured-generation-workflow.md` 读取相关原文，填好 `facts-workspace.json` 后再渲染。
