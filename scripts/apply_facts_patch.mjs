#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * 解析命令行参数，得到事实工作区、patch JSON 和输出路径。
 */
function parseArgs(argv) {
  const args = { facts: "", patch: "", out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--patch") args.patch = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.facts || !args.patch) {
    throw new Error("Usage: node scripts/apply_facts_patch.mjs --facts <facts-workspace.json> --patch <facts-patch.json> [-o facts-workspace.json]");
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
 * 判断值是否为普通对象。数组和 null 不参与递归合并。
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 深合并 patch。数组按整体替换，避免列表项去重或顺序被脚本猜测。
 */
function mergeDeep(base, patchValue) {
  if (!isPlainObject(base) || !isPlainObject(patchValue)) return patchValue;
  const result = { ...base };
  for (const [key, value] of Object.entries(patchValue)) {
    result[key] = key in result ? mergeDeep(result[key], value) : value;
  }
  return result;
}

/**
 * 校验 patch 没有引入 facts 顶层未知字段，防止拼错路径静默落盘。
 */
function validateTopLevelPatch(base, patchValue) {
  for (const key of Object.keys(patchValue)) {
    if (!Object.hasOwn(base, key)) {
      throw new Error(`Patch contains unknown top-level key: ${key}`);
    }
  }
}

/**
 * 命令行入口：把 agent 生成的局部 facts patch 合并回事实工作区。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const factsPath = path.resolve(args.facts);
  const patchPath = path.resolve(args.patch);
  const outPath = path.resolve(args.out || args.facts);
  const facts = readJson(factsPath);
  const patchValue = readJson(patchPath);
  validateTopLevelPatch(facts, patchValue);
  const merged = mergeDeep(facts, patchValue);
  fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Applied ${patchPath} to ${factsPath}; wrote ${outPath}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
