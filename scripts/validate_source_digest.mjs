#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const TARGET_TYPES = new Set(["place", "city", "day", "global", "confirmation"]);
const DAY_FIELDS = new Set(["notes", "confirmations"]);

function parseArgs(argv) {
  const args = {
    digest: "",
    facts: "",
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--digest") args.digest = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "-o" || arg === "--out") args.out = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.digest || !args.facts) {
    throw new Error("Usage: node scripts/validate_source_digest.mjs --digest <source-digest.json> --facts <facts-workspace.json> [-o validation-report.json]");
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function asList(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  return String(value ?? "").trim();
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digestFiles(digest) {
  if (Array.isArray(digest?.files)) return digest.files;
  if (Array.isArray(digest)) return digest;
  return [];
}

function collectArrayFields(object) {
  const fields = new Set();
  for (const [key, value] of Object.entries(object ?? {})) {
    if (Array.isArray(value)) fields.add(key);
  }
  return fields;
}

function buildFactsLookup(facts) {
  const places = new Set(Object.keys(facts.places ?? {}));
  const cities = new Set(Object.keys(facts.cities ?? {}));
  const placeFields = {};
  const cityFields = {};

  for (const [name, data] of Object.entries(facts.places ?? {})) {
    placeFields[name] = collectArrayFields(data);
  }
  for (const [name, data] of Object.entries(facts.cities ?? {})) {
    cityFields[name] = collectArrayFields(data);
  }

  const days = new Map();
  for (const day of asList(facts.trip?.days)) {
    for (const key of [day?.day, `day-${day?.day}`, `Day ${day?.day}`, day?.date, day?.title]) {
      const normalized = text(key);
      if (normalized) days.set(normalized, day);
    }
  }

  return { places, cities, placeFields, cityFields, days };
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

function countFileFacts(file) {
  return countDigestFacts(file?.facts);
}

function fileHasReviewedContent(file) {
  return countFileFacts(file) > 0 || nonEmptyArray(file?.conflicts) || nonEmptyArray(file?.global_notes);
}

function factLocation(file, index, fact) {
  const id = text(fact?.id);
  return [text(file?.path) || "(missing path)", id || `fact[${index}]`].join("#");
}

function validateFact(fact, context) {
  const { file, index, seenIds, lookup } = context;
  const errors = [];
  const warnings = [];
  const location = factLocation(file, index, fact);

  if (!isObject(fact)) {
    return {
      errors: [{ location, message: "fact must be an object" }],
      warnings,
    };
  }

  const id = text(fact.id);
  const targetType = text(fact.target_type);
  const targetName = text(fact.target_name);
  const field = text(fact.field);

  if (!id) {
    errors.push({ location, message: "fact.id is required" });
  } else if (seenIds.has(id)) {
    errors.push({ location, message: `duplicate fact.id: ${id}` });
  } else {
    seenIds.add(id);
  }

  if (!TARGET_TYPES.has(targetType)) {
    errors.push({ location, message: `invalid target_type: ${targetType || "(empty)"}` });
  }

  if (!field) {
    errors.push({ location, message: "fact.field is required" });
  }

  if (!nonEmptyArray(fact.items)) {
    errors.push({ location, message: "fact.items must be a non-empty array" });
  } else {
    for (const [itemIndex, item] of fact.items.entries()) {
      if (!text(item)) errors.push({ location, message: `fact.items[${itemIndex}] is empty` });
    }
  }

  if (targetType === "place") {
    if (!lookup.places.has(targetName)) {
      errors.push({ location, message: `unknown place target_name: ${targetName || "(empty)"}` });
    } else if (!lookup.placeFields[targetName]?.has(field)) {
      errors.push({ location, message: `unsupported place field: places.${targetName}.${field}` });
    }
  } else if (targetType === "city") {
    if (!lookup.cities.has(targetName)) {
      errors.push({ location, message: `unknown city target_name: ${targetName || "(empty)"}` });
    } else if (!lookup.cityFields[targetName]?.has(field)) {
      errors.push({ location, message: `unsupported city field: cities.${targetName}.${field}` });
    }
  } else if (targetType === "day") {
    if (!lookup.days.has(targetName)) {
      errors.push({ location, message: `unknown day target_name: ${targetName || "(empty)"}` });
    }
    if (!DAY_FIELDS.has(field)) {
      errors.push({ location, message: `unsupported day field: trip.days[].${field}` });
    }
  } else if (targetType === "global") {
    if (field !== "global_notes") {
      errors.push({ location, message: `global facts must use field global_notes, got: ${field || "(empty)"}` });
    }
  } else if (targetType === "confirmation") {
    if (field !== "confirm_before_departure") {
      errors.push({
        location,
        message: `confirmation facts must use field confirm_before_departure, got: ${field || "(empty)"}`,
      });
    }
  }

  if (fact.evidence !== undefined && !Array.isArray(fact.evidence)) {
    errors.push({ location, message: "fact.evidence must be an array when present" });
  }
  for (const [evidenceIndex, evidence] of asList(fact.evidence).entries()) {
    if (!isObject(evidence)) {
      errors.push({ location, message: `fact.evidence[${evidenceIndex}] must be an object` });
      continue;
    }
    if (text(evidence.quote).length > 240) {
      warnings.push({ location, message: `fact.evidence[${evidenceIndex}].quote is longer than 240 characters` });
    }
  }

  return { errors, warnings };
}

function validateDigest(digest, facts) {
  const files = digestFiles(digest);
  const lookup = buildFactsLookup(facts);
  const seenIds = new Set();
  const invalidFacts = [];
  const warnings = [];

  let factCount = 0;
  let reviewedContentMissingCount = 0;

  for (const [fileIndex, file] of files.entries()) {
    const filePath = text(file?.path) || `files[${fileIndex}]`;
    if (!isObject(file)) {
      invalidFacts.push({ location: `files[${fileIndex}]`, message: "file entry must be an object" });
      continue;
    }
    if (!text(file.path)) warnings.push({ location: filePath, message: "file.path is empty" });

    const fileFacts = asList(file.facts);
    factCount += countFileFacts(file);

    if (file.reviewed === true && !fileHasReviewedContent(file)) {
      reviewedContentMissingCount += 1;
      warnings.push({ location: filePath, message: "reviewed file has no facts, conflicts, or global_notes" });
    }
    if (file.reviewed !== true && fileHasReviewedContent(file)) {
      warnings.push({ location: filePath, message: "file has digest content but reviewed is not true" });
    }

    for (const [factIndex, fact] of fileFacts.entries()) {
      const result = validateFact(fact, {
        file,
        index: factIndex,
        seenIds,
        lookup,
      });
      invalidFacts.push(...result.errors);
      warnings.push(...result.warnings);
    }
  }

  const reviewedCount = files.filter((file) => file?.reviewed === true).length;
  const reviewedCompletion = files.length > 0 ? Number((reviewedCount / files.length).toFixed(4)) : null;

  const failures = [];
  if (files.length > 0 && reviewedCount === 0) {
    failures.push("source_digest_file_count > 0 but source_digest_reviewed_count is 0");
  }
  if (factCount === 0) {
    failures.push("source_digest_fact_count is 0");
  }
  if (invalidFacts.length > 0) {
    failures.push(`invalid fact count is ${invalidFacts.length}`);
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    inputs: {},
    metrics: {
      source_digest_file_count: files.length,
      source_digest_reviewed_count: reviewedCount,
      source_digest_pending_count: Math.max(files.length - reviewedCount, 0),
      digest_review_completion: reviewedCompletion,
      source_digest_fact_count: factCount,
      invalid_fact_count: invalidFacts.length,
      reviewed_content_missing_count: reviewedContentMissingCount,
    },
    invalid_facts: invalidFacts,
    warnings,
    failures,
    status: failures.length === 0 ? "passed" : "failed",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const digest = readJson(args.digest);
  const facts = readJson(args.facts);
  const report = validateDigest(digest, facts);
  report.inputs = {
    source_digest: path.resolve(args.digest),
    facts_workspace: path.resolve(args.facts),
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(
    `Source digest validation ${report.status}: ${report.metrics.source_digest_reviewed_count}/${report.metrics.source_digest_file_count} reviewed, ${report.metrics.source_digest_fact_count} facts, ${report.metrics.invalid_fact_count} invalid facts.`,
  );
  if (report.warnings.length > 0) {
    console.warn(`Warnings: ${report.warnings.map((warning) => warning.message).join("; ")}`);
  }
  if (report.failures.length > 0) {
    console.error(`Failures: ${report.failures.join("; ")}`);
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
