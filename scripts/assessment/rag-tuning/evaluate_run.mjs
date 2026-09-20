#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyCoverageOverrides, createAdjudicationSkeleton } from "./lib/adjudication.mjs";
import { evaluateFactsLayer } from "./lib/facts_metrics.mjs";
import { evaluateHtmlLayer } from "./lib/html_metrics.mjs";
import { evaluateRetrievalLayer } from "./lib/retrieval_metrics.mjs";
import { computeNewItemEffect, createDeltas, createNewItemDeltas, createReport, writeAssessmentOutputs } from "./lib/report_writer.mjs";
import { assertValidAdjudications, assertValidChecklist, assertValidRunManifest } from "./lib/schemas.mjs";

function parseArgs(argv) {
  const args = {
    baseline: "",
    run: "",
    htmlDir: "",
    adjudications: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") args.baseline = argv[++i];
    else if (arg === "--run") args.run = argv[++i];
    else if (arg === "--html-dir") args.htmlDir = argv[++i];
    else if (arg === "--adjudications") args.adjudications = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.baseline) throw new Error("Missing required --baseline <checklist.json>.");
  if (!args.run) throw new Error("Missing required --run <assessment-run-dir>.");
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveRunPath(runDir, value, fallbackName = "") {
  const candidate = value || fallbackName;
  if (!candidate) return "";
  return path.isAbsolute(candidate) ? candidate : path.resolve(runDir, candidate);
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function requireJson(label, filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`Missing required ${label}: ${filePath || "(empty path)"}`);
  return readJson(filePath);
}

function loadRunManifest(runDir) {
  const manifestPath = path.join(runDir, "run.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing run manifest: ${manifestPath}`);
  return assertValidRunManifest(readJson(manifestPath));
}

function writeAdjudicationSkeletonIfMissing(runDir, runId, factsEvaluation, htmlEvaluation, adjudicationPath) {
  const skeleton = createAdjudicationSkeleton(runId, factsEvaluation);
  const htmlReviewItems = (htmlEvaluation?.adjudication_needed ?? []).map((item) => ({
    item_id: item.item_id,
    target_type: item.target_type,
    target_name: item.target_name,
    theme: item.theme,
    criticality: item.criticality,
    current_assessment: "rendered_low_confidence",
    reason: item.reason,
    matched_hints: item.matched_hints,
  }));
  skeleton.coverage_review_items.push(...htmlReviewItems);
  assertValidAdjudications(skeleton);
  fs.writeFileSync(adjudicationPath, `${JSON.stringify(skeleton, null, 2)}\n`, "utf8");
  return skeleton;
}

export function evaluateAssessmentRun({ baselinePath, runDir, htmlDir = "", adjudicationsPath = "" }) {
  const resolvedRunDir = path.resolve(runDir);
  const checklist = assertValidChecklist(requireJson("baseline checklist", path.resolve(baselinePath)));
  const runManifest = loadRunManifest(resolvedRunDir);
  if (runManifest.baseline_id !== checklist.baseline_id) {
    throw new Error(`Baseline mismatch: run uses ${runManifest.baseline_id}, checklist is ${checklist.baseline_id}.`);
  }

  const factsPath = resolveRunPath(resolvedRunDir, runManifest.paths?.facts_workspace, "facts-workspace.json");
  const retrievalWorkspacePath = resolveRunPath(resolvedRunDir, runManifest.paths?.retrieval_workspace, "retrieval-workspace.json");
  const retrievalLogPath = resolveRunPath(resolvedRunDir, runManifest.paths?.retrieval_log, "retrieval-log.json");
  const resolvedHtmlDir = htmlDir || resolveRunPath(resolvedRunDir, runManifest.paths?.html_dir);
  const resolvedAdjudicationsPath = adjudicationsPath
    ? path.resolve(adjudicationsPath)
    : path.join(resolvedRunDir, "adjudications.json");

  const facts = requireJson("facts workspace", factsPath);
  const retrievalWorkspace = requireJson("retrieval workspace", retrievalWorkspacePath);
  const retrievalLog = readOptionalJson(retrievalLogPath);
  const existingAdjudications = readOptionalJson(resolvedAdjudicationsPath);
  if (existingAdjudications) assertValidAdjudications(existingAdjudications);

  const retrievalEvaluation = evaluateRetrievalLayer(checklist, retrievalWorkspace, retrievalLog);
  const rawFactsEvaluation = evaluateFactsLayer(checklist, facts, retrievalEvaluation);
  const factsEvaluation = existingAdjudications
    ? applyCoverageOverrides(rawFactsEvaluation, existingAdjudications)
    : rawFactsEvaluation;
  const htmlEvaluation = evaluateHtmlLayer(checklist, resolvedHtmlDir, factsEvaluation);
  const adjudications = existingAdjudications
    ?? writeAdjudicationSkeletonIfMissing(resolvedRunDir, runManifest.run_id, factsEvaluation, htmlEvaluation, resolvedAdjudicationsPath);
  const newItems = createNewItemDeltas({ checklist, facts, retrievalWorkspace, runManifest });
  const newItemEffect = computeNewItemEffect({ checklist, newItems, retrievalWorkspace });
  const deltas = createDeltas({
    checklist,
    runId: runManifest.run_id,
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
    newItems,
    newItemEffect,
  });
  const report = createReport({
    checklist,
    runManifest,
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
    adjudications,
    deltas,
  });

  writeAssessmentOutputs(resolvedRunDir, { report, deltas });
  return {
    runDir: resolvedRunDir,
    report,
    deltas,
    retrievalEvaluation,
    factsEvaluation,
    htmlEvaluation,
    adjudications,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = evaluateAssessmentRun({
    baselinePath: args.baseline,
    runDir: args.run,
    htmlDir: args.htmlDir,
    adjudicationsPath: args.adjudications,
  });
  console.log(`Assessment ${result.report.conclusion}: ${path.join(result.runDir, "report.md")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
