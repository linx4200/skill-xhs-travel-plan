#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
export function htmlFiles(outDir, pattern = /\.html$/) {
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
export function localTargetExists(outDir, value) {
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
export function extractLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\s(href|src)="([^"]+)"/g)) {
    links.push({ kind: match[1], value: match[2] });
  }
  return links;
}

/**
 * 校验单个 HTML 文件的远程资源和本地链接目标。
 */
function verifyFile(filePath, outDir, result) {
  const text = read(filePath);
  const name = path.basename(filePath);
  for (const { kind, value } of extractLinks(text)) {
    if (/^https?:\/\//i.test(value)) {
      result.remoteResources.push({ file: name, kind, value });
      result.verifyErrors.push(`${name}: remote resource found: ${value}`);
    }
    if (!localTargetExists(outDir, value)) {
      const item = { file: name, kind, value };
      result.brokenLinks.push(item);
      if (kind === "src") result.missingPhotos.push(item);
      result.verifyErrors.push(`${name}: missing linked target: ${value}`);
    }
  }
}

/**
 * 校验输出目录中最基础的入口文件存在性。
 */
function verifyIndex(outDir, result) {
  const indexPath = path.join(outDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    result.verifyErrors.push("missing index.html");
  }
}

/**
 * 执行输出校验，并返回 CLI 和评估脚本共用的结构化结果。
 */
export function verifyOutput(outDirInput) {
  const outDir = path.resolve(outDirInput);
  const result = {
    forbidden: [],
    brokenLinks: [],
    missingPhotos: [],
    remoteResources: [],
    verifyErrors: [],
  };
  if (!fs.existsSync(outDir)) {
    result.verifyErrors.push(`output directory does not exist: ${outDir}`);
  } else {
    for (const filePath of htmlFiles(outDir)) verifyFile(filePath, outDir, result);
    verifyIndex(outDir, result);
  }
  return result;
}

/**
 * 命令行入口：汇总执行所有输出校验，并用退出码表示成功或失败。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir);
  const result = verifyOutput(outDir);

  if (result.verifyErrors.length) {
    console.log("Verification failed:");
    for (const error of result.verifyErrors) console.log(`- ${error}`);
    process.exit(1);
  }
  console.log(`Verification passed for ${outDir}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
