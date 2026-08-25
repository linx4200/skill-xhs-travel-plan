#!/usr/bin/env node
import ejs from "ejs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * 解析命令行参数，得到事实工作区 JSON、输出目录和 skill 根目录。
 */
function parseArgs(argv) {
  const args = { factsJson: "", outDir: "", skillRoot: DEFAULT_SKILL_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--out-dir") args.outDir = argv[++i];
    else if (arg === "--skill-root") args.skillRoot = argv[++i];
    else if (!args.factsJson) args.factsJson = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.factsJson || !args.outDir) {
    throw new Error("Usage: node scripts/render_travel_html.mjs <facts-workspace.json> -o <output_dir> [--skill-root <skill_root>]");
  }
  return args;
}

/**
 * 转义 HTML 特殊字符，供 EJS <%= %> 使用。
 */
function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

/**
 * 把空值、单值或数组统一规范成数组，方便后续渲染列表。
 */
function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 从字符串或结构化对象中取出适合展示的文本内容。
 */
function textOf(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    for (const key of ["text", "summary", "name", "title"]) {
      if (item[key]) return String(item[key]);
    }
    return JSON.stringify(item);
  }
  return String(item);
}

/**
 * 把任意列表字段规范成模板可以直接遍历的文本数组。
 */
function textList(value) {
  return asList(value)
    .map(textOf)
    .filter((text) => text.trim());
}

/**
 * 把当前系统路径分隔符转换为 POSIX 分隔符，供 HTML src/href 使用。
 */
function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * 将事实工作区引用的本地照片复制到输出目录，并返回相对图片路径。
 */
function copyPhoto(photo, place, resourceRoot, outDir) {
  let source = String(photo);
  if (!path.isAbsolute(source)) source = path.join(resourceRoot, source);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return "";
  const dest = path.join(outDir, "assets", "photos", place, path.basename(source));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  return toPosix(path.relative(outDir, dest));
}

/**
 * 从事实工作区中过滤出 include=true、需要生成城市页的城市。
 */
function includedCities(facts) {
  return Object.entries(facts.cities ?? {}).filter(([, data]) => data.include);
}

/**
 * 根据每日行程对象生成页面标题和首页 Day 链接标题。
 */
function dayTitle(day) {
  const no = day.day ?? "";
  const fallback = [day.date, (day.route_places ?? []).join(" / ")].filter(Boolean).join("｜");
  const title = day.title || fallback;
  return no ? `Day ${no}｜${title}` : String(title);
}

/**
 * 生成详情页导航链接；每日页会根据天数补上一天和下一天链接。
 */
function navLinks(dayNo, totalDays) {
  const links = [{ href: "index.html", label: "返回首页" }];
  if (dayNo && dayNo > 1) links.push({ href: `day-${String(dayNo - 1).padStart(2, "0")}.html`, label: "上一天" });
  if (dayNo && totalDays && dayNo < totalDays) {
    links.push({ href: `day-${String(dayNo + 1).padStart(2, "0")}.html`, label: "下一天" });
  }
  return links;
}

/**
 * 把行程顺序项规范成 timeline 模板数据。
 */
function timelineItems(items, fallbackTitle = "") {
  const rows = [];
  for (const item of asList(items)) {
    let label = "";
    let summary = "";
    let details = [];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      label = item.title || item.time || item.place || fallbackTitle;
      summary = item.summary || item.text || "";
      details = textList(item.details ?? []);
    } else {
      label = fallbackTitle || textOf(item);
      summary = textOf(item);
    }
    if (!label && !summary) continue;
    rows.push({ label, summary, details });
  }
  return rows;
}

/**
 * 渲染整体注意事项；支持普通列表或按小节名分组的对象。
 */
function noteGroups(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([title, items]) => ({ title, items: textList(items) }))
      .filter((group) => group.items.length);
  }
  const items = textList(value);
  return items.length ? [{ title: "", items }] : [];
}

/**
 * 整理某个景点的照片区；不存在的照片会被跳过，不生成占位内容。
 */
function preparePhotos(place, photos, resourceRoot, outDir) {
  const prepared = [];
  for (const photo of asList(photos).slice(0, 3)) {
    const photoPath = textOf(photo);
    const rel = copyPhoto(photoPath, place, resourceRoot, outDir);
    if (!rel) continue;
    const stem = path.basename(photoPath, path.extname(photoPath));
    const alt = stem ? `${place}${stem}` : place;
    prepared.push({ src: rel, alt, caption: `${alt}。` });
  }
  return prepared;
}

/**
 * 整理单个景点详情，包括简介、看点、实用信息、注意事项和照片。
 */
function preparePlace(name, data, resourceRoot, outDir) {
  const groups = [];
  for (const [title, key] of [
    ["看点", "highlights"],
    ["缺点", "drawbacks"],
    ["营业时间", "opening_hours"],
    ["门票与优惠", "tickets"],
    ["推荐游玩线路", "routes"],
    ["不同玩法/游玩方式", "play_options"],
    ["交通与实用信息", "practical_info"],
    ["注意事项", "notes"],
    ["冲突信息", "conflicts"],
  ]) {
    const items = textList(data[key] ?? []);
    if (items.length) groups.push({ title, items });
  }

  const photos = preparePhotos(name, data.photos ?? [], resourceRoot, outDir);
  const place = {
    name,
    summary: data.summary || "",
    groups,
    duration: data.duration || "",
    photos,
  };
  const hasContent = place.summary || place.groups.length || place.duration || place.photos.length;
  return hasContent ? place : null;
}

/**
 * 使用 EJS 模板渲染页面。
 */
function renderTemplate(skillRoot, templateName, data) {
  const templatePath = path.join(skillRoot, "templates", "travel-html", templateName);
  const template = fs.readFileSync(templatePath, "utf8");
  return ejs.render(template, data, {
    escape: esc,
    filename: templatePath,
    rmWhitespace: false,
  });
}

/**
 * 准备首页 index.html 的模板数据。
 */
function prepareIndex(facts) {
  const days = (facts.trip?.days ?? []).map((day, index) => {
    const no = Number(day.day || index + 1);
    return {
      href: `day-${String(no).padStart(2, "0")}.html`,
      title: dayTitle(day),
      summary: day.summary || "当天细节见详情页。",
    };
  });
  const cities = includedCities(facts).map(([city, data], index) => ({
    href: `city-${String(index + 1).padStart(2, "0")}.html`,
    name: city,
    summary: data.summary || "城市级信息见详情页",
  }));
  return {
    title: facts.title || "旅行攻略",
    days,
    cities,
    globalNotes: noteGroups(facts.global_notes ?? []),
    confirmBeforeDeparture: textList(facts.confirm_before_departure ?? []),
    generatedAt: facts.generated_at || new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16),
  };
}

/**
 * 准备单个每日详情页的模板数据。
 */
function prepareDay(day, facts, resourceRoot, outDir, totalDays) {
  const no = Number(day.day || 1);
  const places = [];
  for (const place of day.places ?? day.route_places ?? []) {
    const prepared = preparePlace(place, facts.places?.[place] ?? {}, resourceRoot, outDir);
    if (prepared) places.push(prepared);
  }
  return {
    title: dayTitle(day),
    navLinks: navLinks(no, totalDays),
    timeline: timelineItems(day.timeline?.length ? day.timeline : [day.summary || day.title], day.title || ""),
    places,
    notes: [...textList(day.notes ?? []), ...textList(day.confirmations ?? [])],
  };
}

/**
 * 准备单个城市详情页的模板数据。
 */
function prepareCity(name, data) {
  const groups = [];
  for (const [title, key] of [
    ["备选景点库", "backup_places"],
    ["美食", "foods"],
    ["住宿建议", "lodging"],
    ["城市交通", "transport"],
    ["购物或伴手礼", "shopping"],
    ["城市级注意事项", "notes"],
  ]) {
    const items = textList(data[key] ?? []);
    if (items.length) groups.push({ title, items });
  }
  return {
    title: name,
    overview: textList(data.overview?.length ? data.overview : data.summary),
    groups,
  };
}

/**
 * 执行完整渲染流程：复制 CSS、生成首页、每日页、城市页和照片资源。
 */
function render(facts, outDir, skillRoot) {
  fs.mkdirSync(outDir, { recursive: true });
  const cssSource = path.join(skillRoot, "templates", "travel-html", "reading-first.css");
  if (!fs.existsSync(cssSource)) {
    throw new Error(`Missing template stylesheet: ${cssSource}`);
  }
  fs.copyFileSync(cssSource, path.join(outDir, "reading-first.css"));
  let resourceRoot = facts.source?.resource_root || ".";
  if (!path.isAbsolute(resourceRoot)) resourceRoot = path.resolve(skillRoot, resourceRoot);

  fs.writeFileSync(path.join(outDir, "index.html"), renderTemplate(skillRoot, "index.ejs", prepareIndex(facts)), "utf8");
  const days = facts.trip?.days ?? [];
  days.forEach((day, index) => {
    if (!day.day) day.day = index + 1;
    const filename = `day-${String(Number(day.day)).padStart(2, "0")}.html`;
    const html = renderTemplate(skillRoot, "day.ejs", prepareDay(day, facts, resourceRoot, outDir, days.length));
    fs.writeFileSync(path.join(outDir, filename), html, "utf8");
  });
  includedCities(facts).forEach(([city, data], index) => {
    const filename = `city-${String(index + 1).padStart(2, "0")}.html`;
    fs.writeFileSync(path.join(outDir, filename), renderTemplate(skillRoot, "city.ejs", prepareCity(city, data)), "utf8");
  });
}

/**
 * 命令行入口：读取 facts-workspace.json 并生成静态 HTML 输出目录。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const facts = JSON.parse(fs.readFileSync(args.factsJson, "utf8"));
  render(facts, path.resolve(args.outDir), path.resolve(args.skillRoot));
  console.log(`Rendered travel HTML into ${args.outDir}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
