#!/usr/bin/env node
/**
 * build_ceiling_baseline.mjs
 *
 * 从「基底批次 + 覆盖清单」合成天花板基准 B3-ceiling。
 *
 * 模型见 assessment/rag-tuning/CEILING-INTENT.md
 *   - 基底批次的 facts-workspace 作为默认值
 *   - 覆盖清单（md 表格）写出「要改的那几格」
 *   - 检索层 / 呈现层按「格子实际来源批次」派生，保证内容与证据同源
 *
 * 用法：
 *   node scripts/assessment/rag-tuning/build_ceiling_baseline.mjs \
 *     --coverage assessment/rag-tuning/baselines/B3-ceiling.coverage.md \
 *     --base-tag 20260907 \
 *     --baseline-id B3 --baseline-name ceiling \
 *     --out assessment/rag-tuning/baselines/B3-ceiling.checklist.json \
 *     --work-dir assessment/rag-tuning/ceiling-runs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildChecklistFromFacts, readJson } from "./lib/checklist.mjs";
import { loadEvidenceIndex, verifyEvidenceRefs } from "./lib/evidence_access.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

// ---------------------------------------------------------------- 常量表

/** 批次目录名前缀 */
const BATCH_PREFIX = "2026-guoqing-self-drive-plan-";

/** 目标名别名 → canonical（基底批次的叫法） */
const TARGET_ALIASES = {
  豆沙关古镇: "五尺道",
  盐津县城: "盐津老县城",
  昭通大山包: "大山包",
};

/** 类型别名 → 内部类型 */
const TYPE_ALIASES = {
  景点: "place",
  地点: "place",
  景区: "place",
  place: "place",
  城市: "city",
  city: "city",
  天: "day",
  日程: "day",
  day: "day",
  全局: "global",
  global: "global",
};

/** 部分名（中文/键名）→ JSON 键。键名本身也可直接用。 */
const FIELD_ALIASES = {
  // 景点
  概述: "summary",
  简介: "summary",
  亮点: "highlights",
  看点: "highlights",
  缺点: "drawbacks",
  短板: "drawbacks",
  开放时间: "opening_hours",
  门票: "tickets",
  票务: "tickets",
  票价: "tickets",
  时长: "duration",
  路线: "routes",
  线路: "routes",
  行程: "routes",
  玩法选项: "play_options",
  玩法: "play_options",
  游玩方式: "play_options",
  实用信息: "practical_info",
  笔记: "notes",
  备注: "notes",
  冲突: "conflicts",
  // 城市
  概览: "overview",
  备选景点库: "backup_places",
  备选: "backup_places",
  美食: "foods",
  餐饮: "foods",
  住宿: "lodging",
  交通: "transport",
  购物: "shopping",
  // 天
  标题: "title",
  行程安排: "timeline",
  途经景点: "route_places",
  住宿城市: "lodging_city",
  待确认: "confirmations",
  // 全局
  出发前确认: "confirm_before_departure",
  全局笔记: "global_notes",
};

/** 允许出现在「部分」位置的所有键名（含元数据外的合法字段） */
const PLACE_FIELDS = [
  "summary", "highlights", "drawbacks", "opening_hours", "tickets", "duration",
  "routes", "play_options", "practical_info", "notes", "conflicts",
];
const CITY_FIELDS = ["summary", "overview", "backup_places", "foods", "lodging", "transport", "shopping", "notes"];
const DAY_FIELDS = ["title", "summary", "timeline", "route_places", "lodging_city", "notes", "confirmations"];
const GLOBAL_FIELDS = ["confirm_before_departure", "global_notes"];

/** 键名 → 中文名（生成菜单用） */
const FIELD_CN = {
  summary: "概述",
  highlights: "亮点",
  drawbacks: "缺点",
  opening_hours: "开放时间",
  tickets: "门票",
  duration: "时长",
  routes: "路线",
  play_options: "玩法选项",
  practical_info: "实用信息",
  notes: "笔记",
  conflicts: "冲突",
  overview: "概览",
  backup_places: "备选景点库",
  foods: "美食",
  lodging: "住宿",
  transport: "交通",
  shopping: "购物",
  title: "标题",
  timeline: "行程安排",
  route_places: "途经景点",
  lodging_city: "住宿城市",
  confirmations: "待确认",
  confirm_before_departure: "出发前确认",
  global_notes: "全局笔记",
};

const TYPE_CN = { place: "景点", city: "城市", day: "天", global: "全局" };

const FIELDS_BY_TYPE = {
  place: PLACE_FIELDS,
  city: CITY_FIELDS,
  day: DAY_FIELDS,
  global: GLOBAL_FIELDS,
};

/** 字段 → 检索主题（与 lib/checklist.mjs 的 FIELD_RULES 保持一致） */
const THEME_BY_FIELD = {
  summary: "highlights",
  highlights: "highlights",
  drawbacks: "drawbacks",
  opening_hours: "tickets",
  tickets: "tickets",
  duration: "routes",
  routes: "routes",
  play_options: "routes",
  practical_info: "transport",
  notes: "safety",
  conflicts: "safety",
  overview: "notes",
  backup_places: "backup_places",
  foods: "foods",
  lodging: "lodging",
  transport: "transport",
  shopping: "backup_places",
  timeline: "routes",
  route_places: "routes",
  lodging_city: "lodging",
  confirmations: "tickets",
  title: "routes",
};

/** 城市字段的主题（与景点同名字段主题不同，需区分） */
const CITY_THEME_BY_FIELD = {
  summary: "notes",
  overview: "notes",
  backup_places: "backup_places",
  foods: "foods",
  lodging: "lodging",
  transport: "transport",
  shopping: "backup_places",
  notes: "notes",
};

const DELETE_MARKERS = new Set(["删除", "删掉", "remove", "delete", "skip", "无", "none"]);

/**
 * 「改用」列的动作前缀（写完前缀再写批次指针）。
 * 默认 = replace。
 *   replace  整格换成选中的来源条目（默认，前缀可省略）
 *   merge    保留基底原格，把选中的来源条目**追加**到末尾（去重）
 *   takeover 整目标接管：只写「批次 - 类型 - 目标」，该目标所有内容字段取自来源
 */
const ACTION_PREFIXES = [
  { re: /^(?:接管|整取|whole|takeover)[\s:：]+/i, action: "takeover" },
  { re: /^(?:合并|追加|merge|add)[\s:：]+/i, action: "merge" },
  { re: /^(?:替换|覆盖|replace)[\s:：]+/i, action: "replace" },
  { re: /^(?:接管|整取|whole|takeover)$/i, action: "takeover" },
  { re: /^(?:合并|追加|merge|add)$/i, action: "merge" },
  { re: /^(?:替换|覆盖|replace)$/i, action: "replace" },
];

/** 「改用」列尾部的条目选择器：#1 / #1,3 / #2-4 */
const ITEM_SELECTOR_RE = /#\s*(\d+(?:\s*[,，\-–~、]\s*\d+)*)\s*$/;

/** 把 `1,3` / `2-4` 展开成 1-based 条号数组 */
function parseItemSelector(spec) {
  const out = [];
  for (const part of String(spec).split(/[,，、]/)) {
    const range = part.split(/[\-–~]/).map((s) => Number(s.trim()));
    if (range.length === 2 && range.every((n) => Number.isFinite(n))) {
      const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]];
      for (let i = a; i <= b; i += 1) out.push(i);
    } else if (Number.isFinite(range[0])) {
      out.push(range[0]);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const args = {
    coverage: "",
    baseTag: "20260907",
    outputsDir: path.join(PROJECT_ROOT, "outputs"),
    baselineId: "B3",
    baselineName: "ceiling",
    capability: "ceiling",
    out: "",
    workDir: path.join(PROJECT_ROOT, "assessment/rag-tuning/ceiling-runs"),
    runId: "",
    dryRun: false,
    allowPartial: false,
    menuTarget: "",
    menuOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--coverage") args.coverage = argv[++i];
    else if (a === "--base-tag") args.baseTag = argv[++i];
    else if (a === "--outputs-dir") args.outputsDir = argv[++i];
    else if (a === "--baseline-id") args.baselineId = argv[++i];
    else if (a === "--baseline-name") args.baselineName = argv[++i];
    else if (a === "--capability") args.capability = argv[++i];
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--work-dir") args.workDir = argv[++i];
    else if (a === "--run-id") args.runId = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--allow-partial") args.allowPartial = true;
    else if (a === "--emit-menu") {
      args.menuTarget = argv[++i];
      args.menuOnly = true;
    }
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!args.menuOnly && !args.coverage) throw new Error("Missing required --coverage <coverage.md>.");
  if (!args.menuOnly && !args.out) throw new Error("Missing required --out <checklist.json>.");
  return args;
}

// ---------------------------------------------------------------- 小工具

const clone = (value) => JSON.parse(JSON.stringify(value));
const asList = (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
const hasContent = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? "").trim().length > 0);
const batchTagOf = (dirName) => dirName.replace(BATCH_PREFIX, "");
const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

function normalizeTargetName(raw) {
  const t = String(raw ?? "").trim();
  return TARGET_ALIASES[t] ?? t;
}

function normalizeDayName(raw) {
  const t = String(raw ?? "").trim();
  const m = t.match(/^(?:day[-_]?|d)?0*(\d+)$/i) || t.match(/^第\s*(\d+)\s*天$/);
  if (!m) return t;
  return `day-${String(Number(m[1])).padStart(2, "0")}`;
}

function normalizeField(raw, type) {
  const t = String(raw ?? "").trim().replace(/[`\s]/g, "");
  if (!t) return "";
  const allowed = FIELDS_BY_TYPE[type] ?? [];
  // 1) 精确命中：别名表或键名本身
  const exact = FIELD_ALIASES[t] ?? t;
  if (allowed.includes(exact)) return exact;
  // 2) 包含兜底：处理「门票与优惠」「推荐游玩线路」「不同玩法-游玩方式」这类口语写法。
  //    候选按字面长度降序，避免「玩法」抢在「玩法选项」前面。
  const candidates = [
    ...Object.entries(FIELD_ALIASES),
    ...allowed.map((k) => [k, k]),
  ]
    .filter(([alias, key]) => allowed.includes(key) && t.includes(alias))
    .sort((a, b) => b[0].length - a[0].length);
  return candidates.length ? candidates[0][1] : "";
}

// ---------------------------------------------------------------- 解析覆盖清单

/** 把一行表格拆成单元格 */
function splitRow(line) {
  const raw = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return raw.split("|").map((c) => c.trim());
}

/** 从「批次 - 类型 - 目标 - 部分」里剥离批次标签 */
function extractBatchToken(text, tags) {
  const t = String(text ?? "").trim();
  // 目录全名优先
  for (const tag of tags) {
    const full = BATCH_PREFIX + tag;
    if (t.startsWith(full)) return { tag, rest: t.slice(full.length) };
  }
  // 标签匹配：必须按长度降序，否则 `20260918-3` 会被 `20260918` 抢先吃掉
  const byLength = [...tags].sort((a, b) => b.length - a.length);
  for (const tag of byLength) {
    if (!t.startsWith(tag)) continue;
    const rest = t.slice(tag.length);
    // 标签后面必须是分隔符或结尾，避免 `202609181` 被当成 `20260918`
    if (rest === "" || /^[\s\-–—·|｜/>]/.test(rest)) return { tag, rest };
  }
  // 前缀歧义检测：8 位数字开头但无精确匹配
  const m = t.match(/^\d{8}/);
  if (m) {
    const candidates = tags.filter((tag) => tag.startsWith(m[0]));
    if (candidates.length) {
      throw new Error(`批次标签 "${m[0]}" 有歧义，候选：${candidates.join(" / ")}。请写完整标签。`);
    }
  }
  return null;
}

function splitPointer(rest) {
  // 保护 `day-01` / `第1天` 这类 token：先用不含分隔符的占位符替换，切分后再还原
  const GUARD = "\u0000";
  const guarded = String(rest ?? "").replace(
    /(?:第\s*(\d+)\s*天)|(?:day[-_]?(\d+))/gi,
    (_, cn, en) => `${GUARD}${String(Number(cn ?? en)).padStart(2, "0")}${GUARD}`,
  );
  return guarded
    .split(/\s*(?:[-–—·|｜/>]+)\s*/)
    .map((s) =>
      s
        .split(GUARD)
        .map((part, idx) => (idx % 2 === 1 ? `day-${part}` : part))
        .join("")
        .trim(),
    )
    .filter(Boolean);
}

/** 在某个批次的 facts 里按 canonical 名查实际键名（处理别名） */
function resolveNameInFacts(facts, type, canonicalName) {
  const group = type === "city" ? facts.cities : type === "place" ? facts.places : null;
  if (!group) return canonicalName;
  if (group[canonicalName]) return canonicalName;
  const hit = Object.keys(group).find((k) => (TARGET_ALIASES[k] ?? k) === canonicalName);
  return hit ?? canonicalName;
}

export function parseCoverage(mdText, tags) {
  const overrides = [];
  const problems = [];
  const lines = mdText.split(/\r?\n/);

  // 只解析「覆盖表」：从含「范围」与「改用」的表头行开始，到第一行非表格行为止。
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      if (start >= 0) {
        end = i;
        break;
      }
      continue;
    }
    if (start < 0) {
      const cells = splitRow(line);
      const joined = cells.join(" ");
      if (joined.includes("范围") && joined.includes("改用")) start = i;
    }
  }
  if (start < 0) {
    throw new Error('在覆盖清单里找不到「范围 / 改用」表头。请确认文件里有 §1 覆盖表。');
  }

  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    // 跳过表头与分隔行
    if (/^-{2,}$/.test(cells[0]) || cells[0] === "" || cells[0] === "#") continue;
    if (/^范围/.test(cells[1] ?? "") || /^改用/.test(cells[2] ?? "")) continue;
    if (cells.every((c) => c === "")) continue;

    const rowNo = i + 1;
    const scopeRaw = (cells[1] ?? "").trim();
    const overrideRaw = (cells[2] ?? "").trim();
    const note = (cells[3] ?? "").trim();

    if (!scopeRaw && !overrideRaw) continue; // 全空行
    if (scopeRaw && !overrideRaw) continue; // 留空 = 采用基底

    // ---- 拆解「改用」：动作前缀 + 条目选择器（#1 / #1,3 / #2-4）
    let action = "replace";
    let body = overrideRaw;
    for (const p of ACTION_PREFIXES) {
      if (p.re.test(body)) {
        action = p.action;
        body = body.replace(p.re, "").trim();
        break;
      }
    }
    let picks = null;
    const selMatch = body.match(ITEM_SELECTOR_RE);
    if (selMatch) {
      picks = parseItemSelector(selMatch[1]);
      body = body.slice(0, selMatch.index).trim();
      if (!picks.length) {
        problems.push({ row: rowNo, message: `改用 "${overrideRaw}" 的条目选择器解析不出条号` });
        continue;
      }
    }

    // ---- 解析范围（范围留空 = 整目标接管）
    let scopeType = "";
    let scopeTarget = "";
    let scopeField = "";
    if (scopeRaw) {
      const scopeTokens = splitPointer(scopeRaw);
      if (scopeTokens.length < 2) {
        problems.push({ row: rowNo, message: `范围 "${scopeRaw}" 解析不出「类型-目标-部分」` });
        continue;
      }
      scopeType = TYPE_ALIASES[scopeTokens[0]];
      if (!scopeType) {
        problems.push({ row: rowNo, message: `未知类型 "${scopeTokens[0]}"（可用：景点/城市/天/全局）` });
        continue;
      }
      scopeTarget = scopeType === "day" ? normalizeDayName(scopeTokens[1]) : normalizeTargetName(scopeTokens[1]);
      scopeField = normalizeField(scopeTokens.slice(2).join("-"), scopeType);
      if (!scopeField && action !== "takeover") {
        problems.push({
          row: rowNo,
          message: `类型 ${scopeType} 下无法识别部分 "${scopeTokens.slice(2).join("-")}"（可用：${FIELDS_BY_TYPE[scopeType].join(" / ")}）`,
        });
        continue;
      }
    } else {
      action = "takeover"; // 没写范围 = 整目标接管
    }

    // ---- 解析改用（删除标记优先于批次解析）
    if (DELETE_MARKERS.has(body.toLowerCase())) {
      if (!scopeField) {
        problems.push({ row: rowNo, message: `「${overrideRaw}」要删除但没写明要删的部分` });
        continue;
      }
      overrides.push({
        row: rowNo,
        action: "delete",
        scope: { type: scopeType, target: scopeTarget, field: scopeField },
        source: { tag: "", type: scopeType, target: scopeTarget, field: scopeField },
        deleted: true,
        picks: null,
        note,
        raw: { scope: scopeRaw, override: overrideRaw },
      });
      continue;
    }
    const token = extractBatchToken(body, tags);
    if (!token) {
      problems.push({ row: rowNo, message: `改用 "${overrideRaw}" 无法识别批次标签（可用：${tags.join(" ")}）` });
      continue;
    }
    const srcTag = token.tag;
    const srcTokens = splitPointer(token.rest);

    // ---- 整目标接管：该目标所有内容字段取自来源批次
    if (action === "takeover") {
      let srcType = scopeType;
      let srcTarget = scopeTarget;
      if (srcTokens.length) {
        if (TYPE_ALIASES[srcTokens[0]]) {
          srcType = TYPE_ALIASES[srcTokens[0]];
          if (srcTokens.length >= 2) {
            srcTarget = srcType === "day" ? normalizeDayName(srcTokens[1]) : normalizeTargetName(srcTokens[1]);
          }
          if (srcTokens.length >= 3) {
            problems.push({ row: rowNo, message: `接管只写「批次 - 类型 - 目标」，第 3 段 "${srcTokens[2]}" 是多余的` });
            continue;
          }
        } else {
          srcTarget = srcType === "day" ? normalizeDayName(srcTokens[0]) : normalizeTargetName(srcTokens[0]);
        }
      }
      if (!srcType || !srcTarget) {
        problems.push({ row: rowNo, message: `接管要写明类型与目标，例如「接管 20260918 - 城市 - 盐津」` });
        continue;
      }
      if (!["place", "city"].includes(srcType)) {
        problems.push({ row: rowNo, message: `整目标接管目前只支持 景点/城市（${srcType} 请按部分逐格指定）` });
        continue;
      }
      overrides.push({
        row: rowNo,
        action: "takeover",
        wholeTarget: true,
        scope: { type: srcType, target: srcTarget, field: "" },
        source: { tag: srcTag, type: srcType, target: srcTarget, field: "" },
        deleted: false,
        picks: null,
        note,
        raw: { scope: scopeRaw, override: overrideRaw },
      });
      continue;
    }

    // 允许「只有批次号」
    let srcType = scopeType;
    let srcTarget = scopeTarget;
    let srcField = scopeField;
    let deleted = false;

    if (srcTokens.length === 1 && DELETE_MARKERS.has(srcTokens[0].toLowerCase())) {
      deleted = true;
    } else if (srcTokens.length > 0) {
      const first = srcTokens[0];
      if (DELETE_MARKERS.has(first.toLowerCase())) {
        deleted = true;
      } else if (TYPE_ALIASES[first]) {
        srcType = TYPE_ALIASES[first];
        if (srcTokens.length >= 2) {
          srcTarget = srcType === "day" ? normalizeDayName(srcTokens[1]) : normalizeTargetName(srcTokens[1]);
        }
        if (srcTokens.length >= 3) {
          const f = normalizeField(srcTokens.slice(2).join("-"), srcType);
          if (!f) {
            problems.push({ row: rowNo, message: `改用里的部分 "${srcTokens.slice(2).join("-")}" 在类型 ${srcType} 下无法识别` });
            continue;
          }
          srcField = f;
        }
      } else {
        // 只写了目标名或部分名：部分名优先精确命中，否则当目标名
        const allowed = FIELDS_BY_TYPE[srcType] ?? [];
        const exactField = FIELD_ALIASES[first] ?? first;
        const asField = allowed.includes(exactField) ? exactField : "";
        const asTarget = srcType === "day" ? normalizeDayName(first) : normalizeTargetName(first);
        if (asField) srcField = asField;
        else if (asTarget) srcTarget = asTarget;
        else {
          problems.push({ row: rowNo, message: `改用 "${overrideRaw}" 无法解析（既不是目标也不是部分名）` });
          continue;
        }
      }
    }

    if (!deleted && srcType !== scopeType) {
      problems.push({ row: rowNo, message: `改用的类型(${srcType}) 与范围的类型(${scopeType}) 不一致，请改回同一类型` });
      continue;
    }

    overrides.push({
      row: rowNo,
      action: deleted ? "delete" : action,
      scope: { type: scopeType, target: scopeTarget, field: scopeField },
      source: { tag: srcTag, type: srcType, target: srcTarget, field: srcField },
      deleted,
      picks,
      note,
      raw: { scope: scopeRaw, override: overrideRaw },
    });
  }

  return { overrides, problems };
}

// ---------------------------------------------------------------- 批次装载

function loadBatches(outputsDir) {
  if (!fs.existsSync(outputsDir)) throw new Error(`outputs 目录不存在：${outputsDir}`);
  const dirs = fs
    .readdirSync(outputsDir)
    .filter((d) => fs.statSync(path.join(outputsDir, d)).isDirectory())
    .filter((d) => d.startsWith(BATCH_PREFIX))
    .sort();

  const batches = new Map();
  const skipped = [];
  for (const dir of dirs) {
    const tag = batchTagOf(dir);
    const dirPath = path.join(outputsDir, dir);
    const factsPath = path.join(dirPath, "facts-workspace.json");
    const wsPath = path.join(dirPath, "retrieval-workspace.json");
    if (!fs.existsSync(factsPath)) {
      skipped.push({ tag, dir, reason: "缺 facts-workspace.json" });
      continue;
    }
    batches.set(tag, {
      tag,
      dir,
      dirPath,
      facts: readJson(factsPath),
      factsPath,
      wsPath: fs.existsSync(wsPath) ? wsPath : "",
      ws: fs.existsSync(wsPath) ? readJson(wsPath) : null,
    });
  }
  return { batches, skipped };
}

// ---------------------------------------------------------------- 取值 / 写入

function getCell(facts, type, target, field) {
  if (type === "place") return facts.places?.[target]?.[field];
  if (type === "city") return facts.cities?.[target]?.[field];
  if (type === "day") {
    const day = (facts.trip?.days ?? []).find(
      (d) => `day-${String(d.day).padStart(2, "0")}` === target,
    );
    return day ? day[field] : undefined;
  }
  if (type === "global") return facts[field];
  return undefined;
}

function setCell(facts, type, target, field, value) {
  if (type === "place") {
    facts.places = facts.places ?? {};
    facts.places[target] = facts.places[target] ?? {};
    facts.places[target][field] = value;
    return;
  }
  if (type === "city") {
    facts.cities = facts.cities ?? {};
    facts.cities[target] = facts.cities[target] ?? {};
    facts.cities[target][field] = value;
    return;
  }
  if (type === "day") {
    const day = (facts.trip?.days ?? []).find(
      (d) => `day-${String(d.day).padStart(2, "0")}` === target,
    );
    if (!day) throw new Error(`合成 facts 里找不到 ${target}`);
    day[field] = value;
    return;
  }
  facts[field] = value;
}

function themeOf(type, field) {
  if (type === "city") return CITY_THEME_BY_FIELD[field] ?? THEME_BY_FIELD[field];
  return THEME_BY_FIELD[field];
}

// ---------------------------------------------------------------- 派生检索池

function emptyWsShell(baseWs) {
  return {
    schema_version: baseWs.schema_version ?? 1,
    source: clone(baseWs.source ?? {}),
    retrieval: clone(baseWs.retrieval ?? {}),
    chunks_by_id: clone(baseWs.chunks_by_id ?? {}),
    places: clone(baseWs.places ?? {}),
    cities: clone(baseWs.cities ?? {}),
    summary: clone(baseWs.summary ?? {}),
  };
}

function themeIds(ws, type, target, theme) {
  const group = type === "city" ? ws.cities : ws.places;
  const entry = group?.[target];
  if (!entry) return [];
  return [
    ...asList(entry.themes?.[theme]).map((i) => i?.chunk_id).filter(Boolean),
    ...asList(entry.unique_chunk_ids).filter(Boolean),
  ];
}

/** 在某个批次的 retrieval-workspace 里按 canonical 名查实际键名（处理别名） */
function resolveNameInWs(ws, type, canonicalName) {
  const group = type === "city" ? ws?.cities : ws?.places;
  if (!group) return canonicalName;
  if (group[canonicalName]) return canonicalName;
  const hit = Object.keys(group).find((k) => (TARGET_ALIASES[k] ?? k) === canonicalName);
  return hit ?? canonicalName;
}

function mergeThemeInto(target, type, name, theme, sourceBatch) {
  const groupKey = type === "city" ? "cities" : "places";
  target[groupKey] = target[groupKey] ?? {};
  target[groupKey][name] = target[groupKey][name] ?? { target: name, unique_chunk_ids: [], themes: {} };
  const dst = target[groupKey][name];
  const srcName = resolveNameInWs(sourceBatch.ws, type, name);
  const src = sourceBatch.ws?.[groupKey]?.[srcName];

  // 1) 主题条目并集
  if (src) {
    const seen = new Set(asList(dst.themes[theme]).map((i) => i?.chunk_id));
    const merged = asList(dst.themes[theme]).slice();
    for (const item of asList(src.themes?.[theme])) {
      if (item?.chunk_id && !seen.has(item.chunk_id)) {
        seen.add(item.chunk_id);
        merged.push(clone(item));
      }
    }
    dst.themes[theme] = merged;
    dst.unique_chunk_ids = [...new Set([...asList(dst.unique_chunk_ids), ...asList(src.unique_chunk_ids)])];
  }

  // 2) 补齐 chunks_by_id
  for (const id of themeIds(sourceBatch.ws ?? { places: {}, cities: {} }, type, srcName, theme)) {
    if (!target.chunks_by_id[id] && sourceBatch.ws?.chunks_by_id?.[id]) {
      target.chunks_by_id[id] = clone(sourceBatch.ws.chunks_by_id[id]);
    }
  }
}

// ---------------------------------------------------------------- 可选格子菜单

/**
 * 生成 §3 可选格子菜单（字段合法性以本脚本的 FIELDS_BY_TYPE 为准）。
 * 返回 markdown 文本；--emit-menu <file> 会把目标文件里 `## 3.` 之后整段替换掉。
 */
export function renderMenuBlock(args) {
  const { batches } = loadBatches(args.outputsDir);
  const base = batches.get(args.baseTag);
  if (!base) {
    throw new Error(`基底批次 ${args.baseTag} 不可用。可用：${[...batches.keys()].join(" ")}`);
  }
  const all = [...batches.values()];
  const rows = [];

  const pushRow = (type, name, field) => {
    const n = all.filter((b) => {
      const resolved = resolveNameInFacts(b.facts, type, name);
      return hasContent(getCell(b.facts, type, resolved, field));
    }).length;
    const baseEmpty = !hasContent(getCell(base.facts, type, resolveNameInFacts(base.facts, type, name), field));
    const hint = n === 0 ? "<br>⚠ 全空" : baseEmpty ? "<br>⚠ 基底为空·可增补" : "";
    rows.push([TYPE_CN[type], name, `${FIELD_CN[field] ?? field} \`${field}\``, String(n), hint]);
  };

  for (const p of Object.keys(base.facts.places ?? {})) {
    for (const f of PLACE_FIELDS.filter((x) => x !== "conflicts")) pushRow("place", p, f);
  }
  for (const c of Object.keys(base.facts.cities ?? {})) {
    for (const f of CITY_FIELDS) pushRow("city", c, f);
  }
  for (const d of base.facts.trip?.days ?? []) {
    const dayName = `day-${String(d.day).padStart(2, "0")}`;
    for (const f of DAY_FIELDS) pushRow("day", dayName, f);
  }
  rows.push(["全局", "-", "出发前确认 `confirm_before_departure`", String(all.length), ""]);
  rows.push(["全局", "-", "全局笔记 `global_notes`", String(all.length), ""]);

  const out = [
    `## 3. 可选格子菜单（${rows.length} 格）`,
    "",
    `「有内容的批次数」= ${all.length} 个可用批次里写过这格的有几个。\`⚠ 基底为空·可增补\` = 基底 ${args.baseTag} 没写，只能从别批补。\`⚠ 全空\` = 所有批次都没写。`,
    "",
    "| 类型 | 目标 | 部分（中文 / 键名） | 有内容的批次数 | 提示 |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ];
  return out.join("\n");
}

function emitMenu(args) {
  const block = renderMenuBlock(args);
  if (!args.menuTarget) {
    process.stdout.write(block);
    return block;
  }
  const p = path.resolve(args.menuTarget);
  const text = fs.readFileSync(p, "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^##\s*3\./.test(l));
  if (at < 0) throw new Error(`${args.menuTarget} 里找不到 "## 3." 小节，无法替换菜单。`);
  const head = lines.slice(0, at).join("\n").replace(/\n*$/, "\n");
  fs.writeFileSync(p, `${head}\n${block}`, "utf8");
  console.log(`菜单已写入 ${args.menuTarget}（${block.split("\n").filter((l) => l.startsWith("| ")).length - 1} 行）`);
  return block;
}

// ---------------------------------------------------------------- 主流程

export function buildCeiling(args) {
  const tags = fs
    .readdirSync(args.outputsDir)
    .filter((d) => fs.statSync(path.join(args.outputsDir, d)).isDirectory() && d.startsWith(BATCH_PREFIX))
    .map(batchTagOf)
    .sort();

  const { batches, skipped } = loadBatches(args.outputsDir);
  const base = batches.get(args.baseTag);
  if (!base) {
    throw new Error(`基底批次 ${args.baseTag} 不可用。可用：${[...batches.keys()].join(" ")}；跳过：${skipped.map((s) => `${s.tag}(${s.reason})`).join(", ")}`);
  }
  if (!base.ws) throw new Error(`基底批次 ${args.baseTag} 缺 retrieval-workspace.json，无法派生检索池。`);

  const mdText = fs.readFileSync(args.coverage, "utf8");
  const { overrides, problems } = parseCoverage(mdText, tags);

  const mergedFacts = clone(base.facts);
  const workingWs = emptyWsShell(base.ws);
  const provenance = [];
  const warnings = [];
  const fatal = [];

  // 同一格被写两次：后者会静默覆盖前者，直接拦下
  const scopeSeen = new Map();
  for (const ov of overrides) {
    if (ov.wholeTarget || ov.deleted) continue;
    const key = `${ov.scope.type}|${ov.scope.target}|${ov.scope.field}`;
    if (scopeSeen.has(key)) {
      fatal.push(`第 ${ov.row} 行：与第 ${scopeSeen.get(key)} 行改的是同一格（${ov.scope.type} · ${ov.scope.target} · ${ov.scope.field}），请合并成一行。`);
    } else {
      scopeSeen.set(key, ov.row);
    }
  }

  for (const ov of overrides) {
    const { type, target, field } = ov.scope;

    // 删除项不涉及来源批次，先处理
    if (ov.deleted) {
      const exists =
        type === "global" ||
        (type === "place" && mergedFacts.places?.[target]) ||
        (type === "city" && mergedFacts.cities?.[target]) ||
        (type === "day" && (mergedFacts.trip?.days ?? []).some((d) => `day-${String(d.day).padStart(2, "0")}` === target));
      if (!exists) {
        fatal.push(`第 ${ov.row} 行：合成 facts 里没有「${type} · ${target}」，无法删除。`);
        continue;
      }
      const beforeCount = asList(getCell(mergedFacts, type, target, field)).length;
      setCell(mergedFacts, type, target, field, []);
      provenance.push({
        row: ov.row,
        action: "delete",
        scope: `${type} · ${target} · ${field}`,
        from: `原 ${beforeCount} 条 → 删除`,
        note: ov.note,
        applied: true,
      });
      continue;
    }

    const srcBatch = batches.get(ov.source.tag);
    if (!srcBatch) {
      const reason = skipped.find((s) => s.tag === ov.source.tag);
      fatal.push(`第 ${ov.row} 行：批次 ${ov.source.tag} ${reason ? `不可用（${reason.reason}）` : "不是已知批次"}`);
      continue;
    }

    // ---- 整目标接管：该目标所有内容字段取自来源批次（可在基底里新建目标）
    if (ov.wholeTarget) {
      const srcType = ov.source.type;
      const srcTarget = ov.source.target;
      const resolved = resolveNameInFacts(srcBatch.facts, srcType, srcTarget);
      const groupKey = srcType === "city" ? "cities" : "places";
      const srcObj = srcBatch.facts[groupKey]?.[resolved];
      if (!srcObj) {
        fatal.push(`第 ${ov.row} 行：批次 ${ov.source.tag} 里没有「${srcType} · ${srcTarget}」，无法整目标接管。`);
        continue;
      }
      const adopted = [];
      const cleared = [];
      const absent = [];
      for (const f of FIELDS_BY_TYPE[srcType] ?? []) {
        const srcVal = srcObj[f];
        const beforeVal = getCell(mergedFacts, srcType, srcTarget, f);
        if (hasContent(srcVal)) {
          setCell(mergedFacts, srcType, srcTarget, f, clone(srcVal));
          mergeThemeInto(workingWs, srcType, srcTarget, themeOf(srcType, f), srcBatch);
          adopted.push(`${f}=${asList(srcVal).length}`);
        } else if (hasContent(beforeVal)) {
          // 来源为空 → 清空（真正的「接管」语义），但要报出来
          setCell(mergedFacts, srcType, srcTarget, f, []);
          cleared.push(f);
        } else {
          absent.push(f);
        }
      }
      if (cleared.length) {
        warnings.push(
          `第 ${ov.row} 行：批次 ${ov.source.tag} 的「${srcType} · ${srcTarget}」在 ${cleared.join(" / ")} 上是空的，接管后这几格被清空。`,
        );
      }
      provenance.push({
        row: ov.row,
        action: "takeover",
        scope: `${srcType} · ${srcTarget} · （整目标）`,
        from: `${ov.source.tag} · 带入 ${adopted.length} 个字段` + (cleared.length ? ` / 清空 ${cleared.length} 个` : ""),
        detail: { adopted, cleared, empty: absent },
        note: ov.note,
        applied: true,
      });
      continue;
    }

    // 目标存在性
    const targetExists =
      type === "global" ||
      (type === "place" && mergedFacts.places?.[target]) ||
      (type === "city" && mergedFacts.cities?.[target]) ||
      (type === "day" && (mergedFacts.trip?.days ?? []).some((d) => `day-${String(d.day).padStart(2, "0")}` === target));
    if (!targetExists) {
      fatal.push(`第 ${ov.row} 行：合成 facts 里没有「${type} · ${target}」。可用目标见 B3-ceiling.coverage.md §3 菜单。`);
      continue;
    }

    // 来源取值
    const srcField = ov.source.field;
    const srcResolvedTarget = resolveNameInFacts(srcBatch.facts, ov.source.type, ov.source.target);
    const srcValue = getCell(srcBatch.facts, ov.source.type, srcResolvedTarget, srcField);
    if (!hasContent(srcValue)) {
      fatal.push(
        `第 ${ov.row} 行：批次 ${ov.source.tag} 的「${ov.source.type} · ${ov.source.target} · ${srcField}」是空的，取不到内容。`,
      );
      continue;
    }

    // ---- 条目级选取：来源该格的第 N 条（1-based）
    const srcList = asList(srcValue);
    let picked = srcList.map((v) => clone(v));
    let pickNote = "";
    if (ov.picks && ov.picks.length) {
      const outOfRange = ov.picks.filter((n) => n < 1 || n > srcList.length);
      if (outOfRange.length) {
        fatal.push(
          `第 ${ov.row} 行：批次 ${ov.source.tag} 的「${ov.source.type} · ${ov.source.target} · ${srcField}」只有 ${srcList.length} 条，取不到 #${outOfRange.join(",#")}。`,
        );
        continue;
      }
      picked = ov.picks.map((n) => clone(srcList[n - 1]));
      pickNote = `（取 #${ov.picks.join(",#")}）`;
    }

    const before = getCell(mergedFacts, type, target, field);
    const beforeCount = asList(before).length;
    let nextValue = picked;
    if (ov.action === "merge") {
      // 保留基底原格，把选中的来源条目追加到末尾（完全相同的不重复追加）
      const seen = new Set(asList(before).map((v) => JSON.stringify(v)));
      nextValue = asList(before)
        .map((v) => clone(v))
        .concat(picked.filter((v) => !seen.has(JSON.stringify(v))));
    }
    setCell(mergedFacts, type, target, field, nextValue);

    // 检索层：按该格来源批次派生
    const theme = themeOf(type, field);
    if (type === "day") {
      const srcDay = (srcBatch.facts.trip?.days ?? []).find(
        (d) => `day-${String(d.day).padStart(2, "0")}` === ov.source.target,
      );
      const names = [
        ...asList(srcDay?.route_places).map((n) => ["place", normalizeTargetName(n)]),
        ...(srcDay?.lodging_city ? [["city", normalizeTargetName(srcDay.lodging_city)]] : []),
        ...asList(srcBatch.facts.source?.cities).map((n) => ["city", normalizeTargetName(n)]),
      ];
      for (const [t, n] of names) mergeThemeInto(workingWs, t, n, theme, srcBatch);
    } else if (type === "global") {
      for (const n of Object.keys(srcBatch.ws?.places ?? {})) mergeThemeInto(workingWs, "place", n, "safety", srcBatch);
      for (const n of Object.keys(srcBatch.ws?.cities ?? {})) mergeThemeInto(workingWs, "city", n, "notes", srcBatch);
    } else {
      mergeThemeInto(workingWs, type, target, theme, srcBatch);
    }

    provenance.push({
      row: ov.row,
      action: ov.action === "merge" ? "merge" : "override",
      scope: `${type} · ${target} · ${field}`,
      from: `${String(beforeCount).padStart(2)} 条 → ${ov.source.tag} · ${ov.source.target} · ${srcField}${pickNote} 后 ${asList(nextValue).length} 条`,
      note: ov.note,
      applied: true,
    });
  }

  // 解析失败与解析歧义一律**阻塞**：静默跳行会让基准跟你要的不是一回事。
  if ((problems.length || fatal.length) && !args.allowPartial) {
    const lines = [
      `覆盖清单有 ${problems.length + fatal.length} 处问题，已中止（未写出任何产物）：`,
      ...problems.map((p) => `  · 第 ${p.row} 行（解析）: ${p.message}`),
      ...fatal.map((m) => `  · ${m}`),
      ``,
      `修好后重跑；确实想跳过这些行请加 --allow-partial。`,
    ];
    throw new Error(lines.join("\n"));
  }

  // 派生检索池：把合成后 cells 里引用的 chunk 全部补齐
  const referenced = new Set();
  for (const [, place] of Object.entries(mergedFacts.places ?? {})) {
    void place;
  }
  for (const type of ["place", "city"]) {
    const names = type === "place" ? Object.keys(workingWs.places ?? {}) : Object.keys(workingWs.cities ?? {});
    for (const name of names) {
      for (const theme of Object.keys(
        (type === "place" ? workingWs.places[name] : workingWs.cities[name])?.themes ?? {},
      )) {
        for (const id of themeIds(workingWs, type, name, theme)) {
          if (workingWs.chunks_by_id[id]) referenced.add(id);
        }
      }
    }
  }
  for (const batch of batches.values()) {
    for (const id of referenced) {
      if (!workingWs.chunks_by_id[id] && batch.ws?.chunks_by_id?.[id]) {
        workingWs.chunks_by_id[id] = clone(batch.ws.chunks_by_id[id]);
      }
    }
  }

  // 构基
  const runId = args.runId || `${timestamp()}-${args.baselineId}-ceiling`;
  const runDir = path.join(args.workDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const factsOut = path.join(runDir, "facts-workspace.json");
  const wsOut = path.join(runDir, "retrieval-workspace.json");
  fs.writeFileSync(factsOut, `${JSON.stringify(mergedFacts, null, 2)}\n`, "utf8");
  fs.writeFileSync(wsOut, `${JSON.stringify(workingWs, null, 2)}\n`, "utf8");

  const checklist = buildChecklistFromFacts(mergedFacts, workingWs, {
    baselineId: args.baselineId,
    baselineName: args.baselineName,
    capability: args.capability,
    sourceRun: path.posix.join("outputs", base.dir),
    ragIndexPath: "",
    retrievalWorkspacePath: path.relative(PROJECT_ROOT, wsOut),
    version: 1,
  });

  const evidenceIndex = loadEvidenceIndex({ retrievalWorkspacePath: wsOut });
  const missing = verifyEvidenceRefs(checklist, evidenceIndex);
  if (missing.length) {
    throw new Error(
      `checklist 存在无法溯源的证据引用：${missing.slice(0, 10).map((m) => `${m.item_id}:${m.chunk_id}`).join(", ")}`,
    );
  }

  // 静默丢弃检测：合成 facts 里有多少条目因为无证据而被丢掉
  const expectedTexts = new Set();
  for (const type of ["place", "city"]) {
    const group = type === "place" ? mergedFacts.places : mergedFacts.cities;
    for (const [, obj] of Object.entries(group ?? {})) {
      for (const f of FIELDS_BY_TYPE[type]) for (const v of asList(obj[f])) expectedTexts.add(String(v).replace(/\s+/g, " ").trim());
    }
  }
  for (const day of mergedFacts.trip?.days ?? []) {
    for (const f of DAY_FIELDS) {
      if (f === "timeline") {
        for (const v of asList(day[f])) expectedTexts.add(String(v?.title ?? "").trim() || String(v).trim());
      } else {
        for (const v of asList(day[f])) expectedTexts.add(String(v).replace(/\s+/g, " ").trim());
      }
    }
  }
  const producedTexts = new Set(checklist.items.map((i) => i.text));
  const dropped = [...expectedTexts].filter((t) => t && !producedTexts.has(t));
  if (dropped.length) {
    warnings.push(
      `${dropped.length} 条合成内容因「该 (目标,部分) 在派生检索池里没有证据 chunk」被静默丢弃（pushItem 行为）。示例：${dropped.slice(0, 3).join(" ｜ ")}`,
    );
  }

  const byType = {};
  const byCriticality = {};
  for (const item of checklist.items) {
    byType[item.target_type] = (byType[item.target_type] ?? 0) + 1;
    byCriticality[item.criticality] = (byCriticality[item.criticality] ?? 0) + 1;
  }

  const provenanceDoc = {
    generated_at: new Date().toISOString(),
    base_tag: args.baseTag,
    base_dir: base.dir,
    coverage_file: path.relative(PROJECT_ROOT, args.coverage),
    override_count: overrides.filter((o) => !o.deleted && !o.wholeTarget).length,
    takeover_count: overrides.filter((o) => o.wholeTarget).length,
    delete_count: overrides.filter((o) => o.deleted).length,
    items: provenance,
    warnings,
    derived: {
      facts_workspace: path.relative(PROJECT_ROOT, factsOut),
      retrieval_workspace: path.relative(PROJECT_ROOT, wsOut),
    },
    available_batches: [...batches.keys()],
    unavailable_batches: skipped,
  };
  fs.writeFileSync(path.join(runDir, "provenance.json"), `${JSON.stringify(provenanceDoc, null, 2)}\n`, "utf8");

  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(checklist, null, 2)}\n`, "utf8");
  }

  return {
    runId,
    runDir,
    checklist,
    byType,
    byCriticality,
    overrideCount: overrides.filter((o) => !o.deleted && !o.wholeTarget).length,
    takeoverCount: overrides.filter((o) => o.wholeTarget).length,
    deleteCount: overrides.filter((o) => o.deleted).length,
    provenance,
    warnings,
    problems,
    dropped,
    batches: [...batches.keys()],
    skipped,
    out: args.out,
  };
}

// ---------------------------------------------------------------- CLI

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.menuOnly) {
    emitMenu(args);
    return;
  }
  const r = buildCeiling(args);

  console.log(`基底批次      : ${args.baseTag}`);
  console.log(`可用批次      : ${r.batches.join(" ")}`);
  if (r.skipped.length) console.log(`不可用批次    : ${r.skipped.map((s) => `${s.tag}(${s.reason})`).join(", ")}`);
  console.log(`覆盖项        : ${r.overrideCount} 条改写 / ${r.takeoverCount} 条整目标接管 / ${r.deleteCount} 条删除`);
  console.log(`合成中间产物  : ${path.relative(PROJECT_ROOT, r.runDir)}`);
  console.log(`checklist     : ${r.checklist.items.length} 条  →  ${r.out}`);
  console.log(`  按类型      : ${JSON.stringify(r.byType)}`);
  console.log(`  按 criticality: ${JSON.stringify(r.byCriticality)}`);
  if (r.problems.length) {
    console.log(`\n⚠ ${r.problems.length} 行解析失败（已跳过）：`);
    for (const p of r.problems) console.log(`  第 ${p.row} 行: ${p.message}`);
  }
  if (r.warnings.length) {
    console.log(`\n⚠ 警告：`);
    for (const w of r.warnings) console.log(`  ${w}`);
  }
  console.log(`\n溯源记录: ${path.relative(PROJECT_ROOT, path.join(r.runDir, "provenance.json"))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`\n[build_ceiling_baseline] ${error.message}`);
    process.exit(1);
  }
}
