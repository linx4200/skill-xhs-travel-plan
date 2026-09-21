/**
 * RAG 检索统一配置。
 *
 * 这里集中放会影响召回范围、阅读池大小和排序窗口的默认参数。
 * CLI 传参仍然可以覆盖这些默认值；修改这里会影响未显式传参的脚本运行。
 */

/**
 * 景点级检索主题。批量检索会按这里对象 key 的书写顺序，依次把各主题结果加入总阅读池；
 * 阅读池满额后，后面的主题不再贡献新的 chunk（只把已入池的 chunk 登记进自己的索引），
 * 被丢弃的数量记在 retrieval_quota.dropped_by_theme 里。
 *
 * 因此「主题顺序」就是名额先到先得的顺序：新增、删除或调整这里的 key 会直接改变
 * 谁先占名额。默认 10 个主题 × placeMaxThemeChunks 5 恰好等于 maxPlaceChunks 50。
 *
 * 每个 theme 对应一组用于匹配 chunk 标题和正文的中文触发词。
 */
export const PLACE_THEMES = {
  highlights: ["看点", "出片", "宝藏", "必去", "值得", "精华", "机位", "推荐", "最佳", "夯"],
  drawbacks: ["避雷", "避坑", "缺点", "差评", "不推荐", "踩雷", "失望"],
  tickets: ["门票", "票价", "预约", "开放", "优惠", "套票", "免票", "半价", "购票", "闭园", "营业"],
  transport: ["停车", "导航", "交通", "路况", "入口", "自驾", "高铁", "塞车", "包车", "打车", "班车", "接驳"],
  routes: ["路线", "玩法", "游览", "顺序", "环线", "徒步", "索道", "游船", "观光车", "打卡点"],
  nearby: ["周边", "附近", "景点", "顺路", "路线", "玩法", "半日游", "一日游", "小众", "打卡点"],
  crowds: ["人流", "人少", "人多", "错峰", "排队", "拥挤", "限流", "早去", "晚去", "工作日", "节假日", "旺季"],
  accessibility: ["无人机", "老人", "小孩", "亲子", "带娃", "推车", "无障碍", "台阶", "体力"],
  facilities: ["厕所", "卫生间", "补给", "吃的", "美食", "餐饮", "小卖部", "休息区", "寄存", "充电", "游客中心"],
  safety: ["安全", "注意", "贴士", "tips", "防滑", "风大", "保暖", "防晒", "雨具", "高反", "海拔", "温差", "封路"],
};

/**
 * 城市级检索主题。收集顺序与名额规则同 PLACE_THEMES：按对象 key 书写顺序先到先得。
 * 默认 5 个主题 × cityMaxThemeChunks 5 恰好等于 maxCityChunks 25。
 *
 * 城市主题偏向吃住行、备选点和整体风险提醒。
 */
export const CITY_THEMES = {
  foods: ["美食", "好吃", "餐厅", "小吃", "夜市", "宵夜", "夜宵", "早餐", "早市", "烧烤", "火锅", "蔬菜", "咖啡", "奶茶", "特色菜", "本地人"],
  lodging: ["住宿", "酒店", "民宿", "客栈", "青旅", "位置", "商圈", "隔音", "性价比"],
  transport: ["停车", "路况", "导航", "限行", "交通", "自驾", "高铁", "大巴", "包车", "打车", "拼车", "公交"],
  backup_places: ["景点", "观景台", "打卡点", "冷门", "小众", "顺路", "附近", "周边", "文创", "手信", "伴手礼" , "带娃"],
  notes: ["风险", "注意", "安全", "贴士", "tips", "天气", "海拔", "温差", "高反", "绕路", "限流", "堵车", "物价", "宰客", "预约", "关门"],
};

export const RAG_SCORING = {
  // 档位语义：这些 theme 的城市级 / 地点级材料是硬分层，低优先档不可翻越高优先档。
  cityTierThemes: ["backup_places"],

  // 软降权语义：降权幅度（0~1），乘子 = 1 - tilt。
  videoTilt: 0.15,
  defaultCityTilt: 0.1,
  cityTiltByTheme: {
    foods: 0.1,
    lodging: 0.1,
    transport: 0.1,
    notes: 0.1,
  },
};

/**
 * 读取档位：用一次性的具名开关预设四个配额，避免调用方记四个数字。
 *
 * 档位只是「批量默认值」，不改变任何单参数语义：
 * CLI 的四个原子参数（--place-top-k / --city-top-k / --max-place-chunks /
 * --max-city-chunks）优先级高于档位，显式传参可以逐个覆盖档位值。
 *
 * ⚠️ `default` 是冻结基线档，数值必须与 2026-09 P2/P3 轮次完全一致。
 * 改它会让 B1/B2 基线、评估报告和相关 reference 同时失效。
 * 需要新的读取策略请新增 key，不要修改 `default`。
 */
export const RAG_READ_PROFILES = {
  default: {
    label: "标准",
    placeMaxThemeChunks: 5,
    cityMaxThemeChunks: 5,
    maxPlaceChunks: 50,
    maxCityChunks: 25,
  },

  // 广读档。取值来自 P3 天花板扫描后在 B1 上做的落地复核：
  // 见 assessment/rag-tuning/rounds/P3-2026-09-20/B1-RECHECK.md。
  // 实测（B1 基准 4 个 target）：阅读池 82 → 110 chunk，正文 token +3.5k 量级；
  // R1 0.7797→0.9153、R2 0.8136→0.9153，facts N1/N2 不退化。
  // 因为读量 +34.1% 超出 §1.3 的默认值门槛，它只作为显式可选档，不是默认值。
  wide: {
    label: "广读",
    placeMaxThemeChunks: 10,
    cityMaxThemeChunks: 10,
    maxPlaceChunks: 100,
    maxCityChunks: 50,
  },
};

/** 未显式指定档位时使用的档位名。 */
export const RAG_READ_PROFILE_DEFAULT = "default";

/**
 * 按名字解析读取档位。非法档名直接抛错，不做静默回退 —— 档位决定读量和 token 成本，
 * 静默降级会让调用方以为自己在用 wide，实际跑的是 default。
 */
export function resolveReadProfile(name) {
  const key = String(name ?? "").trim() || RAG_READ_PROFILE_DEFAULT;
  const profile = RAG_READ_PROFILES[key];
  if (!profile) {
    throw new Error(
      `Unknown --read-scope "${key}". Available: ${Object.keys(RAG_READ_PROFILES).join(", ")}.`,
    );
  }
  return { name: key, ...profile };
}

const DEFAULT_READ_PROFILE = RAG_READ_PROFILES[RAG_READ_PROFILE_DEFAULT];

export const RAG_RETRIEVAL_DEFAULTS = {
  // 以下四个配额字段全部由 RAG_READ_PROFILES.default 派生，保持单一真源：
  // 想改默认行为，改 RAG_READ_PROFILES.default，不要在这里写第二份数字。

  // 正式生成：每个景点的每个 theme 最多拿多少条 chunk。
  // 对应 CLI: --place-top-k；输出字段仍叫 retrieval.place_top_k。
  placeMaxThemeChunks: DEFAULT_READ_PROFILE.placeMaxThemeChunks,

  // 正式生成：每个城市的每个 theme 最多拿多少条 chunk。
  // 对应 CLI: --city-top-k；输出字段仍叫 retrieval.city_top_k。
  cityMaxThemeChunks: DEFAULT_READ_PROFILE.cityMaxThemeChunks,

  // 正式生成：一个景点所有 themes 合起来最多读多少条 chunk。
  // 对应 CLI: --max-place-chunks。
  // 默认值恰好等于 PLACE_THEMES 主题数 × placeMaxThemeChunks，所以默认不会触发名额丢弃。
  // 调大 placeMaxThemeChunks 或新增主题后，丢弃会从主题顺序末尾开始，需同步评估这个值。
  maxPlaceChunks: DEFAULT_READ_PROFILE.maxPlaceChunks,

  // 正式生成：一个城市所有 themes 合起来最多读多少条 chunk。
  // 对应 CLI: --max-city-chunks。
  // 与 maxPlaceChunks 同理，默认值恰好等于 CITY_THEMES 主题数 × cityMaxThemeChunks。
  maxCityChunks: DEFAULT_READ_PROFILE.maxCityChunks,

  // keyword_match 计分时最多按多少个命中词归一化；提高会让多词命中更难满分。
  keywordScoreTermCap: 6,

  // retrieval_health 判定景点召回偏少的阈值；低于该值会给 weak warning，不会直接过滤结果。
  minHealthyPlaceChunks: 3,

  // retrieval_health 判定城市召回偏少的阈值；低于该值会给 weak warning，不会直接过滤结果。
  minHealthyCityChunks: 2,

  // 仅调试：手动运行 rag:retrieve 且没传 --top-k 时，默认显示多少条 chunk。
  // 正式生成走 rag:workspace，不看这个值。
  ragRetrieveResultChunks: 8,
};

/**
 * Rerank 默认配置。常规检索默认不启用 rerank；只有 CLI 或调用方显式开启时，
 * 才会访问本地 HTTP rerank 服务。
 *
 * queryTemplates 是固定自然语言模板表，只用于 rerank API，不改变 embedding query。
 */
export const RAG_RERANK_DEFAULTS = {
  enabled: false,
  url: "http://127.0.0.1:11435/rerank",
  model: "onnx-community/Qwen3-Reranker-0.6B-ONNX",

  // 候选窗口宽度：每个命中 theme 送入 rerank 的候选条数。
  // 2026-09-20 由 12 上调至 24（P2 自动调参结论，见 assessment/rag-tuning/rounds/P2-2026-09-20/P2-TUNING-REPORT.md）：
  // 窗口 12 会把初排落在 13-24 位、但确实该读的 chunk 挡在窗口外；扩至 24 后
  // R1 0.7797→0.8644、R2 0.8136→0.8870，而读取量只 +1.2%（82→83）。
  // 注意：并非越大越好 —— 24→30→56 会反向退化，不要在没有实测的前提下继续上调。
  recallWidth: 24,
  probThreshold: 0.9,
  probThresholdByTheme: {
    place: {
      facilities: 0.70,
    },
    city: {},
  },

  // 单条 rerank document 的正文截断上限，只用于防止异常长文本拖慢推理。
  maxDocChars: 700,

  timeoutMs: 120000,
  queryTemplates: {
    place: {
      highlights: "{name}有哪些值得专门停留、拍照或体验的景观亮点和游玩看点？",
      nearby: "{name}周边有哪些顺路、附近或可组合游玩的地点和路线建议？",
      routes: "{name}游玩材料是否提供具体游览路线、先后顺序、环线、徒步、游船、观光车或索道等动线玩法安排？",
      facilities:
        "{name}游玩材料是否提到任一实用配套信息，例如厕所/卫生间、停车/接驳/观光车、游客中心、吃饭住宿、补给/小卖部、休息区、寄存或充电？",
    },
    city: {
      backup_places: "{name}有哪些可作为行程备选、顺路补充或城市周边的小众地点？",
    },
  },
  highRiskThemes: {
    place: ["highlights", "nearby", "routes", "facilities"],
    city: ["backup_places"],
  },
};
