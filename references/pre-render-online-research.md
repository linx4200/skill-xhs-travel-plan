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

### 高原海拔

触发条件：

- 路线或本地材料明确出现高原、高海拔、高反、缺氧、海拔、雪山、垭口等线索。
- 行程城市或景点从常识上可能位于高原地区，但不确定是否超过 2000 米。
- 已有材料或一次海拔查询显示任一行程城市或景点海拔大于 2000 米。

允许查询：

- 为判断是否触发规则，可以查询行程城市或疑似高海拔景点的海拔。
- 一旦确认任一行程城市或地点海拔大于 2000 米，必须查询本次行程中每个候选城市和每个 `route_places` 地点的海拔。

填写规则：

- 城市海拔填入 `facts-workspace.json` 的 `cities.<城市名>.elevation_m`、`cities.<城市名>.elevation_source_url`、`cities.<城市名>.elevation_checked_at`。
- 景点海拔填入 `facts-workspace.json` 的 `places.<景点名>.elevation_m`、`places.<景点名>.elevation_source_url`、`places.<景点名>.elevation_checked_at`。
- `elevation_m` 只填数字，单位固定为米；来源 URL 填查询依据页面；`elevation_checked_at` 填查询日期，格式为 `YYYY-MM-DD`。
- 不同来源数值略有差异时，使用“约”的表达进入正文；JSON 数值可取可信来源给出的整数或四舍五入后的整数。若来源差异足以影响高反、衣物或路线判断，把差异放入对应地点的 `notes` 或 `conflicts`。

禁止顺手查询：

- 不要借海拔查询顺手补充开放时间、票价、交通时长、天气预报、最新政策、路线推荐、餐厅、住宿或图片。
- 不要把未列入行程的周边景点加入攻略。
- 不要使用远程图片链接或联网补图。
