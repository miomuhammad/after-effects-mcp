import fs from "fs";
import path from "path";
import { parseCliArgs } from "../bridge-cli-utils.mjs";

const repoRoot = process.cwd();
const localRoot = path.join(repoRoot, ".local", "wrapper-maker");
const usageLogPath = path.join(localRoot, "adhoc-usage.jsonl");
const reportsDir = path.join(localRoot, "reports");
const scaffoldsDir = path.join(localRoot, "scaffolds");

function printHelp() {
  console.log(`
Wrapper maker for promoting frequent ad-hoc ExtendScript usage into wrapper candidates.

Usage:
  npm run wrapper:maker -- <command> [options]

Commands:
  record      Append one ad-hoc usage event into local usage log.
  candidates  Build candidate report from usage history.
  scaffold    Generate wrapper scaffold from a candidate or explicit name.

Common options:
  --local-dir <path>   Override local workspace path (default: ./.local/wrapper-maker)
  --help               Show this help.

record options:
  --name <string>             Required. Candidate key (ex: bounce-drop)
  --intent <string>           Optional. Human-readable intent.
  --command <string>          Optional. AE command used (ex: run-script)
  --script-name <string>      Optional. Script id/name used.
  --status <success|error>    Optional. Default success.
  --duration-ms <number>      Optional.
  --notes <string>            Optional.
  --meta-json <json-object>   Optional extra metadata object.

candidates options:
  --lookback-days <number>    Optional. Default 14.
  --min-uses <number>         Optional. Default 5.
  --min-success-rate <number> Optional. Default 0.8 (0..1).
  --top <number>              Optional. Default 20.

scaffold options:
  --name <string>             Required unless --from-candidate is set.
  --from-candidate <string>   Candidate key from latest report.
  --intent <string>           Optional override.
  --output-dir <path>         Optional scaffold output directory.

Examples:
  npm run wrapper:maker -- record --name bounce-drop --intent "Ball drop with bounce" --status success
  npm run wrapper:maker -- candidates --lookback-days 14 --min-uses 5 --min-success-rate 0.8
  npm run wrapper:maker -- scaffold --from-candidate bounce-drop
`.trim());
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getLocalPaths(options) {
  const explicit = options["local-dir"] ? path.resolve(String(options["local-dir"])) : null;
  const base = explicit || localRoot;
  return {
    base,
    usageLog: path.join(base, "adhoc-usage.jsonl"),
    reports: path.join(base, "reports"),
    scaffolds: path.join(base, "scaffolds")
  };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }
  return entries;
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function appendJsonl(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
}

function loadLatestCandidatesReport(paths) {
  const latestPath = path.join(paths.reports, "candidates-latest.json");
  if (!fs.existsSync(latestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
}

function buildScaffoldFiles({ wrapperName, intent, candidate, outputDir }) {
  const safeName = slugify(wrapperName) || "new-wrapper";
  const now = new Date().toISOString();
  const folderName = `${safeName}-${Date.now()}`;
  const root = outputDir || path.join(scaffoldsDir, folderName);
  ensureDir(root);

  const spec = {
    wrapperName: safeName,
    displayName: wrapperName,
    intent: intent || candidate?.intent || "",
    createdAt: now,
    sourceCandidate: candidate ? {
      key: candidate.key,
      uses: candidate.uses,
      successRate: candidate.successRate
    } : null,
    params: [
      { name: "compName", type: "string", required: false, description: "Target composition name. Default active comp." },
      { name: "layerName", type: "string", required: false, description: "Target layer name." }
    ],
    underlyingCommands: [
      "resolveTargets",
      "setLayerProperties"
    ]
  };

  const handlerTs = `export type ${toPascalCase(safeName)}Input = {
  compName?: string;
  layerName?: string;
};

export async function ${toCamelCase(safeName)}Wrapper(
  input: ${toPascalCase(safeName)}Input,
  deps: {
    executeBridgeCommandAndWait: (command: string, args: Record<string, unknown>, options?: { timeoutMs?: number; maxAttempts?: number }) => Promise<{ ok: boolean; result: any }>;
  }
) {
  // TODO: Replace with real orchestration steps.
  const resolved = await deps.executeBridgeCommandAndWait("resolveTargets", {
    compName: input.compName,
    layerName: input.layerName
  }, { timeoutMs: 8000, maxAttempts: 1 });

  if (!resolved.ok) {
    return { status: "error", message: "Failed to resolve targets.", host: resolved.result };
  }

  return {
    status: "success",
    message: "Scaffold wrapper executed.",
    wrapper: "${safeName}",
    target: resolved.result?.resolvedTargets || null
  };
}
`;

  const testTs = `import { describe, it, expect } from "vitest";

describe("${safeName} wrapper scaffold", () => {
  it("has placeholder test", () => {
    expect(true).toBe(true);
  });
});
`;

  const readme = `# ${wrapperName} Wrapper Scaffold

Generated at: ${now}

## Goal
${intent || candidate?.intent || "Fill wrapper intent here."}

## Candidate Signal
- key: ${candidate?.key || "manual"}
- uses: ${candidate?.uses ?? "n/a"}
- successRate: ${candidate?.successRate ?? "n/a"}

## Next Steps
1. Finalize parameters in \`wrapper-spec.json\`.
2. Implement real command chain in \`wrapper-handler.template.ts\`.
3. Add real tests in \`wrapper-test.template.ts\`.
4. Integrate into \`src/orchestration/wrapperRegistry.ts\` after review.
`;

  writeJson(path.join(root, "wrapper-spec.json"), spec);
  fs.writeFileSync(path.join(root, "wrapper-handler.template.ts"), handlerTs, "utf8");
  fs.writeFileSync(path.join(root, "wrapper-test.template.ts"), testTs, "utf8");
  fs.writeFileSync(path.join(root, "README.md"), readme, "utf8");

  return root;
}

function toCamelCase(value) {
  const parts = slugify(value).split("-").filter(Boolean);
  if (parts.length === 0) {
    return "newWrapper";
  }
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function toPascalCase(value) {
  return slugify(value)
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("") || "NewWrapper";
}

function runRecord(options, paths) {
  const name = String(options.name || "").trim();
  if (!name) {
    throw new Error("record requires --name");
  }

  let meta = {};
  if (options["meta-json"]) {
    const parsed = JSON.parse(String(options["meta-json"]));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--meta-json must be a JSON object");
    }
    meta = parsed;
  }

  const entry = {
    at: new Date().toISOString(),
    key: slugify(name),
    name,
    intent: options.intent ? String(options.intent) : null,
    command: options.command ? String(options.command) : null,
    scriptName: options["script-name"] ? String(options["script-name"]) : null,
    status: options.status ? String(options.status).toLowerCase() : "success",
    durationMs: options["duration-ms"] !== undefined ? toNumber(options["duration-ms"], null) : null,
    notes: options.notes ? String(options.notes) : null,
    meta
  };

  appendJsonl(paths.usageLog, entry);

  console.log(JSON.stringify({
    status: "recorded",
    usageLog: paths.usageLog,
    entry
  }, null, 2));
}

function runCandidates(options, paths) {
  ensureDir(paths.reports);
  const lookbackDays = toNumber(options["lookback-days"], 14);
  const minUses = Math.max(1, Math.floor(toNumber(options["min-uses"], 5)));
  const minSuccessRate = Math.max(0, Math.min(1, toNumber(options["min-success-rate"], 0.8)));
  const top = Math.max(1, Math.floor(toNumber(options.top, 20)));
  const entries = readJsonl(paths.usageLog);

  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const scoped = entries.filter((entry) => {
    const ts = Date.parse(String(entry?.at || ""));
    return Number.isFinite(ts) && ts >= cutoffMs;
  });

  const buckets = new Map();
  for (const entry of scoped) {
    const key = slugify(entry?.key || entry?.name || "unknown");
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        name: entry?.name || key,
        intent: entry?.intent || "",
        uses: 0,
        successCount: 0,
        errorCount: 0,
        avgDurationMs: 0,
        commands: {},
        lastSeenAt: entry?.at || null
      });
    }
    const bucket = buckets.get(key);
    bucket.uses += 1;
    if (String(entry?.status || "").toLowerCase() === "error") {
      bucket.errorCount += 1;
    } else {
      bucket.successCount += 1;
    }
    if (Number.isFinite(entry?.durationMs)) {
      bucket.avgDurationMs += Number(entry.durationMs);
    }
    const cmd = entry?.scriptName || entry?.command || "unknown";
    bucket.commands[cmd] = (bucket.commands[cmd] || 0) + 1;
    bucket.lastSeenAt = entry?.at || bucket.lastSeenAt;
  }

  const all = Array.from(buckets.values()).map((item) => {
    const measuredCount = item.successCount + item.errorCount;
    const successRate = measuredCount > 0 ? item.successCount / measuredCount : 0;
    const avgDurationMs = measuredCount > 0 && item.avgDurationMs > 0
      ? Math.round(item.avgDurationMs / measuredCount)
      : null;
    return {
      ...item,
      successRate: Number(successRate.toFixed(3)),
      avgDurationMs
    };
  }).sort((a, b) => b.uses - a.uses);

  const promoted = all
    .filter((entry) => entry.uses >= minUses && entry.successRate >= minSuccessRate)
    .slice(0, top);

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      usageLog: paths.usageLog,
      totalEntries: entries.length,
      scopedEntries: scoped.length
    },
    policy: {
      lookbackDays,
      minUses,
      minSuccessRate,
      top
    },
    candidates: promoted,
    allRanked: all.slice(0, top)
  };

  const latestPath = path.join(paths.reports, "candidates-latest.json");
  const snapshotPath = path.join(paths.reports, `candidates-${Date.now()}.json`);
  writeJson(latestPath, report);
  writeJson(snapshotPath, report);

  console.log(JSON.stringify({
    status: "ok",
    latestReport: latestPath,
    snapshotReport: snapshotPath,
    candidateCount: promoted.length
  }, null, 2));
}

function runScaffold(options, paths) {
  ensureDir(paths.scaffolds);
  const fromCandidate = options["from-candidate"] ? slugify(String(options["from-candidate"])) : "";
  let name = String(options.name || "").trim();
  let selectedCandidate = null;

  if (fromCandidate) {
    const latest = loadLatestCandidatesReport(paths);
    const candidates = latest?.candidates || [];
    selectedCandidate = candidates.find((entry) => slugify(entry.key) === fromCandidate) || null;
    if (!selectedCandidate) {
      throw new Error(`Candidate '${fromCandidate}' not found in candidates-latest.json`);
    }
    if (!name) {
      name = selectedCandidate.name || selectedCandidate.key;
    }
  }

  if (!name) {
    throw new Error("scaffold requires --name or --from-candidate");
  }

  const outputDir = options["output-dir"] ? path.resolve(String(options["output-dir"])) : "";
  const root = buildScaffoldFiles({
    wrapperName: name,
    intent: options.intent ? String(options.intent) : "",
    candidate: selectedCandidate,
    outputDir: outputDir || ""
  });

  console.log(JSON.stringify({
    status: "ok",
    scaffoldPath: root,
    wrapperName: name,
    sourceCandidate: selectedCandidate?.key || null
  }, null, 2));
}

async function main() {
  const [, , maybeCommand, ...rest] = process.argv;
  const command = String(maybeCommand || "").trim();
  const options = parseCliArgs(command.startsWith("--") ? [command, ...rest] : rest);
  const paths = getLocalPaths(options);

  if (!command || command === "--help" || options.help) {
    printHelp();
    return;
  }

  if (command === "record") {
    runRecord(options, paths);
    return;
  }
  if (command === "candidates") {
    runCandidates(options, paths);
    return;
  }
  if (command === "scaffold") {
    runScaffold(options, paths);
    return;
  }

  throw new Error(`Unknown command '${command}'. Use --help.`);
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "error",
    message: String(error?.message || error)
  }, null, 2));
  process.exitCode = 1;
});
