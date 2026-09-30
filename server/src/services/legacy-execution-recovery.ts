import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { isTimeCapCheckpointStopReason, normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { isSupersededConversationRun } from "./agent-conversations.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Task = typeof issues.$inferSelect;
export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

/** One terminal run is one incident; its recovery identity is the run id. */
export function legacyExecutionRecoveryFingerprint(runId: string) {
  return `legacy-execution:${runId}`;
}

/**
 * `resultJson` key recording that an operator action (`initiator`) stopped a
 * run's provider process, which this server owned. The cancellation records
 * the request; `processTerminated` follows once termination verified that the
 * process is gone, so it may trail the terminal status briefly.
 */
export const PROVIDER_STOP_RESULT_KEY = "providerStop";
export const AGENT_PAUSE_STOP_ERROR_CODE = "agent_paused";

export function buildProviderStop(stop: { initiator: "agent_pause"; requestedAt: Date; verifiedAt?: Date }) {
  return {
    initiator: stop.initiator,
    requestedAt: stop.requestedAt.toISOString(),
    ...(stop.verifiedAt ? { processTerminated: true, verifiedAt: stop.verifiedAt.toISOString() } : {}),
  };
}

/**
 * A legacy run that an agent pause stopped, with the stop of its provider
 * process verified. Resuming the agent is the operator's decision to continue
 * the task: the run's recorded work stands, and a new turn decides what
 * remains. A pause stop whose termination was not verified keeps the regular
 * reconciliation hold.
 *
 * Other operator stops need no such record. A restart or drain records an
 * interrupted run, a board Stop records an acknowledged cancellation once
 * termination returns, and conversation continuation accepts both without a
 * hold; a stop that verified nothing keeps the hold. The pause marks its runs
 * cancelled before it stops their processes, so it records the verified stop
 * separately.
 */
export function isVerifiedAgentPauseStop(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson">,
): boolean {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" ||
      run.errorCode !== AGENT_PAUSE_STOP_ERROR_CODE) return false;
  if (hasWorkspaceRestoreFailure(run.resultJson)) return false;
  // A board Stop of the same run is the operator's own decision to stop.
  if (typeof run.resultJson?.cancelledByActorType === "string") return false;
  const stop = run.resultJson?.[PROVIDER_STOP_RESULT_KEY] as Record<string, unknown> | undefined;
  return stop?.initiator === "agent_pause" && stop.processTerminated === true;
}

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  // A fresh model turn cannot repair or verify unrestored files.
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive") return true;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  // A hard time cap that stopped a run while it was still producing output is
  // a checkpoint: the adapter finished its own teardown and the task
  // continues in a bounded continuation from the workspace state.
  if (isTimeCapCheckpointStopReason(run.resultJson?.stopReason)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && run.errorCode === "ai_connection_busy" &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

function isCurrentReviewParticipant(task: Task, agentId: string): boolean {
  const review = task.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
  return review?.status === "pending" &&
    review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === agentId;
}

/**
 * Whether a terminal legacy run records its reconciliation hold on the task:
 * only while its agent still owns the open task (as assignee or as the
 * current review participant) and the run is not an older turn of a
 * conversation that has moved on. Anything that waits for that hold must use
 * the same test, or it can wait for a hold that is never recorded.
 */
export function legacyExecutionHoldApplies(
  task: Task,
  run: Pick<Run, "id" | "agentId" | "contextSnapshot">,
): boolean {
  return (
    !["done", "cancelled"].includes(task.status) &&
    (task.assigneeAgentId === run.agentId || isCurrentReviewParticipant(task, run.agentId)) &&
    !isSupersededConversationRun(task, run)
  );
}

/** Persist the failed legacy run, owned lock release and operator decision together. */
export async function terminalizeLegacyExecution(input: {
  db: Db;
  run: Run;
  status: string;
  patch?: Partial<typeof heartbeatRuns.$inferInsert>;
  fromStatuses?: string[];
}) {
  const { db, run, status, patch } = input;
  const issueId =
    run.nativeIssueId ??
    (typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [task] = issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)),
          )
          .for("update")
      : [];
    const [updated] = await tx
      .update(heartbeatRuns)
      .set({
        status,
        ...patch,
        executionStatusDeliveryId: randomUUID(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          inArray(heartbeatRuns.status, input.fromStatuses ?? [run.status]),
        ),
      )
      .returning();
    if (!updated) return null;
    if (task?.executionRunId === run.id)
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, task.id));
    if (task?.checkoutRunId === run.id)
      await tx
        .update(issues)
        .set({ checkoutRunId: null })
        .where(eq(issues.id, task.id));
    if (task && legacyExecutionHoldApplies(task, updated)) {
      const isCurrentReviewer = isCurrentReviewParticipant(task, run.agentId);
      const fingerprint = legacyExecutionRecoveryFingerprint(run.id);
      // Periodic stranded-work checks, retry paths and late finalizers may
      // revisit this terminal run. Its incident is recorded once. A closed
      // record (reconciled, settled without replay, cancelled or superseded)
      // already carries the decision for this exact run; a second row would
      // be a second hold that must be cleared on its own. Only an open record
      // is refreshed in place. The issue row lock above serializes callers.
      const recorded = await tx.select({
        status: issueRecoveryActions.status,
        reconciled: sql<boolean>`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
      })
        .from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          or(
            and(
              eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
              eq(issueRecoveryActions.fingerprint, fingerprint),
            ),
            and(
              eq(issueRecoveryActions.status, "resolved"),
              sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
            ),
            // A run whose workspace restore was refused as unsafe is settled
            // without replay; its record stands like any other closed one.
            and(
              eq(issueRecoveryActions.status, "resolved"),
              sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
              sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
              sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
            ),
          ),
        ));
      const open = recorded.some((row) => ["active", "escalated"].includes(row.status));
      // A recorded operator decision for this run always stands.
      const reconciled = recorded.some((row) => row.status === "resolved" && row.reconciled === true);
      if (reconciled || (recorded.length > 0 && !open)) return updated;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: run.companyId,
        sourceIssueId: task.id,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: task.assigneeAgentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint,
        evidence: {
          runId: run.id,
          ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
          originalFailureCode: updated.errorCode,
          ...(hasWorkspaceRestoreFailure(updated.resultJson) ? { workspaceRestoreFailure: updated.resultJson!.workspaceRestoreFailure } : {}),
          adapterRecovery: "unsupported_or_unknown",
          attempt: executionFailureRetryCount(run) + 1,
        },
        nextAction: hasWorkspaceRestoreFailure(updated.resultJson)
          ? "Verify safe workspace staging or repair, then reconcile the stopped run before continuing. Saved work and approval decisions remain in force."
          : "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing. This adapter has not established a safe resume checkpoint.",
        maxAttempts: 3,
        wakePolicy: null,
        supersedeOnIdentityChange: true,
      });
    }
    return updated;
  });
}
