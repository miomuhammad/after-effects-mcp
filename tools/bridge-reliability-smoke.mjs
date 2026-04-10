import fs from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = process.cwd();
const outputPath = path.join(repoRoot, "docs", "plansv5", "reports", "07-phase-5-reliability-smoke-latest.json");
const bridgeDir = path.join("C:", "Users", "orely", "OneDrive", "Documents", "ae-mcp-bridge");
const commandsDir = path.join(bridgeDir, "commands");
const resultsDir = path.join(bridgeDir, "results");

function parseToolPayload(result) {
  const text = result?.content?.find((entry) => entry.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(repoRoot, "build", "index.js")],
  cwd: repoRoot,
  stderr: "pipe"
});

const client = new Client({ name: "bridge-reliability-smoke", version: "1.0.0" });
await client.connect(transport);

const report = {
  generatedAt: new Date().toISOString(),
  checks: {}
};

try {
  const healthRaw = await client.request({
    method: "tools/call",
    params: {
      name: "inspect-bridge-health",
      arguments: { staleSeconds: 12 }
    }
  }, CallToolResultSchema);
  const health = parseToolPayload(healthRaw);
  report.checks.health = {
    ok: health?.bridgeHealthClass === "healthy" || health?.bridgeHealthClass === "warning",
    bridgeHealthClass: health?.bridgeHealthClass || null,
    diagnosis: health?.diagnosis || null,
    autoRunEnabled: health?.files?.heartbeat?.autoRunEnabled ?? null,
    heartbeatAgeMs: health?.files?.heartbeat?.heartbeatAgeMs ?? null
  };

  const deterministicRaw = await client.request({
    method: "tools/call",
    params: {
      name: "run-script",
      arguments: { script: "getProjectInfo", parameters: {} }
    }
  }, CallToolResultSchema);
  const deterministic = parseToolPayload(deterministicRaw);
  report.checks.deterministicDefault = {
    ok: deterministic?.status === "success",
    status: deterministic?.status || null,
    failureClass: deterministic?.failureClass || null
  };

  const queueRaw = await client.request({
    method: "tools/call",
    params: {
      name: "run-script",
      arguments: { script: "getProjectInfo", parameters: {}, executionMode: "queue_only" }
    }
  }, CallToolResultSchema);
  const queued = parseToolPayload(queueRaw);
  let queueResult = null;
  if (queued?.commandId) {
    await sleep(2500);
    const resultRaw = await client.request({
      method: "tools/call",
      params: {
        name: "get-results",
        arguments: {
          commandId: queued.commandId,
          command: "getProjectInfo"
        }
      }
    }, CallToolResultSchema);
    queueResult = parseToolPayload(resultRaw);
  }
  report.checks.queueCompatibility = {
    ok: queued?.status === "queued" && queueResult?.status === "success",
    queueStatus: queued?.status || null,
    commandId: queued?.commandId || null,
    getResultsStatus: queueResult?.status || null
  };

  const watchdogId = `watchdog-gate-${Date.now()}`;
  const staleTimestamp = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const commandPath = path.join(commandsDir, `${watchdogId}.json`);
  const resultPath = path.join(resultsDir, `${watchdogId}.json`);
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(commandPath, JSON.stringify({
    command: "getProjectInfo",
    args: { commandId: watchdogId },
    commandId: watchdogId,
    timestamp: staleTimestamp,
    runningSince: staleTimestamp,
    status: "running"
  }, null, 2), "utf8");

  await sleep(6500);

  let commandAfter = null;
  let resultAfter = null;
  if (fs.existsSync(commandPath)) {
    commandAfter = JSON.parse(fs.readFileSync(commandPath, "utf8"));
  }
  if (fs.existsSync(resultPath)) {
    resultAfter = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  }

  report.checks.watchdog = {
    ok: commandAfter?.status === "error" && resultAfter?.failureClass === "stuck-running",
    commandStatusAfter: commandAfter?.status || null,
    resultStatus: resultAfter?.status || null,
    resultFailureClass: resultAfter?.failureClass || null
  };

  try { if (fs.existsSync(commandPath)) fs.unlinkSync(commandPath); } catch {}
  try { if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); } catch {}

  const checks = Object.values(report.checks);
  const passed = checks.filter((entry) => entry.ok).length;
  report.summary = {
    passed,
    total: checks.length,
    passRate: checks.length > 0 ? Number((passed / checks.length).toFixed(3)) : 0
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await transport.close();
}
