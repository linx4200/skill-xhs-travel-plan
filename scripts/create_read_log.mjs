#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    index: "",
    queue: "",
    digest: "",
    out: "read-log.json",
    reason: "source_digest_review",
    includeUnreviewed: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--index") args.index = argv[++i];
    else if (arg === "--queue") args.queue = argv[++i];
    else if (arg === "--digest") args.digest = argv[++i];
    else if (arg === "--reason") args.reason = argv[++i];
    else if (arg === "--include-unreviewed") args.includeUnreviewed = true;
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.queue && !args.digest) {
    throw new Error(
      "Usage: node scripts/create_read_log.mjs [--index <resource-index.json>] (--queue <reading-queue.json> | --digest <source-digest.json>) [-o read-log.json] [--reason <reason>] [--include-unreviewed]",
    );
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function maybeReadJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function toPosix(value) {
  return String(value ?? "").split(path.sep).join("/");
}

function normalizePath(value) {
  return toPosix(value).replace(/^\.\//, "").trim();
}

function buildCharCountLookup(index) {
  const lookup = new Map();
  for (const file of index?.files ?? []) {
    const filePath = normalizePath(file.path);
    if (!filePath) continue;
    lookup.set(filePath, Number(file.char_count ?? 0));
    const basename = path.posix.basename(filePath);
    if (!lookup.has(basename)) lookup.set(basename, Number(file.char_count ?? 0));
  }
  return lookup;
}

function charsForFile(file, lookup) {
  const explicit = Number(file?.char_count);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const filePath = normalizePath(file?.path);
  if (lookup.has(filePath)) return lookup.get(filePath);

  const basename = path.posix.basename(filePath);
  if (lookup.has(basename)) return lookup.get(basename);

  return 0;
}

function targetsFromConsumers(consumers) {
  const targets = [];
  for (const consumer of asList(consumers)) {
    const type = String(consumer?.type ?? "").trim();
    const name = String(consumer?.name ?? "").trim();
    if (!type || !name) continue;
    if (!targets.some((target) => target.type === type && target.name === name)) {
      targets.push({ type, name });
    }
  }
  return targets;
}

function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / 1.5);
}

function sourceFiles(args) {
  if (args.digest) {
    const digest = readJson(args.digest);
    return {
      sourceKind: "source_digest",
      sourcePath: path.resolve(args.digest),
      files: asList(digest.files).filter((file) => args.includeUnreviewed || file?.reviewed === true),
      resourceRoot: digest.source?.resource_root ?? "",
      inferredFrom: args.includeUnreviewed ? "source_digest.files" : "source_digest.reviewed_files",
    };
  }

  const queue = readJson(args.queue);
  return {
    sourceKind: "reading_queue",
    sourcePath: path.resolve(args.queue),
    files: asList(queue.files),
    resourceRoot: queue.source?.resource_root ?? "",
    inferredFrom: "reading_queue.files",
  };
}

function buildReadLog(args) {
  const index = maybeReadJson(args.index);
  const lookup = buildCharCountLookup(index);
  const source = sourceFiles(args);
  const events = [];

  for (const file of source.files) {
    const filePath = normalizePath(file?.path);
    if (!filePath) continue;
    const chars = charsForFile(file, lookup);
    events.push({
      path: filePath,
      mode: "full_file",
      chars,
      tokens_estimated: estimateTokens(chars),
      reason: args.reason,
      targets: targetsFromConsumers(file?.consumers),
      inferred: true,
      inferred_from: source.inferredFrom,
    });
  }

  const actualLoadedChars = events.reduce((total, event) => total + Number(event.chars ?? 0), 0);
  const actualLoadedTokens = events.reduce((total, event) => total + Number(event.tokens_estimated ?? 0), 0);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: {
      kind: source.sourceKind,
      path: source.sourcePath,
      resource_root: source.resourceRoot,
      resource_index: args.index ? path.resolve(args.index) : null,
    },
    stats: {
      event_count: events.length,
      full_file_read_count: events.filter((event) => event.mode === "full_file").length,
      unique_loaded_file_count: new Set(events.map((event) => event.path)).size,
      actual_loaded_chars: actualLoadedChars,
      actual_loaded_tokens_estimated: actualLoadedTokens,
      token_estimation_method: "ceil(chars / 1.5)",
    },
    events,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReadLog(args);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `Created read log with ${report.stats.event_count} events and ${report.stats.actual_loaded_chars} loaded chars.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
