#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CITY_THEMES,
  PLACE_THEMES,
  RAG_RERANK_DEFAULTS,
  RAG_RETRIEVAL_DEFAULTS,
  RAG_SCORING,
} from "../../../rag/rag_retrieval_config.mjs";

const DEFAULT_CONFIG_SOURCE = "scripts/rag/rag_retrieval_config.mjs";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

export function createParamsSnapshot(options = {}) {
  return {
    schema_version: 1,
    captured_at: options.capturedAt ?? nowIso(),
    config_source: options.configSource ?? DEFAULT_CONFIG_SOURCE,
    place_themes: cloneJson(PLACE_THEMES),
    city_themes: cloneJson(CITY_THEMES),
    rag_scoring: cloneJson(RAG_SCORING),
    retrieval_defaults: cloneJson(RAG_RETRIEVAL_DEFAULTS),
    rerank_defaults: cloneJson(RAG_RERANK_DEFAULTS),
    cli_overrides: cloneJson(options.cliOverrides ?? {}),
  };
}

export function writeParamsSnapshot(outPath, options = {}) {
  const snapshot = createParamsSnapshot(options);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
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
    out: "",
    capturedAt: "",
    configSource: "",
    cliOverrides: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") args.out = argv[++i];
    else if (arg === "--captured-at") args.capturedAt = argv[++i];
    else if (arg === "--config-source") args.configSource = argv[++i];
    else if (arg === "--cli-overrides") {
      const filePath = argv[++i];
      args.cliOverrides = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } else if (arg === "--set") {
      const [key, value] = parseSetArg(argv[++i]);
      args.cliOverrides[key] = value;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!args.out) throw new Error("Missing required --out <params.json>.");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = writeParamsSnapshot(args.out, {
    capturedAt: args.capturedAt || undefined,
    configSource: args.configSource || undefined,
    cliOverrides: args.cliOverrides,
  });
  console.log(`Wrote params snapshot to ${args.out} with ${Object.keys(snapshot.place_themes).length} place themes and ${Object.keys(snapshot.city_themes).length} city themes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
