# Source Digest 读取去重优化方案

## 背景

本 skill 用于根据用户提供的本地小红书、评论、整理稿、照片等旅行材料，生成中文旅游攻略和移动端静态 HTML 页面。当前完整攻略优先走结构化低上下文流程：

1. agent 解析用户路线，生成 `route-structure.json`。
2. `scripts/scan_resources.mjs` 扫描输入材料，生成 `resource-index.json`。
3. `scripts/create_fact_workspace.mjs` 根据路线和素材索引生成 `facts-workspace.json`。
4. agent 阅读相关原文，填充 `facts-workspace.json`。
5. `scripts/render_travel_html.mjs` 渲染 HTML，`scripts/verify_output.mjs` 校验。

这套流程已经避免了在最终写 HTML 时反复塞入全部材料，但仍存在一个明显低效点：`facts-workspace.json` 以地点和城市为中心组织 `source_files`，当同一个文件同时命中多个地点、城市或主题时，agent 很容易按地点/城市逐项处理，从而重复读取同一个原文文件。

## 当前问题

以仓库中 `output/2026-guoqing-self-drive-plan/` 的样例产物为例：

- `resource-index.json` 中共有 53 个文本材料文件。
- 这些文本材料的 `char_count` 总和约为 73,159 字符。
- `facts-workspace.json` 中所有 `places.*.source_files` 和 `cities.*.source_files` 合计引用 104 次文件。
- 去重后实际涉及 50 个唯一文件，字符总量约为 71,070。
- 如果按地点/城市拆开逐项读取、不做去重，累计读取量约为 179,444 字符。

这说明当前的读取放大主要来自两个方面：

1. 同一个文件被多个地点和城市重复引用。
2. 城市名命中过宽，导致很多景点材料也被挂到城市级 `source_files`。

因此，即使不引入 RAG，也可以通过读取顺序和中间数据结构优化，把材料读取量从按引用累计的约 17.9 万字符，压回接近去重后的约 7.1 万字符。实际 token 节省会受模型分词、agent 是否需要回读、材料结构和输出复杂度影响，但读取阶段节省 50% 以上是合理目标。

## 目标

本优化不改变事实边界、不自动生成未经核验的攻略事实，也不引入向量检索。目标是：

- 同一原文文件在事实抽取阶段最多读取一次。
- 一次读取时同时抽取该文件对所有相关地点、城市和全局提醒的有效信息。
- 后续填充 `facts-workspace.json` 时优先读取结构化摘要，而不是重复打开原文。
- 降低城市名宽匹配造成的误读和重复处理。
- 保留必要的原文回读能力，用于冲突判断、材料不足和质量复核。

## 方案概览

新增一个按文件组织的中间层：`source-digest.json`。

推荐流程：

```text
route-structure.json
resource-index.json
        |
        v
reading-queue.json 或 source-digest.json 初始壳
        |
        v
agent 按唯一文件读取原文，并抽取全部相关事实
        |
        v
source-digest.json
        |
        v
facts-workspace.json
        |
        v
render + verify
```

最小可行版本可以先只生成 `reading-queue.json`，用于改变 agent 的读取顺序。完整版本再持久化 `source-digest.json`，让后续修改和复核也能复用文件级事实摘要。

## 数据结构建议

### reading-queue.json

`reading-queue.json` 用于告诉 agent 应该按哪些唯一文件读取，以及每个文件服务哪些事实目标。

示例：

```json
{
  "schema_version": 1,
  "source": {
    "resource_index": "resource-index.json",
    "facts_workspace": "facts-workspace.json"
  },
  "files": [
    {
      "path": "019-caohai-comments.md",
      "char_count": 14258,
      "consumers": [
        { "type": "place", "name": "威宁百草坪", "reason": "candidate_place" },
        { "type": "place", "name": "威宁草海", "reason": "candidate_place" },
        { "type": "city", "name": "毕节", "reason": "candidate_city" },
        { "type": "city", "name": "威宁", "reason": "candidate_city" }
      ],
      "matched_keywords": ["停车", "美食", "避坑"],
      "priority": "primary"
    }
  ]
}
```

### source-digest.json

`source-digest.json` 用于保存 agent 读完每个唯一文件后的结构化摘要。它按文件组织，不按地点组织。

示例：

```json
{
  "schema_version": 1,
  "needs_agent_review": true,
  "source": {
    "resource_root": "/path/to/resources",
    "resource_index": "resource-index.json",
    "route_structure": "route-structure.json"
  },
  "files": [
    {
      "path": "019-caohai-comments.md",
      "char_count": 14258,
      "reviewed": true,
      "consumers": [
        { "type": "place", "name": "威宁百草坪" },
        { "type": "place", "name": "威宁草海" },
        { "type": "city", "name": "毕节" },
        { "type": "city", "name": "威宁" }
      ],
      "facts": [
        {
          "target_type": "place",
          "target_name": "威宁百草坪",
          "field": "practical_info",
          "items": [
            "..."
          ],
          "evidence": [
            {
              "quote": "...",
              "note": "短证据，仅用于 agent 复核，不进入最终正文"
            }
          ]
        },
        {
          "target_type": "place",
          "target_name": "威宁草海",
          "field": "notes",
          "items": [
            "..."
          ],
          "evidence": []
        }
      ],
      "conflicts": [],
      "global_notes": []
    }
  ]
}
```

注意：`source-digest.json` 不是最终攻略正文。它是事实抽取工作区，允许保留短证据、冲突线索和字段归属，方便后续把事实分发到 `facts-workspace.json`。

## 分阶段落地步骤

### 阶段 1：只改流程说明

先在 `references/structured-generation-workflow.md` 中补充一条规则：

- 读取原文前，必须先把 `facts-workspace.json` 中所有 `source_files` 去重。
- 按唯一文件建立读取队列。
- 每次打开一个文件时，同时处理它服务的所有地点、城市和全局事项。
- 不要按 `places` 或 `cities` 逐项重复读取同一文件。

这一阶段不需要改脚本，风险最低，能马上减少 agent 的重复读取。

### 阶段 2：新增 reading queue 脚本

新增脚本：

```text
scripts/create_reading_queue.mjs
```

输入：

```text
--index <resource-index.json>
--facts <facts-workspace.json>
-o <reading-queue.json>
```

职责：

- 汇总 `places.*.source_files` 和 `cities.*.source_files`。
- 按文件路径去重。
- 为每个文件标注 consumers。
- 附带 `char_count`、标题、候选地点、候选城市和关键词。
- 计算重复读取放大数据，用于命令行输出。

建议输出统计：

```text
Created reading queue with 50 unique files from 104 source refs.
Unique source chars: 71070. Repeated source chars: 179444. Estimated read amplification: 2.52x.
```

这一阶段可以立刻把读取路径从“地点/城市 -> 文件”改成“文件 -> 地点/城市”。

### 阶段 3：新增 source-digest 工作区

新增脚本：

```text
scripts/create_source_digest_workspace.mjs
```

输入：

```text
--queue <reading-queue.json>
-o <source-digest.json>
```

职责：

- 创建待 agent 填充的 `source-digest.json` 壳。
- 每个文件包含 `reviewed: false`、`consumers`、空的 `facts`、`conflicts` 和 `global_notes`。
- 不做自动事实抽取。

agent 后续按 `source-digest.json.files[]` 顺序读取原文，并填充每个文件的 digest。

### 阶段 4：从 source digest 分发到 facts workspace

可以先由 agent 人工读取 `source-digest.json` 后编辑 `facts-workspace.json`。稳定后再新增辅助脚本：

```text
scripts/apply_source_digest.mjs
```

职责：

- 读取 `source-digest.json` 和 `facts-workspace.json`。
- 根据 `facts[].target_type`、`target_name`、`field` 分发事实。
- 合并数组字段并去重。
- 保留 `needs_agent_review: true`，要求 agent 最终复核。

这个脚本只能做机械合并，不能判断事实质量、冲突优先级或城市 `include`。

### 阶段 5：优化城市 source_files 策略

修改 `scripts/create_fact_workspace.mjs` 的城市 source 逻辑：

- 城市先输出 `candidate_source_files`，不要直接作为强 source 使用。
- 只有城市 `include=true` 或 agent 明确需要城市页判断时，才处理城市候选文件。
- 如果某文件已经作为景点材料被处理，且 digest 中没有城市级增量信息，不再重复进入城市页。

长期可以把城市字段拆成：

```json
{
  "source_files": [],
  "candidate_source_files": [],
  "weak_source_files": []
}
```

默认只处理 `source_files`。`candidate_source_files` 和 `weak_source_files` 用于材料不足、冲突判断和人工复核。

## 优先级建议

优先做：

1. 阶段 1：改流程说明，要求唯一文件读取。
2. 阶段 2：新增 `reading-queue.json`，让去重读取变成可执行产物。
3. 阶段 3：新增 `source-digest.json`，提高后续修改复用率。

暂缓做：

- 自动从 digest 写回 facts 的完整脚本。
- 复杂的城市 include 自动判断。
- RAG 或 embedding。

原因是本 skill 的事实边界严格，自动化越深，越容易把“整理辅助”误用成“事实判断器”。先把读取去重和文件级摘要做好，收益明确且风险可控。

## 注意事项

- `source-digest.json` 不应替代原文。遇到冲突、票价、开放时间、预约、交通管制、安全风险等高影响信息，仍应允许回读原文。
- digest 中的 `evidence.quote` 只保留短证据，避免把大段原文复制进工作区。
- 城市名命中应视为弱信号。只命中“毕节”“昭通”“威宁”等城市名，不代表文件一定有城市页价值。
- 评论长文优先按唯一文件读取。读完一次后，应同时抽取它对所有关联地点和城市的事实，避免后续反复打开。
- `source_files` 仍应保留在 `facts-workspace.json` 中，作为事实追溯入口，但 agent 的默认读取顺序应以 `reading-queue.json` 或 `source-digest.json` 为准。
- 脚本生成的 queue 或 digest 壳不能自动标记 `needs_agent_review: false`。只有 agent 完成事实检查、冲突判断和内容取舍后，才能关闭 review 标记。
- 最终 HTML 仍必须通过 `scripts/verify_output.mjs`，并按 `references/manual-quality-check.md` 做人工质量检查。

## 成功标准

一次完整攻略生成中，本优化达到以下标准即可认为有效：

- 原文读取顺序以唯一文件为单位，而不是以地点/城市为单位。
- 重复读取放大倍数有统计输出。
- 同一文件不会因为同时命中多个地点和城市而被 agent 多次完整读取。
- `facts-workspace.json` 仍能保留清晰的地点、城市和全局事实结构。
- 城市页内容没有因为去重读取而混入无关景点材料。
- 需要复核的高影响事实仍能追溯回具体原文文件。
