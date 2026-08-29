#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_PATTERNS = ["资料来源", "餐饮节奏", "占位图", "placeholder", "http://", "https://", "<script", "<iframe"];
const GENERIC_CITY_PATTERNS = [
  "本行程中承担",
  "出发基地",
  "连续住宿",
  "便于补给",
  "便于次日出发",
  "未给出",
  "材料未说明",
  "具体玩法未说明",
  "可作为",
];
const PLACE_FACT_KEYS = [
  "summary",
  "elevation_m",
  "highlights",
  "drawbacks",
  "opening_hours",
  "tickets",
  "duration",
  "routes",
  "play_options",
  "practical_info",
  "notes",
  "conflicts",
];
const CITY_FACT_KEYS = ["summary", "elevation_m", "overview", "backup_places", "foods", "lodging", "transport", "shopping", "notes"];

function parseArgs(argv) {
  const args = {
    route: "",
    facts: "",
    outputDir: "",
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--route") args.route = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.route || !args.facts || !args.outputDir || !args.out) {
    throw new Error(
      "Usage: node script/assessment/assess_quality.mjs --route <route-structure.json> --facts <facts-workspace.json> --output-dir <html-output-dir> -o <quality-metrics.json>",
    );
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    for (const key of ["text", "summary", "name", "title", "value"]) {
      if (item[key]) return String(item[key]);
    }
    return JSON.stringify(item);
  }
  return String(item ?? "");
}

function textList(value) {
  return asList(value)
    .map(textOf)
    .map((text) => text.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function htmlFiles(outDir, pattern = /\.html$/) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((name) => pattern.test(name))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((name) => path.join(outDir, name));
}

function dayFileFor(day, index) {
  const dayNo = Number(day.day || index + 1);
  return `day-${String(dayNo).padStart(2, "0")}.html`;
}

function routeDays(route) {
  return asList(route.days).map((day, index) => ({
    ...day,
    day: Number(day.day || index + 1),
    route_places: uniqueStrings(asList(day.route_places ?? day.places)),
    html_file: dayFileFor(day, index),
  }));
}

function allRoutePlaces(days) {
  return uniqueStrings(days.flatMap((day) => day.route_places));
}

function hasTextValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasTextValue);
  if (typeof value === "object") return Object.values(value).some(hasTextValue);
  return String(value).trim().length > 0;
}

function placeHasContent(placeFacts) {
  return PLACE_FACT_KEYS.some((key) => hasTextValue(placeFacts?.[key]));
}

function htmlDecode(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return htmlDecode(String(value ?? "").replace(/<[^>]*>/g, " "));
}

function normalizeText(value) {
  return stripTags(value).replace(/\s+/g, " ").trim();
}

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

function extractLinks(text) {
  const links = [];
  for (const match of text.matchAll(/\s(href|src)="([^"]+)"/g)) {
    links.push({ kind: match[1], value: match[2] });
  }
  return links;
}

function verifyHtml(outDir) {
  const forbidden = [];
  const brokenLinks = [];
  const missingPhotos = [];
  const remoteResources = [];
  const verifyErrors = [];

  if (!fs.existsSync(outDir)) {
    verifyErrors.push(`output directory does not exist: ${outDir}`);
    return { forbidden, brokenLinks, missingPhotos, remoteResources, verifyErrors };
  }

  for (const filePath of htmlFiles(outDir)) {
    const text = readText(filePath);
    const name = path.basename(filePath);
    if (!text.includes('<link rel="stylesheet" href="reading-first.css">')) {
      verifyErrors.push(`${name}: missing reading-first.css link`);
    }
    if (!text.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0">')) {
      verifyErrors.push(`${name}: missing viewport meta`);
    }

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (text.includes(pattern)) {
        const item = { file: name, pattern };
        forbidden.push(item);
        verifyErrors.push(`${name}: forbidden pattern found: ${pattern}`);
      }
    }

    for (const { kind, value } of extractLinks(text)) {
      if (/^https?:\/\//i.test(value)) {
        remoteResources.push({ file: name, kind, value });
      }
      if (kind === "src" && !value.startsWith("assets/photos/")) {
        verifyErrors.push(`${name}: image source is not under assets/photos/: ${value}`);
      }
      if (!localTargetExists(outDir, value)) {
        const item = { file: name, kind, value };
        brokenLinks.push(item);
        verifyErrors.push(`${name}: missing linked target: ${value}`);
        if (kind === "src") missingPhotos.push(item);
      }
    }
  }

  const indexPath = path.join(outDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    verifyErrors.push("missing index.html");
  } else {
    const index = readText(indexPath);
    if (index.includes('nav class="page-nav"')) verifyErrors.push("index.html: must not contain nav.page-nav");
    if (!/生成时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(index)) verifyErrors.push("index.html: missing generated time");
    if (!index.includes('<ol class="timeline">')) verifyErrors.push("index.html: missing ol.timeline");
    if (/<a href="day-\d{2}\.html"><strong>.*?<\/strong><\/a>\s*<p>.*?<\/p>\s*<ul>/s.test(index)) {
      verifyErrors.push("index.html: day timeline must not contain detail ul lists");
    }
    for (const dayFile of htmlFiles(outDir, /^day-\d{2}\.html$/)) {
      const name = path.basename(dayFile);
      if (!index.includes(`href="${name}"`)) verifyErrors.push(`index.html: missing link to ${name}`);
    }
  }

  for (const filePath of htmlFiles(outDir, /^day-\d{2}\.html$/)) {
    const text = readText(filePath);
    const name = path.basename(filePath);
    if ((text.match(/nav class="page-nav"/g) ?? []).length < 2) {
      verifyErrors.push(`${name}: expected top and bottom page-nav`);
    }
    if (!text.includes('<ol class="timeline">')) verifyErrors.push(`${name}: missing ol.timeline`);
  }

  const index = fs.existsSync(indexPath) ? readText(indexPath) : "";
  for (const filePath of htmlFiles(outDir, /^city-\d{2}\.html$/)) {
    const text = readText(filePath);
    const name = path.basename(filePath);
    if (!text.includes('href="index.html"')) verifyErrors.push(`${name}: missing return-home link`);
    if (!index.includes(`href="${name}"`)) verifyErrors.push(`index.html: missing link to ${name}`);
  }

  return { forbidden, brokenLinks, missingPhotos, remoteResources, verifyErrors };
}

function coverageMetrics(days, facts, outDir) {
  const total = days.reduce((count, day) => count + day.route_places.length, 0);
  const covered = [];
  const emptyPlaces = [];
  const missing = [];

  for (const day of days) {
    const htmlPath = path.join(outDir, day.html_file);
    const html = fs.existsSync(htmlPath) ? readText(htmlPath) : "";
    for (const place of day.route_places) {
      const factsForPlace = facts.places?.[place];
      const hasContent = placeHasContent(factsForPlace);
      const appearsInHtml = html.includes(place);
      const item = { day: day.day, place, html_file: day.html_file, has_content: hasContent, appears_in_html: appearsInHtml };
      if (hasContent && appearsInHtml) covered.push(item);
      else missing.push(item);
      if (!hasContent) emptyPlaces.push(item);
    }
  }

  return {
    route_place_coverage: total > 0 ? Number((covered.length / total).toFixed(4)) : null,
    empty_required_place_count: emptyPlaces.length,
    details: { covered_route_places: covered, missing_route_places: missing, empty_required_places: emptyPlaces },
  };
}

function wrongAttributionCandidates(days, routePlaces, facts, outDir) {
  const candidates = [];
  for (const day of days) {
    const htmlPath = path.join(outDir, day.html_file);
    if (!fs.existsSync(htmlPath)) continue;
    const text = normalizeText(readText(htmlPath));
    const allowed = new Set(day.route_places);
    for (const place of routePlaces) {
      if (allowed.has(place)) continue;
      if (!text.includes(place)) continue;
      candidates.push({
        type: "other_route_place_in_day_page",
        file: day.html_file,
        day: day.day,
        place,
        expected_day_places: day.route_places,
      });
    }
  }

  const includedCities = Object.entries(facts.cities ?? {}).filter(([, data]) => data?.include === true);
  includedCities.forEach(([city], index) => {
    const file = `city-${String(index + 1).padStart(2, "0")}.html`;
    const htmlPath = path.join(outDir, file);
    if (!fs.existsSync(htmlPath)) return;
    const text = normalizeText(readText(htmlPath));
    for (const place of routePlaces) {
      if (!text.includes(place)) continue;
      const relatedDay = days.find((day) => day.route_places.includes(place));
      const cityLikelyRelated =
        place.includes(city) ||
        relatedDay?.lodging_city === city ||
        facts.places?.[place]?.source_files?.some((source) => String(source).includes(city));
      if (!cityLikelyRelated) {
        candidates.push({ type: "route_place_in_unrelated_city_page", file, city, place });
      }
    }
  });

  return candidates;
}

function textItemsFromFactsObject(value, location, output = []) {
  if (value === null || value === undefined || value === "") return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => textItemsFromFactsObject(item, `${location}[${index}]`, output));
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (["source_files", "photos", "elevation_source_url", "elevation_checked_at"].includes(key)) continue;
      textItemsFromFactsObject(child, `${location}.${key}`, output);
    }
    return output;
  }
  const text = String(value).trim();
  if (text) output.push({ location, text });
  return output;
}

function factItemsForTraceability(facts) {
  const items = [];
  for (const [place, data] of Object.entries(facts.places ?? {})) {
    for (const key of PLACE_FACT_KEYS) {
      textItemsFromFactsObject(data?.[key], `places.${place}.${key}`, items);
    }
  }
  for (const [city, data] of Object.entries(facts.cities ?? {})) {
    for (const key of CITY_FACT_KEYS) {
      textItemsFromFactsObject(data?.[key], `cities.${city}.${key}`, items);
    }
  }
  textItemsFromFactsObject(facts.global_notes, "global_notes", items);
  textItemsFromFactsObject(facts.confirm_before_departure, "confirm_before_departure", items);
  return items;
}

function sourceTraceability(facts) {
  const items = factItemsForTraceability(facts);
  const traceable = items.filter((item) => {
    const [, group, name] = item.location.match(/^(places|cities)\.([^.]+)\./) ?? [];
    if (!group || !name) return false;
    const parent = facts[group]?.[name];
    return Array.isArray(parent?.source_files) && parent.source_files.length > 0;
  });
  return {
    source_traceability_ratio: items.length > 0 ? Number((traceable.length / items.length).toFixed(4)) : null,
    details: {
      total_fact_items: items.length,
      traceable_fact_items: traceable.length,
      untraceable_fact_items: items.filter((item) => !traceable.includes(item)).slice(0, 100),
    },
  };
}

function htmlTextFragments(outDir) {
  const fragments = [];
  for (const filePath of htmlFiles(outDir)) {
    const file = path.basename(filePath);
    const html = readText(filePath);
    for (const match of html.matchAll(/<(p|li|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const text = normalizeText(match[2]);
      if (text.length >= 12 && !text.startsWith("生成时间：")) {
        fragments.push({ file, tag: match[1].toLowerCase(), text });
      }
    }
  }
  return fragments;
}

function duplicateContentCandidates(outDir) {
  const groups = new Map();
  for (const fragment of htmlTextFragments(outDir)) {
    const key = fragment.text.replace(/[，。；：、,.!！?？]/g, "").replace(/\s+/g, "");
    if (key.length < 12) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fragment);
  }

  return [...groups.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({
      text: items[0].text,
      count: items.length,
      occurrences: items.map(({ file, tag }) => ({ file, tag })),
    }));
}

function cityNoiseCandidates(facts, routePlaces) {
  const candidates = [];
  const placeTexts = [];
  for (const [place, data] of Object.entries(facts.places ?? {})) {
    for (const item of textItemsFromFactsObject(data, `places.${place}`)) {
      if (item.text.length >= 12) placeTexts.push({ place, text: item.text });
    }
  }

  for (const [city, data] of Object.entries(facts.cities ?? {})) {
    if (data?.include !== true) continue;
    const cityItems = textItemsFromFactsObject(data, `cities.${city}`);
    for (const item of cityItems) {
      const text = item.text;
      if (!text || item.location.endsWith(".elevation_m")) continue;

      for (const pattern of GENERIC_CITY_PATTERNS) {
        if (text.includes(pattern)) {
          candidates.push({ type: "generic_or_low_value_city_text", city, location: item.location, pattern, text });
          break;
        }
      }

      for (const routePlace of routePlaces) {
        if (!text.includes(routePlace)) continue;
        candidates.push({ type: "city_text_mentions_route_place", city, location: item.location, route_place: routePlace, text });
      }

      const duplicate = placeTexts.find((placeItem) => placeItem.text === text);
      if (duplicate) {
        candidates.push({
          type: "city_text_duplicates_place_fact",
          city,
          location: item.location,
          duplicated_place: duplicate.place,
          text,
        });
      }
    }
  }

  const unique = new Map();
  for (const candidate of candidates) {
    const key = [candidate.type, candidate.city, candidate.location, candidate.route_place ?? candidate.pattern ?? "", candidate.text].join("\u0000");
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function buildReport(args) {
  const route = readJson(args.route);
  const facts = readJson(args.facts);
  const outDir = path.resolve(args.outputDir);
  const days = routeDays(route);
  const routePlaces = allRoutePlaces(days);

  const coverage = coverageMetrics(days, facts, outDir);
  const verify = verifyHtml(outDir);
  const wrongAttribution = wrongAttributionCandidates(days, routePlaces, facts, outDir);
  const cityNoise = cityNoiseCandidates(facts, routePlaces);
  const duplicates = duplicateContentCandidates(outDir);
  const traceability = sourceTraceability(facts);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    metric_set: "travel_plan_quality_metrics",
    inputs: {
      route_structure: path.resolve(args.route),
      facts_workspace: path.resolve(args.facts),
      html_output_dir: outDir,
    },
    metrics: {
      route_place_coverage: coverage.route_place_coverage,
      empty_required_place_count: coverage.empty_required_place_count,
      wrong_attribution_candidate_count: wrongAttribution.length,
      city_noise_candidate_count: cityNoise.length,
      duplicate_content_count: duplicates.reduce((total, item) => total + item.count - 1, 0),
      final_verify_pass: verify.verifyErrors.length === 0,
      broken_link_count: verify.brokenLinks.length,
      missing_photo_count: verify.missingPhotos.length,
      remote_resource_count: verify.remoteResources.length,
      forbidden_section_count: verify.forbidden.length,
      source_traceability_ratio: traceability.source_traceability_ratio,
    },
    details: {
      ...coverage.details,
      wrong_attribution_candidates: wrongAttribution,
      city_noise_candidates: cityNoise,
      duplicate_content_candidates: duplicates,
      source_traceability: traceability.details,
      broken_links: verify.brokenLinks,
      missing_photos: verify.missingPhotos,
      remote_resources: verify.remoteResources,
      forbidden_sections: verify.forbidden,
      verify_errors: verify.verifyErrors,
    },
    warnings: [
      "wrong_attribution_candidate_count, city_noise_candidate_count, and duplicate_content_count are review candidates only.",
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${args.out}: route coverage ${report.metrics.route_place_coverage ?? "n/a"}, verify ${report.metrics.final_verify_pass ? "passed" : "failed"}, ${report.metrics.wrong_attribution_candidate_count} attribution candidates, ${report.metrics.city_noise_candidate_count} city-noise candidates.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
