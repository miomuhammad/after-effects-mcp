import {
  parseCliArgs,
  resolveBridgeDir,
  waitForResultByCommandId
} from "./bridge-cli-utils.mjs";

function printHelp() {
  console.log(`
Wait for a specific bridge result by commandId.

Usage:
  node tools/wait-bridge-result.mjs --command-id <id> [options]

Options:
  --command-id <id>        Required. commandId to wait for.
  --command <name>         Optional. Validate expected command name.
  --timeout-ms <number>    Optional. Default 12000.
  --poll-ms <number>       Optional. Default 250.
  --bridge-dir <path>      Optional. Override bridge directory.
  --help                   Show this help.

Examples:
  npm run bridge:wait -- --command-id cli-1710000000000-abc123 --command createShapeLayer
`.trim());
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const commandId = String(options["command-id"] || "").trim();
  if (!commandId) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const command = options.command ? String(options.command) : undefined;
  const timeoutMs = Number(options["timeout-ms"] || 12000);
  const pollMs = Number(options["poll-ms"] || 250);
  const bridgeDir = resolveBridgeDir(options["bridge-dir"] ? String(options["bridge-dir"]) : "");

  const waited = await waitForResultByCommandId({
    bridgeDir,
    commandId,
    expectedCommand: command,
    timeoutMs,
    pollMs
  });

  console.log(JSON.stringify({
    status: waited.result?.status || "unknown",
    commandId,
    command: command || waited.result?._commandExecuted || waited.result?.command || null,
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

