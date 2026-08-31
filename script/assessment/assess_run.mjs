#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "../..");

function parseArgs(argv) {
  const args = {
    caseName: "",
    variant: "",
    resourceDir: "",
    route: "",
    workDir: "",
    htmlOutputDir: "",
    resourceIndex: "",
    facts: "",
    runId: "",
    model: "",
    readingQueue: "",
    sourceDigest: "",
    readLog: "",
    skillRoot: SKILL_ROOT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--case") args.caseName = argv[++i];
    else if (arg === "--variant") args.variant = argv[++i];
    else if (arg === "--resource-dir") args.resourceDir = argv[++i];
    else if (arg === "--route") args.route = argv[++i];
    else if (arg === "--work-dir") args.workDir = argv[++i];
    else if (arg === "--html-output-dir") args.htmlOutputDir = argv[++i];
    else if (arg === "--resource-index") args.resourceIndex = argv[++i];
    else if (arg === "--facts") args.facts = argv[++i];
    else if (arg === "--run-id") args.runId = argv[++i];
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--reading-queue") args.readingQueue = argv[++i];
    else if (arg === "--source-digest") args.sourceDigest = argv[++i];
    else if (arg === "--read-log") args.readLog = argv[++i];
    else if (arg === "--skill-root") args.skillRoot = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!args.caseName || !args.variant || !args.route || !args.workDir) {
    throw new Error(
      "Usage: node script/assessment/assess_run.mjs --case <case-name> --variant <baseline|source_digest|rag> --route <route-structure.json> --work-dir <work-dir> [--resource-dir <input-resource-dir>] [--html-output-dir <html-output-dir>] [--resource-index <resource-index.json>] [--facts <facts-workspace.json>] [--run-id <run-id>]",
    );
  }

  return args;
}

function timestampForRunId() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
}

function defaultRunId(args) {
  return `${args.caseName}-${args.variant}-${timestampForRunId()}`;
}

function resolveMaybe(value) {
  return value ? path.resolve(value) : "";
}

function existingPath(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function runCommand(stage, command, commandArgs, options = {}) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? SKILL_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const endedAt = new Date().toISOString();
  const durationSeconds = Number(((performance.now() - start) / 1000).toFixed(3));
  const exitCode = result.status ?? (result.error ? 1 : 0);
  return {
    stage,
    command: [command, ...commandArgs],
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    exit_code: exitCode,
    status: exitCode === 0 ? "passed" : "failed",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

function skippedStage(stage, reason) {
  const now = new Date().toISOString();
  return {
    stage,
    command: [],
    started_at: now,
    ended_at: now,
    duration_seconds: 0,
    exit_code: null,
    status: "skipped",
    reason,
    stdout: "",
    stderr: "",
  };
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function failIfMissing(label, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath || "(not provided)"}`);
  }
}

function maybeAddPathArg(args, flag, value) {
  if (value) args.push(flag, value);
}

function buildInitialConfig(args, paths) {
  return {
    schema_version: 1,
    run_id: paths.runId,
    case_name: args.caseName,
    variant: args.variant,
    model: args.model || null,
    created_at: paths.createdAt,
    updated_at: paths.createdAt,
    inputs: {
      resource_dir: resolveMaybe(args.resourceDir) || null,
      route_structure: paths.route,
      provided_resource_index: resolveMaybe(args.resourceIndex) || null,
      provided_facts_workspace: resolveMaybe(args.facts) || null,
      reading_queue: resolveMaybe(args.readingQueue) || null,
      source_digest: resolveMaybe(args.sourceDigest) || null,
      read_log: resolveMaybe(args.readLog) || null,
    },
    outputs: {
      run_dir: paths.runDir,
      html_output_dir: paths.htmlOutputDir,
      run_config: paths.runConfig,
      cost_metrics: paths.costMetrics,
      quality_metrics: paths.qualityMetrics,
      read_log: paths.readLog,
      stage_timings: paths.stageTimings,
      source_digest_validation: paths.sourceDigestValidation,
      source_digest_applied_facts: paths.sourceDigestAppliedFacts,
      resource_index: null,
      facts_workspace: null,
    },
    notes: [
      "第一版 assess_run 不自动驱动 agent 填写 facts-workspace，只评估已有 facts 或脚本生成的空 facts shell。",
    ],
  };
}

function buildStageTimings(runId, createdAt, timings) {
  const startedMs = Date.parse(timings[0]?.started_at ?? createdAt);
  const endedMs = Date.parse(timings.at(-1)?.ended_at ?? new Date().toISOString());
  return {
    schema_version: 1,
    run_id: runId,
    generated_at: new Date().toISOString(),
    wall_time_seconds: Number(((endedMs - startedMs) / 1000).toFixed(3)),
    stages: timings,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workDir = path.resolve(args.workDir);
  const runId = args.runId || defaultRunId(args);
  const runDir = path.join(workDir, "assess", runId);
  const htmlOutputDir = path.resolve(args.htmlOutputDir || path.join(runDir, "html"));
  const paths = {
    runId,
    createdAt: new Date().toISOString(),
    route: path.resolve(args.route),
    runDir,
    htmlOutputDir,
    runConfig: path.join(runDir, "run-config.json"),
    costMetrics: path.join(runDir, "cost-metrics.json"),
    qualityMetrics: path.join(runDir, "quality-metrics.json"),
    readLog: path.join(runDir, "read-log.json"),
    stageTimings: path.join(runDir, "stage-timings.json"),
    sourceDigestValidation: path.join(runDir, "source-digest-validation.json"),
    sourceDigestAppliedFacts: path.join(runDir, "facts-workspace.digest-applied.json"),
  };

  failIfMissing("route-structure.json", paths.route);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(htmlOutputDir, { recursive: true });

  const timings = [];
  const config = buildInitialConfig(args, paths);
  writeJson(paths.runConfig, config);

  function recordStage(timing) {
    timings.push(timing);
    writeJson(paths.stageTimings, buildStageTimings(runId, paths.createdAt, timings));
    return timing;
  }

  let resourceIndex = existingPath([
    resolveMaybe(args.resourceIndex),
    path.join(workDir, "resource-index.json"),
    path.join(runDir, "resource-index.json"),
  ]);

  if (!resourceIndex) {
    if (!args.resourceDir) {
      throw new Error("No resource index found. Provide --resource-index, keep resource-index.json in --work-dir, or pass --resource-dir to scan.");
    }
    resourceIndex = path.join(runDir, "resource-index.json");
    const scanArgs = ["scripts/scan_resources.mjs", path.resolve(args.resourceDir), "--route-json", paths.route, "-o", resourceIndex];
    const timing = recordStage(runCommand("scan", process.execPath, scanArgs, { cwd: path.resolve(args.skillRoot) }));
    if (timing.exit_code !== 0) throw new Error(`scan failed. See ${paths.stageTimings}`);
  } else {
    recordStage(skippedStage("scan", `using existing resource index: ${resourceIndex}`));
  }

  let facts = existingPath([
    resolveMaybe(args.facts),
    path.join(workDir, "facts-workspace.json"),
    path.join(runDir, "facts-workspace.json"),
  ]);

  if (!facts) {
    facts = path.join(runDir, "facts-workspace.json");
    const workspaceArgs = ["scripts/create_fact_workspace.mjs", "--route-json", paths.route, "--index", resourceIndex, "-o", facts];
    const timing = recordStage(runCommand("workspace", process.execPath, workspaceArgs, { cwd: path.resolve(args.skillRoot) }));
    if (timing.exit_code !== 0) throw new Error(`workspace creation failed. See ${paths.stageTimings}`);
  } else {
    recordStage(skippedStage("workspace", `using existing facts workspace: ${facts}`));
  }

  config.outputs.resource_index = resourceIndex;
  config.outputs.facts_workspace = facts;
  config.updated_at = new Date().toISOString();
  writeJson(paths.runConfig, config);

  const sourceDigest = existingPath([
    resolveMaybe(args.sourceDigest),
    path.join(workDir, "source-digest.json"),
    path.join(runDir, "source-digest.json"),
  ]);
  let readLog = existingPath([
    resolveMaybe(args.readLog),
    path.join(workDir, "read-log.json"),
    path.join(runDir, "read-log.json"),
  ]);

  if (args.variant === "source_digest") {
    failIfMissing("source-digest.json", sourceDigest);
    const validateDigestArgs = [
      "scripts/validate_source_digest.mjs",
      "--digest",
      sourceDigest,
      "--facts",
      facts,
      "-o",
      paths.sourceDigestValidation,
    ];
    const timing = recordStage(runCommand("validate_digest", process.execPath, validateDigestArgs, { cwd: path.resolve(args.skillRoot) }));
    if (timing.exit_code !== 0) throw new Error(`source digest validation failed. See ${paths.stageTimings}`);

    const applyDigestArgs = [
      "scripts/apply_source_digest_to_facts.mjs",
      "--digest",
      sourceDigest,
      "--facts",
      facts,
      "-o",
      paths.sourceDigestAppliedFacts,
    ];
    const applyTiming = recordStage(runCommand("apply_digest_to_facts", process.execPath, applyDigestArgs, { cwd: path.resolve(args.skillRoot) }));
    if (applyTiming.exit_code !== 0) throw new Error(`source digest application failed. See ${paths.stageTimings}`);
    facts = paths.sourceDigestAppliedFacts;
    config.outputs.facts_workspace = facts;
    config.updated_at = new Date().toISOString();
    writeJson(paths.runConfig, config);

    if (!readLog) {
      const createReadLogArgs = [
        "scripts/create_read_log.mjs",
        "--index",
        resourceIndex,
        "--digest",
        sourceDigest,
        "-o",
        paths.readLog,
      ];
      const readLogTiming = recordStage(runCommand("create_read_log", process.execPath, createReadLogArgs, { cwd: path.resolve(args.skillRoot) }));
      if (readLogTiming.exit_code !== 0) throw new Error(`read log creation failed. See ${paths.stageTimings}`);
      readLog = paths.readLog;
      config.inputs.read_log = null;
      config.outputs.read_log = readLog;
      config.updated_at = new Date().toISOString();
      writeJson(paths.runConfig, config);
    }
  }

  const renderArgs = ["scripts/render_travel_html.mjs", facts, "-o", htmlOutputDir, "--skill-root", path.resolve(args.skillRoot)];
  let timing = recordStage(runCommand("render", process.execPath, renderArgs, { cwd: path.resolve(args.skillRoot) }));
  if (timing.exit_code !== 0) throw new Error(`render failed. See ${paths.stageTimings}`);

  timing = recordStage(runCommand("verify", process.execPath, ["scripts/verify_output.mjs", htmlOutputDir], { cwd: path.resolve(args.skillRoot) }));

  const assessSourceArgs = [
    "script/assessment/assess_sources.mjs",
    "--index",
    resourceIndex,
    "--facts",
    facts,
    "-o",
    paths.costMetrics,
  ];
  maybeAddPathArg(assessSourceArgs, "--reading-queue", resolveMaybe(args.readingQueue));
  maybeAddPathArg(assessSourceArgs, "--source-digest", sourceDigest);
  maybeAddPathArg(assessSourceArgs, "--read-log", readLog);
  timing = recordStage(runCommand("assess_sources", process.execPath, assessSourceArgs, { cwd: path.resolve(args.skillRoot) }));
  if (timing.exit_code !== 0) throw new Error(`source assessment failed. See ${paths.stageTimings}`);

  const assessQualityArgs = [
    "script/assessment/assess_quality.mjs",
    "--route",
    paths.route,
    "--facts",
    facts,
    "--output-dir",
    htmlOutputDir,
    "-o",
    paths.qualityMetrics,
  ];
  timing = recordStage(runCommand("assess_quality", process.execPath, assessQualityArgs, { cwd: path.resolve(args.skillRoot) }));

  config.updated_at = new Date().toISOString();
  config.completed_at = config.updated_at;
  config.status = timings.every((item) => item.status !== "failed") ? "passed" : "failed";
  config.outputs.stage_timings = paths.stageTimings;
  writeJson(paths.runConfig, config);

  if (timings.some((item) => item.status === "failed")) {
    throw new Error(`Assessment run completed with failed stages. See ${paths.stageTimings}`);
  }

  console.log(`Assessment run ${runId} completed.`);
  console.log(`Run directory: ${runDir}`);
  console.log(`HTML output: ${htmlOutputDir}`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
