#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * 解析命令行参数，得到读取队列和 source digest 输出路径。
 */
function parseArgs(argv) {
  const args = {
    queue: "reading-queue.json",
    out: "source-digest.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--queue") args.queue = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.queue) {
    throw new Error("Usage: node scripts/create_source_digest_workspace.mjs --queue <reading-queue.json> [-o source-digest.json]");
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
 * 把空值、单值或数组统一规范成数组，方便兼容 agent 编辑过的结构。
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
 * 规范 consumers，避免 agent 或脚本中间产物带入空目标。
 */
function normalizeConsumers(consumers) {
  const result = [];
  for (const consumer of asList(consumers)) {
    const type = String(consumer?.type ?? "").trim();
    const name = String(consumer?.name ?? "").trim();
    const reason = String(consumer?.reason ?? "").trim();
    if (!type || !name) continue;
    if (!result.some((item) => item.type === type && item.name === name)) {
      result.push({ type, name, reason });
    }
  }
  return result;
}

/**
 * 根据 reading-queue.json 创建待 agent 填充的 source-digest.json 壳。
 */
function buildSourceDigest(queue, sourcePaths) {
  const files = [];
  for (const item of asList(queue.files)) {
    const filePath = String(item?.path ?? "").trim();
    if (!filePath) continue;
    files.push({
      path: filePath,
      title: String(item?.title ?? ""),
      kind: String(item?.kind ?? ""),
      char_count: Number(item?.char_count ?? 0),
      reviewed: false,
      consumers: normalizeConsumers(item?.consumers),
      candidate_places: uniqueStrings(asList(item?.candidate_places)),
      candidate_cities: uniqueStrings(asList(item?.candidate_cities)),
      keywords: uniqueStrings(asList(item?.keywords)),
      priority: String(item?.priority ?? "secondary"),
      facts: [],
      conflicts: [],
      global_notes: [],
    });
  }

  return {
    schema_version: 1,
    needs_agent_review: true,
    source: {
      resource_root: queue.source?.resource_root ?? "",
      resource_index: queue.source?.resource_index ?? "",
      facts_workspace: queue.source?.facts_workspace ?? "",
      reading_queue: sourcePaths.queue,
    },
    stats: {
      files: files.length,
      reviewed_files: 0,
      pending_files: files.length,
    },
    files,
  };
}

/**
 * 命令行入口：读取 reading-queue.json，生成待 agent 填充的文件级 digest 工作区。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const queue = readJson(args.queue);
  const digest = buildSourceDigest(queue, {
    queue: path.basename(args.queue),
  });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(digest, null, 2)}\n`, "utf8");
  console.log(`Created source digest workspace with ${digest.stats.files} file shells. Agent review is still required.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
