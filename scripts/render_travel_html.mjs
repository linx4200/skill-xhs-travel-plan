#!/usr/bin/env node
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
 * 转义 HTML 特殊字符，避免正文内容破坏页面结构。
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
 * 把一组文本或对象渲染成 HTML 无序列表；空列表返回空字符串。
 */
function htmlList(items) {
  const rows = asList(items)
    .map(textOf)
    .filter((text) => text.trim())
    .map((text) => `        <li>${esc(text)}</li>`);
  return rows.length ? `<ul>\n${rows.join("\n")}\n      </ul>` : "";
}

/**
 * 渲染符合 reading-first.css 结构约定的可折叠 section。
 */
function section(title, body, level = 2, open = true) {
  if (!body.trim()) return "";
  const attr = open ? " open" : "";
  return (
    "  <section>\n" +
    `    <details${attr}>\n` +
    `      <summary><h${level}>${esc(title)}</h${level}></summary>\n` +
    `${body.trimEnd()}\n` +
    "    </details>\n" +
    "  </section>\n"
  );
}

/**
 * 包装完整 HTML 页面骨架，包含 meta、title、CSS 链接和 h1。
 */
function page(title, body) {
  return (
    "<!doctype html>\n" +
    '<html lang="zh-CN">\n' +
    "<head>\n" +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `  <title>${esc(title)}</title>\n` +
    '  <link rel="stylesheet" href="reading-first.css">\n' +
    "</head>\n" +
    "<body>\n" +
    `  <h1>${esc(title)}</h1>\n\n` +
    `${body.trimEnd()}\n` +
    "</body>\n" +
    "</html>\n"
  );
}

/**
 * 渲染详情页导航；每日页会根据天数补上一天和下一天链接。
 */
function nav(dayNo, totalDays) {
  const links = ['    <a href="index.html">返回首页</a>'];
  if (dayNo && dayNo > 1) links.push(`    <a href="day-${String(dayNo - 1).padStart(2, "0")}.html">上一天</a>`);
  if (dayNo && totalDays && dayNo < totalDays) {
    links.push(`    <a href="day-${String(dayNo + 1).padStart(2, "0")}.html">下一天</a>`);
  }
  return `<nav class="page-nav" aria-label="页面导航">\n${links.join("\n")}\n  </nav>\n`;
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
 * 把行程顺序项渲染成 ol.timeline 结构，用于首页和每日详情页。
 */
function timeline(items, fallbackTitle = "") {
  const rows = [];
  for (const item of asList(items)) {
    let label = "";
    let summary = "";
    let details = "";
    if (item && typeof item === "object" && !Array.isArray(item)) {
      label = item.title || item.time || item.place || fallbackTitle;
      summary = item.summary || item.text || "";
      details = htmlList(item.details ?? []);
    } else {
      label = fallbackTitle || textOf(item);
      summary = textOf(item);
    }
    if (!label && !summary) continue;
    rows.push(
      "        <li>\n" +
        `          <strong>${esc(label)}</strong>\n` +
        (summary ? `          <p>${esc(summary)}</p>\n` : "") +
        (details ? `${details.replace("<ul>", "          <ul>").replace("</ul>", "          </ul>")}\n` : "") +
        "        </li>",
    );
  }
  return rows.length ? `      <ol class="timeline">\n${rows.join("\n")}\n      </ol>` : "";
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
 * 渲染某个景点的照片区；不存在的照片会被跳过，不生成占位内容。
 */
function renderPhotos(place, photos, resourceRoot, outDir) {
  const figures = [];
  for (const photo of asList(photos).slice(0, 3)) {
    const photoPath = textOf(photo);
    const rel = copyPhoto(photoPath, place, resourceRoot, outDir);
    if (!rel) continue;
    const stem = path.basename(photoPath, path.extname(photoPath));
    const alt = stem ? `${place}${stem}` : place;
    figures.push(
      '          <figure class="photo">\n' +
        `            <img src="${esc(rel)}" alt="${esc(alt)}" loading="lazy">\n` +
        `            <figcaption>${esc(alt)}。</figcaption>\n` +
        "          </figure>",
    );
  }
  if (!figures.length) return "";
  if (figures.length === 1) return `        <h4>照片</h4>\n${figures[0]}\n`;
  return `        <h4>照片</h4>\n        <div class="photo-grid">\n${figures.join("\n")}\n        </div>\n`;
}

/**
 * 渲染单个景点详情，包括简介、看点、实用信息、注意事项和照片。
 */
function renderPlace(name, data, resourceRoot, outDir) {
  const chunks = [];
  if (data.summary) chunks.push(`        <p>${esc(data.summary)}</p>`);
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
    const body = htmlList(data[key] ?? []);
    if (body) chunks.push(`        <h4>${esc(title)}</h4>\n${body}`);
  }
  if (data.duration) chunks.push(`        <h4>建议游玩时长</h4>\n        <p>${esc(data.duration)}</p>`);
  chunks.push(renderPhotos(name, data.photos ?? [], resourceRoot, outDir).trimEnd());
  const body = chunks.filter((chunk) => chunk.trim()).join("\n");
  if (!body) return "";
  return (
    "      <section>\n" +
    "        <details open>\n" +
    `          <summary><h3>${esc(name)}</h3></summary>\n` +
    `${body}\n` +
    "        </details>\n" +
    "      </section>"
  );
}

/**
 * 从事实工作区中过滤出 include=true、需要生成城市页的城市。
 */
function includedCities(facts) {
  return Object.entries(facts.cities ?? {}).filter(([, data]) => data.include);
}

/**
 * 渲染整体注意事项；支持普通列表或按小节名分组的对象。
 */
function renderNoteGroups(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([title, items]) => {
        const body = htmlList(items);
        return body ? `      <h3>${esc(title)}</h3>\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return htmlList(value);
}

/**
 * 渲染首页 index.html，只包含总览、城市汇总、整体提醒和生成时间。
 */
function renderIndex(facts) {
  const days = facts.trip?.days ?? [];
  const cityItems = includedCities(facts).map(([city, data], index) => {
    const filename = `city-${String(index + 1).padStart(2, "0")}.html`;
    const summary = data.summary || "城市级信息见详情页";
    return `        <li><a href="${filename}">${esc(city)}</a>：${esc(summary)}</li>`;
  });
  const dayRows = days.map((day, index) => {
    const no = Number(day.day || index + 1);
    const title = dayTitle(day);
    const summary = day.summary || "当天细节见详情页。";
    return (
      "        <li>\n" +
      `          <a href="day-${String(no).padStart(2, "0")}.html"><strong>${esc(title)}</strong></a>\n` +
      `          <p>${esc(summary)}</p>\n` +
      "        </li>"
    );
  });
  let body = section("每日行程安排", `      <ol class="timeline">\n${dayRows.join("\n")}\n      </ol>`);
  body += section("城市汇总", cityItems.length ? `<ul>\n${cityItems.join("\n")}\n      </ul>` : "");
  body += section("整体注意事情", renderNoteGroups(facts.global_notes ?? []));
  body += section("出行前确认清单", htmlList(facts.confirm_before_departure ?? []));
  const generatedAt = facts.generated_at || new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
  body += `  <p class="meta">生成时间：${esc(generatedAt)}</p>\n`;
  return page(facts.title || "旅行攻略", body);
}

/**
 * 渲染单个每日详情页，包含导航、当日 timeline、景点详情和当天提醒。
 */
function renderDay(day, facts, resourceRoot, outDir, totalDays) {
  const no = Number(day.day || 1);
  let body = `${nav(no, totalDays)}\n`;
  body += section("当日行程安排", timeline(day.timeline?.length ? day.timeline : [day.summary || day.title], day.title || ""));
  const placeChunks = [];
  for (const place of day.places ?? day.route_places ?? []) {
    const rendered = renderPlace(place, facts.places?.[place] ?? {}, resourceRoot, outDir);
    if (rendered) placeChunks.push(rendered);
  }
  body += section("当日景点详细信息", placeChunks.join("\n"));
  body += section("当日注意事项/确认事项", htmlList(day.notes ?? []) + htmlList(day.confirmations ?? []));
  body += `\n${nav(no, totalDays)}`;
  return page(dayTitle(day), body);
}

/**
 * 渲染单个城市详情页，只输出通过独立增量价值判断后的城市级信息。
 */
function renderCity(name, data) {
  let body = '<nav class="page-nav" aria-label="页面导航">\n    <a href="index.html">返回首页</a>\n  </nav>\n\n';
  const overview = asList(data.overview?.length ? data.overview : data.summary)
    .map(textOf)
    .filter((text) => text.trim())
    .map((text) => `      <p>${esc(text)}</p>`)
    .join("\n");
  body += section("城市概览", overview);
  for (const [title, key] of [
    ["备选景点库", "backup_places"],
    ["美食", "foods"],
    ["住宿建议", "lodging"],
    ["城市交通", "transport"],
    ["购物或伴手礼", "shopping"],
    ["城市级注意事项", "notes"],
  ]) {
    body += section(title, htmlList(data[key] ?? []));
  }
  return page(name, body);
}

/**
 * 执行完整渲染流程：复制 CSS、生成首页、每日页、城市页和照片资源。
 */
function render(facts, outDir, skillRoot) {
  fs.mkdirSync(outDir, { recursive: true });
  const cssSource = path.join(skillRoot, "reading-first.css");
  if (fs.existsSync(cssSource)) fs.copyFileSync(cssSource, path.join(outDir, "reading-first.css"));
  let resourceRoot = facts.source?.resource_root || ".";
  if (!path.isAbsolute(resourceRoot)) resourceRoot = path.resolve(skillRoot, resourceRoot);

  fs.writeFileSync(path.join(outDir, "index.html"), renderIndex(facts), "utf8");
  const days = facts.trip?.days ?? [];
  days.forEach((day, index) => {
    if (!day.day) day.day = index + 1;
    const filename = `day-${String(Number(day.day)).padStart(2, "0")}.html`;
    fs.writeFileSync(path.join(outDir, filename), renderDay(day, facts, resourceRoot, outDir, days.length), "utf8");
  });
  includedCities(facts).forEach(([city, data], index) => {
    const filename = `city-${String(index + 1).padStart(2, "0")}.html`;
    fs.writeFileSync(path.join(outDir, filename), renderCity(city, data), "utf8");
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
