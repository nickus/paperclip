import { runningProcesses } from "../../../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../../services/local-service-supervisor.js";
import { isSessionedLocalAdapter } from "../../../services/run-host-process.js";
import type { RunProcessController } from "../application/ports.js";
import type { RunProcessCleanupOutcome, RunProcessMetadata } from "../application/types.js";

function isValidPositivePid(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export type ProcessAdapterDeps = {
  /**
   * Whether the pid and process group recorded for a run name a process on
   * this host rather than inside a sandbox. Consulted only for an adapter
   * outside the built-in list that left no in-memory handle; without it such
   * a run's process is left alone.
   */
  runProcessIsOnHost?: (runId: string) => Promise<boolean>;
};

export function createProcessAdapter(deps: ProcessAdapterDeps = {}): RunProcessController {
  return {
    async cleanupRunProcess(input: RunProcessMetadata): Promise<RunProcessCleanupOutcome> {
      const running = runningProcesses.get(input.runId);
      // A registered handle is a child this server spawned on this host. Any
      // other adapter's recorded process is stopped like a built-in's when it
      // runs on this host.
      const stopsHostProcess =
        isSessionedLocalAdapter(input.adapterType) ||
        running !== undefined ||
        ((isValidPositivePid(input.fallbackPid) || isValidPositivePid(input.fallbackProcessGroupId)) &&
          (await deps.runProcessIsOnHost?.(input.runId)) === true);
      if (!stopsHostProcess) {
        return { attempted: false, outcome: "skipped_non_local_adapter", adapterType: input.adapterType };
      }

      const registeredPid = running?.child.pid ?? null;
      const registeredProcessGroupId = running?.processGroupId ?? null;
      const pid = isValidPositivePid(registeredPid)
        ? registeredPid
        : isValidPositivePid(input.fallbackPid)
          ? input.fallbackPid
          : null;
      const processGroupId = isValidPositivePid(registeredProcessGroupId)
        ? registeredProcessGroupId
        : isValidPositivePid(input.fallbackProcessGroupId)
          ? input.fallbackProcessGroupId
          : null;
      const terminationPid = pid ?? processGroupId;
      if (terminationPid === null) {
        return { attempted: false, outcome: "no_process_metadata", adapterType: input.adapterType };
      }

      const wasAlive =
        (pid !== null && isPidAlive(pid)) ||
        (processGroupId !== null && isProcessGroupAlive(processGroupId));
      if (!wasAlive) {
        runningProcesses.delete(input.runId);
        return { attempted: false, outcome: "not_running", adapterType: input.adapterType, pid, processGroupId };
      }

      try {
        await terminateLocalService(
          {
            pid: terminationPid,
            processGroupId,
          },
          running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
        );
        runningProcesses.delete(input.runId);
        const stillAlive =
          (pid !== null && isPidAlive(pid)) ||
          (processGroupId !== null && isProcessGroupAlive(processGroupId));
        return {
          attempted: true,
          outcome: stillAlive ? "termination_sent_still_running" : "terminated",
          adapterType: input.adapterType,
          pid,
          processGroupId,
        };
      } catch (error) {
        return {
          attempted: true,
          outcome: "failed",
          adapterType: input.adapterType,
          pid,
          processGroupId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
