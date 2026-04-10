import * as fs from "fs";
import {
  getAECommandFilePath,
  getAECommandQueueFilePath,
  getAECommandQueueDirPath,
  getAEHealthFilePath,
  getAEResultFilePath,
  getAEResultQueueDirPath,
  getAEResultQueueFilePath
} from "./paths.js";
import { appendOperationLog } from "../observability/operationLog.js";

const fsp = fs.promises;
let bridgeRoundTripChain: Promise<void> = Promise.resolve();
const JOURNAL_RETENTION_MAX_FILES = 300;
const JOURNAL_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type WaitForBridgeResultOptions = {
  expectedCommand?: string;
  expectedCommandId?: string;
  timeoutMs?: number;
  pollMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeJsonAtomic(filePath: string, payload: Record<string, any>): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fsp.rename(tempPath, filePath);
}

async function applyJournalRetention(
  directoryPath: string,
  options: { maxFiles: number; maxAgeMs: number; skipActiveCommands?: boolean }
): Promise<{ deleted: number; scanned: number }> {
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  const now = Date.now();
  const withStats: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];

  for (const file of jsonFiles) {
    const fullPath = `${directoryPath}/${file.name}`.replace(/\\/g, "/");
    try {
      const stats = await fsp.stat(fullPath);
      withStats.push({ name: file.name, fullPath, mtimeMs: stats.mtimeMs });
    } catch {
      // ignore race with external writers
    }
  }

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = now - options.maxAgeMs;
  const protectedNewest = withStats.slice(0, Math.max(0, options.maxFiles)).map((entry) => entry.fullPath);
  const protectedSet = new Set(protectedNewest);

  let deleted = 0;
  for (const file of withStats) {
    const isOld = file.mtimeMs < cutoff;
    const overCap = !protectedSet.has(file.fullPath);
    if (!isOld && !overCap) {
      continue;
    }

    if (options.skipActiveCommands) {
      try {
        const raw = await fsp.readFile(file.fullPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.status === "pending" || parsed?.status === "running") {
          continue;
        }
      } catch {
        // if unreadable/invalid, allow cleanup
      }
    }

    try {
      await fsp.unlink(file.fullPath);
      deleted += 1;
    } catch {
      // ignore transient delete failures
    }
  }

  return {
    deleted,
    scanned: withStats.length
  };
}

async function pruneBridgeJournalIfNeeded(): Promise<void> {
  try {
    const commandDir = getAECommandQueueDirPath();
    const resultDir = getAEResultQueueDirPath();
    const commandPruned = await applyJournalRetention(commandDir, {
      maxFiles: JOURNAL_RETENTION_MAX_FILES,
      maxAgeMs: JOURNAL_RETENTION_MAX_AGE_MS,
      skipActiveCommands: true
    });
    const resultPruned = await applyJournalRetention(resultDir, {
      maxFiles: JOURNAL_RETENTION_MAX_FILES,
      maxAgeMs: JOURNAL_RETENTION_MAX_AGE_MS
    });

    if (commandPruned.deleted > 0 || resultPruned.deleted > 0) {
      appendOperationLog({
        timestamp: new Date().toISOString(),
        phase: "journal-retention",
        status: "info",
        detail: "Bridge journal retention removed old entries.",
        meta: {
          command: commandPruned,
          result: resultPruned
        }
      });
    }
  } catch (error) {
    appendOperationLog({
      timestamp: new Date().toISOString(),
      phase: "journal-retention",
      status: "error",
      detail: "Bridge journal retention failed.",
      meta: {
        error: String(error)
      }
    });
  }
}

async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readBridgeHealthSnapshot(): Promise<Record<string, unknown> | null> {
  try {
    const healthPath = getAEHealthFilePath();
    const stats = await statIfExists(healthPath);
    if (!stats) {
      return null;
    }
    const raw = await fsp.readFile(healthPath, "utf8");
    if (!raw || !raw.trim()) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function classifyHealthTimeout(health: Record<string, unknown> | null): {
  failureClass: "panel-offline" | "autorun-disabled" | "host-stalled" | "bridge-timeout";
  reason: string;
} {
  if (!health) {
    return {
      failureClass: "panel-offline",
      reason: "No health heartbeat was found. The bridge panel may be closed."
    };
  }

  if (health.autoRunEnabled === false) {
    return {
      failureClass: "autorun-disabled",
      reason: "Bridge panel heartbeat is present but auto-run is disabled."
    };
  }

  const lastPollAt = typeof health.lastPollAt === "string" ? Date.parse(health.lastPollAt) : NaN;
  if (!Number.isNaN(lastPollAt)) {
    const ageMs = Date.now() - lastPollAt;
    if (ageMs > 10_000) {
      return {
        failureClass: "panel-offline",
        reason: `Bridge heartbeat is stale (${Math.round(ageMs / 1000)}s old).`
      };
    }
  }

  return {
    failureClass: "host-stalled",
    reason: "Bridge heartbeat is alive, but the expected command result did not arrive in time."
  };
}

export async function readResultsFromTempFile(): Promise<string> {
  try {
    const tempFilePath = getAEResultFilePath();
    console.error(`Checking for results at: ${tempFilePath}`);

    const stats = await statIfExists(tempFilePath);
    if (stats) {
      console.error(`Result file exists, last modified: ${stats.mtime.toISOString()}`);

      const content = await fsp.readFile(tempFilePath, "utf8");
      console.error(`Result file content length: ${content.length} bytes`);

      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      if (stats.mtime < thirtySecondsAgo) {
        console.error("WARNING: Result file is older than 30 seconds. After Effects may not be updating results.");
        return JSON.stringify({
          warning: "Result file appears to be stale (not recently updated).",
          message: "This could indicate After Effects is not properly writing results or the MCP Bridge Auto panel isn't running.",
          lastModified: stats.mtime.toISOString(),
          originalContent: content
        });
      }

      return content;
    }

    console.error(`Result file not found at: ${tempFilePath}`);
    return JSON.stringify({ error: "No results file found. Please run a script in After Effects first." });
  } catch (error) {
    console.error("Error reading results file:", error);
    return JSON.stringify({ error: `Failed to read results: ${String(error)}` });
  }
}

export async function waitForBridgeResult(options: WaitForBridgeResultOptions = {}): Promise<string> {
  const { expectedCommand, expectedCommandId, timeoutMs = 5000, pollMs = 250 } = options;
  const start = Date.now();
  const resultPath = getAEResultFilePath();
  const journalResultPath = expectedCommandId ? getAEResultQueueFilePath(expectedCommandId) : null;
  let lastContent = "";
  let lastMtimeMs = -1;
  let lastJournalContent = "";
  let lastJournalMtimeMs = -1;
  let currentPollMs = Math.max(100, pollMs);
  const maxPollMs = Math.max(currentPollMs, 1500);

  while (Date.now() - start < timeoutMs) {
    try {
      if (journalResultPath) {
        const journalStats = await statIfExists(journalResultPath);
        if (journalStats && journalStats.mtimeMs !== lastJournalMtimeMs) {
          lastJournalMtimeMs = journalStats.mtimeMs;
          const journalContent = await fsp.readFile(journalResultPath, "utf8");
          if (journalContent && journalContent.length > 0 && journalContent !== lastJournalContent) {
            lastJournalContent = journalContent;
            try {
              const parsed = JSON.parse(journalContent);
              if (parsed?.status === "waiting" && parsed?._placeholder === true) {
                currentPollMs = Math.min(maxPollMs, Math.max(100, Math.round(currentPollMs * 1.5)));
              } else if (expectedCommand && parsed?._commandExecuted !== expectedCommand) {
                currentPollMs = Math.min(maxPollMs, Math.max(100, Math.round(currentPollMs * 1.5)));
              } else if (!expectedCommandId || parsed?._commandId === expectedCommandId || parsed?.commandId === expectedCommandId) {
                return journalContent;
              }
            } catch {
              // not JSON yet; continue polling
            }
          }
        }
      }

      const stats = await statIfExists(resultPath);
      if (stats && stats.mtimeMs !== lastMtimeMs) {
        lastMtimeMs = stats.mtimeMs;
        const content = await fsp.readFile(resultPath, "utf8");
        if (content && content.length > 0 && content !== lastContent) {
          lastContent = content;
          try {
            const parsed = JSON.parse(content);
            if (parsed?.status === "waiting" && parsed?._placeholder === true) {
              currentPollMs = Math.min(maxPollMs, Math.max(100, Math.round(currentPollMs * 1.5)));
              continue;
            }
            if (expectedCommand && parsed?._commandExecuted !== expectedCommand) {
              currentPollMs = Math.min(maxPollMs, Math.max(100, Math.round(currentPollMs * 1.5)));
              continue;
            }
            if (expectedCommandId && parsed?._commandId !== expectedCommandId) {
              currentPollMs = Math.min(maxPollMs, Math.max(100, Math.round(currentPollMs * 1.5)));
              continue;
            }
            if (!expectedCommand || parsed?._commandExecuted === expectedCommand) {
              return content;
            }
          } catch {
            // not JSON yet; continue polling
          }
        }
      }
    } catch {
      // transient read error; continue polling
    }
    await sleep(currentPollMs);
    currentPollMs = Math.min(maxPollMs, Math.max(100, Math.round(currentPollMs * 1.25)));
  }

  const healthSnapshot = await readBridgeHealthSnapshot();
  const timeoutClassification = classifyHealthTimeout(healthSnapshot);

  return JSON.stringify({
    status: "error",
    message: `Timed out waiting for bridge result${expectedCommand ? ` for command '${expectedCommand}'` : ""}${expectedCommandId ? ` (${expectedCommandId})` : ""}.`,
    command: expectedCommand || null,
    commandId: expectedCommandId || null,
    failureClass: timeoutClassification.failureClass,
    failureReason: timeoutClassification.reason,
    health: healthSnapshot
  });
}

export function createCommandId(command: string): string {
  return `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeCommandFile(command: string, args: Record<string, any> = {}, commandId: string = createCommandId(command)): Promise<string> {
  try {
    const commandData = {
      command,
      args,
      commandId,
      timestamp: new Date().toISOString(),
      status: "pending"
    };
    const commandFile = getAECommandFilePath();
    const queueCommandFile = getAECommandQueueFilePath(commandId);

    // Write journal command first, then mirror to legacy single-slot path for compatibility.
    await writeJsonAtomic(queueCommandFile, commandData);
    await writeJsonAtomic(commandFile, commandData);
    console.error(`Command "${command}" (${commandId}) written to ${queueCommandFile} and mirrored to ${commandFile}`);
  } catch (error) {
    console.error("Error writing command file:", error);
    throw error;
  }
  return commandId;
}

async function clearResultsFile(commandId?: string, command?: string): Promise<void> {
  try {
    const resultFile = getAEResultFilePath();
    const resultQueueFile = commandId ? getAEResultQueueFilePath(commandId) : null;
    const resetData = {
      status: "waiting",
      message: "Waiting for new result from After Effects...",
      command: command || null,
      commandId: commandId || null,
      timestamp: new Date().toISOString(),
      _placeholder: true
    };

    await writeJsonAtomic(resultFile, resetData);
    if (resultQueueFile) {
      await writeJsonAtomic(resultQueueFile, resetData);
    }
    console.error(`Results file cleared at ${resultFile}${resultQueueFile ? ` and ${resultQueueFile}` : ""}`);
  } catch (error) {
    console.error("Error clearing results file:", error);
    throw error;
  }
}

export async function queueBridgeCommand(command: string, args: Record<string, any> = {}): Promise<string> {
  await pruneBridgeJournalIfNeeded();
  const commandId = createCommandId(command);
  await clearResultsFile(commandId, command);
  appendOperationLog({
    timestamp: new Date().toISOString(),
    phase: "queue",
    status: "info",
    command,
    commandId,
    detail: "Queued command for bridge execution.",
    meta: {
      args
    }
  });
  return await writeCommandFile(command, { ...args, commandId }, commandId);
}

export async function withBridgeRoundTripLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = bridgeRoundTripChain;
  let release!: () => void;
  bridgeRoundTripChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
