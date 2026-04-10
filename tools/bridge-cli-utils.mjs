import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

function tryResolveWindowsDocumentsFromRegistry() {
  if (process.platform !== "win32") {
    return null;
  }

  try {
    const output = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Personal',
      { encoding: "utf8" }
    );
    const match = output.match(/Personal\s+REG_\w+\s+([^\r\n]+)/);
    if (!match?.[1]) {
      return null;
    }
    return path.resolve(
      match[1].replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`).trim()
    );
  } catch {
    return null;
  }
}

export function resolveBridgeDir(explicitDir) {
  if (explicitDir) {
    return path.resolve(explicitDir);
  }

  const homeDir = os.homedir();
  const registryDocs = tryResolveWindowsDocumentsFromRegistry();
  const candidates = [
    process.env.AE_MCP_BRIDGE_DIR || null,
    registryDocs ? path.join(registryDocs, "ae-mcp-bridge") : null,
    process.env.OneDriveCommercial ? path.join(process.env.OneDriveCommercial, "Documents", "ae-mcp-bridge") : null,
    process.env.OneDriveConsumer ? path.join(process.env.OneDriveConsumer, "Documents", "ae-mcp-bridge") : null,
    process.env.OneDrive ? path.join(process.env.OneDrive, "Documents", "ae-mcp-bridge") : null,
    path.join(homeDir, "Documents", "ae-mcp-bridge")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || path.join(homeDir, "Documents", "ae-mcp-bridge");
}

export function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return options;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForResultByCommandId({
  bridgeDir,
  commandId,
  expectedCommand,
  timeoutMs = 12000,
  pollMs = 250
}) {
  const resultFilePath = path.join(bridgeDir, "ae_mcp_result.json");
  const journalResultPath = path.join(bridgeDir, "results", `${commandId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const journalResult = readJsonIfExists(journalResultPath);
    if (journalResult && matchesResult(journalResult, commandId, expectedCommand)) {
      return { source: "journal", result: journalResult, path: journalResultPath };
    }

    const latestResult = readJsonIfExists(resultFilePath);
    if (latestResult && matchesResult(latestResult, commandId, expectedCommand)) {
      return { source: "latest", result: latestResult, path: resultFilePath };
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Timeout waiting for bridge result (commandId=${commandId}, timeoutMs=${timeoutMs})`
  );
}

function matchesResult(parsed, commandId, expectedCommand) {
  const resultCommandId = parsed?._commandId || parsed?.commandId || null;
  const resultCommand = parsed?._commandExecuted || parsed?.command || null;

  if (resultCommandId !== commandId) {
    return false;
  }
  if (expectedCommand && resultCommand !== expectedCommand) {
    return false;
  }
  return true;
}
