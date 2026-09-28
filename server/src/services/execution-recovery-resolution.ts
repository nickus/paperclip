import { randomUUID } from "node:crypto";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, inArray, isNull, not, notInArray, or, sql } from "drizzle-orm";
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
import { conflict } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { DIRECT_NON_INVOKABLE_STATUSES } from "./agent-invokability.js";
import { LEGACY_RECOVERY_CAUSE } from "./legacy-execution-recovery.js";
import {
  assessInertLegacyRun,
  describeInertRunEvidence,
  inertLegacyRunGraceCondition,
  inertLegacyRunRowCondition,
  isInertRunAutoReconcileEnabled,
  INERT_RUN_RECONCILIATION_POLICY,
  INERT_RUN_RELEASE_RECHECK_MS,
} from "./inert-legacy-execution.js";
import { releaseHeldExecutionWaits } from "./execution-wait-release.js";

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
) {
  try {
    await releaseHeldExecutionWaits(db, wake, { companyId: action.companyId, issueId: action.sourceIssueId });
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
) {
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
      ),
    )
    .limit(25);
  for (const action of pending) {
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
        if (invalidated && task) await releaseAfterContinuation(db, wake, action);
        continue;
      }
      const run = await wake(action.returnOwnerAgentId, {
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
      if (!run) continue;
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
      await releaseAfterContinuation(db, wake, action);
    } catch {
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
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
        const note = current
          ? "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
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
 * Legacy execution holds of this issue that the automatic reconciliation of
 * inert runs may take: an open hold that has not been assessed yet, or a hold
 * the automatic no-replay disposition settled before it could be assessed
 * (the reconciliation window passed while the sandbox was still releasing, the
 * policy was off, or the hold predates it). An operator's decision is never
 * revisited: a settled hold that carries a reconciliation is not a candidate.
 */
function inertReconciliationCandidateCondition(recheckBefore: Date) {
  return or(
    and(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`not (${issueRecoveryActions.evidence} ? 'inertRunAssessment')`,
    ),
    and(
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'policy' = 'preserve_without_replay_v1'`,
      sql`not (${issueRecoveryActions.evidence} ? 'executionReconciliation')`,
      or(
        sql`not (${issueRecoveryActions.evidence} ? 'inertRunAssessment')`,
        // A settled hold whose sandbox was still releasing is rechecked at a
        // bounded pace instead of on every sweep.
        sql`(
          ${issueRecoveryActions.evidence}->'inertRunAssessment'->>'verdict' = 'awaiting_release'
          and coalesce((${issueRecoveryActions.evidence}->'inertRunAssessment'->>'assessedAt')::timestamptz, 'epoch'::timestamptz)
            <= ${recheckBefore.toISOString()}::timestamptz
        )`,
      ),
    ),
  );
}

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
 * A hold the automatic no-replay disposition already settled qualifies as
 * well: the disposition records that outcomes are unknown, and for such a run
 * they are known. Like the operator path for a settled hold, the task the
 * disposition moved to `blocked` goes back to `todo` for the continuation,
 * unless a first-class blocker or a pending review stage still applies.
 *
 * Disabled with PAPERCLIP_AUTO_RECONCILE_INERT_RUNS=0. Any doubt keeps the hold.
 */
export async function reconcileInertLegacyExecutions(db: Db, now = new Date()) {
  const result = { checked: 0, reconciled: 0, notInert: 0, awaitingRelease: 0 };
  if (!isInertRunAutoReconcileEnabled()) return result;
  const recheckBefore = new Date(now.getTime() - INERT_RUN_RELEASE_RECHECK_MS);
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
    .where(
      and(
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
        inertReconciliationCandidateCondition(recheckBefore),
        inertLegacyRunRowCondition(),
      ),
    )
    .orderBy(asc(issueRecoveryActions.updatedAt))
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
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !action.returnOwnerAgentId ||
          task.assigneeAgentId !== action.returnOwnerAgentId ||
          ["done", "cancelled"].includes(task.status) ||
          isSupersededConversationRun(task, run) ||
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          // Another execution took the settled task over since.
          (settled && task.executionRunId && task.executionRunId !== run.id) ||
          (settled && task.checkoutRunId && task.checkoutRunId !== run.id)
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
        const verdict = await assessInertLegacyRun(tx as unknown as Db, run);
        if (verdict.kind === "awaiting_release") {
          // An open hold is simply revisited (the disposition leaves it alone
          // during the window). A settled one records when it was checked.
          if (settled) await recordAssessment({ verdict: "awaiting_release", reason: verdict.reason });
          return "awaiting_release" as const;
        }
        if (verdict.kind === "not_inert") return decline(verdict.reason);

        // The disposition moved the task to `blocked` to hold it. Hand it back
        // the way an operator restoring a settled hold does, unless something
        // else still holds it.
        let restoredStatus: string | null = null;
        const statusBeforeHold = (action.evidence.automaticRecovery as { issueStatusBefore?: unknown } | undefined)
          ?.issueStatusBefore;
        if (
          settled &&
          action.outcome === "blocked" &&
          task.status === "blocked" &&
          // Blocked before the disposition: that hold is someone else's.
          statusBeforeHold !== "blocked"
        ) {
          if (parseIssueExecutionState(task.executionState)?.status === "pending")
            return decline("governed_stage_pending");
          const [unresolvedBlocker] = await tx
            .select({ id: issues.id })
            .from(issueRelations)
            .innerJoin(issues, eq(issueRelations.issueId, issues.id))
            .where(
              and(
                eq(issueRelations.companyId, task.companyId),
                eq(issueRelations.relatedIssueId, task.id),
                eq(issueRelations.type, "blocks"),
                notInArray(issues.status, ["done", "cancelled"]),
              ),
            )
            .limit(1);
          if (!unresolvedBlocker) restoredStatus = "todo";
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
    } catch (err) {
      logger.warn(
        { err, recoveryActionId: candidate.id, issueId: candidate.sourceIssueId, runId },
        "Inert execution reconciliation declined; the hold stays with the regular disposition",
      );
    }
  }
  return result;
}
