#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * 解析命令行参数，得到 source digest、facts 工作区和输出路径。
 */
function parseArgs(argv) {
  const args = {
    digest: "",
    facts: "",
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--digest") args.digest = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.digest || !args.facts || !args.out) {
    throw new Error("Usage: node scripts/apply_source_digest_to_facts.mjs --digest <source-digest.json> --facts <facts-workspace.json> -o <facts-workspace.json>");
  }

  return args;
}

/**
 * 读取并解析 JSON 文件。该脚本只读取 digest 和 facts，不读取原始素材目录。
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * 写出分发后的 facts 工作区。
 */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * 把空值、单值或数组统一规范成数组，兼容 agent 手工编辑后的结构。
 */
function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * 判断是否为普通对象；列表项对象和 source refs 都依赖这个分支处理。
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从字符串或对象列表项中取出可用于去重和展示的正文。
 */
function textOf(item) {
  if (isObject(item)) return String(item.text ?? item.summary ?? item.name ?? item.title ?? "").trim();
  return String(item ?? "").trim();
}

/**
 * 清理并去重字符串数组，保留第一次出现的顺序。
 */
function uniqueStrings(values) {
  const result = [];
  for (const value of asList(values)) {
    const text = String(value ?? "").trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

/**
 * 兼容对象形式和数组形式的 digest 文件列表。
 */
function digestFiles(digest) {
  if (Array.isArray(digest?.files)) return digest.files;
  if (Array.isArray(digest)) return digest;
  return [];
}

/**
 * 生成 item-level 来源引用，指向 digest 中的具体文件和 fact id。
 */
function digestSourceRef(file, fact) {
  const filePath = String(file?.path ?? "").trim();
  const factId = String(fact?.id ?? "").trim();
  return `source-digest:${filePath}${factId ? `#${factId}` : ""}`;
}

/**
 * 创建 facts-workspace 可兼容的结构化列表项。
 */
function makeSourcedItem(text, sourceRefs) {
  return {
    text,
    source_refs: uniqueStrings(sourceRefs),
  };
}

/**
 * 对已经存在的同文本列表项追加来源引用。
 */
function mergeSourceRefs(item, sourceRef) {
  const existingRefs = isObject(item) ? item.source_refs : [];
  return makeSourcedItem(textOf(item), [...uniqueStrings(existingRefs), sourceRef]);
}

/**
 * 将 digest fact.items 追加到目标数组；只按 text 去重，不做事实判断。
 */
function appendItems(target, items, sourceRef) {
  if (!Array.isArray(target)) {
    throw new Error("Target field must be an array");
  }

  let added = 0;
  let merged = 0;
  for (const item of asList(items)) {
    const text = textOf(item);
    if (!text) continue;

    const existingIndex = target.findIndex((candidate) => textOf(candidate) === text);
    if (existingIndex >= 0) {
      target[existingIndex] = mergeSourceRefs(target[existingIndex], sourceRef);
      merged += 1;
      continue;
    }

    target.push(makeSourcedItem(text, [sourceRef]));
    added += 1;
  }
  return { added, merged };
}

/**
 * 生成 day fact 可匹配的稳定 key，支持按 day 编号、日期或标题定位。
 */
function dayKeys(day) {
  return [day?.day, `day-${day?.day}`, `Day ${day?.day}`, day?.date, day?.title]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

/**
 * 在 facts.trip.days 中查找 digest 指定的 day 目标。
 */
function findDay(facts, targetName) {
  const name = String(targetName ?? "").trim();
  for (const day of asList(facts.trip?.days)) {
    if (dayKeys(day).includes(name)) return day;
  }
  return null;
}

/**
 * 确保分组形式的 global_notes 存在；已有普通列表会迁移到“通用提醒”。
 */
function ensureGlobalNotesGroup(facts, groupName) {
  const name = String(groupName || "通用提醒").trim();
  if (!isObject(facts.global_notes)) {
    const existing = asList(facts.global_notes).filter((item) => textOf(item));
    facts.global_notes = {};
    if (existing.length > 0) facts.global_notes["通用提醒"] = existing;
  }
  if (!Array.isArray(facts.global_notes[name])) facts.global_notes[name] = [];
  return facts.global_notes[name];
}

/**
 * 根据 target_type、target_name 和 field 找到 facts 中的目标数组字段。
 */
function routeFactTarget(facts, fact) {
  const targetType = String(fact?.target_type ?? "").trim();
  const targetName = String(fact?.target_name ?? "").trim();
  const field = String(fact?.field ?? "").trim();

  if (targetType === "place") {
    const place = facts.places?.[targetName];
    if (!place) throw new Error(`Unknown place target_name: ${targetName}`);
    if (!Array.isArray(place[field])) throw new Error(`Unsupported place array field: places.${targetName}.${field}`);
    return place[field];
  }

  if (targetType === "city") {
    const city = facts.cities?.[targetName];
    if (!city) throw new Error(`Unknown city target_name: ${targetName}`);
    if (!Array.isArray(city[field])) throw new Error(`Unsupported city array field: cities.${targetName}.${field}`);
    return city[field];
  }

  if (targetType === "day") {
    const day = findDay(facts, targetName);
    if (!day) throw new Error(`Unknown day target_name: ${targetName}`);
    if (!Array.isArray(day[field])) throw new Error(`Unsupported day array field: trip.days[].${field}`);
    return day[field];
  }

  if (targetType === "global") {
    if (field !== "global_notes") throw new Error(`Global fact must use field global_notes, got: ${field}`);
    if (targetName) return ensureGlobalNotesGroup(facts, targetName);
    if (!Array.isArray(facts.global_notes)) facts.global_notes = asList(facts.global_notes).filter((item) => textOf(item));
    return facts.global_notes;
  }

  if (targetType === "confirmation") {
    if (field !== "confirm_before_departure") {
      throw new Error(`Confirmation fact must use field confirm_before_departure, got: ${field}`);
    }
    if (!Array.isArray(facts.confirm_before_departure)) facts.confirm_before_departure = asList(facts.confirm_before_departure);
    return facts.confirm_before_departure;
  }

  throw new Error(`Unsupported target_type: ${targetType}`);
}

/**
 * 把已 reviewed 的 digest facts 机械分发到 facts 工作区，并统计追加/合并情况。
 */
function applyDigestToFacts(digest, facts) {
  const stats = {
    reviewed_files: 0,
    skipped_unreviewed_files: 0,
    facts_seen: 0,
    facts_applied: 0,
    items_added: 0,
    items_merged: 0,
  };
  const errors = [];

  for (const file of digestFiles(digest)) {
    if (file?.reviewed !== true) {
      stats.skipped_unreviewed_files += 1;
      continue;
    }
    stats.reviewed_files += 1;

    for (const fact of asList(file.facts)) {
      stats.facts_seen += 1;
      const location = `${String(file?.path ?? "(missing path)") || "(missing path)"}#${String(fact?.id ?? "(missing id)") || "(missing id)"}`;
      try {
        const target = routeFactTarget(facts, fact);
        const result = appendItems(target, fact.items, digestSourceRef(file, fact));
        stats.facts_applied += 1;
        stats.items_added += result.added;
        stats.items_merged += result.merged;
      } catch (error) {
        errors.push({ location, message: error.message });
      }
    }
  }

  facts.needs_agent_review = true;
  return { stats, errors };
}

/**
 * 命令行入口：校验输入、执行分发，若存在路由错误则不写出部分结果。
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const digest = readJson(args.digest);
  const facts = readJson(args.facts);
  const report = applyDigestToFacts(digest, facts);

  facts.source = {
    ...(facts.source ?? {}),
    source_digest: path.basename(args.digest),
  };

  if (report.errors.length > 0) {
    console.error(`Errors: ${report.errors.map((error) => `${error.location}: ${error.message}`).join("; ")}`);
    process.exit(1);
  }

  writeJson(args.out, facts);
  console.log(
    `Applied source digest: ${report.stats.facts_applied}/${report.stats.facts_seen} facts, ${report.stats.items_added} items added, ${report.stats.items_merged} duplicates merged.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
