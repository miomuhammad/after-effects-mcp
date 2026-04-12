import { SafetyError } from "../safety.js";
import { SkillError } from "../skills.js";

export function describeQueuedCommand(command: string, commandId: string): string {
  return `Command "${command}" has been queued.\nCommand ID: ${commandId}`;
}

export function safeJsonParse<T = any>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function classifyBridgeFailure(result: any): { transient: boolean; failureClass: string } {
  if (typeof result?.failureClass === "string" && result.failureClass.trim()) {
    const explicitFailureClass = result.failureClass.trim();
    const transient =
      explicitFailureClass === "bridge-timeout" ||
      explicitFailureClass === "stale-result" ||
      explicitFailureClass === "host-stalled";
    return { transient, failureClass: explicitFailureClass };
  }
  const message = String(result?.message || result?.error || "");
  if (message.includes("Timed out waiting for bridge result")) {
    return { transient: true, failureClass: "bridge-timeout" };
  }
  if (result?.status === "waiting" || result?._placeholder === true) {
    return { transient: true, failureClass: "stale-result" };
  }
  return { transient: false, failureClass: "semantic-ae-failure" };
}

export function formatToolPayload(payload: Record<string, unknown>, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    ...(isError ? { isError: true } : {})
  };
}

export function buildResultEnvelope(input: {
  source: string;
  status?: "success" | "warning" | "error";
  message?: string | null;
  summary?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}) {
  return {
    status: input.status || "success",
    source: input.source,
    message: input.message || null,
    summary: input.summary || {},
    data: input.data || {},
    meta: input.meta || {}
  };
}

export function buildErrorEnvelope(input: {
  source: string;
  message: string;
  summary?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}) {
  return buildResultEnvelope({
    source: input.source,
    status: "error",
    message: input.message,
    summary: input.summary || {},
    data: input.data || {},
    meta: input.meta || {}
  });
}

function summarizeChanges(result: any): string[] {
  if (typeof result?.transactionId === "string" && typeof result?.operationCount === "number") {
    const summary: string[] = [];
    const created = Array.isArray(result?.created) ? result.created : [];
    const changed = Array.isArray(result?.changed) ? result.changed : [];
    const maxChangedEntries = 6;

    if (created.length > 0) {
      const createdLabels = created
        .slice(0, 3)
        .map((entry: any) => `${String(entry?.type || "item")} ${String(entry?.name || "").trim()}`.trim());
      summary.push(`Created ${created.length} item(s).${createdLabels.length ? ` ${createdLabels.join(", ")}` : ""}`);
    }

    for (const entry of changed.slice(0, maxChangedEntries)) {
      summary.push(String(entry));
    }
    if (changed.length > maxChangedEntries) {
      summary.push(`...and ${changed.length - maxChangedEntries} more change(s).`);
    }

    if (typeof result?.failedCount === "number" && result.failedCount > 0) {
      summary.push(`${result.failedCount} operation(s) failed.`);
    }
    if (typeof result?.skippedCount === "number" && result.skippedCount > 0) {
      summary.push(`${result.skippedCount} operation(s) were skipped.`);
    }

    if (!summary.length && typeof result?.message === "string" && result.message.trim()) {
      summary.push(result.message.trim());
    }
    return summary;
  }

  if (Array.isArray(result?.changed) && result.changed.length > 0) {
    return result.changed.map((entry: unknown) => String(entry));
  }
  if (Array.isArray(result?.changedProperties) && result.changedProperties.length > 0) {
    return result.changedProperties.map((entry: unknown) => String(entry));
  }
  if (typeof result?.message === "string" && result.message.trim()) {
    return [result.message.trim()];
  }
  return [];
}

function extractTargetSummary(result: any): Record<string, unknown> | null {
  if (typeof result?.transactionId === "string" && typeof result?.operationCount === "number") {
    const touchedLayers = Array.isArray(result?.touchedLayers)
      ? result.touchedLayers.map((layer: any) => ({
          index: layer?.index ?? null,
          name: layer?.name ?? null,
          type: layer?.type ?? null,
          composition: layer?.composition
            ? {
                index: layer.composition?.index ?? null,
                name: layer.composition?.name ?? null
              }
            : null
        }))
      : [];

    return {
      composition: result?.composition || null,
      operationCount: result?.operationCount ?? null,
      touchedLayerCount: touchedLayers.length,
      touchedLayers: touchedLayers.slice(0, 8)
    };
  }

  if (result?.target && typeof result.target === "object") {
    return result.target;
  }
  if (result?.resolvedTargets && typeof result.resolvedTargets === "object") {
    return result.resolvedTargets;
  }
  if (result?.activeComp && typeof result.activeComp === "object") {
    return {
      composition: result.activeComp
    };
  }
  return null;
}

function inferNextAction(result: any): string | null {
  if (result?.status === "waiting") {
    return "Wait a few seconds and call get-results again.";
  }
  if (typeof result?.transactionId === "string" && typeof result?.operationCount === "number") {
    if (typeof result?.failedCount === "number" && result.failedCount > 0) {
      return "Inspect failedOperations, then validate one touched layer with runtime-layer-details before retrying.";
    }
    if (Array.isArray(result?.touchedLayers) && result.touchedLayers.length > 0) {
      return "Use touchedLayers in the result or call runtime-layer-details for an exact follow-up check.";
    }
  }
  if (result?.status === "error") {
    return "Inspect the structured error details and bridge log before retrying.";
  }
  if (result?._commandExecuted || result?.command) {
    return "Review the AE result payload and continue with the next production step.";
  }
  return null;
}

export function formatUserFacingResult(result: any) {
  const status = result?.status === "error" ? "error" : (result?.status || "success");
  const isTransactionResult = typeof result?.transactionId === "string" && typeof result?.operationCount === "number";
  return {
    status,
    summary: {
      whatChanged: summarizeChanges(result),
      targetUsed: extractTargetSummary(result),
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      nextAction: inferNextAction(result),
      transaction: isTransactionResult
        ? {
            transactionId: result.transactionId,
            operationCount: result.operationCount ?? null,
            succeededCount: result.succeededCount ?? null,
            failedCount: result.failedCount ?? null,
            skippedCount: result.skippedCount ?? null,
            composition: result.composition || null,
            touchedLayerCount: Array.isArray(result?.touchedLayers) ? result.touchedLayers.length : 0
          }
        : null,
      validationTargets: isTransactionResult && Array.isArray(result?.touchedLayers)
        ? result.touchedLayers.slice(0, 8).map((layer: any) => ({
            index: layer?.index ?? null,
            name: layer?.name ?? null,
            type: layer?.type ?? null,
            composition: layer?.composition?.name ?? null
          }))
        : []
    },
    result
  };
}

export function buildQueuedBridgeToolResponse(command: string, commandId: string, detail?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${describeQueuedCommand(command, commandId)}${detail ? `\n${detail}` : ""}\nUse the "get-results" tool after a few seconds to inspect the result.`
      }
    ]
  };
}

export function sanitizeMutationArgs(args: Record<string, any> = {}): Record<string, any> {
  const clone = { ...args };
  delete clone.forceWithoutCheckpoint;
  delete clone.checkpointLabel;
  return clone;
}

export function buildStructuredSafetyError(error: unknown, fallbackCode: string, fallbackMessage: string) {
  if (error instanceof SafetyError) {
    return {
      status: "error",
      code: error.code,
      message: error.message,
      details: error.details || null
    };
  }

  return {
    status: "error",
    code: fallbackCode,
    message: fallbackMessage,
    details: {
      error: String(error)
    }
  };
}

export function buildStructuredSkillError(error: unknown, fallbackCode: string, fallbackMessage: string) {
  if (error instanceof SkillError) {
    return {
      status: "error",
      code: error.code,
      message: error.message,
      details: error.details || null
    };
  }

  return {
    status: "error",
    code: fallbackCode,
    message: fallbackMessage,
    details: {
      error: String(error)
    }
  };
}
