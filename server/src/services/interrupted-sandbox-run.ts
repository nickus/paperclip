import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";

/**
 * Whether a run was ended from outside instead of finishing its turn: it was
 * cancelled (a Stop, a comment that interrupts it, a pause, a reassignment),
 * timed out, interrupted by a server shutdown, or lost its process. Such a run
 * may not have synced its workspace changes back to the host.
 */
export function runWasInterrupted(run: { status: string; errorCode: string | null }): boolean {
  return run.status === "cancelled" ||
    run.status === "timed_out" ||
    run.status === "interrupted" ||
    (run.status === "failed" && run.errorCode === "process_lost");
}

/**
 * The previous run on the same task when this run resumed the sandbox that run
 * used (`previousRunId` on the lease's acquisition record) and it was
 * interrupted; otherwise null.
 *
 * A run of a legacy adapter stages the workspace from the host copy into the
 * sandbox again, so what the interrupted run changed in the sandbox without
 * syncing it back is gone. The agent session the sandbox kept still remembers
 * those changes, so the wake prompt tells the agent to re-check the workspace.
 */
export async function interruptedRunBeforeResumedSandbox(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    issueId: string | null;
    lease: Pick<EnvironmentLease, "metadata">;
  },
): Promise<string | null> {
  if (!input.issueId) return null;
  const acquisition = input.lease.metadata?.sandboxLeaseAcquisition;
  if (!acquisition || typeof acquisition !== "object" || Array.isArray(acquisition)) return null;
  const { outcome, previousRunId } = acquisition as Record<string, unknown>;
  if (outcome !== "resumed" || typeof previousRunId !== "string" || previousRunId === input.runId) return null;
  const [previous] = await db
    .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, previousRunId), eq(heartbeatRuns.companyId, input.companyId)))
    .limit(1);
  if (!previous || !runWasInterrupted(previous)) return null;
  return previous.contextSnapshot?.issueId === input.issueId ? previousRunId : null;
}
