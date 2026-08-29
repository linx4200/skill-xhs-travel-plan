#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * 解析命令行参数，得到素材索引、事实工作区和读取队列输出路径。
 */
function parseArgs(argv) {
  const args = {
    index: "resource-index.json",
    facts: "facts-workspace.json",
    out: "reading-queue.json",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--index") args.index = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.index || !args.facts) {
    throw new Error(
      "Usage: node scripts/create_reading_queue.mjs --index <resource-index.json> --facts <facts-workspace.json> [-o reading-queue.json]",
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
 * 把当前系统路径分隔符转换为 POSIX 分隔符，保证 JSON 中路径稳定。
 */
function toPosix(value) {
  return String(value ?? "").split(path.sep).join("/");
}

/**
 * 生成地点名的轻量别名，用于判断“九洞天景区”和“九洞天”这类明显同指名称。
 */
function nameAliases(name) {
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
 * 判断素材索引中的候选名和 facts 目标名是否足够明确地相关。
 */
function relatedName(left, right) {
  for (const a of nameAliases(left)) {
    for (const b of nameAliases(right)) {
      if (a === b || a.includes(b) || b.includes(a)) return true;
    }
  }
  return false;
}

/**
 * 根据素材索引元数据给 consumer 标注来源原因。
 */
function reasonForConsumer(type, name, meta) {
  if (!meta) return "missing_index_entry";
  if (type === "place" && (meta.candidate_places ?? []).some((candidate) => relatedName(name, candidate))) return "candidate_place";
  if (type === "city" && (meta.candidate_cities ?? []).includes(name)) return "candidate_city";
  if (nameAliases(name).some((alias) => meta.path?.includes(alias))) return "path_match";
  if (nameAliases(name).some((alias) => meta.title?.includes(alias))) return "title_match";
  return "source_file";
}

/**
 * 以 path 为 key 建立素材索引查询表。
 */
function indexByPath(index) {
  const result = new Map();
  for (const item of index.files ?? []) {
    if (item?.path) result.set(toPosix(item.path), item);
  }
  return result;
}

/**
 * 收集 places.*.source_files 和 cities.*.source_files 中的全部引用。
 */
function collectSourceRefs(facts) {
  const refs = [];
  for (const [name, place] of Object.entries(facts.places ?? {})) {
    for (const sourcePath of asList(place?.source_files)) {
      const cleanPath = toPosix(String(sourcePath ?? "").trim());
      if (cleanPath) refs.push({ path: cleanPath, type: "place", name });
    }
  }
  for (const [name, city] of Object.entries(facts.cities ?? {})) {
    for (const sourcePath of asList(city?.source_files)) {
      const cleanPath = toPosix(String(sourcePath ?? "").trim());
      if (cleanPath) refs.push({ path: cleanPath, type: "city", name });
    }
  }
  return refs;
}

/**
 * 按唯一文件构建 agent 阅读队列，并聚合每个文件服务的地点和城市。
 */
function buildQueue(index, facts, sourcePaths) {
  const metas = indexByPath(index);
  const filesByPath = new Map();
  let repeatedSourceChars = 0;

  for (const ref of collectSourceRefs(facts)) {
    const meta = metas.get(ref.path);
    repeatedSourceChars += Number(meta?.char_count ?? 0);
    if (!filesByPath.has(ref.path)) {
      filesByPath.set(ref.path, {
        path: ref.path,
        title: String(meta?.title ?? ""),
        kind: String(meta?.kind ?? ""),
        char_count: Number(meta?.char_count ?? 0),
        consumers: [],
        candidate_places: uniqueStrings(asList(meta?.candidate_places)),
        candidate_cities: uniqueStrings(asList(meta?.candidate_cities)),
        keywords: uniqueStrings(asList(meta?.keywords)),
        priority: "secondary",
      });
    }
    const item = filesByPath.get(ref.path);
    const reason = reasonForConsumer(ref.type, ref.name, meta);
    if (!item.consumers.some((consumer) => consumer.type === ref.type && consumer.name === ref.name)) {
      item.consumers.push({ type: ref.type, name: ref.name, reason });
    }
    if (ref.type === "place") item.priority = "primary";
  }

  const files = [...filesByPath.values()];
  const uniqueSourceChars = files.reduce((sum, item) => sum + item.char_count, 0);
  const sourceRefs = collectSourceRefs(facts).length;
  const missingIndexFiles = files.filter((item) => !metas.has(item.path)).map((item) => item.path);

  return {
    schema_version: 1,
    needs_agent_review: true,
    source: {
      resource_root: index.resource_root ?? facts.source?.resource_root ?? "",
      resource_index: sourcePaths.index,
      facts_workspace: sourcePaths.facts,
    },
    stats: {
      source_refs: sourceRefs,
      unique_files: files.length,
      unique_source_chars: uniqueSourceChars,
      repeated_source_chars: repeatedSourceChars,
      read_amplification: uniqueSourceChars > 0 ? Number((repeatedSourceChars / uniqueSourceChars).toFixed(2)) : 0,
      missing_index_files: missingIndexFiles.length,
    },
    files,
  };
}

/**
 * 命令行入口：读取 resource-index.json 和 facts-workspace.json，生成去重后的原文读取队列。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = readJson(args.index);
  const facts = readJson(args.facts);
  const queue = buildQueue(index, facts, {
    index: path.basename(args.index),
    facts: path.basename(args.facts),
  });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  console.log(`Created reading queue with ${queue.stats.unique_files} unique files from ${queue.stats.source_refs} source refs.`);
  console.log(
    `Unique source chars: ${queue.stats.unique_source_chars}. Repeated source chars: ${queue.stats.repeated_source_chars}. Estimated read amplification: ${queue.stats.read_amplification.toFixed(2)}x.`,
  );
  if (queue.stats.missing_index_files > 0) {
    console.log(`Warning: ${queue.stats.missing_index_files} queued files were not found in the resource index.`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
