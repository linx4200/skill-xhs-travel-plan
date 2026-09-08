#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    testPath: "test.json",
    logsPath: "logs.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--test") args.testPath = argv[++i];
    else if (arg === "--logs") args.logsPath = argv[++i];
    else {
      throw new Error("Usage: node scripts/rag/print_chunks_above_baseline.mjs [--test test.json] [--logs logs.json]");
    }
  }

  if (!args.testPath) throw new Error("Missing value for --test.");
  if (!args.logsPath) throw new Error("Missing value for --logs.");
  return args;
}

function readJson(filePath) {
  const absolutePath = path.resolve(filePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON from ${absolutePath}: ${error.message}`);
  }
}

function requireNumber(value, fieldPath) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldPath} must be a finite number.`);
  }
  return value;
}

function requestList(logs) {
  if (Array.isArray(logs.requests)) return logs.requests;
  if (logs.requests && typeof logs.requests === "object") return [logs.requests];
  throw new Error("logs.json must contain requests as an array or object.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const test = readJson(args.testPath);
  const logs = readJson(args.logsPath);

  if (!Array.isArray(test.results) || test.results.length === 0) {
    throw new Error("test.json must contain a non-empty results array.");
  }

  const scores = test.results.map((result, index) => requireNumber(result?.score, `test.json results[${index}].score`));
  const baseline = Math.max(...scores);
  const matches = [];

  for (const request of requestList(logs)) {
    const chunks = request?.chunks;
    if (!Array.isArray(chunks)) continue;

    for (const chunk of chunks) {
      const total = chunk?.score?.total;
      if (typeof total === "number" && Number.isFinite(total) && total > baseline) {
        matches.push(chunk);
      }
    }
  }

  console.error(`Baseline score: ${baseline}`);
  console.error(`Matched chunks: ${matches.length}`);
  console.log(JSON.stringify(matches, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
