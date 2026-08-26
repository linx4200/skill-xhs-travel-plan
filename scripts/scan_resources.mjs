#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const TEXT_EXTS = new Set([".json", ".md", ".markdown", ".txt"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]);
const UTILITY_KEYWORDS = [
  "门票",
  "预约",
  "停车",
  "入口",
  "游客中心",
  "营业",
  "开放",
  "排队",
  "游船",
  "索道",
  "徒步",
  "老人",
  "小孩",
  "高反",
  "温差",
  "避坑",
  "安全",
  "美食",
  "住宿",
];

/**
 * 解析命令行参数，得到素材目录、输出路径、结构化路线和显式传入的景点名/城市名列表。
 */
function parseArgs(argv) {
  const args = { places: [], cities: [], routeJson: "", out: "resource-index.json", resourceDir: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--route-json") {
      args.routeJson = argv[++i];
    } else if (arg === "--place") {
      args.places.push(argv[++i]);
    } else if (arg === "--city") {
      args.cities.push(argv[++i]);
    } else if (!args.resourceDir) {
      args.resourceDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!args.resourceDir) {
    throw new Error(
      "Usage: node scripts/scan_resources.mjs <resource_dir> [-o resource-index.json] [--route-json route-structure.json] [--place 景点名] [--city 城市名]",
    );
  }
  return args;
}

/**
 * 读取并解析 JSON 文件。
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * 把路线结构中的字符串或字符串数组字段规范成数组，忽略对象等非名称值。
 */
function asNameList(value) {
  if (value === null || value === undefined || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
    .filter(Boolean);
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
 * 从 agent 已生成的 route-structure.json 提取候选景点和城市。
 */
function termsFromRoute(routeJsonPath) {
  if (!routeJsonPath) return { places: [], cities: [] };
  const route = readJson(routeJsonPath);
  const places = [];
  for (const day of Array.isArray(route.days) ? route.days : []) {
    places.push(...asNameList(day.route_places ?? day.places));
  }
  places.push(...asNameList(route.route_places ?? route.places));

  return {
    places: uniqueStrings(places),
    cities: uniqueStrings(asNameList(route.cities)),
  };
}

/**
 * 读取文本文件，并按常见中文文本编码尝试解码成字符串。
 */
function decodeText(filePath) {
  const buffer = fs.readFileSync(filePath);
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
      // Try the next likely text encoding.
    }
  }
  return new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
}

/**
 * 在 JSON 对象或数组中递归查找可作为素材标题的字段。
 */
function findJsonTitle(data) {
  if (Array.isArray(data)) {
    for (const item of data.slice(0, 5)) {
      const title = findJsonTitle(item);
      if (title) return title;
    }
    return "";
  }
  if (data && typeof data === "object") {
    for (const key of ["title", "display_title", "name", "desc", "description"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    for (const value of Object.values(data)) {
      const title = findJsonTitle(value);
      if (title) return title;
    }
  }
  return "";
}

/**
 * 为文本素材推断标题；JSON 优先取标题字段，普通文本取第一行非空内容。
 */
function guessTitle(filePath, text) {
  if (path.extname(filePath).toLowerCase() === ".json") {
    try {
      const title = findJsonTitle(JSON.parse(text));
      if (title) return title.slice(0, 120);
    } catch {
      // Fall back to first non-empty line.
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^#+/, "").trim();
    if (cleaned) return cleaned.slice(0, 120);
  }
  return path.basename(filePath, path.extname(filePath));
}

/**
 * 压缩文本空白并截取短摘录，用于索引预览而不是事实抽取。
 */
function compactExcerpt(text, limit = 180) {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * 根据文件扩展名生成素材类型标记，例如 json-note 或 md-note。
 */
function kindFor(filePath) {
  const suffix = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return suffix ? `${suffix}-note` : "text-note";
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
 * 合并用户显式传入的景点名和 photos/ 下的目录名，作为候选地点词表。
 */
function collectPlaces(root, explicitPlaces) {
  const places = new Set(explicitPlaces.map((place) => place.trim()).filter(Boolean));
  const photosRoot = path.join(root, "photos");
  if (fs.existsSync(photosRoot)) {
    for (const entry of fs.readdirSync(photosRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) places.add(entry.name);
    }
  }
  return [...places].sort((a, b) => b.length - a.length || a.localeCompare(b, "zh-CN"));
}

/**
 * 清理并排序城市候选词；城市不混入景点候选字段。
 */
function collectCities(explicitCities) {
  const cities = new Set(explicitCities.map((city) => city.trim()).filter(Boolean));
  return [...cities].sort((a, b) => b.length - a.length || a.localeCompare(b, "zh-CN"));
}

/**
 * 扫描 photos/ 目录，把本地照片按景点目录归属整理成索引。
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
 * 扫描输入材料目录，输出文本素材索引、候选关键词匹配和照片索引。
 */
function scan(resourceDir, explicitPlaces, explicitCities) {
  const root = path.resolve(resourceDir);
  const places = collectPlaces(root, explicitPlaces);
  const cities = collectCities(explicitCities);
  const files = [];

  for (const filePath of walk(root)) {
    if (!TEXT_EXTS.has(path.extname(filePath).toLowerCase())) continue;
    const text = decodeText(filePath);
    const rel = toPosix(path.relative(root, filePath));
    const matchedPlaces = places.filter((place) => place && (text.includes(place) || rel.includes(place)));
    const matchedCities = cities.filter((city) => city && (text.includes(city) || rel.includes(city)));
    const matchedKeywords = UTILITY_KEYWORDS.filter((word) => text.includes(word));
    files.push({
      path: rel,
      title: guessTitle(filePath, text),
      kind: kindFor(filePath),
      char_count: text.length,
      keywords: [...new Set([...matchedPlaces, ...matchedCities, ...matchedKeywords])].sort((a, b) => a.localeCompare(b, "zh-CN")),
      candidate_places: matchedPlaces,
      candidate_cities: matchedCities,
      excerpt: compactExcerpt(text),
    });
  }

  return {
    resource_root: root,
    files,
    photos: scanPhotos(root),
  };
}

/**
 * 命令行入口：解析参数、执行扫描并写出 resource-index.json。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const routeTerms = termsFromRoute(args.routeJson);
  const index = scan(args.resourceDir, [...routeTerms.places, ...args.places], [...routeTerms.cities, ...args.cities]);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const photoCount = Object.values(index.photos).reduce((sum, items) => sum + items.length, 0);
  console.log(`Indexed ${index.files.length} text files and ${photoCount} photos into ${args.out}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
