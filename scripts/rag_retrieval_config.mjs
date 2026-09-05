/**
 * RAG 检索统一配置。
 *
 * 这里集中放会影响召回范围、阅读池大小和排序窗口的默认参数。
 * CLI 传参仍然可以覆盖这些默认值；修改这里会影响未显式传参的脚本运行。
 */

/**
 * 景点级检索主题。对象 key 的顺序会影响批量检索时跨主题加入阅读池的先后顺序。
 * 每个 theme 对应一组用于匹配 chunk 标题和正文的中文触发词。
 */
export const PLACE_THEMES = {
  highlights: ["看点", "出片", "宝藏", "必去", "值得", "精华", "机位", "推荐"],
  drawbacks: ["避雷", "避坑", "缺点", "差评", "不推荐", "踩雷", "失望"],
  tickets: ["门票", "票价", "预约", "开放", "优惠", "套票", "免票", "半价", "购票", "闭园", "营业"],
  transport: ["停车", "导航", "交通", "路况", "自驾", "塞车", "包车", "打车", "公交", "班车", "接驳", "换乘"],
  routes: ["路线", "玩法", "游览", "顺序", "入口", "出口", "上山", "下山", "环线", "徒步", "索道", "缆车", "游船", "观光车"],
  crowds: ["人流", "人少", "人多", "错峰", "排队", "拥挤", "限流", "早去", "晚去", "工作日", "节假日", "旺季"],
  accessibility: ["老人", "小孩", "亲子", "带娃", "推车", "无障碍", "台阶", "体力"],
  facilities: ["厕所", "卫生间", "补给", "餐饮", "小卖部", "休息区", "座椅", "寄存", "充电", "游客中心"],
  safety: ["安全", "注意", "防滑", "风大", "保暖", "防晒", "雨具", "高反", "海拔", "温差", "落石", "封路"],
};

/**
 * 城市级检索主题。对象 key 的顺序会影响批量检索时跨主题加入阅读池的先后顺序。
 * 城市主题偏向吃住行、备选点和整体风险提醒。
 */
export const CITY_THEMES = {
  foods: ["美食", "餐厅", "小吃", "夜市", "早市", "菜市场", "烧烤", "咖啡", "甜品", "特色菜", "本地人"],
  lodging: ["住宿", "酒店", "民宿", "客栈", "青旅", "位置", "商圈", "隔音", "性价比"],
  transport: ["停车", "路况", "导航", "限行", "交通", "自驾", "高铁", "大巴", "包车", "打车", "拼车", "公交"],
  backup_places: ["备选", "景点", "观景台", "打卡点", "冷门", "小众", "顺路", "附近"],
  notes: ["风险", "注意", "安全", "贴士", "天气", "海拔", "温差", "高反", "绕路", "限流", "堵车", "物价", "宰客", "预约", "关门"],
};

export const RAG_RETRIEVAL_DEFAULTS = {
  // 单点 rag:retrieve 未传 --top-k 时，每个检索请求最多返回多少条 chunk。
  singleTopK: 3,

  // 单点 rag:retrieve 未传 --max-chunks 时，单个请求最多允许进入最终结果的 chunk 数。
  // 最终返回数量是 min(singleTopK, singleMaxChunks)。
  singleMaxChunks: 20,

  // 批量 rag:workspace 中，每个景点的每个 theme 最多保留多少条结果。
  // 对应 CLI: --place-top-k；输出字段仍叫 retrieval.place_top_k。
  placeMaxThemeChunks: 5,

  // 批量 rag:workspace 中，每个城市的每个 theme 最多保留多少条结果。
  // 对应 CLI: --city-top-k；输出字段仍叫 retrieval.city_top_k。
  cityMaxThemeChunks: 4,

  // 批量 rag:workspace 中，单个景点跨全部 themes 去重后的阅读池最大 chunk 数。
  // 对应 CLI: --max-place-chunks。
  maxPlaceChunks: 45,

  // 批量 rag:workspace 中，单个城市跨全部 themes 去重后的阅读池最大 chunk 数。
  // 对应 CLI: --max-city-chunks。
  maxCityChunks: 24,

  // keyword_match 计分时最多按多少个命中词归一化；提高会让多词命中更难满分。
  keywordScoreTermCap: 6,

  // retrieval_health 判定景点召回偏少的阈值；低于该值会给 weak warning，不会直接过滤结果。
  minHealthyPlaceChunks: 3,

  // retrieval_health 判定城市召回偏少的阈值；低于该值会给 weak warning，不会直接过滤结果。
  minHealthyCityChunks: 2,
};
