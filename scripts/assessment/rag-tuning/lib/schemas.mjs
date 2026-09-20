export const CHECKLIST_CRITICALITIES = ["critical", "core-quality", "mid", "low"];
export const CHECKLIST_DOMAINS = [
  "execution_fact",
  "experience_value",
  "decision_support",
  "risk_avoidance",
  "supporting_info",
];
export const TARGET_TYPES = ["place", "city", "day", "global"];
export const DELTA_LAYERS = ["retrieval", "facts", "render"];
export const ATTRIBUTION_CODES = [
  "keyword_miss",
  "score_low",
  "topk_cut",
  "quota_dropped",
  "rerank_drop",
  "facts_drop",
  "render_drop",
  "unknown",
];
export const REPORT_CONCLUSIONS = ["PASS", "PASS_WITH_NOTES", "FAIL"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasStringArray(value, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) return false;
  if (nonEmpty && value.length === 0) return false;
  return value.every(isNonEmptyString);
}

function pushRequired(errors, condition, path, message = "is required") {
  if (!condition) errors.push(`${path} ${message}`);
}

function validateSchemaVersion(doc, errors) {
  pushRequired(errors, Number.isInteger(doc?.schema_version) && doc.schema_version > 0, "schema_version", "must be a positive integer");
}

function validateTargetFields(item, path, errors) {
  pushRequired(errors, TARGET_TYPES.includes(item.target_type), `${path}.target_type`, `must be one of ${TARGET_TYPES.join(", ")}`);
  if (item.target_type !== "global") {
    pushRequired(errors, isNonEmptyString(item.target_name), `${path}.target_name`);
  }
}

export function validateChecklist(checklist) {
  const errors = [];
  if (!isObject(checklist)) return ["checklist must be an object"];

  validateSchemaVersion(checklist, errors);
  pushRequired(errors, isNonEmptyString(checklist.baseline_id), "baseline_id");
  pushRequired(errors, isNonEmptyString(checklist.baseline_name), "baseline_name");
  pushRequired(errors, isNonEmptyString(checklist.capability), "capability");
  pushRequired(errors, Number.isInteger(checklist.version) && checklist.version > 0, "version", "must be a positive integer");
  pushRequired(errors, Array.isArray(checklist.items), "items", "must be an array");

  if (Array.isArray(checklist.items)) {
    checklist.items.forEach((item, index) => {
      const path = `items[${index}]`;
      if (!isObject(item)) {
        errors.push(`${path} must be an object`);
        return;
      }
      pushRequired(errors, isNonEmptyString(item.id), `${path}.id`);
      pushRequired(errors, isNonEmptyString(item.text), `${path}.text`);
      pushRequired(errors, CHECKLIST_DOMAINS.includes(item.domain), `${path}.domain`, `must be one of ${CHECKLIST_DOMAINS.join(", ")}`);
      validateTargetFields(item, path, errors);
      pushRequired(errors, isNonEmptyString(item.theme), `${path}.theme`);
      pushRequired(
        errors,
        CHECKLIST_CRITICALITIES.includes(item.criticality),
        `${path}.criticality`,
        `must be one of ${CHECKLIST_CRITICALITIES.join(", ")}`,
      );
      pushRequired(errors, hasStringArray(item.source_chunk_ids, { nonEmpty: true }), `${path}.source_chunk_ids`, "must be a non-empty string array");
      pushRequired(errors, isObject(item.evidence_ref), `${path}.evidence_ref`, "must be an object");
      if (isObject(item.evidence_ref)) {
        pushRequired(
          errors,
          hasStringArray(item.evidence_ref.chunk_ids, { nonEmpty: true }),
          `${path}.evidence_ref.chunk_ids`,
          "must be a non-empty string array",
        );
      }
      pushRequired(errors, isNonEmptyString(item.added_at), `${path}.added_at`);
      pushRequired(errors, isNonEmptyString(item.source_run), `${path}.source_run`);
      if (item.match_hints !== undefined) {
        pushRequired(errors, hasStringArray(item.match_hints), `${path}.match_hints`, "must be a string array");
      }
    });
  }

  return errors;
}

function validateDeltaItem(item, path, errors) {
  if (!isObject(item)) {
    errors.push(`${path} must be an object`);
    return;
  }
  pushRequired(errors, isNonEmptyString(item.item_id), `${path}.item_id`);
  validateTargetFields(item, path, errors);
  pushRequired(errors, isNonEmptyString(item.theme), `${path}.theme`);
  pushRequired(errors, CHECKLIST_CRITICALITIES.includes(item.criticality), `${path}.criticality`, "must be a valid criticality");
  pushRequired(errors, DELTA_LAYERS.includes(item.layer), `${path}.layer`, `must be one of ${DELTA_LAYERS.join(", ")}`);
  pushRequired(
    errors,
    ATTRIBUTION_CODES.includes(item.attribution_code),
    `${path}.attribution_code`,
    `must be one of ${ATTRIBUTION_CODES.join(", ")}`,
  );
}

export function validateDeltas(deltas) {
  const errors = [];
  if (!isObject(deltas)) return ["deltas must be an object"];
  validateSchemaVersion(deltas, errors);
  pushRequired(errors, isNonEmptyString(deltas.baseline_id), "baseline_id");
  pushRequired(errors, isNonEmptyString(deltas.run_id), "run_id");

  for (const key of ["lost_items", "new_items", "misplaced_items", "unsupported_facts", "duplicates", "attribution"]) {
    pushRequired(errors, Array.isArray(deltas[key]), key, "must be an array");
    if (Array.isArray(deltas[key])) {
      deltas[key].forEach((item, index) => {
        if (key === "attribution" && Object.keys(item ?? {}).length === 0) return;
        validateDeltaItem(item, `${key}[${index}]`, errors);
      });
    }
  }
  return errors;
}

export function validateRunManifest(run) {
  const errors = [];
  if (!isObject(run)) return ["run manifest must be an object"];
  validateSchemaVersion(run, errors);
  pushRequired(errors, isNonEmptyString(run.run_id), "run_id");
  pushRequired(errors, isNonEmptyString(run.baseline_id), "baseline_id");
  pushRequired(errors, isNonEmptyString(run.created_at), "created_at");
  pushRequired(errors, isObject(run.paths), "paths", "must be an object");
  pushRequired(errors, isObject(run.params), "params", "must be an object");
  return errors;
}

export function validateReport(report) {
  const errors = [];
  if (!isObject(report)) return ["report must be an object"];
  validateSchemaVersion(report, errors);
  pushRequired(errors, isNonEmptyString(report.run_id), "run_id");
  pushRequired(errors, isNonEmptyString(report.baseline_id), "baseline_id");
  pushRequired(errors, REPORT_CONCLUSIONS.includes(report.conclusion), "conclusion", `must be one of ${REPORT_CONCLUSIONS.join(", ")}`);
  pushRequired(errors, isObject(report.gates), "gates", "must be an object");
  pushRequired(errors, isObject(report.metrics), "metrics", "must be an object");
  if (report.semantic_scores !== undefined) {
    pushRequired(errors, Array.isArray(report.semantic_scores), "semantic_scores", "must be an array");
  }
  return errors;
}

function validateScoreMap(scores, path, errors) {
  pushRequired(errors, isObject(scores), path, "must be an object");
  if (!isObject(scores)) return;
  for (const [key, value] of Object.entries(scores)) {
    pushRequired(errors, Number.isInteger(value) && value >= 1 && value <= 5, `${path}.${key}`, "must be an integer from 1 to 5");
  }
}

export function validateAdjudications(adjudications) {
  const errors = [];
  if (!isObject(adjudications)) return ["adjudications must be an object"];
  validateSchemaVersion(adjudications, errors);
  pushRequired(errors, isNonEmptyString(adjudications.run_id), "run_id");
  pushRequired(errors, Array.isArray(adjudications.coverage_overrides), "coverage_overrides", "must be an array");
  pushRequired(errors, Array.isArray(adjudications.semantic_scores), "semantic_scores", "must be an array");

  if (Array.isArray(adjudications.coverage_overrides)) {
    adjudications.coverage_overrides.forEach((item, index) => {
      const path = `coverage_overrides[${index}]`;
      if (!isObject(item)) {
        errors.push(`${path} must be an object`);
        return;
      }
      pushRequired(errors, isNonEmptyString(item.item_id), `${path}.item_id`);
      pushRequired(errors, typeof item.facts_covered === "boolean", `${path}.facts_covered`, "must be a boolean");
      pushRequired(errors, isNonEmptyString(item.reason), `${path}.reason`);
    });
  }

  if (Array.isArray(adjudications.semantic_scores)) {
    adjudications.semantic_scores.forEach((item, index) => {
      const path = `semantic_scores[${index}]`;
      if (!isObject(item)) {
        errors.push(`${path} must be an object`);
        return;
      }
      validateTargetFields(item, path, errors);
      validateScoreMap(item.scores, `${path}.scores`, errors);
      pushRequired(errors, isNonEmptyString(item.evidence), `${path}.evidence`);
      pushRequired(errors, Array.isArray(item.deductions), `${path}.deductions`, "must be an array");
    });
  }

  return errors;
}

export function assertValid(documentName, document, validator) {
  const errors = validator(document);
  if (errors.length) {
    throw new Error(`${documentName} failed schema validation:\n- ${errors.join("\n- ")}`);
  }
  return document;
}

export function assertValidChecklist(checklist) {
  return assertValid("checklist", checklist, validateChecklist);
}

export function assertValidDeltas(deltas) {
  return assertValid("deltas", deltas, validateDeltas);
}

export function assertValidRunManifest(run) {
  return assertValid("run manifest", run, validateRunManifest);
}

export function assertValidReport(report) {
  return assertValid("report", report, validateReport);
}

export function assertValidAdjudications(adjudications) {
  return assertValid("adjudications", adjudications, validateAdjudications);
}
