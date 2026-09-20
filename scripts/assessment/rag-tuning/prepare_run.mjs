#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createParamsSnapshot } from "./lib/params_snapshot.mjs";
import { assertValidRunManifest } from "./lib/schemas.mjs";

function timestampForRunId(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}-${value.hour}${value.minute}`;
}

function safeTag(value) {
  return String(value ?? "run")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

function parseValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseSetArg(value) {
  const index = value.indexOf("=");
  if (index <= 0) throw new Error(`Invalid --set value: ${value}. Expected key=value.`);
  return [value.slice(0, index), parseValue(value.slice(index + 1))];
}

function parseArgs(argv) {
  const args = {
    baselineId: "",
    tag: "run",
    outRoot: "assessment/rag-tuning/runs",
    runDir: "",
    facts: "",
    retrievalWorkspace: "",
    retrievalLog: "",
    htmlDir: "",
    cliOverrides: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--baseline-id") args.baselineId = argv[++i];
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--out-root") args.outRoot = argv[++i];
    else if (arg === "--run-dir") args.runDir = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--retrieval-workspace") args.retrievalWorkspace = argv[++i];
    else if (arg === "--retrieval-log") args.retrievalLog = argv[++i];
    else if (arg === "--html-dir") args.htmlDir = argv[++i];
    else if (arg === "--cli-overrides") {
      args.cliOverrides = JSON.parse(fs.readFileSync(argv[++i], "utf8"));
    } else if (arg === "--set") {
      const [key, value] = parseSetArg(argv[++i]);
      args.cliOverrides[key] = value;
    } else if (arg === "--params-from-config") {
      // The current phase always snapshots the project config; keep the flag accepted for the planned CLI shape.
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!args.baselineId) throw new Error("Missing required --baseline-id <id>.");
  return args;
}

function relativePath(filePath, fromDir) {
  if (!filePath) return "";
  const resolved = path.resolve(filePath);
  const rel = path.relative(path.resolve(fromDir), resolved);
  return rel && !rel.startsWith("..") ? rel : resolved;
}

export function createAssessmentRun(args, now = new Date()) {
  const runId = `${timestampForRunId(now)}-${args.baselineId}-${safeTag(args.tag)}`;
  const runDir = path.resolve(args.runDir || path.join(args.outRoot, runId));
  fs.mkdirSync(runDir, { recursive: true });

  const params = createParamsSnapshot({ cliOverrides: args.cliOverrides });
  fs.writeFileSync(path.join(runDir, "params.json"), `${JSON.stringify(params, null, 2)}\n`, "utf8");

  const manifest = {
    schema_version: 1,
    run_id: path.basename(runDir),
    baseline_id: args.baselineId,
    created_at: new Date(now).toISOString(),
    paths: {
      facts_workspace: relativePath(args.facts, runDir),
      retrieval_workspace: relativePath(args.retrievalWorkspace, runDir),
      retrieval_log: relativePath(args.retrievalLog, runDir),
      html_dir: relativePath(args.htmlDir, runDir),
      params: "params.json",
    },
    params,
  };
  assertValidRunManifest(manifest);
  fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { runDir, manifest };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runDir } = createAssessmentRun(args);
  console.log(`Created assessment run at ${runDir}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
