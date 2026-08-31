#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    index: "",
    facts: "",
    out: "",
    readingQueue: "",
    sourceDigest: "",
    readLog: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--index") args.index = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--reading-queue") args.readingQueue = argv[++i];
    else if (arg === "--source-digest") args.sourceDigest = argv[++i];
    else if (arg === "--read-log") args.readLog = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.index || !args.facts || !args.out) {
    throw new Error(
      "Usage: node scripts/assessment/assess_sources.mjs --index <resource-index.json> --facts <facts-workspace.json> [-o <cost-metrics.json>] [--reading-queue <reading-queue.json>] [--source-digest <source-digest.json>] [--read-log <read-log.json>]",
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

function toPosix(value) {
  return String(value ?? "").split(path.sep).join("/");
}

function normalizeSourcePath(value) {
  return toPosix(value).replace(/^\.\//, "").trim();
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + numberOrZero(value), 0);
}

function photoCount(index) {
  return sum(Object.values(index.photos ?? {}).map((items) => (Array.isArray(items) ? items.length : 0)));
}

function buildCharCountLookup(index) {
  const lookup = new Map();
  for (const file of index.files ?? []) {
    const filePath = normalizeSourcePath(file.path);
    if (!filePath) continue;
    const charCount = numberOrZero(file.char_count);
    lookup.set(filePath, charCount);

    const basename = path.posix.basename(filePath);
    if (!lookup.has(basename)) lookup.set(basename, charCount);
  }
  return lookup;
}

function collectSourceRefsFromGroup(group, groupType) {
  const refs = [];
  for (const [name, item] of Object.entries(group ?? {})) {
    for (const sourceFile of Array.isArray(item?.source_files) ? item.source_files : []) {
      const sourcePath = normalizeSourcePath(sourceFile);
      if (!sourcePath) continue;
      refs.push({ group_type: groupType, name, path: sourcePath });
    }
  }
  return refs;
}

function collectSourceRefs(facts) {
  return [
    ...collectSourceRefsFromGroup(facts.places, "place"),
    ...collectSourceRefsFromGroup(facts.cities, "city"),
  ];
}

function charsForPath(sourcePath, lookup) {
  const normalized = normalizeSourcePath(sourcePath);
  if (lookup.has(normalized)) return lookup.get(normalized);

  const basename = path.posix.basename(normalized);
  if (lookup.has(basename)) return lookup.get(basename);

  return null;
}

function sourceCharStats(sourceRefs, lookup) {
  const unresolved = new Set();
  const repeatedChars = sourceRefs.reduce((total, ref) => {
    const charCount = charsForPath(ref.path, lookup);
    if (charCount === null) {
      unresolved.add(ref.path);
      return total;
    }
    return total + charCount;
  }, 0);

  const uniqueSourcePaths = [...new Set(sourceRefs.map((ref) => ref.path))];
  const uniqueChars = uniqueSourcePaths.reduce((total, sourcePath) => {
    const charCount = charsForPath(sourcePath, lookup);
    if (charCount === null) {
      unresolved.add(sourcePath);
      return total;
    }
    return total + charCount;
  }, 0);

  return {
    unique_source_file_count: uniqueSourcePaths.length,
    unique_source_chars: uniqueChars,
    repeated_source_chars: repeatedChars,
    read_amplification: uniqueChars > 0 ? Number((repeatedChars / uniqueChars).toFixed(4)) : null,
    unresolved_source_files: [...unresolved].sort((a, b) => a.localeCompare(b, "zh-CN")),
  };
}

function candidateJsonPaths(args, basename) {
  const factsDir = path.dirname(path.resolve(args.facts));
  const indexDir = path.dirname(path.resolve(args.index));
  return [
    path.join(factsDir, basename),
    path.join(indexDir, basename),
    path.resolve(basename),
  ];
}

function firstExistingJson(paths) {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return "";
}

function queueFiles(readingQueue) {
  if (!readingQueue) return [];
  if (Array.isArray(readingQueue.files)) return readingQueue.files;
  if (Array.isArray(readingQueue)) return readingQueue;
  return [];
}

function digestFiles(sourceDigest) {
  if (!sourceDigest) return [];
  if (Array.isArray(sourceDigest.files)) return sourceDigest.files;
  if (Array.isArray(sourceDigest)) return sourceDigest;
  return [];
}

function countDigestFacts(facts) {
  if (Array.isArray(facts)) return facts.length;
  if (!facts || typeof facts !== "object") return 0;
  return Object.values(facts).reduce((total, value) => {
    if (Array.isArray(value)) return total + value.length;
    if (value && typeof value === "object") return total + countDigestFacts(value);
    return total;
  }, 0);
}

function optionalSourceMetrics(args, lookup) {
  const readingQueuePath =
    args.readingQueue || firstExistingJson(candidateJsonPaths(args, "reading-queue.json"));
  const sourceDigestPath =
    args.sourceDigest || firstExistingJson(candidateJsonPaths(args, "source-digest.json"));
  const readLogPath =
    args.readLog || firstExistingJson(candidateJsonPaths(args, "read-log.json"));

  const metrics = {
    reading_queue_file_count: null,
    reading_queue_chars: null,
    source_digest_file_count: null,
    source_digest_reviewed_count: null,
    digest_review_completion: null,
    source_digest_fact_count: null,
    read_log_event_count: null,
    full_file_read_count: null,
    unique_loaded_file_count: null,
    actual_loaded_chars: null,
    actual_loaded_tokens_estimated: null,
  };
  const inputs = {};
  const warnings = [];

  const readingQueue = maybeReadJson(readingQueuePath);
  if (readingQueue) {
    const files = queueFiles(readingQueue);
    metrics.reading_queue_file_count = files.length;
    metrics.reading_queue_chars = files.reduce((total, file) => {
      if (Number.isFinite(Number(file?.char_count))) return total + Number(file.char_count);
      const charCount = charsForPath(file?.path ?? file, lookup);
      if (charCount === null) return total;
      return total + charCount;
    }, 0);
    inputs.reading_queue = path.resolve(readingQueuePath);
  } else if (readingQueuePath) {
    warnings.push(`reading_queue_not_found: ${readingQueuePath}`);
  }

  const sourceDigest = maybeReadJson(sourceDigestPath);
  if (sourceDigest) {
    const files = digestFiles(sourceDigest);
    const reviewedCount = files.filter((file) => file?.reviewed === true).length;
    metrics.source_digest_file_count = files.length;
    metrics.source_digest_reviewed_count = reviewedCount;
    metrics.digest_review_completion = files.length > 0 ? Number((reviewedCount / files.length).toFixed(4)) : null;
    metrics.source_digest_fact_count = files.reduce((total, file) => total + countDigestFacts(file?.facts), 0);
    inputs.source_digest = path.resolve(sourceDigestPath);
  } else if (sourceDigestPath) {
    warnings.push(`source_digest_not_found: ${sourceDigestPath}`);
  }

  const readLog = maybeReadJson(readLogPath);
  if (readLog) {
    const events = Array.isArray(readLog.events) ? readLog.events : [];
    const fullFileEvents = events.filter((event) => event?.mode === "full_file");
    metrics.read_log_event_count = events.length;
    metrics.full_file_read_count = fullFileEvents.length;
    metrics.unique_loaded_file_count = new Set(events.map((event) => normalizeSourcePath(event?.path)).filter(Boolean)).size;
    metrics.actual_loaded_chars = events.reduce((total, event) => total + numberOrZero(event?.chars), 0);
    metrics.actual_loaded_tokens_estimated = events.reduce((total, event) => {
      if (Number.isFinite(Number(event?.tokens_estimated))) return total + Number(event.tokens_estimated);
      return total + Math.ceil(numberOrZero(event?.chars) / 1.5);
    }, 0);
    inputs.read_log = path.resolve(readLogPath);
  } else if (readLogPath) {
    warnings.push(`read_log_not_found: ${readLogPath}`);
  }

  return { metrics, inputs, warnings };
}

function buildReport(args) {
  const index = readJson(args.index);
  const facts = readJson(args.facts);
  const lookup = buildCharCountLookup(index);
  const sourceRefs = collectSourceRefs(facts);
  const stats = sourceCharStats(sourceRefs, lookup);
  const optional = optionalSourceMetrics(args, lookup);

  const metrics = {
    raw_material_file_count: Array.isArray(index.files) ? index.files.length : 0,
    raw_material_chars: sum((index.files ?? []).map((file) => file.char_count)),
    photo_count: photoCount(index),
    source_ref_count: sourceRefs.length,
    unique_source_file_count: stats.unique_source_file_count,
    unique_source_chars: stats.unique_source_chars,
    repeated_source_chars: stats.repeated_source_chars,
    read_amplification: stats.read_amplification,
    ...optional.metrics,
  };

  const warnings = [...optional.warnings];
  if (stats.unresolved_source_files.length > 0) {
    warnings.push(`unresolved_source_files: ${stats.unresolved_source_files.join(", ")}`);
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    metric_set: "travel_plan_cost_metrics",
    inputs: {
      resource_index: path.resolve(args.index),
      facts_workspace: path.resolve(args.facts),
      ...optional.inputs,
    },
    metrics,
    details: {
      source_refs: sourceRefs,
      unresolved_source_files: stats.unresolved_source_files,
    },
    warnings,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${args.out}: ${report.metrics.raw_material_file_count} raw files, ${report.metrics.source_ref_count} source refs, ${report.metrics.unique_source_file_count} unique source files, amplification ${report.metrics.read_amplification ?? "n/a"}.`,
  );
  if (report.warnings.length > 0) {
    console.warn(`Warnings: ${report.warnings.join("; ")}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
