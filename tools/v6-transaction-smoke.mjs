import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = process.cwd();
const reportsDir = path.join(repoRoot, "docs", "plansv6", "reports");
const outputPath = path.join(reportsDir, "01-v6-transaction-smoke-latest.json");
const cliPayloadPath = path.join(reportsDir, "tmp-v6-cli-payload.json");
const uniquePrefix = `AE MCP V6 Smoke ${Date.now()}`;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseToolPayload(result) {
  const text = result?.content?.find((entry) => entry.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractBridgeResult(payload) {
  return payload?.result?.bridgeResult || payload?.result || payload?.bridgeResult || payload || null;
}

function summarizeError(error) {
  return String(error?.message || error);
}

async function callTool(client, name, args = {}) {
  const raw = await client.request({
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  }, CallToolResultSchema);
  return parseToolPayload(raw);
}

function runCli(args, inputText = null) {
  const completed = spawnSync("node", args, {
    cwd: repoRoot,
    input: inputText ?? undefined,
    encoding: "utf8"
  });

  const stdout = String(completed.stdout || "").trim();
  const stderr = String(completed.stderr || "").trim();
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = { raw: stdout };
  }

  return {
    exitCode: completed.status,
    stdout,
    stderr,
    parsed
  };
}

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(repoRoot, "build", "index.js")],
  cwd: repoRoot,
  stderr: "pipe"
});

const client = new Client({ name: "v6-transaction-smoke", version: "1.0.0" });
await client.connect(transport);

ensureDir(reportsDir);

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    repoRoot,
    outputPath
  },
  checks: {}
};

try {
  const health = await callTool(client, "inspect-bridge-health", { staleSeconds: 12 });
  report.checks.bridgeHealth = {
    ok: health?.bridgeHealthClass === "healthy" || health?.bridgeHealthClass === "warning",
    bridgeHealthClass: health?.bridgeHealthClass || null,
    diagnosis: health?.diagnosis || null
  };

  const simpleBatchPayload = {
    undoLabel: "V6 Smoke Simple Batch",
    stopOnError: true,
    operations: [
      {
        type: "createShapeLayer",
        name: `${uniquePrefix} | Simple Ball`,
        shapeType: "ellipse",
        size: [120, 120],
        fillColor: [1, 0.45, 0.1],
        position: [640, 360],
        duration: 4
      }
    ]
  };

  const simpleBatch = await callTool(client, "run-script", {
    script: "runOperationBatch",
    parameters: simpleBatchPayload
  });
  const simpleBatchBridge = extractBridgeResult(simpleBatch);
  report.checks.simpleBatchCreate = {
    ok: simpleBatch?.status === "success" && simpleBatchBridge?.status === "success",
    toolStatus: simpleBatch?.status || null,
    bridgeStatus: simpleBatchBridge?.status || null,
    transactionId: simpleBatchBridge?.transactionId || null,
    touchedLayerCount: Array.isArray(simpleBatchBridge?.touchedLayers) ? simpleBatchBridge.touchedLayers.length : 0
  };

  const expressionLayerName = `${uniquePrefix} | Expression Wheel`;
  const expressionBatch = await callTool(client, "run-script", {
    script: "runOperationBatch",
    parameters: {
      undoLabel: "V6 Smoke Expression Batch",
      stopOnError: true,
      operations: [
        {
          type: "createShapeLayer",
          name: expressionLayerName,
          shapeType: "ellipse",
          size: [160, 160],
          fillColor: [0.2, 0.6, 1],
          position: [840, 360],
          duration: 4
        },
        {
          type: "setLayerExpression",
          layerName: expressionLayerName,
          propertyName: "Rotation",
          expressionString: "time * 180;"
        }
      ]
    }
  });
  const expressionBridge = extractBridgeResult(expressionBatch);
  report.checks.batchCreatePlusExpression = {
    ok: expressionBatch?.status === "success" && expressionBridge?.status === "success",
    toolStatus: expressionBatch?.status || null,
    bridgeStatus: expressionBridge?.status || null,
    changed: expressionBridge?.changed || []
  };

  const partialBatch = await callTool(client, "run-script", {
    script: "runOperationBatch",
    parameters: {
      undoLabel: "V6 Smoke Partial Failure Batch",
      stopOnError: false,
      operations: [
        {
          type: "createShapeLayer",
          name: `${uniquePrefix} | Partial OK`,
          shapeType: "rectangle",
          size: [220, 80],
          fillColor: [0.9, 0.2, 0.2],
          position: [420, 520],
          duration: 4
        },
        {
          type: "setLayerExpression",
          layerName: `${uniquePrefix} | Missing Layer`,
          propertyName: "Rotation",
          expressionString: "time * 90;"
        },
        {
          type: "createShapeLayer",
          name: `${uniquePrefix} | Partial Continues`,
          shapeType: "ellipse",
          size: [90, 90],
          fillColor: [0.3, 0.9, 0.4],
          position: [720, 520],
          duration: 4
        }
      ]
    }
  });
  const partialBridge = extractBridgeResult(partialBatch);
  report.checks.partialFailureHandling = {
    ok: partialBatch?.status === "success" &&
      partialBridge?.status === "warning" &&
      Number(partialBridge?.failedCount || 0) >= 1 &&
      Number(partialBridge?.succeededCount || 0) >= 1,
    toolStatus: partialBatch?.status || null,
    bridgeStatus: partialBridge?.status || null,
    failedCount: partialBridge?.failedCount ?? null,
    succeededCount: partialBridge?.succeededCount ?? null
  };

  fs.writeFileSync(cliPayloadPath, `\ufeff${JSON.stringify({
    undoLabel: "V6 Smoke CLI File Batch",
    stopOnError: true,
    operations: [
      {
        type: "createShapeLayer",
        name: `${uniquePrefix} | CLI File`,
        shapeType: "ellipse",
        size: [80, 80],
        fillColor: [1, 0.85, 0.1],
        position: [960, 540],
        duration: 3
      }
    ]
  }, null, 2)}`, "utf8");

  const cliFile = runCli([
    path.join("tools", "send-bridge-command.mjs"),
    "--command", "runOperationBatch",
    "--args-file", cliPayloadPath,
    "--wait",
    "--timeout-ms", "12000"
  ]);
  report.checks.windowsJsonPayloadFile = {
    ok: cliFile.exitCode === 0 && cliFile.parsed?.status === "success",
    exitCode: cliFile.exitCode,
    status: cliFile.parsed?.status || null,
    bridgeStatus: cliFile.parsed?.result?.status || null,
    stderr: cliFile.stderr || null
  };

  const cliStdinPayload = JSON.stringify({}, null, 2);
  const cliStdin = runCli([
    path.join("tools", "send-bridge-command.mjs"),
    "--command", "getProjectInfo",
    "--args-stdin",
    "--wait",
    "--timeout-ms", "12000"
  ], cliStdinPayload);
  report.checks.windowsJsonPayloadStdin = {
    ok: cliStdin.exitCode === 0 && cliStdin.parsed?.status === "success",
    exitCode: cliStdin.exitCode,
    status: cliStdin.parsed?.status || null,
    bridgeStatus: cliStdin.parsed?.result?.status || null,
    stderr: cliStdin.stderr || null
  };

  const validation = await callTool(client, "runtime-layer-details", {
    layerName: expressionLayerName
  });
  report.checks.targetedLayerValidation = {
    ok: validation?.status === "success" && validation?.summary?.layer?.name === expressionLayerName,
    status: validation?.status || null,
    layer: validation?.summary?.layer || null,
    expressions: validation?.summary?.expressions || []
  };
} catch (error) {
  report.fatal = summarizeError(error);
} finally {
  try {
    if (fs.existsSync(cliPayloadPath)) {
      fs.unlinkSync(cliPayloadPath);
    }
  } catch {}

  const checks = Object.values(report.checks);
  const passed = checks.filter((entry) => entry && entry.ok).length;
  report.summary = {
    passed,
    total: checks.length,
    passRate: checks.length > 0 ? Number((passed / checks.length).toFixed(3)) : 0
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await transport.close();
}
