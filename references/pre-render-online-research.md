# 渲染前联网需求判断

本文件定义生成 HTML 前唯一由 skill 主动触发的联网查询白名单。除非用户另行明确授权，不要查询本文件没有列出的信息。

## 使用时机

在 `facts-workspace.json` 已经根据本地材料完成主要填充后、运行 `render_travel_html.mjs` 前，读取本文件并做一次独立判断：

1. 列出本次行程中的候选城市：`route-structure.json.cities` 和 `facts-workspace.json.cities` 的 key。
2. 列出本次行程中的真实游玩或短停地点：每日 `route_places` 和 `facts-workspace.json.places` 的 key。
3. 对照下方“允许联网查询的信息”判断是否触发联网查询。
4. 只查询被触发规则明确允许的信息，并把结果填入 `facts-workspace.json`；不要把查询过程、来源审计或大段网页内容写进最终 HTML 正文。

如果没有任何规则被触发，直接进入渲染，不要为了补全攻略而联网搜索。

## 允许联网查询的信息

当前没有默认允许的渲染前联网查询项。

需要新增渲染前联网项时，必须补充触发条件、充分性判断、允许查询范围、写回字段和禁止外扩项。
