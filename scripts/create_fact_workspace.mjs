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
 * 规范单日路线对象，确保工作区中的每日字段稳定存在。
 */
function normalizeDay(day, index) {
  const routePlaces = uniqueStrings(asList(day.route_places ?? day.places));
  return {
    day: Number(day.day || index + 1),
    date: String(day.date ?? ""),
    title: String(day.title ?? day.source_line ?? ""),
    summary: String(day.summary ?? ""),
    route_places: routePlaces,
    timeline: asList(day.timeline),
    notes: asList(day.notes),
    confirmations: asList(day.confirmations),
    source_line: String(day.source_line ?? day.title ?? ""),
  };
}

/**
 * 从 agent 生成的 route-structure.json 中读取并规范化每日路线。
 */
function normalizeDays(routeStructure) {
  return asList(routeStructure.days).map(normalizeDay);
}

/**
 * 根据候选地点名，从素材索引中找出可能相关的原始素材文件路径。
 */
function filesForPlace(index, place) {
  const matches = [];
  for (const item of index.files ?? []) {
    if ((item.candidate_places ?? []).includes(place) || item.path?.includes(place) || item.title?.includes(place)) {
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
 * 构建 facts-workspace.json 的初始结构；只创建空槽位，不自动生成攻略事实。
 */
function buildFacts(index, routeStructure) {
  const days = normalizeDays(routeStructure);
  const routePlaces = routePlacesFromDays(days);
  const placeFacts = {};
  for (const place of routePlaces) {
    placeFacts[place] = {
      summary: "",
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
      photos: (index.photos?.[place] ?? []).slice(0, 3),
      source_files: filesForPlace(index, place),
    };
  }

  const cityFacts = {};
  for (const city of uniqueStrings(asList(routeStructure.cities))) {
    cityFacts[city] = {
      include: false,
      summary: "",
      overview: [],
      backup_places: [],
      foods: [],
      lodging: [],
      transport: [],
      shopping: [],
      notes: [],
      source_files: filesForPlace(index, city),
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
