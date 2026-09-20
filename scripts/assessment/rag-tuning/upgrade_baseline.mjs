#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertValidChecklist, assertValidDeltas, assertValidReport } from "./lib/schemas.mjs";

function parseArgs(argv) {
  const args = {
    baseline: "",
    run: "",
    acceptNewItems: [],
    out: "",
    changelog: "assessment/rag-tuning/CHANGELOG.md",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline") args.baseline = argv[++i];
    else if (arg === "--run") args.run = argv[++i];
    else if (arg === "--accept-new-items") {
      args.acceptNewItems = String(argv[++i]).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--changelog") args.changelog = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.baseline) throw new Error("Missing required --baseline <checklist.json>.");
  if (!args.run) throw new Error("Missing required --run <assessment-run-dir>.");
  if (!args.acceptNewItems.length) throw new Error("Missing required --accept-new-items <id,id>.");
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultOutPath(baselinePath, nextVersion) {
  const parsed = path.parse(baselinePath);
  return path.join(parsed.dir, `${parsed.name}.v${nextVersion}${parsed.ext}`);
}

function maxExistingNumber(items, baselineId) {
  let max = 0;
  const pattern = new RegExp(`^${baselineId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[a-z]+-(\\d+)$`);
  for (const item of items) {
    const match = String(item.id ?? "").match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function acceptedCandidateMap(deltas) {
  const map = new Map();
  for (const item of deltas.new_items ?? []) map.set(item.item_id, item);
  return map;
}

function itemKey(item) {
  return [
    item.target_type,
    item.target_name ?? "",
    item.theme,
    String(item.text ?? "").replace(/\s+/g, "").trim(),
  ].join("\u0000");
}

function ensureCanUpgrade({ baseline, report, deltas, acceptedIds }) {
  if (report.conclusion !== "PASS") {
    throw new Error(`Only PASS runs can upgrade a baseline. Current conclusion: ${report.conclusion}.`);
  }
  if (deltas.baseline_id !== baseline.baseline_id || report.baseline_id !== baseline.baseline_id) {
    throw new Error("Baseline id mismatch between checklist, report, and deltas.");
  }
  if ((deltas.unsupported_facts ?? []).length) throw new Error("Run has unsupported facts; resolve them before upgrading.");
  if ((deltas.duplicates ?? []).length) throw new Error("Run has duplicate/conflict records; resolve them before upgrading.");
  const candidates = acceptedCandidateMap(deltas);
  for (const id of acceptedIds) {
    if (!candidates.has(id)) throw new Error(`Accepted new item not found in deltas.new_items: ${id}`);
    if (!candidates.get(id).checklist_item) throw new Error(`New item lacks checklist_item payload: ${id}`);
  }
}

function appendChangelog(changelogPath, record) {
  fs.mkdirSync(path.dirname(path.resolve(changelogPath)), { recursive: true });
  if (!fs.existsSync(changelogPath)) {
    fs.writeFileSync(
      changelogPath,
      [
        "# RAG 调参评估体系变更记录",
        "",
        "| checklist_id | from | to | source_run | added_items | conflicts_pending | upgraded_at |",
        "|---|---|---|---|---|---|---|",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  const row = [
    record.checklist_id,
    `v${record.from_version}`,
    `v${record.to_version}`,
    record.source_run,
    record.added_items.join(", "),
    record.conflicts_pending.join(", ") || "无",
    record.upgraded_at,
  ];
  fs.appendFileSync(changelogPath, `| ${row.join(" | ")} |\n`, "utf8");
}

export function upgradeBaselineFromRun(args, now = new Date()) {
  const baselinePath = path.resolve(args.baseline);
  const runDir = path.resolve(args.run);
  const baseline = assertValidChecklist(readJson(baselinePath));
  const report = assertValidReport(readJson(path.join(runDir, "report.json")));
  const deltas = assertValidDeltas(readJson(path.join(runDir, "deltas.json")));
  const acceptedIds = args.acceptNewItems;

  ensureCanUpgrade({ baseline, report, deltas, acceptedIds });
  const candidates = acceptedCandidateMap(deltas);
  const existingKeys = new Set((baseline.items ?? []).map(itemKey));
  let nextNumber = maxExistingNumber(baseline.items ?? [], baseline.baseline_id) + 1;
  const addedItems = [];

  for (const candidateId of acceptedIds) {
    const source = candidates.get(candidateId).checklist_item;
    const candidateKey = itemKey(source);
    if (existingKeys.has(candidateKey)) continue;
    const formalId = `${baseline.baseline_id}-${source.target_type}-${String(nextNumber).padStart(4, "0")}`;
    nextNumber += 1;
    const item = {
      ...source,
      id: formalId,
      added_at: now.toISOString(),
      added_by: "assessment:upgrade",
      source_run: report.run_id,
    };
    addedItems.push(item);
    existingKeys.add(candidateKey);
  }

  if (!addedItems.length) throw new Error("No accepted new items remain after duplicate checks.");
  const upgraded = {
    ...baseline,
    version: Number(baseline.version) + 1,
    items: [...baseline.items, ...addedItems],
  };
  assertValidChecklist(upgraded);

  const outPath = path.resolve(args.out || defaultOutPath(baselinePath, upgraded.version));
  if (outPath === baselinePath) throw new Error("Refusing to overwrite the baseline file; provide a different --out path.");
  if (fs.existsSync(outPath)) throw new Error(`Output checklist already exists: ${outPath}`);
  writeJson(outPath, upgraded);

  const changelogPath = path.resolve(args.changelog || "assessment/rag-tuning/CHANGELOG.md");
  appendChangelog(changelogPath, {
    checklist_id: baseline.baseline_id,
    from_version: baseline.version,
    to_version: upgraded.version,
    source_run: report.run_id,
    added_items: addedItems.map((item) => item.id),
    conflicts_pending: [],
    upgraded_at: now.toISOString(),
  });

  return { outPath, upgraded, addedItems };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = upgradeBaselineFromRun(args);
  console.log(`Wrote upgraded baseline ${result.outPath} with ${result.addedItems.length} new items.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
