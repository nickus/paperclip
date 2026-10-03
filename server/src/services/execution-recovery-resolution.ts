import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import {
  conversationRecoveryActionPredicate,
  getConversationOwnershipBlocker,
  runUsedConversationAdapter,
} from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, inArray, isNull, not, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  agents,
  chatActions,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { conflict, HttpError } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { DIRECT_NON_INVOKABLE_STATUSES } from "./agent-invokability.js";
import {
  AGENT_PAUSE_STOP_ERROR_CODE,
  isVerifiedAgentPauseStop,
  LEGACY_RECOVERY_CAUSE,
  PROVIDER_STOP_RESULT_KEY,
} from "./legacy-execution-recovery.js";
import {
  assessInertLegacyRun,
  describeInertRunEvidence,
  inertLegacyRunGraceCondition,
  inertLegacyRunRowCondition,
  isInertRunAutoReconcileEnabled,
  INERT_RUN_RECONCILIATION_POLICY,
  INERT_RUN_RELEASE_RECHECK_MS,
  inertRunSettledHoldMaxAgeMs,
} from "./inert-legacy-execution.js";
import { releaseHeldExecutionWaits, type PromoteDeferredWakesAfterHold } from "./execution-wait-release.js";
import { withWakeBudget, type ExecutionHoldWakeBudget } from "./execution-hold-wake-budget.js";
import { issueService } from "./issues.js";
import { getExecutionBlocker } from "./execution-blocker.js";

/** An operator records observed outcomes; this is not permission to blindly retry. */
export async function validateExecutionReconciliation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string | null;
  sourceRunId: unknown;
  decision: ExecutionReconciliation | undefined;
}) {
  const { db, companyId, issueId, agentId, decision } = input;
  if (!decision || decision.runId !== input.sourceRunId || !agentId) {
    throw conflict(
      "Reconcile the recorded execution and its action outcomes before continuing this task.",
    );
  }
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, decision.runId),
      ),
    );
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const review =
    task?.status === "in_review"
      ? parseIssueExecutionState(task.executionState)
      : null;
  const isCurrentReviewer =
    review?.status === "pending" &&
    review.currentParticipant?.type === "agent" &&
    review.currentParticipant.agentId === run?.agentId;
  if (
    !run ||
    !task ||
    task.assigneeAgentId !== agentId ||
    (run.agentId !== agentId && !isCurrentReviewer) ||
    (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
    !["failed", "interrupted", "timed_out", "cancelled"].includes(run.status)
  ) {
    throw conflict(
      "The recovery source or task owner changed. Inspect the current execution before continuing.",
    );
  }
  if (hasWorkspaceRestoreFailure(run.resultJson) &&
      (!decision.workspaceRepairEvidence || decision.workspaceRepairEvidence.trim().length < 20)) {
    throw conflict("Verify safe workspace staging or repair and record workspaceRepairEvidence before continuing this run.");
  }
  for (const pid of [
    run.processPid,
    run.processGroupId ? -run.processGroupId : null,
  ]) {
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw conflict(
        "The previous provider's process ownership cannot be verified.",
      );
    }
    throw conflict(
      "The previous provider is still running. Stop it before continuing.",
    );
  }
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, run.id),
      ),
    );
  if (coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId)
    throw conflict(
      "This execution still has a coordinator or a linked continuation. Inspect that run first.",
    );
  const leases = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        isNull(environmentLeases.releasedAt),
      ),
    )
    .limit(1);
  if (leases.length)
    throw conflict(
      "The previous execution environment has not finished releasing its authority.",
    );
  await buildExecutionContinuation({
    db,
    companyId,
    issueId,
    agentId,
    context: { previousRunId: run.id },
    summary: null,
    exposeLowTrustRaw: false,
  });
  return run;
}

/** Durable delivery marker lives on the existing source-scoped recovery action. */
export async function markExecutionReconciliation(
  db: Db,
  action: Pick<
    typeof issueRecoveryActions.$inferSelect,
    "companyId" | "id" | "evidence" | "sourceIssueId"
  >,
  decision: ExecutionReconciliation,
  actorId: string,
  deliveryOwner?: { kind: "chat_failed_run_retry"; actionId: string },
) {
  if (deliveryOwner) {
    const [retry] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, action.companyId),
          eq(chatActions.id, deliveryOwner.actionId),
        ),
      );
    if (
      deliveryOwner.kind !== "chat_failed_run_retry" ||
      !retry ||
      retry.kind !== "failed_run_retry" ||
      !["issued", "processing", "processed"].includes(retry.status) ||
      retry.payload.version !== 1 ||
      retry.payload.failedRunId !== decision.runId ||
      retry.payload.issueId !== action.sourceIssueId
    ) {
      throw conflict("The authorized chat retry owner is no longer valid.");
    }
  }
  await db
    .update(nativeRunFinalizations)
    .set({
      failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "operator_reconciled" })}::jsonb`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.companyId, action.companyId),
        eq(nativeRunFinalizations.runId, decision.runId),
      ),
    );
  await db
    .update(issueRecoveryActions)
    .set({
      evidence: {
        ...action.evidence,
        automaticRecovery: undefined,
        executionReconciliation: {
          ...decision,
          actorId,
          recordedAt: new Date().toISOString(),
        },
        continuationDelivery: deliveryOwner ? "delegated" : "pending",
        ...(deliveryOwner ? { continuationDeliveryOwner: deliveryOwner } : {}),
      },
    })
    .where(
      and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
      ),
    );
}

/**
 * A settled continuation is the last step of a hold that ended through
 * reconciliation. Release what the hold kept back (the continuation covers the
 * assignee's signals); a failure here leaves it to the periodic sweep.
 */
async function releaseAfterContinuation(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
  action: Pick<typeof issueRecoveryActions.$inferSelect, "id" | "companyId" | "sourceIssueId">,
  promote?: PromoteDeferredWakesAfterHold,
) {
  try {
    await releaseHeldExecutionWaits(db, wake, { companyId: action.companyId, issueId: action.sourceIssueId, promote });
  } catch (err) {
    logger.warn(
      { err, recoveryActionId: action.id, issueId: action.sourceIssueId },
      "Held execution wait release after a reconciled continuation deferred to the sweep",
    );
  }
}

export async function deliverReconciledExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
  options: { promote?: PromoteDeferredWakesAfterHold; budget?: ExecutionHoldWakeBudget } = {},
) {
  const { budget } = options;
  const budgetedWake = withWakeBudget(budget, wake);
  const promote = options.promote ? withWakeBudget(budget, options.promote) : undefined;
  const pending = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        // A paused, terminated or unapproved owner cannot accept the wake. Its
        // delivery stays pending until the owner is invokable again, and is
        // left out of the batch so it never crowds out deliverable rows.
        sql`not exists (
          select 1 from ${agents}
          where ${agents.companyId} = ${issueRecoveryActions.companyId}
            and ${agents.id} = ${issueRecoveryActions.returnOwnerAgentId}
            and ${agents.status} in (${sql.join(
              [...DIRECT_NON_INVOKABLE_STATUSES].map((status) => sql`${status}`),
              sql`, `,
            )})
        )`,
        // Dependency admission does not start the continuation while a
        // first-class blocker is unresolved; it waits here the same way. Only
        // a done blocker is resolved: a cancelled one stays unresolved until
        // the relation is removed or replaced.
        sql`not exists (
          select 1 from ${issueRelations}
          inner join ${issues} on ${issues.id} = ${issueRelations.issueId}
          where ${issueRelations.companyId} = ${issueRecoveryActions.companyId}
            and ${issueRelations.relatedIssueId} = ${issueRecoveryActions.sourceIssueId}
            and ${issueRelations.type} = 'blocks'
            and ${issues.status} <> 'done'
        )`,
      ),
    )
    // Rows never attempted first, then the ones declined longest ago: a
    // continuation that admission keeps declining (for example behind a
    // blocker's workspace finalization) rotates behind the others.
    .orderBy(
      sql`(${issueRecoveryActions.evidence}->>'continuationDeliveryAttemptedAt')::timestamptz asc nulls first`,
      asc(issueRecoveryActions.resolvedAt),
      asc(issueRecoveryActions.id),
    )
    .limit(25);
  const recordDeclinedAttempt = (action: typeof issueRecoveryActions.$inferSelect) =>
    db
      .update(issueRecoveryActions)
      .set({
        evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
          continuationDeliveryAttemptedAt: new Date().toISOString(),
        })}::jsonb`,
      })
      .where(
        and(
          eq(issueRecoveryActions.companyId, action.companyId),
          eq(issueRecoveryActions.id, action.id),
          sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        ),
      )
      .catch(() => undefined);
  for (const [index, action] of pending.entries()) {
    // Paced: the rest waits, untouched, for a later pass.
    if (budget && !budget.available()) {
      logger.info(
        { overBudget: pending.length - index },
        "Reconciled continuations paced by the sweep wake budget; the rest wait for the next pass",
      );
      break;
    }
    try {
      const decision = action.evidence.executionReconciliation as
        ExecutionReconciliation | undefined;
      if (!decision || !action.returnOwnerAgentId) continue;
      const pendingDecision = and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        sql`${issueRecoveryActions.evidence}->'executionReconciliation' = ${JSON.stringify(decision)}::jsonb`,
      );
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, action.companyId),
            eq(issues.id, action.sourceIssueId),
          ),
        );
      if (
        !task ||
        task.assigneeAgentId !== action.returnOwnerAgentId ||
        ["done", "cancelled"].includes(task.status)
      ) {
        const [invalidated] = await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
              continuationDelivery: "invalidated",
              continuationDeliveryAt: new Date().toISOString(),
            })}::jsonb`,
          })
          .where(pendingDecision)
          .returning({ id: issueRecoveryActions.id });
        // The task changed hands or finished: whatever the hold kept back goes
        // to the current assignee, or is finalized.
        if (invalidated && task) await releaseAfterContinuation(db, budgetedWake, action, promote);
        continue;
      }
      const run = await budgetedWake(action.returnOwnerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        idempotencyKey: `execution-reconciliation:${action.id}`,
        payload: { issueId: task.id, recoveryActionId: action.id },
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          recoveryActionId: action.id,
          previousRunId: decision.runId,
          retryOfRunId: decision.runId,
          forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored",
          source: "execution.reconciled",
        },
      });
      if (!run) {
        // Admission declined it and recorded its own receipt; retried later.
        await recordDeclinedAttempt(action);
        continue;
      }
      await db.transaction(async (tx) => {
        await tx
          .update(heartbeatRuns)
          .set({ retryOfRunId: decision.runId })
          .where(
            and(
              eq(heartbeatRuns.companyId, action.companyId),
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.agentId, action.returnOwnerAgentId!),
              sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${action.id}`,
              sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${decision.runId}`,
            ),
          );
        await tx
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
              {
                continuationDelivery: "delivered",
                continuationRunId: run.id,
                continuationDeliveryAt: new Date().toISOString(),
              },
            )}::jsonb`,
          })
          .where(pendingDecision);
      });
      // The continuation covers the signals the hold kept back; record that,
      // and finalize anything held for someone else.
      await releaseAfterContinuation(db, budgetedWake, action, promote);
    } catch {
      await recordDeclinedAttempt(action);
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
  }
}

export const AGENT_PAUSE_RESUME_POLICY = "agent_pause_resume_v1";

/**
 * How long the automatic disposition leaves a run the agent pause cancelled
 * while the pause is still stopping its process: the verified stop and the
 * release of the run's execution environment follow the cancellation. After
 * this window a run without both keeps the regular no-replay disposition.
 */
export const AGENT_PAUSE_STOP_SETTLE_GRACE_MS = 5 * 60_000;

/** Null-safe: true only for a recent pause stop that is not yet verified or released. */
function agentPauseStopPendingCondition(now: Date): SQL {
  const cutoff = new Date(now.getTime() - AGENT_PAUSE_STOP_SETTLE_GRACE_MS);
  const stop = sql`${heartbeatRuns.resultJson} -> ${PROVIDER_STOP_RESULT_KEY}::text`;
  return sql`(
    ${heartbeatRuns.runtimeMode} = 'legacy'
    and ${heartbeatRuns.status} = 'cancelled'
    and coalesce(${heartbeatRuns.errorCode}, '') = ${AGENT_PAUSE_STOP_ERROR_CODE}
    and coalesce(${stop} ->> 'initiator', '') = 'agent_pause'
    and coalesce(${heartbeatRuns.finishedAt} > ${cutoff.toISOString()}::timestamptz, false)
    and (
      coalesce(${stop} ->> 'processTerminated', '') <> 'true'
      or exists (
        select 1 from ${environmentLeases}
        where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
          and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id}
          and ${environmentLeases.releasedAt} is null
      )
    )
  )`;
}

/**
 * Continue a task whose run an agent pause stopped. The pause stopped the
 * provider process and verified it (see `isVerifiedAgentPauseStop`), and the
 * run's adapter takes a conversation turn, so a new turn sees the recorded
 * comments and documents and decides what remains; nothing is replayed
 * blindly. The decision is the one an operator records for such a run
 * (`providerStopped: true`, `actionOutcome: "mixed"`) and goes through the
 * same validation and delivery path: the continuation is delivered once the
 * agent can be invoked again, that is when it is resumed.
 *
 * Returns false when the operator path would refuse the decision; the caller
 * then applies the regular no-replay disposition. Runs inside the caller's
 * transaction, which already holds the task, coordinator, run and action.
 */
async function continueAfterAgentPause(
  tx: Db,
  input: {
    task: typeof issues.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect;
    action: typeof issueRecoveryActions.$inferSelect;
    now: Date;
  },
) {
  const { task, run, action, now } = input;
  const stop = run.resultJson?.[PROVIDER_STOP_RESULT_KEY] as { verifiedAt?: unknown } | undefined;
  const decision: ExecutionReconciliation = {
    runId: run.id,
    providerStopped: true,
    // Work before the pause may have happened; it stands and is not repeated.
    actionOutcome: "mixed",
    outcomeEvidence:
      `Automatic reconciliation (${AGENT_PAUSE_RESUME_POLICY}): the agent was paused while this run was working. ` +
      `The run's process was stopped and verified gone${typeof stop?.verifiedAt === "string" ? ` at ${stop.verifiedAt}` : ""}. ` +
      "Comments, documents and other work the run recorded before the pause stand; a new turn continues the task.",
  };
  try {
    await validateExecutionReconciliation({
      db: tx,
      companyId: task.companyId,
      issueId: task.id,
      agentId: task.assigneeAgentId,
      sourceRunId: action.evidence.runId,
      decision,
    });
  } catch (err) {
    // A refusal keeps the regular disposition. A database error aborts the
    // transaction instead, and the candidate is retried on the next sweep.
    if (!(err instanceof HttpError)) throw err;
    logger.info(
      { err, recoveryActionId: action.id, runId: run.id },
      "Paused run keeps its no-replay disposition; the continuation was refused",
    );
    return false;
  }
  await markExecutionReconciliation(tx, action, decision, "execution-recovery");
  const note =
    "The agent was paused during this run and its process was stopped. Recorded work is preserved; the task continues in a new run when the agent is resumed.";
  await tx
    .update(issueRecoveryActions)
    .set({
      status: "resolved",
      outcome: "restored",
      resolvedAt: now,
      updatedAt: now,
      nextAction: note,
      resolutionNote: note,
      wakePolicy: null,
      monitorPolicy: null,
    })
    .where(eq(issueRecoveryActions.id, action.id));
  await persistActivity(tx, {
    companyId: run.companyId,
    actorType: "system",
    actorId: "execution-recovery",
    action: "issue.execution_recovery_settled",
    entityType: "issue",
    entityId: task.id,
    runId: run.id,
    details: {
      recoveryActionId: action.id,
      outcome: "restored",
      replay: "authorized_on_resume",
      actionOutcome: decision.actionOutcome,
      automatic: true,
      policy: AGENT_PAUSE_RESUME_POLICY,
    },
  });
  await tx
    .update(heartbeatRuns)
    .set({ executionStatusDeliveryId: randomUUID() })
    .where(eq(heartbeatRuns.id, run.id));
  await appendHeartbeatRunEvent(tx, {
    companyId: run.companyId,
    agentId: run.agentId,
    runId: run.id,
    eventType: "lifecycle",
    stream: "system",
    level: "info",
    message: note,
    payload: {
      recoveryActionId: action.id,
      cause: action.cause,
      automaticRecovery: AGENT_PAUSE_RESUME_POLICY,
      actionOutcome: decision.actionOutcome,
    },
  });
  return true;
}

/** Error code of a resume that a reconciliation hold blocks; see `reconcileExecutionHoldForResume`. */
export const RESUME_RECONCILIATION_REQUIRED_CODE = "execution_reconciliation_required";

/** What a board operator confirms when a resume continues held work. */
export const RESUME_RECONCILIATION_CONFIRMATION =
  "The stopped run's process has exited. Work it recorded before it stopped (comments, documents and other " +
  "actions) stands and is not undone; an action whose result was not recorded may or may not have happened. " +
  "Continuing starts a new run that reviews the recorded work and continues the task.";

/** A hold a board operator can reconcile from the resume flow instead of the recovery API. */
export function isResumeReconcilableBlocker(
  blocker: { recoveryActionId: string | null; cause: string } | null,
): blocker is { recoveryActionId: string; cause: string } {
  return Boolean(blocker?.recoveryActionId && blocker.cause === LEGACY_RECOVERY_CAUSE);
}

/**
 * Reconcile the legacy execution hold that blocks a task a board operator is
 * resuming, after the operator confirmed `RESUME_RECONCILIATION_CONFIRMATION`.
 * Records the same decision as an operator reconciliation through the recovery
 * API (`providerStopped: true`, `actionOutcome: "mixed"`) with the same checks:
 * the task owner, a stopped process, no coordinator and released execution
 * environments. The continuation is delivered like any reconciled one. A
 * refusal throws and records nothing.
 */
export async function reconcileExecutionHoldForResume(
  db: Db,
  input: { companyId: string; issueId: string; recoveryActionId: string; actorId: string },
) {
  const stale = () =>
    conflict("This task's recovery changed while it was being resumed. Refresh the task and try again.");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [candidate] = await tx
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.id, input.recoveryActionId),
        eq(issueRecoveryActions.sourceIssueId, input.issueId),
      ));
    const runId = candidate?.evidence.runId;
    if (typeof runId !== "string") throw stale();
    // Same issue -> coordinator -> run -> action lock order as the disposition.
    const [task] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .for("update");
    await tx
      .select({ runId: nativeRunFinalizations.runId })
      .from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, runId)))
      .for("update");
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)))
      .for("update");
    const [action] = await tx
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, candidate!.id))
      .for("update");
    if (
      !task ||
      !run ||
      !action ||
      action.evidence.runId !== run.id ||
      action.cause !== LEGACY_RECOVERY_CAUSE ||
      action.kind !== "active_run_watchdog" ||
      !(["active", "escalated"].includes(action.status) || isSettledNoReplayHold(action))
    )
      throw stale();
    if (!action.returnOwnerAgentId || task.assigneeAgentId !== action.returnOwnerAgentId)
      throw conflict("The task changed hands since its run stopped. Inspect the task before resuming it.");
    const decision: ExecutionReconciliation = {
      runId: run.id,
      providerStopped: true,
      actionOutcome: "mixed",
      outcomeEvidence: `Confirmed by a board operator while resuming the task: ${RESUME_RECONCILIATION_CONFIRMATION}`,
    };
    await validateExecutionReconciliation({
      db: tx as unknown as Db,
      companyId: task.companyId,
      issueId: task.id,
      agentId: task.assigneeAgentId,
      sourceRunId: run.id,
      decision,
    });
    await markExecutionReconciliation(tx as unknown as Db, action, decision, input.actorId);
    const now = new Date();
    const note =
      "Reconciled by a board operator while resuming the task. Recorded work stands; the task continues in a new run.";
    await tx
      .update(issueRecoveryActions)
      .set({
        status: "resolved",
        outcome: "restored",
        resolvedAt: now,
        updatedAt: now,
        nextAction: note,
        resolutionNote: note,
        wakePolicy: null,
        monitorPolicy: null,
      })
      .where(eq(issueRecoveryActions.id, action.id));
    await persistActivity(tx as unknown as Db, {
      companyId: task.companyId,
      actorType: "user",
      actorId: input.actorId,
      action: "issue.recovery_action_resolved",
      entityType: "issue",
      entityId: task.id,
      details: {
        identifier: task.identifier,
        recoveryActionId: action.id,
        outcome: "restored",
        source: "tree_resume",
        sourceRunId: run.id,
        actionOutcome: decision.actionOutcome,
        resolutionNote: note,
      },
    });
    await tx
      .update(heartbeatRuns)
      .set({ executionStatusDeliveryId: randomUUID() })
      .where(eq(heartbeatRuns.id, run.id));
    return { recoveryActionId: action.id, runId: run.id };
  });
}

/**
 * A board/user signal that is itself an explicit decision to continue a task
 * ends a no-replay hold the same way a board operator's confirmed "Resume
 * work" does: a reopening comment, a comment that @-mentions the assignee, or
 * a status PATCH back to todo/in_progress all say, in as many words, "keep
 * going" about a task whose hold the person issuing them may not even know
 * exists. There is nothing left to confirm (unlike the resume flow, which
 * warns before acting), so this reconciles immediately through the exact same
 * machinery (`getExecutionBlocker`, `isResumeReconcilableBlocker`,
 * `reconcileExecutionHoldForResume`) instead of a parallel path.
 *
 * Best-effort: a hold that is not resume-reconcilable (wrong cause, or an
 * owner-active/workspace-unsafe blocker with no recorded action) or a
 * reconciliation the stale/owner checks refuse leaves the existing
 * disposition in place and the wake parks as usual; only an agent-authored
 * signal is excluded by the caller, never here.
 */
export async function releaseExecutionHoldForExplicitIntent(
  db: Db,
  input: { companyId: string; issueId: string; actorId: string },
): Promise<boolean> {
  const blocker = await getExecutionBlocker(db, input.companyId, input.issueId);
  if (!isResumeReconcilableBlocker(blocker)) return false;
  try {
    await reconcileExecutionHoldForResume(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      recoveryActionId: blocker.recoveryActionId,
      actorId: input.actorId,
    });
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    logger.info(
      { err, issueId: input.issueId, recoveryActionId: blocker.recoveryActionId },
      "Explicit board/user continuation could not reconcile the execution hold; it keeps its disposition",
    );
    return false;
  }
}

/**
 * Failed execution is a system responsibility, not a user questionnaire. After
 * automatic recovery is ruled out, preserve evidence and stop without replay.
 * This is NOT evidence that an external action succeeded or never happened.
 * The resolved record retains a dispatch hold until actual evidence clears it.
 */
export async function settleUnrecoverableExecutions(
  db: Db,
  now = new Date(),
  options: { failpoint?: (phase: "persisted") => void } = {},
) {
  // Fold obsolete conversation holds without waking historical work on upgrade.
  // Keep their evidence and record the policy change in the task's activity log.
  const obsoleteConversationHold = and(
    conversationRecoveryActionPredicate(),
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
  await db.transaction(async tx => {
    const foldable = await tx.select().from(issueRecoveryActions).where(obsoleteConversationHold)
      .limit(25).for("update", { skipLocked: true });
    for (const candidate of foldable) {
      if (await getConversationOwnershipBlocker(tx as unknown as Db, candidate.companyId, candidate.sourceIssueId)) continue;
      const [action] = await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "cancelled",
        resolvedAt: now,
        updatedAt: now,
        nextAction: "Automatic attempts stopped. Send a new message to continue the conversation.",
        resolutionNote: "Conversation continuation does not replay prior tool calls.",
        wakePolicy: null,
        monitorPolicy: null,
        evidence: sql`case when ${issueRecoveryActions.evidence} ? 'automaticRecovery'
          then jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"conversation_continuation"'::jsonb)
          else ${issueRecoveryActions.evidence} end`,
      }).where(and(obsoleteConversationHold, eq(issueRecoveryActions.id, candidate.id))).returning();
      if (!action) continue;
      await persistActivity(tx as unknown as Db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_settled",
        entityType: "issue",
        entityId: action.sourceIssueId,
        details: { recoveryActionId: action.id, outcome: "cancelled", continuation: "conversation" },
      });
    }
  });
  // Filter eligibility before applying the batch limit. A queue of sessions
  // awaiting replacement must not starve settled incidents behind it.
  const candidates = await db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        not(conversationRecoveryActionPredicate()!),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        inArray(issueRecoveryActions.cause, [
          ...EXECUTION_RECONCILIATION_CAUSES,
        ]),
        inArray(heartbeatRuns.status, [
          "failed",
          "timed_out",
          "interrupted",
          "cancelled",
        ]),
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.resultId),
        or(
          isNull(nativeRunFinalizations.runId),
          eq(nativeRunFinalizations.phase, "terminal_failure"),
        ),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`(${heartbeatRuns.runtimeMode} <> 'native' or coalesce(${nativeRunFinalizations.failureCode}, '') <> 'native_provider_terminal_failed'
        or coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') <> '')`,
        // A run that stopped before adapter dispatch belongs to the inert-run
        // reconciliation for a short window, until it is assessed or the
        // window closes. Blocking it here first would leave a no-replay hold.
        isInertRunAutoReconcileEnabled()
          ? not(and(
            eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
            inertLegacyRunGraceCondition(now),
            sql`not (${issueRecoveryActions.evidence} ? 'inertRunAssessment')`,
          )!)
          : undefined,
        // The agent pause records a verified stop after it cancels the run.
        // Settling first would block a task that resuming the agent continues.
        not(and(
          eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
          agentPauseStopPendingCondition(now),
        )!),
      ),
    )
    .limit(25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run ordering as replacement/finalization.
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, candidate.companyId),
              eq(issues.id, candidate.sourceIssueId),
            ),
          )
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.companyId, candidate.companyId),
              eq(nativeRunFinalizations.runId, runId),
            ),
          )
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, candidate.companyId),
              eq(heartbeatRuns.id, runId),
            ),
          )
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== runId ||
          !EXECUTION_RECONCILIATION_CAUSES.includes(
            action.cause as (typeof EXECUTION_RECONCILIATION_CAUSES)[number],
          ) ||
          !["active", "escalated"].includes(action.status) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            run.status,
          )
        )
          return;
        // Give durable native recovery its chance; never preempt a resume,
        // replacement, result finalizer, or still-owned execution.
        if (
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          (coordinator && coordinator.phase !== "terminal_failure") ||
          (run.runtimeMode === "native" &&
            coordinator?.failureCode === "native_provider_terminal_failed" &&
            !coordinator.failureDetail?.replacementDenied)
        )
          return;
        const current =
          !isSupersededConversationRun(task, run) &&
          action.returnOwnerAgentId !== null &&
          task.assigneeAgentId === action.returnOwnerAgentId &&
          !["done", "cancelled"].includes(task.status) &&
          (!task.executionRunId || task.executionRunId === run.id) &&
          (!task.checkoutRunId || task.checkoutRunId === run.id);
        // Pausing an agent is not a decision to stop its task, for any
        // adapter: that is why a verified pause stop is never left as a
        // *silent* hold (see `getExecutionBlocker`, the attention feed, and
        // `releaseExecutionHoldForExplicitIntent` below, which end such a
        // hold the moment a human says to continue). Automatic, unattended
        // continuation right here, though, stays scoped to a conversation
        // adapter's own turn: that turn reviews the recorded comments and
        // documents and decides what remains, so nothing already done is
        // repeated. An adapter that instead replays a configured command or
        // webhook on every invocation (see `CONVERSATION_ADAPTER_TYPES`'
        // module comment) has no such review step, and Paperclip cannot know
        // whether the run already performed its action before the pause —
        // continuing it unattended could repeat that action. Such a run keeps
        // the disposition below until a human explicitly says to continue it.
        if (
          current &&
          action.cause === LEGACY_RECOVERY_CAUSE &&
          run.agentId === task.assigneeAgentId &&
          CONTINUABLE_TASK_STATUSES.includes(task.status) &&
          isVerifiedAgentPauseStop(run) &&
          (await runUsedConversationAdapter(tx as unknown as Db, run)) &&
          (await continueAfterAgentPause(tx as unknown as Db, { task, run, action, now }))
        ) {
          options.failpoint?.("persisted");
          return;
        }
        const note = current
          ? hasWorkspaceRestoreFailure(run.resultJson)
            ? "Workspace repair required. Verify safe staging or repair before continuing. Saved work and approval decisions remain in force."
            : "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
          : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
        let nativeFailureBlock = action.evidence.nativeFailureBlock;
        if (current) {
          const [projected] = await tx
            .update(issues)
            .set({
              status: "blocked",
              executionRunId: null,
              checkoutRunId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, task.id)).returning();
          // Only a transition owned by this failure grants a recovery receipt.
          // An already-blocked task may have a separate human/dependency hold.
          if (task.status !== "blocked" && run.runtimeMode === "native") {
            nativeFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion };
          }
        }
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: current ? "blocked" : "cancelled",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: {
              ...action.evidence,
              ...(nativeFailureBlock ? { nativeFailureBlock } : {}),
              automaticRecovery: {
                policy: "preserve_without_replay_v1",
                runId: run.id,
                replay: "blocked",
                actionOutcome: "unknown",
                recordedAt: now.toISOString(),
                // What a later reconciliation hands the task back from.
                ...(current ? { issueStatusBefore: task.status } : {}),
              },
            },
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: current ? "blocked" : "cancelled",
            replay: "not_authorized",
          },
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: "preserve_without_replay_v1",
            replay: "blocked",
          },
        });
        options.failpoint?.("persisted");
      });
    } catch (err) {
      if (options.failpoint) throw err;
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Automatic recovery disposition remains pending",
      );
    }
  }
}

/**
 * Assessment verdicts of a settled hold that are revisited at a bounded pace:
 * the sandbox is still releasing, or the task is not in a state the policy may
 * continue from yet (a first-class blocker, another execution, a pending
 * review stage, a status someone chose). `not_inert` is final.
 */
const INERT_RUN_RECHECKED_VERDICTS = ["awaiting_release", "deferred"] as const;

/**
 * Legacy execution holds of this issue that the automatic reconciliation of
 * inert runs may take: an open hold that has not been assessed yet, or a hold
 * the automatic no-replay disposition settled before it could be assessed
 * (the reconciliation window passed while the sandbox was still releasing, the
 * policy was off, or the hold predates it). An operator's decision is never
 * revisited: a settled hold that carries a reconciliation is not a candidate.
 *
 * A settled hold is taken up only while its settlement is recent (see
 * `inertRunSettledHoldMaxAgeMs`); an older one stays with an operator.
 *
 * Every condition the transaction below would skip a candidate for is
 * repeated here, so skipped rows cannot fill the batch on every sweep. The
 * query joins the task (`issues`), the run (`heartbeatRuns`) and its
 * coordinator (`nativeRunFinalizations`).
 */
function inertReconciliationCandidateCondition(recheckBefore: Date, settledSince: Date) {
  return and(
    // A coordinator, result finalizer or linked successor owns the run.
    isNull(nativeRunFinalizations.leaseOwner),
    isNull(nativeRunFinalizations.resultId),
    sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
    or(
      and(
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`not (${issueRecoveryActions.evidence} ? 'inertRunAssessment')`,
      ),
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'policy' = 'preserve_without_replay_v1'`,
        sql`not (${issueRecoveryActions.evidence} ? 'executionReconciliation')`,
        sql`coalesce(${issueRecoveryActions.resolvedAt}, ${issueRecoveryActions.updatedAt}) >= ${settledSince.toISOString()}::timestamptz`,
        // Another execution took the settled task over since.
        sql`(${issues.executionRunId} is null or ${issues.executionRunId} = ${heartbeatRuns.id})`,
        sql`(${issues.checkoutRunId} is null or ${issues.checkoutRunId} = ${heartbeatRuns.id})`,
        or(
          sql`not (${issueRecoveryActions.evidence} ? 'inertRunAssessment')`,
          // Rechecked at a bounded pace instead of on every sweep.
          sql`(
            ${issueRecoveryActions.evidence}->'inertRunAssessment'->>'verdict' in (${sql.join(
              INERT_RUN_RECHECKED_VERDICTS.map((verdict) => sql`${verdict}`),
              sql`, `,
            )})
            and coalesce((${issueRecoveryActions.evidence}->'inertRunAssessment'->>'assessedAt')::timestamptz, 'epoch'::timestamptz)
              <= ${recheckBefore.toISOString()}::timestamptz
          )`,
        ),
      ),
    ),
  );
}

/** Statuses a settled task may be continued from without an operator. */
const CONTINUABLE_TASK_STATUSES = ["todo", "in_progress"];
/** Statuses someone parks a task in; a continuation would check it out again. */
const PARKED_TASK_STATUSES = ["backlog", "blocked"];

function isSettledNoReplayHold(action: typeof issueRecoveryActions.$inferSelect) {
  const automatic = action.evidence.automaticRecovery as { replay?: unknown; policy?: unknown } | undefined;
  return (
    action.status === "resolved" &&
    automatic?.replay === "blocked" &&
    automatic.policy === "preserve_without_replay_v1" &&
    !action.evidence.executionReconciliation
  );
}

/**
 * Reconcile legacy execution holds whose source run provably never reached its
 * adapter. The run stopped in the `preparing` stage, recorded no process,
 * output, usage, cost or agent API activity, and holds no execution
 * environment. The decision is the one an operator would record
 * (`actionOutcome: "not_performed"`, `providerStopped: true`); it goes through
 * the same validation and delivery path, so the task's owner receives one
 * continuation and any waits the hold recorded are released.
 *
 * A recently settled hold qualifies as well: the disposition records that
 * outcomes are unknown, and for such a run they are known. The task must
 * still be where the disposition left it, or back in active work:
 *
 * - `blocked` by the disposition from `todo`/`in_progress`: handed back to
 *   `todo` for the continuation, like an operator restoring the hold;
 * - `todo`/`in_progress`: continued as is;
 * - anything else, including a task that is `blocked` for another reason (it
 *   was blocked before the hold, someone else blocked it, or the status
 *   before the hold was not recorded) or whose review stage is pending: left
 *   to an operator, and rechecked at a bounded pace in case that changes. The
 *   continuation would check a blocked task out again.
 *
 * A task that is not dependency-ready (a first-class blocker that is not
 * done, or a done blocker still finalizing its workspace) is not continued
 * until it is: its continuation could not be admitted.
 *
 * Disabled with PAPERCLIP_AUTO_RECONCILE_INERT_RUNS=0. Any doubt keeps the hold.
 */
export async function reconcileInertLegacyExecutions(db: Db, now = new Date()) {
  const result = { checked: 0, reconciled: 0, notInert: 0, awaitingRelease: 0, deferred: 0 };
  if (!isInertRunAutoReconcileEnabled()) return result;
  const recheckBefore = new Date(now.getTime() - INERT_RUN_RELEASE_RECHECK_MS);
  const settledSince = new Date(now.getTime() - inertRunSettledHoldMaxAgeMs());
  const candidates = await db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
      ),
    )
    // Only open work still assigned to the owner the hold returns it to: a
    // settled hold never leaves the table, so a candidate the transaction
    // below would skip for good must not fill the batch on every sweep.
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueRecoveryActions.companyId),
        eq(issues.id, issueRecoveryActions.sourceIssueId),
        eq(issues.assigneeAgentId, issueRecoveryActions.returnOwnerAgentId),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
        inertReconciliationCandidateCondition(recheckBefore, settledSince),
        inertLegacyRunRowCondition(),
      ),
    )
    // Open holds first (their window is short), then settled holds never
    // assessed, then rechecks, least recently assessed first.
    .orderBy(
      sql`case
        when ${issueRecoveryActions.status} in ('active', 'escalated') then 0
        when not (${issueRecoveryActions.evidence} ? 'inertRunAssessment') then 1
        else 2
      end`,
      sql`coalesce((${issueRecoveryActions.evidence}->'inertRunAssessment'->>'assessedAt')::timestamptz, 'epoch'::timestamptz)`,
      asc(issueRecoveryActions.updatedAt),
    )
    .limit(25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    result.checked += 1;
    try {
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run -> action lock order as the
        // automatic disposition and operator resolution.
        const [task] = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.sourceIssueId)))
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(and(eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.runId, runId)))
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, runId)))
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        const settled = action ? isSettledNoReplayHold(action) : false;
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== run.id ||
          action.cause !== LEGACY_RECOVERY_CAUSE ||
          action.kind !== "active_run_watchdog" ||
          !(["active", "escalated"].includes(action.status) || settled) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id
        )
          return "skipped" as const;

        const recordAssessment = (assessment: Record<string, unknown>) =>
          tx
            .update(issueRecoveryActions)
            .set({
              evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
                inertRunAssessment: {
                  policy: INERT_RUN_RECONCILIATION_POLICY,
                  ...assessment,
                  assessedAt: now.toISOString(),
                },
              })}::jsonb`,
            })
            .where(eq(issueRecoveryActions.id, action.id));
        // Final for this run: an open hold goes back to the regular
        // disposition now; a settled hold stays with an operator.
        const decline = async (reason: string) => {
          await recordAssessment({ verdict: "not_inert", reason });
          return "not_inert" as const;
        };
        // Not now: an open hold goes back to the regular disposition, and a
        // settled hold is rechecked at a bounded pace.
        const defer = async (reason: string) => {
          await recordAssessment({ verdict: "deferred", reason });
          return "deferred" as const;
        };

        // The candidate query filters these out; they can still change
        // between that read and this lock.
        const heldElsewhere =
          !action.returnOwnerAgentId || task.assigneeAgentId !== action.returnOwnerAgentId
            ? "owner_changed"
            : ["done", "cancelled"].includes(task.status)
              ? "task_closed"
              : isSupersededConversationRun(task, run)
                ? "conversation_superseded"
                : coordinator?.leaseOwner || coordinator?.resultId || coordinator?.failureDetail?.successorRunId
                  ? "coordinator_owned"
                  : settled &&
                      ((task.executionRunId && task.executionRunId !== run.id) ||
                        (task.checkoutRunId && task.checkoutRunId !== run.id))
                    ? "execution_taken_over"
                    : null;
        if (heldElsewhere) return settled ? defer(heldElsewhere) : ("skipped" as const);

        const verdict = await assessInertLegacyRun(tx as unknown as Db, run);
        if (verdict.kind === "awaiting_release") {
          // An open hold is simply revisited (the disposition leaves it alone
          // during the window). A settled one records when it was checked.
          if (settled) await recordAssessment({ verdict: "awaiting_release", reason: verdict.reason });
          return "awaiting_release" as const;
        }
        if (verdict.kind === "not_inert") return decline(verdict.reason);
        // The stage waits on its participant, not on this continuation.
        if (settled && parseIssueExecutionState(task.executionState)?.status === "pending")
          return defer("governed_stage_pending");

        // Dependency admission would not deliver the continuation while the
        // task is not dependency-ready (the same readiness admission uses); its
        // resolution is held as a signal and the task is continued once ready.
        const readiness = await issueService(tx as unknown as Db)
          .listDependencyReadiness(task.companyId, [task.id], tx)
          .then((rows) => rows.get(task.id) ?? null);
        if (readiness && !readiness.isDependencyReady) return defer("first_class_blocker_unresolved");

        // A settled hold can be old. Continue only from the state the
        // disposition left the task in, or from active work; any other status
        // is a decision someone made since, and stays with an operator.
        let restoredStatus: string | null = null;
        if (settled) {
          const statusBeforeHold = (action.evidence.automaticRecovery as { issueStatusBefore?: unknown } | undefined)
            ?.issueStatusBefore;
          if (task.status === "blocked") {
            // Only a block this disposition made is lifted. The continuation
            // would check any other blocked task out again: one blocked before
            // the hold, by someone else, or with no record of its status
            // before the hold (settled by an older version).
            if (action.outcome !== "blocked") return defer("status_changed:blocked");
            if (typeof statusBeforeHold !== "string") return defer("status_before_hold:unknown");
            if (!CONTINUABLE_TASK_STATUSES.includes(statusBeforeHold))
              return defer(`status_before_hold:${statusBeforeHold}`);
            restoredStatus = "todo";
          } else if (!CONTINUABLE_TASK_STATUSES.includes(task.status)) {
            return defer(`status_changed:${task.status}`);
          }
        } else if (PARKED_TASK_STATUSES.includes(task.status)) {
          // Parked while the hold was open: the regular disposition applies.
          return defer(`task_parked:${task.status}`);
        }

        const decision: ExecutionReconciliation = {
          runId: run.id,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence: describeInertRunEvidence(verdict.facts),
        };
        // The operator path's own checks: owner, run state, process ownership,
        // coordinator, unreleased environments and a buildable continuation.
        // A refusal is final; a database error aborts the transaction, so the
        // marker write fails too and the candidate is retried.
        try {
          await validateExecutionReconciliation({
            db: tx as unknown as Db,
            companyId: task.companyId,
            issueId: task.id,
            agentId: task.assigneeAgentId,
            sourceRunId: action.evidence.runId,
            decision,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return decline(`reconciliation_refused: ${message.slice(0, 160)}`);
        }
        await markExecutionReconciliation(tx as unknown as Db, action, decision, "execution-recovery");
        if (restoredStatus) {
          await tx
            .update(issues)
            .set({ status: restoredStatus, updatedAt: now })
            .where(and(eq(issues.id, task.id), eq(issues.status, "blocked")));
        }
        const note = settled
          ? "The stopped run never reached its adapter, so no actions were performed. The held task was reconciled automatically and continues in a new run."
          : "The stopped run never reached its adapter, so no actions were performed. Reconciled automatically; the task continues in a new run.";
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: "restored",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
              inertRunAssessment: {
                ...verdict.facts,
                verdict: "inert",
                assessedAt: now.toISOString(),
                // The disposition this decision supersedes, kept for audit.
                ...(settled ? { settledDisposition: action.evidence.automaticRecovery } : {}),
              },
            })}::jsonb`,
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: "restored",
            actionOutcome: "not_performed",
            automatic: true,
            policy: INERT_RUN_RECONCILIATION_POLICY,
            ...(settled ? { supersededDisposition: "preserve_without_replay_v1" } : {}),
            ...(restoredStatus ? { issueStatus: { from: task.status, to: restoredStatus } } : {}),
          },
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "info",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: INERT_RUN_RECONCILIATION_POLICY,
            actionOutcome: "not_performed",
          },
        });
        return "reconciled" as const;
      });
      if (outcome === "reconciled") {
        result.reconciled += 1;
        logger.info(
          { recoveryActionId: candidate.id, issueId: candidate.sourceIssueId, runId, policy: INERT_RUN_RECONCILIATION_POLICY },
          "Reconciled an inert legacy execution hold automatically",
        );
      } else if (outcome === "not_inert") result.notInert += 1;
      else if (outcome === "awaiting_release") result.awaitingRelease += 1;
      else if (outcome === "deferred") result.deferred += 1;
    } catch (err) {
      logger.warn(
        { err, recoveryActionId: candidate.id, issueId: candidate.sourceIssueId, runId },
        "Inert execution reconciliation declined; the hold stays with the regular disposition",
      );
    }
  }
  return result;
}
