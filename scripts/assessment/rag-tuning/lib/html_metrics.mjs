import fs from "node:fs";
import path from "node:path";
import { htmlFiles, verifyOutput } from "../../../verify_output.mjs";

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).replace(/[，。；、：:,.!！?？\s"'“”‘’（）()[\]{}<>《》\-|｜]/g, "");
}

function stripHtml(html) {
  return String(html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function readHtmlTexts(htmlDir) {
  const files = htmlFiles(htmlDir);
  return files.map((filePath) => ({
    file: path.basename(filePath),
    text: stripHtml(fs.readFileSync(filePath, "utf8")),
  }));
}

function hintMatches(item, normalizedJoined) {
  const hints = asList(item.match_hints).map(normalizeText).filter((hint) => hint.length >= 2);
  if (!hints.length) return { matched: [], total: 0, ratio: 0 };
  const matched = hints.filter((hint) => normalizedJoined.includes(hint));
  return {
    matched,
    total: hints.length,
    ratio: matched.length / hints.length,
  };
}

function tokenRatio(item, normalizedJoined) {
  const tokens = normalizeText(item.text)
    .split(/[；;]/)
    .flatMap((part) => part.split(/[，。、]/))
    .map(cleanText)
    .map(normalizeText)
    .filter((part) => part.length >= 4);
  if (!tokens.length) return 0;
  return tokens.filter((token) => normalizedJoined.includes(token)).length / tokens.length;
}

export function assessHtmlCoverage(item, htmlTexts) {
  const joined = htmlTexts.map((entry) => entry.text).join(" ");
  const normalizedJoined = normalizeText(joined);
  const normalizedItemText = normalizeText(item.text);
  if (normalizedItemText && normalizedJoined.includes(normalizedItemText)) {
    return {
      rendered: true,
      confidence: "high",
      reason: "exact_item_text_found",
      matched_hints: asList(item.match_hints),
    };
  }
  const hints = hintMatches(item, normalizedJoined);
  if (hints.total && hints.ratio >= 0.5) {
    return {
      rendered: true,
      confidence: "low",
      reason: "match_hints_found",
      matched_hints: hints.matched,
    };
  }
  if (tokenRatio(item, normalizedJoined) >= 0.5) {
    return {
      rendered: true,
      confidence: "low",
      reason: "partial_text_overlap",
      matched_hints: hints.matched,
    };
  }
  return {
    rendered: false,
    confidence: "none",
    reason: "item_text_not_found",
    matched_hints: hints.matched,
  };
}

function factsResultMap(factsEvaluation) {
  const map = new Map();
  for (const result of asList(factsEvaluation?.item_results)) map.set(result.item_id, result);
  return map;
}

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function renderDropDelta(item, result) {
  return {
    item_id: item.id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    layer: "render",
    attribution_code: "render_drop",
    evidence: {
      text: item.text,
      html_reason: result.reason,
      facts_covered: result.facts_covered,
    },
    suggestion: "该项已进入 facts-workspace.json，但未在 HTML 中呈现；应检查渲染模板、页面归位或字段跳过逻辑。",
  };
}

export function evaluateHtmlLayer(checklist, htmlDir, factsEvaluation = null) {
  if (!htmlDir) {
    return {
      schema_version: 1,
      baseline_id: checklist?.baseline_id ?? "",
      status: "N/A",
      mechanical: {
        status: "N/A",
        verify_errors: [],
      },
      metrics: {
        CIR: { critical_items: 0, retained: 0, lost: 0, rate: null },
        N3: { misplaced_items: 0 },
        N8: { structure_complete: "N/A" },
        render_drop_count: 0,
        low_confidence_count: 0,
      },
      item_results: [],
      lost_items: [],
      adjudication_needed: [],
    };
  }

  const mechanical = verifyOutput(htmlDir);
  const htmlTexts = readHtmlTexts(htmlDir);
  const factsMap = factsResultMap(factsEvaluation);
  const itemResults = [];

  for (const item of asList(checklist?.items)) {
    const factsResult = factsMap.get(item.id);
    if (factsResult && !factsResult.covered) continue;
    const coverage = assessHtmlCoverage(item, htmlTexts);
    itemResults.push({
      item_id: item.id,
      target_type: item.target_type,
      target_name: item.target_name,
      theme: item.theme,
      criticality: item.criticality,
      facts_covered: factsResult ? Boolean(factsResult.covered) : null,
      rendered: coverage.rendered,
      confidence: coverage.confidence,
      reason: coverage.reason,
      matched_hints: coverage.matched_hints,
    });
  }

  const criticalResults = itemResults.filter((result) => result.criticality === "critical");
  const criticalRendered = criticalResults.filter((result) => result.rendered).length;
  const lowConfidence = itemResults.filter((result) => result.rendered && result.confidence === "low");
  const renderDrops = itemResults.filter((result) => !result.rendered);

  return {
    schema_version: 1,
    baseline_id: checklist?.baseline_id ?? "",
    status: "evaluated",
    mechanical: {
      status: mechanical.verifyErrors.length ? "FAIL" : "PASS",
      ...mechanical,
    },
    metrics: {
      CIR: {
        critical_items: criticalResults.length,
        retained: criticalRendered,
        lost: criticalResults.length - criticalRendered,
        rate: rate(criticalRendered, criticalResults.length),
      },
      N3: {
        misplaced_items: 0,
      },
      N8: {
        structure_complete: mechanical.verifyErrors.length ? false : true,
        html_file_count: htmlTexts.length,
      },
      render_drop_count: renderDrops.length,
      low_confidence_count: lowConfidence.length,
    },
    item_results: itemResults,
    lost_items: renderDrops.map((result) =>
      renderDropDelta(asList(checklist?.items).find((item) => item.id === result.item_id), result),
    ),
    adjudication_needed: lowConfidence.map((result) => ({
      item_id: result.item_id,
      target_type: result.target_type,
      target_name: result.target_name,
      theme: result.theme,
      criticality: result.criticality,
      reason: result.reason,
      matched_hints: result.matched_hints,
    })),
  };
}
