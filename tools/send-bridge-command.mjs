import fs from "fs";
import path from "path";
import {
  parseCliArgs,
  resolveBridgeDir,
  waitForResultByCommandId
} from "./bridge-cli-utils.mjs";

function printHelp() {
  console.log(`
Queue a bridge command into ae-mcp-bridge and optionally wait for its result.

Usage:
  node tools/send-bridge-command.mjs --command <name> [options]

Options:
  --command <name>         Required. Bridge command name.
  --args-json <json>       Optional. JSON object string for args.
  --args-file <path>       Optional. Path to JSON file for args.
  --wait                   Optional. Wait for matching result by commandId.
  --timeout-ms <number>    Optional. Default 12000.
  --poll-ms <number>       Optional. Default 250.
  --bridge-dir <path>      Optional. Override bridge directory.
  --help                   Show this help.

Examples:
  npm run bridge:send -- --command getProjectInfo --wait
  npm run bridge:send -- --command createShapeLayer --args-json "{\\"shapeType\\":\\"ellipse\\",\\"name\\":\\"Bola\\"}" --wait
  npm run bridge:send -- --command setLayerExpression --args-file .\\payloads\\expr.json --wait
`.trim());
}

function loadArgs(options) {
  const hasJson = Boolean(options["args-json"]);
  const hasFile = Boolean(options["args-file"]);
  if (hasJson && hasFile) {
    throw new Error("Use either --args-json or --args-file, not both.");
  }

  if (hasJson) {
    const parsed = JSON.parse(String(options["args-json"]));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--args-json must decode to a JSON object.");
    }
    return parsed;
  }

  if (hasFile) {
    const filePath = path.resolve(String(options["args-file"]));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--args-file must contain a JSON object.");
    }
    return parsed;
  }

  return {};
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const command = String(options.command || "").trim();
  if (!command) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const args = loadArgs(options);
  const bridgeDir = resolveBridgeDir(options["bridge-dir"] ? String(options["bridge-dir"]) : "");
  const commandFilePath = path.join(bridgeDir, "ae_command.json");
  const commandQueueDir = path.join(bridgeDir, "commands");
  const commandId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const nowIso = new Date().toISOString();
  const timeoutMs = Number(options["timeout-ms"] || 12000);
  const pollMs = Number(options["poll-ms"] || 250);
  const shouldWait = Boolean(options.wait);

  fs.mkdirSync(commandQueueDir, { recursive: true });

  const payload = {
    command,
    args,
    status: "pending",
    timestamp: nowIso,
    commandId
  };

  fs.writeFileSync(commandFilePath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(
    path.join(commandQueueDir, `${commandId}.json`),
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  if (!shouldWait) {
    console.log(JSON.stringify({
      status: "queued",
      command,
      commandId,
      bridgeDir,
      commandFilePath
    }, null, 2));
    return;
  }

  const waited = await waitForResultByCommandId({
    bridgeDir,
    commandId,
    expectedCommand: command,
    timeoutMs,
    pollMs
  });

  console.log(JSON.stringify({
    status: waited.result?.status || "unknown",
    command,
    commandId,
    bridgeDir,
    resultSource: waited.source,
    resultPath: waited.path,
    result: waited.result
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "error",
    message: String(error?.message || error)
  }, null, 2));
  process.exitCode = 1;
});

