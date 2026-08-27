#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * 解析命令行参数，得到结构化路线 JSON、素材索引和输出路径。
 */
function parseArgs(argv) {
  const args = {
    routeJson: "",
    index: "resource-index.json",
    out: "facts-workspace.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--route-json") args.routeJson = argv[++i];
    else if (arg === "--index") args.index = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.routeJson) {
    throw new Error("Usage: node scripts/create_fact_workspace.mjs --route-json <route-structure.json> [--index resource-index.json] [-o facts-workspace.json]");
  }
  return args;
}

/**
 * 读取并解析 JSON 文件，主要用于加载 resource-index.json 和 route-structure.json。
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * 把空值、单值或数组统一规范成数组，方便兼容 agent 生成的结构。
 */
function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 清理并去重字符串数组，保留第一次出现的顺序。
 */
function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

/**
 * 确保每日标题包含 agent 已结构化出的当天住宿城市；脚本不从自然语言路线中抽取住宿信息。
 */
function titleWithLodgingCity(title, lodgingCity) {
  const baseTitle = String(title ?? "");
  lodgingCity = String(lodgingCity ?? "").trim();
  if (!lodgingCity || baseTitle.includes(lodgingCity)) return baseTitle;
  return `${baseTitle} - 宿${lodgingCity}`;
}

// skill 作者按：感觉没啥必要。
/**
 * 生成地点名的轻量别名，用于把“盐津县城”匹配到 photos/盐津/，
 * 或把“九洞天景区”匹配到 photos/九洞天/。这里只做保守名称归一，
 * 语义取舍仍由 agent 复核。
 */
function placeAliases(name) {
  const source = String(name ?? "").trim();
  if (!source) return [];
  const aliases = new Set([source]);
  let stripped = source;
  for (const suffix of ["风景名胜区", "风景区", "旅游区", "国家公园", "景区", "古镇", "县城", "老城", "城区", "市区"]) {
    if (stripped.endsWith(suffix) && stripped.length > suffix.length) {
      stripped = stripped.slice(0, -suffix.length);
      aliases.add(stripped);
    }
  }
  if (stripped.endsWith("县") && stripped.length > 2) aliases.add(stripped.slice(0, -1));
  if (stripped.endsWith("市") && stripped.length > 2) aliases.add(stripped.slice(0, -1));
  return [...aliases].filter((alias) => alias.length >= 2);
}

/**
 * 判断两个地点名称是否足够明确地同指。允许一个名称包含另一个名称，
 * 以覆盖“昭通大山包”与“大山包”这类材料目录简写。
 */
function relatedPlaceName(left, right) {
  for (const a of placeAliases(left)) {
    for (const b of placeAliases(right)) {
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

/**
 * 规范单日路线对象，确保工作区中的每日字段稳定存在。
 */
function normalizeDay(day, index) {
  const routePlaces = uniqueStrings(asList(day.route_places ?? day.places));
  const sourceLine = String(day.source_line ?? day.title ?? "");
  const lodgingCity = String(day.lodging_city ?? "");
  return {
    day: Number(day.day || index + 1),
    date: String(day.date ?? ""),
    title: titleWithLodgingCity(day.title ?? sourceLine, lodgingCity),
    lodging_city: lodgingCity,
    summary: String(day.summary ?? ""),
    route_places: routePlaces,
    timeline: asList(day.timeline),
    notes: asList(day.notes),
    confirmations: asList(day.confirmations),
    source_line: sourceLine,
  };
}

/**
 * 从 agent 生成的 route-structure.json 中读取并规范化每日路线。
 */
function normalizeDays(routeStructure) {
  return asList(routeStructure.days).map(normalizeDay);
}

/**
 * 根据候选景点名，从素材索引中找出可能相关的原始素材文件路径。
 */
function filesForPlace(index, place) {
  const matches = [];
  for (const item of index.files ?? []) {
    const candidateMatch = (item.candidate_places ?? []).some((candidate) => relatedPlaceName(place, candidate));
    const pathMatch = placeAliases(place).some((alias) => item.path?.includes(alias));
    const titleMatch = placeAliases(place).some((alias) => item.title?.includes(alias));
    if (candidateMatch || pathMatch || titleMatch) {
      matches.push(item.path);
    }
  }
  return matches;
}

/**
 * 根据候选城市名，从素材索引中找出可能相关的原始素材文件路径。
 */
function filesForCity(index, city) {
  const matches = [];
  for (const item of index.files ?? []) {
    if ((item.candidate_cities ?? []).includes(city) || item.path?.includes(city) || item.title?.includes(city)) {
      matches.push(item.path);
    }
  }
  return matches;
}

/**
 * 从规范化后的每日路线中汇总本次路线明确出现的景点/景区名称。
 */
function routePlacesFromDays(days) {
  const routePlaces = [];
  for (const day of days) {
    for (const place of day.route_places) {
      if (!routePlaces.includes(place)) routePlaces.push(place);
    }
  }
  return routePlaces;
}

/**
 * 根据路线地点名匹配本地照片目录。优先 exact，也允许明显别名。
 */
function photosForPlace(index, place) {
  const photos = [];
  for (const [photoPlace, items] of Object.entries(index.photos ?? {})) {
    if (relatedPlaceName(place, photoPlace)) photos.push(...items);
  }
  return uniqueStrings(photos).slice(0, 3);
}

/**
 * 构建 facts-workspace.json 的初始结构；只创建空槽位，不自动生成攻略事实。
 */
function buildFacts(index, routeStructure) {
  const days = normalizeDays(routeStructure);
  const routePlaces = routePlacesFromDays(days);
  const placeFacts = {};
  for (const place of routePlaces) {
    placeFacts[place] = {
      summary: "",
      elevation_m: null,
      elevation_source_url: "",
      elevation_checked_at: "",
      highlights: [],
      drawbacks: [],
      opening_hours: [],
      tickets: [],
      duration: "",
      routes: [],
      play_options: [],
      practical_info: [],
      notes: [],
      conflicts: [],
      photos: photosForPlace(index, place),
      source_files: filesForPlace(index, place),
    };
  }

  const cityFacts = {};
  for (const city of uniqueStrings(asList(routeStructure.cities))) {
    cityFacts[city] = {
      include: false,
      summary: "",
      elevation_m: null,
      elevation_source_url: "",
      elevation_checked_at: "",
      overview: [],
      backup_places: [],
      foods: [],
      lodging: [],
      transport: [],
      shopping: [],
      notes: [],
      source_files: filesForCity(index, city),
    };
  }

  return {
    schema_version: 1,
    needs_agent_review: true,
    title: String(routeStructure.title ?? ""),
    source: {
      resource_root: index.resource_root ?? "",
      resource_index: "resource-index.json",
      route_structure: "route-structure.json",
    },
    trip: {
      mode: String(routeStructure.mode ?? "unknown"),
      days,
    },
    places: placeFacts,
    cities: cityFacts,
    global_notes: [],
    confirm_before_departure: [],
  };
}

/**
 * 命令行入口：读取结构化路线和素材索引，生成待 agent 填充的事实工作区 JSON。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = readJson(args.index);
  const routeStructure = readJson(args.routeJson);
  const facts = buildFacts(index, routeStructure);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
  console.log(
    `Created ${args.out} workspace with ${facts.trip.days.length} days, ${Object.keys(facts.places).length} place shells, and ${Object.keys(facts.cities).length} city shells. Agent review is still required before rendering.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
