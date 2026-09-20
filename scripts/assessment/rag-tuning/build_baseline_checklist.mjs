#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildChecklistFromFacts, readJson } from "./lib/checklist.mjs";
import { loadEvidenceIndex, verifyEvidenceRefs } from "./lib/evidence_access.mjs";

function parseArgs(argv) {
  const args = {
    baselineId: "",
    baselineName: "",
    capability: "retrieval_and_facts",
    sourceDir: "",
    facts: "",
    retrievalWorkspace: "",
    ragIndex: "",
    out: "",
    version: 1,
    allowUnverified: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline-id") args.baselineId = argv[++i];
    else if (arg === "--baseline-name") args.baselineName = argv[++i];
    else if (arg === "--capability") args.capability = argv[++i];
    else if (arg === "--source-dir") args.sourceDir = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--retrieval-workspace") args.retrievalWorkspace = argv[++i];
    else if (arg === "--rag-index") args.ragIndex = argv[++i];
    else if (arg === "--out" || arg === "-o") args.out = argv[++i];
    else if (arg === "--version") args.version = Number(argv[++i]);
    else if (arg === "--allow-unverified") args.allowUnverified = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.baselineId) throw new Error("Missing required --baseline-id <id>.");
  if (!args.facts) throw new Error("Missing required --facts <facts-workspace.json>.");
  if (!args.out) throw new Error("Missing required --out <checklist.json>.");
  if (!Number.isInteger(args.version) || args.version <= 0) throw new Error("--version must be a positive integer.");
  return args;
}

function existingPath(filePath) {
  return filePath && fs.existsSync(filePath) ? filePath : "";
}

export function buildBaselineChecklistFromFiles(args) {
  const facts = readJson(args.facts);
  const retrievalWorkspace = args.retrievalWorkspace ? readJson(args.retrievalWorkspace) : null;
  const checklist = buildChecklistFromFacts(facts, retrievalWorkspace, {
    baselineId: args.baselineId,
    baselineName: args.baselineName || args.baselineId,
    capability: args.capability,
    sourceRun: args.sourceDir || path.dirname(args.facts),
    ragIndexPath: args.ragIndex || "",
    retrievalWorkspacePath: args.retrievalWorkspace || "",
    version: args.version,
    allowUnverified: args.allowUnverified,
  });

  const evidenceOptions = {
    ragIndexPath: existingPath(args.ragIndex),
    retrievalWorkspacePath: existingPath(args.retrievalWorkspace),
  };
  if (evidenceOptions.ragIndexPath || evidenceOptions.retrievalWorkspacePath) {
    const evidenceIndex = loadEvidenceIndex(evidenceOptions);
    const missing = verifyEvidenceRefs(checklist, evidenceIndex);
    if (missing.length) {
      throw new Error(`Checklist contains missing evidence refs: ${missing.map((item) => `${item.item_id}:${item.chunk_id}`).join(", ")}`);
    }
  } else if (checklist.items.length) {
    throw new Error("Checklist has items but no evidence source was provided.");
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(checklist, null, 2)}\n`, "utf8");
  return checklist;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const checklist = buildBaselineChecklistFromFiles(args);
  console.log(`Wrote ${args.out} with ${checklist.items.length} checklist items.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
