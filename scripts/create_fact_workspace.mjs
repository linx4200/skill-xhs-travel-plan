#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { cleanDayTitle } from "./day_title_utils.mjs";
import { placeAliases, relatedPlaceName } from "./place_name_utils.mjs";
import { loadRagIndex } from "./rag_retrieve.mjs";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]);

/**
 * 解析命令行参数，得到结构化路线 JSON、素材索引和输出路径。
 */
function parseArgs(argv) {
  const args = {
    routeJson: "",
    index: "resource-index.json",
    ragIndex: "",
    out: "facts-workspace.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--route-json") args.routeJson = argv[++i];
    else if (arg === "--index") args.index = argv[++i];
    else if (arg === "--rag-index") args.ragIndex = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.routeJson) {
    throw new Error(
      "Usage: node scripts/create_fact_workspace.mjs --route-json <route-structure.json> [--index resource-index.json | --rag-index rag-index.json] [-o facts-workspace.json]",
    );
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
 * 把当前系统路径分隔符转换为 POSIX 分隔符，保证 JSON 中路径稳定。
 */
function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * 递归遍历目录，返回按中文 locale 排序后的所有文件路径。
 */
function walk(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/**
 * 扫描 photos/ 目录，把本地照片按目录归属整理成索引。
 */
function scanPhotos(root) {
  const photosRoot = path.join(root, "photos");
  const photos = {};
  if (!fs.existsSync(photosRoot)) return photos;
  for (const filePath of walk(photosRoot)) {
    if (!IMAGE_EXTS.has(path.extname(filePath).toLowerCase())) continue;
    const rel = toPosix(path.relative(root, filePath));
    const parts = rel.split("/");
    const place = parts.length > 2 && parts[0] === "photos" ? parts[1] : path.basename(path.dirname(filePath));
    photos[place] ??= [];
    photos[place].push(rel);
  }
  return photos;
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
 * 将 RAG index 适配成 facts skeleton 所需的最小素材索引。
 */
function indexFromRag(ragIndexPath) {
  const ragIndex = loadRagIndex(ragIndexPath);
  const filesByPath = new Map();
  for (const chunk of ragIndex.chunks ?? []) {
    const sourcePath = String(chunk.resource_path || chunk.source_uri || chunk.chunk_id || "").replace(/^\.?\/*resources\//, "");
    if (!sourcePath) continue;
    const existing = filesByPath.get(sourcePath) ?? {
      path: sourcePath,
      title: chunk.title || sourcePath,
      kind: "rag-note",
      char_count: 0,
      candidate_places: [],
      candidate_cities: [],
      excerpt: "",
    };
    existing.char_count += String(chunk.text ?? "").length;
    existing.candidate_places = uniqueStrings([...existing.candidate_places, ...(chunk.candidate_places ?? [])]);
    existing.candidate_cities = uniqueStrings([...existing.candidate_cities, ...(chunk.candidate_cities ?? [])]);
    if (!existing.excerpt && chunk.text) existing.excerpt = String(chunk.text).replace(/\s+/g, " ").trim().slice(0, 180);
    filesByPath.set(sourcePath, existing);
  }

  const resourceRoot = String(ragIndex.resource_root ?? path.dirname(path.resolve(ragIndexPath)));
  return {
    source_kind: "rag-index",
    rag_index: path.basename(ragIndexPath),
    resource_root: resourceRoot,
    files: [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path, "zh-CN")),
    photos: scanPhotos(resourceRoot),
  };
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
    title: cleanDayTitle(day.title ?? sourceLine),
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
    const aliases = placeAliases(place);
    if (relatedPlaceName(place, photoPlace)) {
      photos.push(...items);
      continue;
    }
    photos.push(...items.filter((item) => aliases.some((alias) => item.includes(alias))));
  }
  return uniqueStrings(photos);
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
      resource_index: index.source_kind === "rag-index" ? "" : "resource-index.json",
      route_structure: "route-structure.json",
      ...(index.rag_index ? { rag_index: index.rag_index } : {}),
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
  const index = args.ragIndex ? indexFromRag(args.ragIndex) : readJson(args.index);
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
