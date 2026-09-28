import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { getExecutionBlocker } from "./execution-blocker.js";

/**
 * Automatic wakes that arrive while an execution recovery hold is in place are
 * recorded as skipped `execution_reconciliation_required` receipts; repeated
 * signals coalesce into one receipt per hold. They are not queued. When the
 * hold ends through operator reconciliation, the reconciled continuation run
 * carries the task forward. Every other way a hold can end (an operator
 * cancels or restores the action, a false positive, an explicit fresh start)
 * used to leave those receipts undelivered unless some unrelated periodic
 * path happened to wake the owner again.
 *
 * This sweep closes that gap. For each recently closed recovery action it
 * finds the held receipts of the source task. When no hold remains and no run
 * of the task's owner has started on the task since the last held signal, it
 * delivers exactly one issue-scoped wake to the current assignee. The regular
 * admission path still applies every gate.
 *
 * Disabled with PAPERCLIP_RELEASE_HELD_EXECUTION_WAITS=0.
 */
export const HELD_EXECUTION_WAIT_RELEASE_ENV = "PAPERCLIP_RELEASE_HELD_EXECUTION_WAITS";
export const HELD_EXECUTION_WAIT_REASON = "execution_reconciliation_required";
export const HELD_EXECUTION_WAIT_RELEASE_SOURCE = "execution.hold_released";
/** Only holds closed this recently are considered; older receipts stay history. */
export const HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS = 24 * 60 * 60_000;
/** A declined delivery (for example a paused owner) is retried at this pace. */
export const HELD_EXECUTION_WAIT_RELEASE_RETRY_MS = 5 * 60_000;

type Wake = ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"];

export function isHeldExecutionWaitReleaseEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env[HELD_EXECUTION_WAIT_RELEASE_ENV]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

export function heldExecutionWaitReleaseIdempotencyKey(recoveryActionId: string) {
  return `execution-hold-released:${recoveryActionId}`;
}

type ReleaseState =
  | "delivered"
  | "covered"
  | "no_held_wakes"
  | "not_applicable"
  | "retry";

/**
 * Not yet released, or a retry/claim whose last attempt is old enough. A claim
 * left by an interrupted sweep becomes retryable after the same interval.
 */
function releasePendingCondition(retryBefore: Date) {
  return sql`(
    not (${issueRecoveryActions.evidence} ? 'heldWakeRelease')
    or (
      ${issueRecoveryActions.evidence}->'heldWakeRelease'->>'state' in ('retry', 'claimed')
      and coalesce((${issueRecoveryActions.evidence}->'heldWakeRelease'->>'attemptedAt')::timestamptz, 'epoch'::timestamptz)
        <= ${retryBefore.toISOString()}::timestamptz
    )
  )`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A receipt is still held until a release marker covers its latest signal. */
function isUnreleased(row: { updatedAt: Date; payload: Record<string, unknown> | null }) {
  const releasedAt = readRecord(readRecord(row.payload).executionWait).releasedAt;
  if (typeof releasedAt !== "string") return true;
  const parsed = new Date(releasedAt);
  return Number.isNaN(parsed.getTime()) || row.updatedAt.getTime() > parsed.getTime();
}

export async function deliverReleasedExecutionWaits(db: Db, wake: Wake, now = new Date()) {
  const result = { checked: 0, delivered: 0, covered: 0, retried: 0 };
  if (!isHeldExecutionWaitReleaseEnabled()) return result;
  const lookback = new Date(now.getTime() - HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS);
  const retryBefore = new Date(now.getTime() - HELD_EXECUTION_WAIT_RELEASE_RETRY_MS);
  const candidates = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
        inArray(issueRecoveryActions.status, ["resolved", "cancelled"]),
        gte(issueRecoveryActions.resolvedAt, lookback),
        // Still an effective hold: nothing was released.
        sql`coalesce(${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay', '') <> 'blocked'`,
        // The reconciled continuation owns delivery until it has been made.
        sql`coalesce(${issueRecoveryActions.evidence}->>'continuationDelivery', '') not in ('pending', 'delegated')`,
        releasePendingCondition(retryBefore),
      ),
    )
    .orderBy(desc(issueRecoveryActions.resolvedAt))
    .limit(25);

  for (const action of candidates) {
    result.checked += 1;
    try {
      const state = await releaseForAction(db, wake, action, now, retryBefore);
      if (state === "delivered") result.delivered += 1;
      else if (state === "covered") result.covered += 1;
      else if (state === "retry") result.retried += 1;
    } catch (err) {
      logger.warn(
        { err, recoveryActionId: action.id, issueId: action.sourceIssueId },
        "Held execution wait release remains pending for retry",
      );
    }
  }
  return result;
}

async function markAction(
  db: Db,
  actionId: string,
  release: { state: ReleaseState; attemptedAt: string } & Record<string, unknown>,
) {
  await db
    .update(issueRecoveryActions)
    .set({
      evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ heldWakeRelease: release })}::jsonb`,
    })
    .where(eq(issueRecoveryActions.id, actionId));
}

async function markReceiptsReleased(
  db: Db,
  companyId: string,
  receiptIds: string[],
  release: { at: string; recoveryActionId: string; outcome: ReleaseState; runId?: string | null },
) {
  if (receiptIds.length === 0) return;
  await db
    .update(agentWakeupRequests)
    .set({
      payload: sql`jsonb_set(
        coalesce(${agentWakeupRequests.payload}, '{}'::jsonb),
        '{executionWait}',
        coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify({
          releasedAt: release.at,
          releasedByRecoveryActionId: release.recoveryActionId,
          releaseOutcome: release.outcome,
          releaseRunId: release.runId ?? null,
        })}::jsonb
      )`,
    })
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.id, receiptIds),
        eq(agentWakeupRequests.status, "skipped"),
      ),
    );
}

async function releaseForAction(
  db: Db,
  wake: Wake,
  action: typeof issueRecoveryActions.$inferSelect,
  now: Date,
  retryBefore: Date,
): Promise<ReleaseState | "held"> {
  const attemptedAt = now.toISOString();
  const previousAttempts = Number(readRecord(action.evidence.heldWakeRelease).attempts ?? 0) || 0;
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, action.companyId), eq(issues.id, action.sourceIssueId)));
  if (!task) {
    await markAction(db, action.id, { state: "not_applicable", attemptedAt, reason: "task_missing" });
    return "not_applicable";
  }
  // Another hold (for example a newer incident) still gates this task. Its
  // own release will deliver the receipts; leave this action for a later pass.
  if (await getExecutionBlocker(db, task.companyId, task.id)) {
    // Recheck at the retry pace instead of on every sweep.
    await markAction(db, action.id, {
      state: "retry", attemptedAt, attempts: previousAttempts, reason: "hold_active",
    });
    return "held";
  }
  // Claim the release so concurrent sweeps deliver at most one wake.
  const [claimed] = await db
    .update(issueRecoveryActions)
    .set({
      evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
        heldWakeRelease: { state: "claimed", attemptedAt, attempts: previousAttempts },
      })}::jsonb`,
    })
    .where(and(eq(issueRecoveryActions.id, action.id), releasePendingCondition(retryBefore)))
    .returning({ id: issueRecoveryActions.id });
  if (!claimed) return "held";

  const receipts = (
    await db
      .select({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        payload: agentWakeupRequests.payload,
        updatedAt: agentWakeupRequests.updatedAt,
        coalescedCount: agentWakeupRequests.coalescedCount,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, task.companyId),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
          eq(agentWakeupRequests.status, "skipped"),
          eq(agentWakeupRequests.reason, HELD_EXECUTION_WAIT_REASON),
          sql`${agentWakeupRequests.payload}->'executionWait'->>'recoveryActionId' is not null`,
          gte(agentWakeupRequests.updatedAt, new Date(now.getTime() - HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS)),
        ),
      )
  ).filter(isUnreleased);
  if (receipts.length === 0) {
    await markAction(db, action.id, { state: "no_held_wakes", attemptedAt });
    return "no_held_wakes";
  }
  const receiptIds = receipts.map((receipt) => receipt.id);
  const assigneeAgentId = task.assigneeAgentId;
  const ownerReceipts = assigneeAgentId
    ? receipts.filter((receipt) => receipt.agentId === assigneeAgentId)
    : [];
  if (!assigneeAgentId || ["done", "cancelled"].includes(task.status) || ownerReceipts.length === 0) {
    // Signals for a previous owner, or for finished work, are not replayed.
    await markReceiptsReleased(db, task.companyId, receiptIds, {
      at: attemptedAt, recoveryActionId: action.id, outcome: "not_applicable",
    });
    await markAction(db, action.id, { state: "not_applicable", attemptedAt, receiptIds });
    return "not_applicable";
  }

  const lastHeldAt = new Date(Math.max(...ownerReceipts.map((receipt) => receipt.updatedAt.getTime())));
  const [laterRun] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, task.companyId),
        eq(heartbeatRuns.agentId, assigneeAgentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`,
        gte(heartbeatRuns.createdAt, lastHeldAt),
      ),
    )
    .limit(1);
  if (laterRun) {
    // The owner already worked on the task after every held signal, e.g. the
    // reconciled continuation or an operator's manual wake.
    await markReceiptsReleased(db, task.companyId, receiptIds, {
      at: attemptedAt, recoveryActionId: action.id, outcome: "covered", runId: laterRun.id,
    });
    await markAction(db, action.id, { state: "covered", attemptedAt, runId: laterRun.id, receiptIds });
    return "covered";
  }

  // A previous attempt may have been admitted before its sweep was interrupted.
  const [admitted] = await db
    .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, task.companyId),
        eq(agentWakeupRequests.agentId, assigneeAgentId),
        eq(agentWakeupRequests.idempotencyKey, heldExecutionWaitReleaseIdempotencyKey(action.id)),
        sql`${agentWakeupRequests.status} <> 'skipped'`,
      ),
    )
    .limit(1);
  if (admitted) {
    await markReceiptsReleased(db, task.companyId, receiptIds, {
      at: attemptedAt, recoveryActionId: action.id, outcome: "delivered", runId: admitted.runId,
    });
    await markAction(db, action.id, { state: "delivered", attemptedAt, runId: admitted.runId, receiptIds });
    return "delivered";
  }
  let run: Awaited<ReturnType<Wake>> | null = null;
  try {
    run = await wake(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_recovery_action_restored",
      idempotencyKey: heldExecutionWaitReleaseIdempotencyKey(action.id),
      // The closed action is referenced as `releasedRecoveryActionId`, never as
      // `recoveryActionId`: that key makes the wake recovery-scoped, so the
      // agent would be told to recover the task instead of doing the work.
      payload: {
        issueId: task.id,
        releasedRecoveryActionId: action.id,
        mutation: "execution_hold_released",
        releasedExecutionWaitIds: ownerReceipts.map((receipt) => receipt.id),
        heldSignalCount: ownerReceipts.reduce((sum, receipt) => sum + 1 + (receipt.coalescedCount ?? 0), 0),
      },
      requestedByActorType: "system",
      requestedByActorId: "execution-recovery",
      contextSnapshot: {
        issueId: task.id,
        taskId: task.id,
        wakeReason: "issue_recovery_action_restored",
        source: HELD_EXECUTION_WAIT_RELEASE_SOURCE,
        releasedRecoveryActionId: action.id,
      },
    });
  } catch (err) {
    // Declined by a gate that may clear later (for example a paused owner).
    await markAction(db, action.id, {
      state: "retry",
      attemptedAt,
      attempts: previousAttempts + 1,
      error: err instanceof Error ? err.message.slice(0, 200) : "wake_failed",
    });
    logger.info(
      { recoveryActionId: action.id, issueId: task.id, agentId: assigneeAgentId, err },
      "Held execution wait release declined; will retry",
    );
    return "retry";
  }
  // A null result means admission recorded its own deferral or skip receipt;
  // that receipt, not this sweep, now owns the signal.
  await markReceiptsReleased(db, task.companyId, receiptIds, {
    at: attemptedAt, recoveryActionId: action.id, outcome: "delivered", runId: run?.id ?? null,
  });
  await markAction(db, action.id, {
    state: "delivered",
    attemptedAt,
    runId: run?.id ?? null,
    receiptIds,
  });
  logger.info(
    {
      recoveryActionId: action.id,
      issueId: task.id,
      agentId: assigneeAgentId,
      runId: run?.id ?? null,
      releasedExecutionWaitIds: ownerReceipts.map((receipt) => receipt.id),
    },
    "Delivered wakes held by a closed execution recovery action",
  );
  return "delivered";
}
