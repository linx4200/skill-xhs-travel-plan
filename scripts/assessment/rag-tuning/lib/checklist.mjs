import fs from "node:fs";
import { assertValidChecklist } from "./schemas.mjs";

const PLACE_FIELD_RULES = {
  summary: { theme: "highlights", domain: "decision_support", criticality: "core-quality" },
  highlights: { theme: "highlights", domain: "experience_value", criticality: "core-quality" },
  drawbacks: { theme: "drawbacks", domain: "risk_avoidance", criticality: "mid" },
  opening_hours: { theme: "tickets", domain: "execution_fact", criticality: "critical" },
  tickets: { theme: "tickets", domain: "execution_fact", criticality: "critical" },
  duration: { theme: "routes", domain: "decision_support", criticality: "core-quality" },
  routes: { theme: "routes", domain: "decision_support", criticality: "core-quality" },
  play_options: { theme: "routes", domain: "decision_support", criticality: "core-quality" },
  practical_info: { theme: "transport", domain: "execution_fact", criticality: "critical" },
  notes: { theme: "safety", domain: "risk_avoidance", criticality: "critical" },
  conflicts: { theme: "safety", domain: "risk_avoidance", criticality: "critical" },
};

const CITY_FIELD_RULES = {
  summary: { theme: "notes", domain: "decision_support", criticality: "core-quality" },
  overview: { theme: "notes", domain: "decision_support", criticality: "core-quality" },
  backup_places: { theme: "backup_places", domain: "decision_support", criticality: "mid" },
  foods: { theme: "foods", domain: "supporting_info", criticality: "low" },
  lodging: { theme: "lodging", domain: "execution_fact", criticality: "critical" },
  transport: { theme: "transport", domain: "execution_fact", criticality: "critical" },
  shopping: { theme: "backup_places", domain: "supporting_info", criticality: "low" },
  notes: { theme: "notes", domain: "risk_avoidance", criticality: "critical" },
};

const DAY_FIELD_RULES = {
  summary: { theme: "routes", domain: "decision_support", criticality: "core-quality" },
  timeline: { theme: "routes", domain: "decision_support", criticality: "core-quality" },
  notes: { theme: "safety", domain: "risk_avoidance", criticality: "critical" },
  confirmations: { theme: "tickets", domain: "execution_fact", criticality: "critical" },
};

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function itemText(value) {
  if (typeof value === "string" || typeof value === "number") return cleanText(value);
  if (value && typeof value === "object") {
    const title = cleanText(value.title);
    const summary = cleanText(value.summary);
    const details = asList(value.details).map(cleanText).filter(Boolean).join("；");
    return [title, summary, details].filter(Boolean).join("：");
  }
  return "";
}

function sourceIdsForTarget(retrievalWorkspace, targetType, targetName, theme) {
  const group = targetType === "city" ? retrievalWorkspace?.cities : retrievalWorkspace?.places;
  const target = group?.[targetName];
  if (!target) return [];
  const themeIds = asList(target.themes?.[theme]).map((item) => item.chunk_id).filter(Boolean);
  const uniqueIds = asList(target.unique_chunk_ids).filter(Boolean);
  return [...new Set([...themeIds, ...uniqueIds])].slice(0, 5);
}

function sourceIdsForDay(facts, retrievalWorkspace, day, theme) {
  const ids = [];
  for (const place of asList(day.route_places)) ids.push(...sourceIdsForTarget(retrievalWorkspace, "place", place, theme));
  const lodgingCity = cleanText(day.lodging_city);
  if (lodgingCity) ids.push(...sourceIdsForTarget(retrievalWorkspace, "city", lodgingCity, theme));
  for (const city of asList(facts?.source?.cities)) ids.push(...sourceIdsForTarget(retrievalWorkspace, "city", city, theme));
  return [...new Set(ids)].slice(0, 5);
}

function hintsFromText(text) {
  const hints = [];
  for (const match of text.matchAll(/[0-9]+(?:\.[0-9]+)?(?:元|小时|分钟|公里|米|天|人|%|m)?/g)) {
    hints.push(match[0]);
  }
  for (const part of text.split(/[，。；、：:,.!！?？\s/]+/)) {
    const cleaned = cleanText(part);
    if (cleaned.length >= 2 && cleaned.length <= 12) hints.push(cleaned);
  }
  return [...new Set(hints)].slice(0, 8);
}

function evidenceRef(options, sourceChunkIds) {
  return {
    rag_index: options.ragIndexPath || "",
    retrieval_workspace: options.retrievalWorkspacePath || "",
    chunk_ids: sourceChunkIds,
    note: "按 target/theme 从受控证据来源归因，未复制大段原文。",
  };
}

function pushItem(items, options, fields) {
  const text = cleanText(fields.text);
  if (!text) return;
  const sourceChunkIds = asList(fields.sourceChunkIds).filter(Boolean);
  if (!sourceChunkIds.length && !options.allowUnverified) return;
  const number = String(items.length + 1).padStart(4, "0");
  items.push({
    id: `${options.baselineId}-${fields.targetType}-${number}`,
    text,
    domain: fields.rule.domain,
    target_type: fields.targetType,
    target_name: fields.targetName,
    theme: fields.rule.theme,
    criticality: fields.rule.criticality,
    source_chunk_ids: sourceChunkIds,
    evidence_ref: evidenceRef(options, sourceChunkIds),
    match_hints: hintsFromText(text),
    added_at: options.createdAt,
    source_run: options.sourceRun,
  });
}

function collectPlaceItems(items, facts, retrievalWorkspace, options) {
  for (const [placeName, place] of Object.entries(facts.places ?? {})) {
    for (const [field, rule] of Object.entries(PLACE_FIELD_RULES)) {
      for (const value of asList(place[field])) {
        pushItem(items, options, {
          targetType: "place",
          targetName: placeName,
          rule,
          text: itemText(value),
          sourceChunkIds: sourceIdsForTarget(retrievalWorkspace, "place", placeName, rule.theme),
        });
      }
    }
  }
}

function collectCityItems(items, facts, retrievalWorkspace, options) {
  for (const [cityName, city] of Object.entries(facts.cities ?? {})) {
    for (const [field, rule] of Object.entries(CITY_FIELD_RULES)) {
      for (const value of asList(city[field])) {
        pushItem(items, options, {
          targetType: "city",
          targetName: cityName,
          rule,
          text: itemText(value),
          sourceChunkIds: sourceIdsForTarget(retrievalWorkspace, "city", cityName, rule.theme),
        });
      }
    }
  }
}

function collectDayItems(items, facts, retrievalWorkspace, options) {
  for (const day of asList(facts.trip?.days)) {
    const targetName = `day-${String(day.day ?? "").padStart(2, "0")}`;
    for (const [field, rule] of Object.entries(DAY_FIELD_RULES)) {
      for (const value of asList(day[field])) {
        pushItem(items, options, {
          targetType: "day",
          targetName,
          rule,
          text: itemText(value),
          sourceChunkIds: sourceIdsForDay(facts, retrievalWorkspace, day, rule.theme),
        });
      }
    }
  }
}

function collectGlobalItems(items, facts, retrievalWorkspace, options) {
  const rule = { theme: "safety", domain: "risk_avoidance", criticality: "critical" };
  const ids = [
    ...Object.keys(retrievalWorkspace?.places ?? {}).flatMap((place) =>
      sourceIdsForTarget(retrievalWorkspace, "place", place, rule.theme),
    ),
    ...Object.keys(retrievalWorkspace?.cities ?? {}).flatMap((city) =>
      sourceIdsForTarget(retrievalWorkspace, "city", city, "notes"),
    ),
  ];
  for (const value of [...asList(facts.global_notes), ...asList(facts.confirm_before_departure)]) {
    pushItem(items, options, {
      targetType: "global",
      targetName: "global",
      rule,
      text: itemText(value),
      sourceChunkIds: [...new Set(ids)].slice(0, 5),
    });
  }
}

export function buildChecklistFromFacts(facts, retrievalWorkspace, options = {}) {
  const now = options.createdAt ?? new Date().toISOString();
  const normalizedOptions = {
    baselineId: options.baselineId,
    sourceRun: options.sourceRun ?? "",
    ragIndexPath: options.ragIndexPath ?? "",
    retrievalWorkspacePath: options.retrievalWorkspacePath ?? "",
    allowUnverified: Boolean(options.allowUnverified),
    createdAt: now,
  };
  if (!normalizedOptions.baselineId) throw new Error("baselineId is required.");
  const items = [];
  collectPlaceItems(items, facts, retrievalWorkspace, normalizedOptions);
  collectCityItems(items, facts, retrievalWorkspace, normalizedOptions);
  collectDayItems(items, facts, retrievalWorkspace, normalizedOptions);
  collectGlobalItems(items, facts, retrievalWorkspace, normalizedOptions);

  const checklist = {
    schema_version: 1,
    baseline_id: normalizedOptions.baselineId,
    baseline_name: options.baselineName ?? normalizedOptions.baselineId,
    capability: options.capability ?? "retrieval_and_facts",
    version: Number(options.version ?? 1),
    created_at: now,
    source_run: normalizedOptions.sourceRun,
    items,
  };
  return assertValidChecklist(checklist);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
