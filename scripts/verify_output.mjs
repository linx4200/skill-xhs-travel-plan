#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_PATTERNS = ["资料来源", "餐饮节奏", "占位图", "placeholder", "http://", "https://", "<script", "<iframe"];

/**
 * 解析命令行参数，得到需要校验的 HTML 输出目录。
 */
function parseArgs(argv) {
  if (argv.length !== 1) {
    throw new Error("Usage: node scripts/verify_output.mjs <output_dir>");
  }
  return { outDir: argv[0] };
}

/**
 * 以 UTF-8 读取文本文件内容。
 */
function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/**
 * 列出输出目录中匹配指定文件名模式的 HTML 文件。
 */
function htmlFiles(outDir, pattern = /\.html$/) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((name) => pattern.test(name))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((name) => path.join(outDir, name));
}

/**
 * 判断 href/src 指向的本地目标是否存在；远程 URL 和锚点视为非本地目标。
 */
function localTargetExists(outDir, value) {
  if (value.startsWith("#")) return true;
  let parsed;
  try {
    parsed = new URL(value, "file:///");
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return true;
  const targetPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  return fs.existsSync(path.join(outDir, targetPath));
}

/**
 * 从 HTML 文本中提取 href 和 src 链接，供存在性校验使用。
 */
function extractLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\s(href|src)="([^"]+)"/g)) {
    links.push({ kind: match[1], value: match[2] });
  }
  return links;
}

/**
 * 校验单个 HTML 文件的 CSS、viewport、禁用内容和本地链接目标。
 */
function verifyFile(filePath, outDir, errors) {
  const text = read(filePath);
  const name = path.basename(filePath);
  if (!text.includes('<link rel="stylesheet" href="reading-first.css">')) {
    errors.push(`${name}: missing reading-first.css link`);
  }
  if (!text.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0">')) {
    errors.push(`${name}: missing viewport meta`);
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (text.includes(pattern)) errors.push(`${name}: forbidden pattern found: ${pattern}`);
  }
  for (const { kind, value } of extractLinks(text)) {
    if (kind === "src" && !value.startsWith("assets/photos/")) {
      errors.push(`${name}: image source is not under assets/photos/: ${value}`);
    }
    if (!localTargetExists(outDir, value)) {
      errors.push(`${name}: missing linked target: ${value}`);
    }
  }
}

/**
 * 校验首页特有规则，例如无 page-nav、包含生成时间和链接到每日页。
 */
function verifyIndex(outDir, errors) {
  const indexPath = path.join(outDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    errors.push("missing index.html");
    return;
  }
  const text = read(indexPath);
  if (text.includes('nav class="page-nav"')) errors.push("index.html: must not contain nav.page-nav");
  if (!/生成时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) errors.push("index.html: missing generated time");
  if (!text.includes('<ol class="timeline">')) errors.push("index.html: missing ol.timeline");
  if (/<a href="day-\d{2}\.html"><strong>.*?<\/strong><\/a>\s*<p>.*?<\/p>\s*<ul>/s.test(text)) {
    errors.push("index.html: day timeline must not contain detail ul lists");
  }
  for (const dayFile of htmlFiles(outDir, /^day-\d{2}\.html$/)) {
    const name = path.basename(dayFile);
    if (!text.includes(`href="${name}"`)) errors.push(`index.html: missing link to ${name}`);
  }
}

/**
 * 校验每日详情页特有规则，例如顶部/底部导航和 timeline 结构。
 */
function verifyDayPages(outDir, errors) {
  for (const filePath of htmlFiles(outDir, /^day-\d{2}\.html$/)) {
    const text = read(filePath);
    const name = path.basename(filePath);
    if ((text.match(/nav class="page-nav"/g) ?? []).length < 2) {
      errors.push(`${name}: expected top and bottom page-nav`);
    }
    if (!text.includes('<ol class="timeline">')) errors.push(`${name}: missing ol.timeline`);
  }
}

/**
 * 校验城市详情页特有规则，例如返回首页链接和首页城市页入口。
 */
function verifyCityPages(outDir, errors) {
  const indexPath = path.join(outDir, "index.html");
  const index = fs.existsSync(indexPath) ? read(indexPath) : "";
  for (const filePath of htmlFiles(outDir, /^city-\d{2}\.html$/)) {
    const text = read(filePath);
    const name = path.basename(filePath);
    if (!text.includes('href="index.html"')) errors.push(`${name}: missing return-home link`);
    if (!index.includes(`href="${name}"`)) errors.push(`index.html: missing link to ${name}`);
  }
}

/**
 * 命令行入口：汇总执行所有输出校验，并用退出码表示成功或失败。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir);
  const errors = [];
  if (!fs.existsSync(outDir)) {
    errors.push(`output directory does not exist: ${outDir}`);
  } else {
    for (const filePath of htmlFiles(outDir)) verifyFile(filePath, outDir, errors);
    verifyIndex(outDir, errors);
    verifyDayPages(outDir, errors);
    verifyCityPages(outDir, errors);
  }

  if (errors.length) {
    console.log("Verification failed:");
    for (const error of errors) console.log(`- ${error}`);
    process.exit(1);
  }
  console.log(`Verification passed for ${outDir}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
