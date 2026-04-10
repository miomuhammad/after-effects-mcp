import { z } from "zod";
import type {
  BuildQueuedBridgeToolResponse,
  ExecuteBridgeCommandAndWait,
  FormatToolPayload,
  QueueMutationWithSafety,
  SafetyRoutingDependencies,
  ToolServer
} from "../toolContracts.js";

export function registerBridgeTools(deps: {
  server: ToolServer;
  fs: typeof import("fs");
  getOperationLogPath: () => string;
  getAECommandFilePath: () => string;
  getAEResultFilePath: () => string;
  getAEHealthFilePath: () => string;
  getAECommandQueueDirPath: () => string;
  getAEResultQueueDirPath: () => string;
  withBridgeRoundTripLock: <T>(work: () => Promise<T>) => Promise<T>;
  queueBridgeCommand: (command: string, args?: Record<string, any>) => Promise<string>;
  waitForBridgeResult: (options?: { expectedCommand?: string; expectedCommandId?: string; timeoutMs?: number; pollMs?: number }) => Promise<string>;
  readResultsFromTempFile: () => Promise<string>;
  appendOperationLog: (entry: any) => void;
  classifyBridgeFailure: (result: any) => { transient: boolean; failureClass: string };
  classifyMutationRisk: (command: string) => any;
  sanitizeMutationArgs: (args?: Record<string, any>) => Record<string, any>;
  formatToolPayload: FormatToolPayload;
  formatUserFacingResult: (result: any) => Record<string, unknown>;
  buildQueuedBridgeToolResponse: BuildQueuedBridgeToolResponse;
  buildStructuredSafetyError: (error: unknown, fallbackCode: string, fallbackMessage: string) => Record<string, unknown>;
  safeJsonParse: <T = any>(value: string) => T | null;
  queueMutationWithSafety: QueueMutationWithSafety;
  inspectMutationPreflight: (command: string, args: Record<string, any>, riskClass: string, executeBridgeCommandAndWait: ExecuteBridgeCommandAndWait) => Promise<any>;
  getSavedProjectInfoForSafety: (executeBridgeCommandAndWait: ExecuteBridgeCommandAndWait) => Promise<any>;
  createProjectCheckpoint: (label: string | undefined, deps: { executeBridgeCommandAndWait: ExecuteBridgeCommandAndWait }) => Promise<any>;
  executeBridgeCommandAndWait: ExecuteBridgeCommandAndWait;
  listCheckpointEntries: (projectPath: string) => any;
  resolveCheckpointEntry: (projectPath: string, checkpointId?: string) => any;
  buildBranchBeforeRestorePath: (projectPath: string, checkpointId: string) => string;
  SafetyError: any;
  CheckpointSelectionSchema: Record<string, unknown>;
  safetyRoutingDependencies: SafetyRoutingDependencies;
}) {
  const {
    server,
    fs,
    getOperationLogPath,
    getAECommandFilePath,
    getAEResultFilePath,
    getAEHealthFilePath,
    getAECommandQueueDirPath,
    getAEResultQueueDirPath,
    withBridgeRoundTripLock,
    queueBridgeCommand,
    waitForBridgeResult,
    readResultsFromTempFile,
    appendOperationLog,
    classifyBridgeFailure,
    classifyMutationRisk,
    sanitizeMutationArgs,
    formatToolPayload,
    formatUserFacingResult,
    buildStructuredSafetyError,
    safeJsonParse,
    queueMutationWithSafety,
    inspectMutationPreflight,
    getSavedProjectInfoForSafety,
    createProjectCheckpoint,
    executeBridgeCommandAndWait,
    listCheckpointEntries,
    resolveCheckpointEntry,
    buildBranchBeforeRestorePath,
    SafetyError,
    CheckpointSelectionSchema,
    safetyRoutingDependencies
  } = deps;

  const readJsonFileIfExists = (filePath: string) => {
    if (!fs.existsSync(filePath)) {
      return { exists: false, parsed: null as any, raw: null as string | null, mtimeIso: null as string | null };
    }
    const stats = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = safeJsonParse(raw);
    return {
      exists: true,
      parsed,
      raw,
      mtimeIso: stats.mtime.toISOString()
    };
  };

  server.resource(
    "compositions",
    "aftereffects://compositions",
    async (uri: any) => {
      const result = await withBridgeRoundTripLock(async () => {
        const commandId = await queueBridgeCommand("listCompositions", {});
        return await waitForBridgeResult({ expectedCommand: "listCompositions", expectedCommandId: commandId, timeoutMs: 6000, pollMs: 250 });
      });

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: result
        }]
      };
    }
  );

  server.tool(
    "inspect-bridge-health",
    "Inspect bridge health heartbeat, command slot state, and latest result freshness for fast transport diagnosis.",
    {
      staleSeconds: z.number().int().positive().max(600).optional().describe("Heartbeat freshness threshold in seconds. Default 10.")
    },
    async ({ staleSeconds = 10 }: { staleSeconds?: number }) => {
      try {
        const commandPath = getAECommandFilePath();
        const resultPath = getAEResultFilePath();
        const healthPath = getAEHealthFilePath();

        const commandFile = readJsonFileIfExists(commandPath);
        const resultFile = readJsonFileIfExists(resultPath);
        const healthFile = readJsonFileIfExists(healthPath);

        const heartbeatTimestampRaw = String(healthFile.parsed?.lastPollAt || "");
        const heartbeatTimestamp = heartbeatTimestampRaw ? Date.parse(heartbeatTimestampRaw) : NaN;
        const heartbeatAgeMs = Number.isNaN(heartbeatTimestamp) ? null : (Date.now() - heartbeatTimestamp);

        const autoRunEnabled = healthFile.parsed?.autoRunEnabled;
        const resultIsPlaceholder = resultFile.parsed?.status === "waiting" && resultFile.parsed?._placeholder === true;
        const commandStatus = String(commandFile.parsed?.status || "");

        let healthClass: "healthy" | "warning" | "error" = "healthy";
        let diagnosis = "Bridge transport appears healthy.";
        if (!healthFile.exists) {
          healthClass = "error";
          diagnosis = "Bridge heartbeat file is missing. The panel may not be running.";
        } else if (autoRunEnabled === false) {
          healthClass = "error";
          diagnosis = "Bridge heartbeat is live, but auto-run is disabled.";
        } else if (heartbeatAgeMs !== null && heartbeatAgeMs > staleSeconds * 1000) {
          healthClass = "error";
          diagnosis = `Bridge heartbeat is stale (${Math.round(heartbeatAgeMs / 1000)}s old).`;
        } else if ((commandStatus === "pending" || commandStatus === "running") && resultIsPlaceholder) {
          healthClass = "warning";
          diagnosis = "Command slot is active but result is still placeholder waiting.";
        }

        return formatToolPayload({
          status: healthClass === "error" ? "error" : "success",
          bridgeHealthClass: healthClass,
          diagnosis,
          staleThresholdSeconds: staleSeconds,
          files: {
            command: {
              path: commandPath,
              exists: commandFile.exists,
              mtime: commandFile.mtimeIso,
              status: commandFile.parsed?.status || null,
              command: commandFile.parsed?.command || null,
              commandId: commandFile.parsed?.commandId || null
            },
            result: {
              path: resultPath,
              exists: resultFile.exists,
              mtime: resultFile.mtimeIso,
              status: resultFile.parsed?.status || null,
              command: resultFile.parsed?._commandExecuted || resultFile.parsed?.command || null,
              commandId: resultFile.parsed?._commandId || resultFile.parsed?.commandId || null,
              placeholder: resultIsPlaceholder
            },
            heartbeat: {
              path: healthPath,
              exists: healthFile.exists,
              mtime: healthFile.mtimeIso,
              status: healthFile.parsed?.status || null,
              autoRunEnabled: autoRunEnabled === true,
              panelRunning: healthFile.parsed?.panelRunning === true,
              isChecking: healthFile.parsed?.isChecking === true,
              lastPollAt: healthFile.parsed?.lastPollAt || null,
              heartbeatAgeMs
            }
          },
          nextAction: healthClass === "healthy"
            ? "Proceed with normal queue/wait flow."
            : "Reopen the MCP Bridge Auto panel, ensure Auto-run is enabled, then retry."
        }, healthClass === "error");
      } catch (error) {
        return formatToolPayload({
          status: "error",
          message: `Failed to inspect bridge health: ${String(error)}`
        }, true);
      }
    }
  );

  server.tool(
    "recover-bridge-state",
    "Apply safe recovery actions for stale bridge placeholders and orphan pending/running command slot state.",
    {
      resetResultPlaceholder: z.boolean().optional().describe("Rewrite result file to a fresh waiting placeholder. Default true."),
      resetCommandStatus: z.enum(["none", "completed", "error"]).optional().describe("Optionally rewrite active command status when slot is stuck.")
    },
    async ({ resetResultPlaceholder = true, resetCommandStatus = "none" }: { resetResultPlaceholder?: boolean; resetCommandStatus?: "none" | "completed" | "error" }) => {
      try {
        const commandPath = getAECommandFilePath();
        const resultPath = getAEResultFilePath();
        const recoveryAt = new Date().toISOString();
        const actions: string[] = [];

        if (resetResultPlaceholder) {
          const placeholder = {
            status: "waiting",
            message: "Waiting for new result from After Effects...",
            command: null,
            commandId: null,
            timestamp: recoveryAt,
            _placeholder: true,
            _recoveredBy: "recover-bridge-state"
          };
          fs.writeFileSync(resultPath, JSON.stringify(placeholder, null, 2), "utf8");
          actions.push("result-placeholder-reset");
        }

        if (resetCommandStatus !== "none" && fs.existsSync(commandPath)) {
          const raw = fs.readFileSync(commandPath, "utf8");
          const parsed = safeJsonParse(raw);
          if (parsed && (parsed.status === "pending" || parsed.status === "running")) {
            parsed.status = resetCommandStatus;
            parsed.recoveredAt = recoveryAt;
            parsed.recoveredBy = "recover-bridge-state";
            fs.writeFileSync(commandPath, JSON.stringify(parsed, null, 2), "utf8");
            actions.push(`command-status-set-${resetCommandStatus}`);
          }
        }

        return formatToolPayload({
          status: "success",
          message: actions.length ? "Bridge recovery actions applied." : "No recovery action was needed.",
          actions,
          commandPath,
          resultPath
        });
      } catch (error) {
        return formatToolPayload({
          status: "error",
          message: `Failed to recover bridge state: ${String(error)}`
        }, true);
      }
    }
  );

  server.tool(
    "cleanup-bridge-journal",
    "Clean old bridge journal entries in commands/results directories with optional dry-run.",
    {
      dryRun: z.boolean().optional().describe("When true, only report candidates without deleting."),
      maxAgeHours: z.number().positive().max(24 * 365).optional().describe("Delete files older than this age in hours. Default 168 (7 days)."),
      maxFilesPerDir: z.number().int().positive().max(5000).optional().describe("Keep at most this many newest files per directory. Default 300.")
    },
    async ({ dryRun = true, maxAgeHours = 168, maxFilesPerDir = 300 }: { dryRun?: boolean; maxAgeHours?: number; maxFilesPerDir?: number }) => {
      try {
        const commandDir = getAECommandQueueDirPath();
        const resultDir = getAEResultQueueDirPath();
        const cutoffMs = Date.now() - Math.round(maxAgeHours * 60 * 60 * 1000);

        const collectCandidates = (dirPath: string, skipActiveCommands: boolean) => {
          if (!fs.existsSync(dirPath)) {
            return {
              dirPath,
              scanned: 0,
              candidates: [] as Array<{ path: string; reason: "age" | "cap" | "age+cap"; mtime: string }>
            };
          }

          const files = fs.readdirSync(dirPath)
            .filter((name) => name.toLowerCase().endsWith(".json"))
            .map((name) => {
              const filePath = `${dirPath}/${name}`.replace(/\\/g, "/");
              const stats = fs.statSync(filePath);
              return {
                name,
                filePath,
                mtimeMs: stats.mtimeMs,
                mtime: stats.mtime.toISOString()
              };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

          const keepSet = new Set(files.slice(0, maxFilesPerDir).map((entry) => entry.filePath));
          const candidates: Array<{ path: string; reason: "age" | "cap" | "age+cap"; mtime: string }> = [];

          for (const file of files) {
            const byAge = file.mtimeMs < cutoffMs;
            const byCap = !keepSet.has(file.filePath);
            if (!byAge && !byCap) {
              continue;
            }
            if (skipActiveCommands) {
              try {
                const parsed = safeJsonParse(fs.readFileSync(file.filePath, "utf8"));
                if (parsed?.status === "pending" || parsed?.status === "running") {
                  continue;
                }
              } catch {
                // allow cleanup if invalid
              }
            }
            candidates.push({
              path: file.filePath,
              reason: byAge && byCap ? "age+cap" : (byAge ? "age" : "cap"),
              mtime: file.mtime
            });
          }

          return {
            dirPath,
            scanned: files.length,
            candidates
          };
        };

        const commandPlan = collectCandidates(commandDir, true);
        const resultPlan = collectCandidates(resultDir, false);

        const deleteCandidates = (plan: { candidates: Array<{ path: string }> }) => {
          let deleted = 0;
          if (dryRun) {
            return deleted;
          }
          for (const candidate of plan.candidates) {
            try {
              fs.unlinkSync(candidate.path);
              deleted += 1;
            } catch {
              // ignore failed delete and continue
            }
          }
          return deleted;
        };

        const deletedCommands = deleteCandidates(commandPlan);
        const deletedResults = deleteCandidates(resultPlan);

        return formatToolPayload({
          status: "success",
          dryRun,
          policy: {
            maxAgeHours,
            maxFilesPerDir
          },
          commands: {
            path: commandPlan.dirPath,
            scanned: commandPlan.scanned,
            candidateCount: commandPlan.candidates.length,
            deletedCount: deletedCommands,
            candidates: commandPlan.candidates.slice(0, 100)
          },
          results: {
            path: resultPlan.dirPath,
            scanned: resultPlan.scanned,
            candidateCount: resultPlan.candidates.length,
            deletedCount: deletedResults,
            candidates: resultPlan.candidates.slice(0, 100)
          }
        });
      } catch (error) {
        return formatToolPayload({
          status: "error",
          message: `Failed to cleanup bridge journal: ${String(error)}`
        }, true);
      }
    }
  );

  server.tool(
    "run-script",
    "Run a read-only script in After Effects",
    {
      script: z.string().describe("Name of the predefined script to run"),
      parameters: z.record(z.string(), z.unknown()).optional().describe("Optional parameters for the script")
    },
    async ({ script, parameters = {} }: { script: string; parameters?: Record<string, unknown> }) => {
      const allowedScripts = [
        "getProjectItems",
        "findProjectItem",
        "setActiveComp",
        "clearLayerSelection",
        "selectLayers",
        "getLayerDetails",
        "getContextPack",
        "resolveTargets",
        "getCapabilityCatalog",
        "listCompositions",
        "getProjectInfo",
        "getLayerInfo",
        "createComposition",
        "createTextLayer",
        "createShapeLayer",
        "createSolidLayer",
        "createBackgroundSolid",
        "animateTextEntry",
        "setLayerProperties",
        "setLayerKeyframe",
        "setLayerExpression",
        "applyEffect",
        "applyEffectTemplate",
        "test-animation",
        "bridgeTestEffects",
        "enableMotionBlur",
        "sequenceLayerPosition",
        "copyPathsToMasks",
        "setupTypewriterText",
        "createTimerRig",
        "applyBwTint",
        "cleanupKeyframes",
        "setupRetimingMode",
        "createDropdownController",
        "linkOpacityToDropdown",
        "createCamera",
        "batchSetLayerProperties",
        "setCompositionProperties",
        "duplicateLayer",
        "deleteLayer",
        "setLayerMask",
        "preflightMutation",
        "prepareProjectCheckpoint",
        "restoreCheckpoint"
      ];

      if (!allowedScripts.includes(script)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Script "${script}" is not allowed. Allowed scripts are: ${allowedScripts.join(", ")}`
            }
          ],
          isError: true
        };
      }

      try {
        const safety = classifyMutationRisk(script);
        if (safety.isMutation) {
          const payload = await queueMutationWithSafety(script, parameters, { allowForceWithoutCheckpoint: true }, safetyRoutingDependencies);
          return formatToolPayload(payload);
        }

        const commandId = await queueBridgeCommand(script, sanitizeMutationArgs(parameters));
        return formatToolPayload({
          status: "queued",
          command: script,
          commandId,
          message: `Command "${script}" has been queued.\nCommand ID: ${commandId}\nPlease ensure the "MCP Bridge Auto" panel is open in After Effects.\nUse the "get-results" tool after a few seconds to check for results.`
        });
      } catch (error) {
        return formatToolPayload(
          buildStructuredSafetyError(error, "RUN_SCRIPT_FAILED", "Failed to queue the requested script."),
          true
        );
      }
    }
  );

  server.tool(
    "get-results",
    "Get results from the last script executed in After Effects",
    {
      commandId: z.string().optional().describe("Optional command id to verify against the latest bridge result."),
      command: z.string().optional().describe("Optional command name to verify against the latest bridge result.")
    },
    async ({ commandId, command }: { commandId?: string; command?: string }) => {
      try {
        const result = await readResultsFromTempFile();
        let parsed: any = null;
        try {
          parsed = JSON.parse(result);
        } catch {
          parsed = null;
        }
        if (commandId || command) {
          if (commandId && parsed?._commandId !== commandId && parsed?.commandId !== commandId) {
            return formatToolPayload({
              status: "error",
              message: `Latest result does not match command id '${commandId}'.`,
              requestedCommandId: commandId,
              actualCommandId: parsed?._commandId || parsed?.commandId || null,
              summary: {
                whatChanged: [],
                targetUsed: null,
                warnings: [],
                nextAction: "Wait for the requested command to finish or inspect the latest bridge command id."
              }
            }, true);
          }
          if (command && parsed?._commandExecuted !== command && parsed?.command !== command) {
            return formatToolPayload({
              status: "error",
              message: `Latest result does not match command '${command}'.`,
              requestedCommand: command,
              actualCommand: parsed?._commandExecuted || parsed?.command || null,
              summary: {
                whatChanged: [],
                targetUsed: null,
                warnings: [],
                nextAction: "Wait for the requested command to finish or inspect the latest bridge command name."
              }
            }, true);
          }
        }

        if (parsed) {
          appendOperationLog({
            timestamp: new Date().toISOString(),
            phase: "read-result",
            status: parsed?.status === "error" ? "error" : "success",
            command: parsed?._commandExecuted || parsed?.command || command || null,
            commandId: parsed?._commandId || parsed?.commandId || commandId || null,
            failureClass: parsed?.status === "error" ? classifyBridgeFailure(parsed).failureClass : null,
            detail: "Read latest bridge result through get-results.",
            meta: {
              result: parsed
            }
          });
          return formatToolPayload(formatUserFacingResult(parsed), parsed?.status === "error");
        }

        return formatToolPayload({
          status: "success",
          summary: {
            whatChanged: [],
            targetUsed: null,
            warnings: [],
            nextAction: "Inspect the raw result string."
          },
          result
        });
      } catch (error) {
        return formatToolPayload({
          status: "error",
          message: `Error getting results: ${String(error)}`,
          summary: {
            whatChanged: [],
            targetUsed: null,
            warnings: [],
            nextAction: "Inspect bridge log output and verify ae_mcp_result.json is writable."
          }
        }, true);
      }
    }
  );

  server.tool(
    "inspect-mutation-safety",
    "Run the phase-3 safety classifier and AE preflight checks for a mutation command without executing it.",
    {
      command: z.string().describe("Bridge command name to inspect."),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments that would be sent to the mutation command.")
    },
    async ({ command, args = {} }: { command: string; args?: Record<string, unknown> }) => {
      try {
        const safety = classifyMutationRisk(command);
        const payload: Record<string, unknown> = {
          status: "success",
          command,
          safety
        };

        if (safety.isMutation && (safety.riskClass === "medium" || safety.riskClass === "high")) {
          payload.preflight = await inspectMutationPreflight(command, sanitizeMutationArgs(args), safety.riskClass, executeBridgeCommandAndWait);
        }

        if (safety.isMutation && safety.riskClass === "high") {
          const projectInfo = await getSavedProjectInfoForSafety(executeBridgeCommandAndWait);
          payload.project = {
            projectName: projectInfo.projectName,
            projectPath: projectInfo.projectPath || null,
            revision: projectInfo.revision,
            canCheckpoint: projectInfo.isSaved
          };
        }

        return formatToolPayload(payload);
      } catch (error) {
        return formatToolPayload(
          buildStructuredSafetyError(error, "INSPECT_MUTATION_SAFETY_FAILED", "Failed to inspect mutation safety."),
          true
        );
      }
    }
  );

  server.tool(
    "create-checkpoint",
    "Create a safety checkpoint for the active saved After Effects project and record it in the phase-3 manifest.",
    {
      label: z.string().optional().describe("Optional short label for the checkpoint.")
    },
    async ({ label }: { label?: string }) => {
      try {
        const payload = await createProjectCheckpoint(label, { executeBridgeCommandAndWait });
        return formatToolPayload(payload);
      } catch (error) {
        return formatToolPayload(
          buildStructuredSafetyError(error, "CREATE_CHECKPOINT_FAILED", "Failed to create a project checkpoint."),
          true
        );
      }
    }
  );

  server.tool(
    "list-checkpoints",
    "List recorded checkpoints for the active project or for an explicit project path.",
    {
      ...CheckpointSelectionSchema
    },
    async ({ projectPath }: { projectPath?: string }) => {
      try {
        const resolvedProjectPath = projectPath || (await getSavedProjectInfoForSafety(executeBridgeCommandAndWait)).projectPath;
        if (!resolvedProjectPath) {
          throw new SafetyError("PROJECT_NOT_SAVED", "Cannot list checkpoints because the active project is unsaved and no canonical project path was provided.");
        }

        const listed = await listCheckpointEntries(resolvedProjectPath);
        return formatToolPayload({
          status: "success",
          projectPath: resolvedProjectPath,
          recoveredManifestFromBackup: listed.recoveredFromBackup,
          manifestPath: listed.manifest.manifestPath,
          checkpointDirectory: listed.manifest.checkpointDirectory,
          checkpoints: listed.manifest.checkpoints
        });
      } catch (error) {
        return formatToolPayload(
          buildStructuredSafetyError(error, "LIST_CHECKPOINTS_FAILED", "Failed to list project checkpoints."),
          true
        );
      }
    }
  );

  server.tool(
    "restore-checkpoint",
    "Restore a saved checkpoint by reopening the checkpoint project in After Effects, with branch-before-revert enabled by default.",
    {
      ...CheckpointSelectionSchema,
      branchBeforeRevert: z.boolean().optional().describe("Save the current open project to a branch path before opening the checkpoint. Defaults to true.")
    },
    async ({ projectPath, checkpointId, branchBeforeRevert = true }: { projectPath?: string; checkpointId?: string; branchBeforeRevert?: boolean }) => {
      try {
        const resolvedProjectPath = projectPath || (await getSavedProjectInfoForSafety(executeBridgeCommandAndWait)).projectPath;
        if (!resolvedProjectPath) {
          throw new SafetyError("PROJECT_NOT_SAVED", "Cannot restore a checkpoint because the active project is unsaved and no canonical project path was provided.");
        }

        const resolved = await resolveCheckpointEntry(resolvedProjectPath, checkpointId);
        const branchPath = branchBeforeRevert ? buildBranchBeforeRestorePath(resolvedProjectPath, resolved.checkpoint.id) : null;
        const restore = await executeBridgeCommandAndWait("restoreCheckpoint", {
          checkpointPath: resolved.checkpoint.checkpointPath,
          branchPath,
          branchBeforeRevert
        }, {
          timeoutMs: 45000,
          maxAttempts: 1
        });

        if (!restore.ok || restore.result?.status !== "success") {
          throw new SafetyError("RESTORE_CHECKPOINT_FAILED", "After Effects failed to reopen the requested checkpoint.", {
            result: restore.result,
            checkpointId: resolved.checkpoint.id,
            checkpointPath: resolved.checkpoint.checkpointPath
          });
        }

        return formatToolPayload({
          status: "success",
          message: "Checkpoint restored successfully.",
          recoveredManifestFromBackup: resolved.recoveredFromBackup,
          checkpoint: resolved.checkpoint,
          branchBeforeRevert,
          branchPath,
          host: restore.result
        });
      } catch (error) {
        return formatToolPayload(
          buildStructuredSafetyError(error, "RESTORE_CHECKPOINT_FAILED", "Failed to restore project checkpoint."),
          true
        );
      }
    }
  );

  server.tool(
    "get-operation-log",
    "Read recent structured bridge/server operation log entries for diagnosis.",
    {
      commandId: z.string().optional().describe("Optional command id filter."),
      command: z.string().optional().describe("Optional command name filter."),
      limit: z.number().int().positive().max(200).optional().describe("Maximum number of log entries to return.")
    },
    async ({ commandId, command, limit = 50 }: { commandId?: string; command?: string; limit?: number }) => {
      try {
        const logPath = getOperationLogPath();
        if (!fs.existsSync(logPath)) {
          return formatToolPayload({
            status: "success",
            logPath,
            count: 0,
            entries: []
          });
        }

        const entries = fs.readFileSync(logPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line: string) => safeJsonParse(line))
          .filter((entry: any) => Boolean(entry))
          .filter((entry: any) => !commandId || entry.commandId === commandId)
          .filter((entry: any) => !command || entry.command === command)
          .slice(-limit);

        return formatToolPayload({
          status: "success",
          logPath,
          count: entries.length,
          entries
        });
      } catch (error) {
        return formatToolPayload({
          status: "error",
          message: `Failed to read operation log: ${String(error)}`
        }, true);
      }
    }
  );
}
