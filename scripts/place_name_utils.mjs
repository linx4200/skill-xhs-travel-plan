/**
 * 共享的通用归一化规则。
 * 这些规则面对的是“景点名/城区名的标准化”，而不是某一份攻略的特例表。
 * 调用方可以按需传入 customAliases 做额外覆盖，但核心库本身不绑定业务数据。
 */
const PLACE_NAME_RULES = {
  stripSuffixes: ["风景名胜区", "风景区", "旅游区", "国家公园", "景区", "古镇", "县城", "老城", "城区", "市区", "镇", "乡", "村"],
  stripTailWords: ["县", "市", "省", "镇"],
};

/**
 * 只在调用方显式提供的 alias 映射中查找一级替换。
 * 设计上保守：不在库内写死任何具体景区或城镇名称。
 */
function applyCustomAliases(value, customAliases = {}) {
  const direct = customAliases[value];
  if (Array.isArray(direct) && direct.length) {
    return direct[0];
  }
  return value;
}

/**
 * 把一个地名规范化成一个“保守的候选名”形式。
 * 例如："九洞天景区" -> "九洞天"，"盐津县城" -> "盐津"。
 * 这一步不追求全覆盖，只保证同一地名的常见变体能落到相同候选名上。
 */
export function canonicalPlaceName(name, customAliases = {}) {
  const source = String(name ?? "").trim();
  if (!source) return "";

  let value = applyCustomAliases(source, customAliases);

  for (const suffix of PLACE_NAME_RULES.stripSuffixes) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }

  for (const tailWord of PLACE_NAME_RULES.stripTailWords) {
    if (value.endsWith(tailWord) && value.length > tailWord.length + 1) {
      value = value.slice(0, -tailWord.length);
      break;
    }
  }

  return value.trim();
}

/**
 * 生成一个地名的候选别名集合，用于做“可能是同一地点”的宽松匹配。
 * 例子：原名、显式 alias、去后缀后的规范名、去县/市后的简写都会被保留。
 * 结果按长度降序排序，优先比较更短、更核心的候选名。
 */
export function placeAliases(name, customAliases = {}) {
  const source = String(name ?? "").trim();
  if (!source) return [];

  const aliases = new Set([source]);
  const queue = [source];
  const addAlias = (alias) => {
    if (!alias || aliases.has(alias)) return;
    aliases.add(alias);
    queue.push(alias);
  };

  while (queue.length) {
    const current = queue.pop();
    const directAlias = applyCustomAliases(current, customAliases);
    if (directAlias && directAlias !== current) {
      addAlias(directAlias);
    }

    const normalized = canonicalPlaceName(current, customAliases);
    if (normalized && normalized !== current) {
      addAlias(normalized);
    }

    let stripped = current;
    for (const suffix of PLACE_NAME_RULES.stripSuffixes) {
      if (stripped.endsWith(suffix) && stripped.length > suffix.length) {
        stripped = stripped.slice(0, -suffix.length);
        break;
      }
    }
    for (const tailWord of PLACE_NAME_RULES.stripTailWords) {
      if (stripped.endsWith(tailWord) && stripped.length > tailWord.length + 1) {
        stripped = stripped.slice(0, -tailWord.length);
        break;
      }
    }
    if (stripped && stripped !== current) {
      addAlias(stripped);
    }
  }

  return [...aliases]
    .filter((alias) => alias && alias.length >= 2)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * 判断两个名称是否“可能指向同一个地点”。
 * 这是一个保守的近似匹配：只要候选别名交集或包含关系成立，就判定为相关。
 * 这个函数用于筛选候选材料和照片，而不是做强确定性的地理实体判定。
 */
export function relatedPlaceName(left, right, customAliases = {}) {
  for (const a of placeAliases(left, customAliases)) {
    for (const b of placeAliases(right, customAliases)) {
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

export { PLACE_NAME_RULES };
