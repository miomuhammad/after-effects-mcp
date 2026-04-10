import fs from "fs";
import path from "path";

type WrapperMakerRuntimeStatus = "success" | "error" | "queued";

export type WrapperMakerRuntimeEntry = {
  script: string;
  executionMode: "execute_and_wait" | "queue_only";
  status: WrapperMakerRuntimeStatus;
  durationMs?: number | null;
  commandId?: string | null;
  failureClass?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
};
export type WrapperMakerRuntimeAppendResult = {
  ok: boolean;
  logPath?: string;
  error?: string;
};

let cachedUsageLogPath: string | null = null;
const runtimeSessionId = `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function slugify(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveRepoRoot(): string {
  const mainScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (mainScriptPath) {
    const maybeBuildDir = path.dirname(mainScriptPath);
    const maybeRepoRoot = path.resolve(maybeBuildDir, "..");
    return maybeRepoRoot;
  }
  return process.cwd();
}

function getUsageLogPath(): string {
  if (cachedUsageLogPath) {
    return cachedUsageLogPath;
  }

  const root = resolveRepoRoot();
  const logDir = path.join(root, ".local", "wrapper-maker");
  fs.mkdirSync(logDir, { recursive: true });
  cachedUsageLogPath = path.join(logDir, "adhoc-usage.jsonl");
  return cachedUsageLogPath;
}

export function appendWrapperMakerRuntimeUsage(entry: WrapperMakerRuntimeEntry): WrapperMakerRuntimeAppendResult {
  try {
    const logPath = getUsageLogPath();
    const now = new Date().toISOString();
    const script = String(entry.script || "").trim();
    if (!script) {
      return { ok: false, error: "Missing script name." };
    }

    const payload = {
      at: now,
      key: slugify(script),
      name: script,
      intent: `run-script:${script}`,
      command: "run-script",
      scriptName: script,
      status: entry.status,
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : null,
      notes: entry.notes || null,
      meta: {
        source: "runtime-auto-hook",
        executionMode: entry.executionMode,
        commandId: entry.commandId || null,
        failureClass: entry.failureClass || null,
        sessionId: runtimeSessionId,
        cwd: process.cwd(),
        ...(entry.metadata || {})
      }
    };

    fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, "utf8");
    return { ok: true, logPath };
  } catch (error) {
    // Swallow logging errors to avoid impacting MCP runtime behavior.
    return {
      ok: false,
      error: `Failed to append wrapper-maker runtime usage log: ${String(error)}`
    };
  }
}
