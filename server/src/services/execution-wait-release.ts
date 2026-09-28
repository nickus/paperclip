import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { hasInteractionContinuationWakeContext } from "../modules/wake-queue/index.js";
import { isConversation } from "./agent-conversations.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";

/**
 * Wakes that arrive while an execution recovery hold is in place are kept
 * back instead of starting a run:
 *
 * - automatic signals become skipped `execution_reconciliation_required`
 *   receipts (repeated signals coalesce into one receipt per hold);
 * - saved user comments stay `deferred_issue_execution` queues.
 *
 * Both carry `payload.executionWait.recoveryActionId`. A hold can end in many
 * ways: operator reconciliation, an operator cancel or restore, an automatic
 * reconciliation, an explicit user continuation or a verified replacement.
 * The release is keyed on the outcome, not on the path: once an issue has no
 * execution blocker left, `releaseHeldExecutionWaits` hands what the holds kept
 * back to the task's current assignee exactly once.
 *
 * - Held signals of the current assignee are delivered with one issue-scoped
 *   wake. That wake goes through regular admission, which also adopts the
 *   assignee's saved comment queues into the run it queues. When the assignee
 *   already ran on the task after the last held signal (for example the
 *   reconciled continuation), the signals are recorded as covered instead.
 * - Held signals of anyone else, or of a task that is done or cancelled, are
 *   finalized: receipts are marked released without a wake, and saved comment
 *   queues of an agent that no longer owns open work on the task are
 *   cancelled (the comments stay in the thread). Nothing is left for a later
 *   pass to revisit.
 *
 * Paths that end a hold call it directly; `deliverReleasedExecutionWaits` is
 * the periodic backstop for every other path and for retries.
 *
 * Disabled with PAPERCLIP_RELEASE_HELD_EXECUTION_WAITS=0.
 */
export const HELD_EXECUTION_WAIT_RELEASE_ENV = "PAPERCLIP_RELEASE_HELD_EXECUTION_WAITS";
export const HELD_EXECUTION_WAIT_REASON = "execution_reconciliation_required";
export const HELD_EXECUTION_WAIT_RELEASE_SOURCE = "execution.hold_released";
/** The backstop sweep revisits actions closed this recently. */
export const HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS = 24 * 60 * 60_000;
/** A declined delivery or an interrupted claim is retried at this pace. */
export const HELD_EXECUTION_WAIT_RELEASE_RETRY_MS = 5 * 60_000;

const DEFERRED_STATUS = "deferred_issue_execution";
const DEFERRED_CONTEXT_KEY = "_paperclipWakeContext";
const COMMENT_WAKE_REASONS = ["issue_commented", "issue_reopened_via_comment"];
// Chat retries that still own the next turn of a chat-bound task.
const IN_FLIGHT_CHAT_ACTION_STATUSES = ["preparing", "issued", "processing"];

type Wake = ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"];

export function isHeldExecutionWaitReleaseEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env[HELD_EXECUTION_WAIT_RELEASE_ENV]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * Deterministic for one held state: a retry after an interrupted delivery
 * reuses the key (and finds the admitted wake); new held signals change it.
 */
export function heldExecutionWaitReleaseIdempotencyKey(input: {
  issueId: string;
  agentId: string;
  heldWakes: Array<{ id: string; signalCount: number }>;
}) {
  const digest = createHash("sha256")
    .update(JSON.stringify(
      [...input.heldWakes].sort((a, b) => a.id.localeCompare(b.id)).map((wake) => [wake.id, wake.signalCount]),
    ))
    .digest("hex")
    .slice(0, 24);
  return `execution-hold-released:${input.issueId}:${input.agentId}:${digest}`;
}

export type HeldExecutionWaitReleaseState =
  | "disabled"
  | "task_missing"
  /** An execution blocker still gates the task. */
  | "held"
  /** A reconciled continuation for the current assignee owns the next turn. */
  | "continuation_pending"
  /** A chat retry for the current assignee owns the next turn. */
  | "delegated"
  /** Another releaser is delivering this held state right now. */
  | "claimed"
  | "no_held_wakes"
  /** Everything held was finalized; nothing is delivered. */
  | "not_applicable"
  | "covered"
  | "delivered"
  /** The wake was declined by a gate that may clear later. */
  | "retry";

export type HeldExecutionWaitRelease = {
  state: HeldExecutionWaitReleaseState;
  agentId?: string | null;
  runId?: string | null;
  deliveredWaitIds?: string[];
  finalizedWaitIds?: string[];
};

/** Terminal for the backstop sweep: nothing is left to deliver for the action. */
export const FINAL_RELEASE_STATES: ReadonlySet<HeldExecutionWaitReleaseState> = new Set([
  "task_missing",
  "no_held_wakes",
  "not_applicable",
  "covered",
  "delivered",
]);

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type HeldWake = {
  id: string;
  agentId: string;
  kind: "receipt" | "comment_queue";
  recoveryActionId: string;
  /** Receipts: 1 + coalesced signals. Comment queues: 1. */
  signalCount: number;
  heldAt: Date;
  claim: { key?: string; at?: string; attempts?: number } | null;
};

/**
 * A receipt is released once a marker covers every signal it has coalesced.
 * Signal counts, not clocks, decide: a receipt row may be stamped by the
 * database clock and the marker by the application clock.
 */
const unreleasedReceiptCondition = sql`coalesce(
  (${agentWakeupRequests.payload}->'executionWait'->>'releasedSignalCount')::int, 0
) < 1 + coalesce(${agentWakeupRequests.coalescedCount}, 0)`;

/** Saved comment queues that admission adopts into the next run it queues. */
function isAdoptableCommentQueue(row: {
  reason: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown> | null;
}) {
  const payload = readRecord(row.payload);
  const context = readRecord(payload[DEFERRED_CONTEXT_KEY]);
  return (
    !row.idempotencyKey?.startsWith("chat-inbound:") &&
    payload.mutation !== "interaction" &&
    !hasInteractionContinuationWakeContext(context) &&
    COMMENT_WAKE_REASONS.includes(String(context.wakeReason ?? row.reason)) &&
    queuedCommentIdsFromWakePayload(payload).length > 0
  );
}

async function loadHeldWakes(tx: Db, task: typeof issues.$inferSelect): Promise<HeldWake[]> {
  const receipts = await tx
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
        unreleasedReceiptCondition,
      ),
    );
  const held: HeldWake[] = receipts.map((row) => {
    const wait = readRecord(readRecord(row.payload).executionWait);
    return {
      id: row.id,
      agentId: row.agentId,
      kind: "receipt",
      recoveryActionId: String(wait.recoveryActionId),
      signalCount: 1 + (row.coalescedCount ?? 0),
      heldAt: row.updatedAt,
      claim: wait.releaseClaim ? (readRecord(wait.releaseClaim) as HeldWake["claim"]) : null,
    };
  });
  // Conversation tasks deliver saved input through their own continuation.
  if (isConversation(task)) return held;
  const queues = await tx
    .select({
      id: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      reason: agentWakeupRequests.reason,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      payload: agentWakeupRequests.payload,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, task.companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
        eq(agentWakeupRequests.status, DEFERRED_STATUS),
        sql`${agentWakeupRequests.payload}->'executionWait'->>'recoveryActionId' is not null`,
        sql`${agentWakeupRequests.payload}->'executionWait'->>'releasedAt' is null`,
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
      ),
    );
  for (const row of queues) {
    if (!isAdoptableCommentQueue(row)) continue;
    const wait = readRecord(readRecord(row.payload).executionWait);
    held.push({
      id: row.id,
      agentId: row.agentId,
      kind: "comment_queue",
      recoveryActionId: String(wait.recoveryActionId),
      signalCount: 1,
      heldAt: row.requestedAt,
      claim: wait.releaseClaim ? (readRecord(wait.releaseClaim) as HeldWake["claim"]) : null,
    });
  }
  return held;
}

/** Agents that owned the task under the holds these wakes were kept back by. */
async function formerOwners(tx: Db, companyId: string, actionIds: string[]) {
  if (actionIds.length === 0) return new Set<string>();
  const actions = await tx
    .select({
      returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
      previousOwnerAgentId: issueRecoveryActions.previousOwnerAgentId,
      runId: sql<string | null>`${issueRecoveryActions.evidence}->>'runId'`,
    })
    .from(issueRecoveryActions)
    .where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.id, actionIds)));
  const owners = new Set<string>();
  const runIds: string[] = [];
  for (const action of actions) {
    if (action.returnOwnerAgentId) owners.add(action.returnOwnerAgentId);
    if (action.previousOwnerAgentId) owners.add(action.previousOwnerAgentId);
    if (action.runId && /^[0-9a-f-]{36}$/i.test(action.runId)) runIds.push(action.runId);
  }
  if (runIds.length > 0) {
    const runs = await tx
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
    for (const run of runs) owners.add(run.agentId);
  }
  return owners;
}

type ReleaseMarker = {
  at: string;
  outcome: "delivered" | "covered" | "not_applicable";
  key?: string | null;
  runId?: string | null;
  reason?: string;
};

async function markReceiptsReleased(tx: Db, companyId: string, wakes: HeldWake[], marker: ReleaseMarker) {
  for (const wake of wakes) {
    if (wake.kind !== "receipt") continue;
    await tx
      .update(agentWakeupRequests)
      .set({
        payload: sql`jsonb_set(
          coalesce(${agentWakeupRequests.payload}, '{}'::jsonb),
          '{executionWait}',
          (coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) - 'releaseClaim') || ${JSON.stringify({
            releasedAt: marker.at,
            releasedSignalCount: wake.signalCount,
            releaseOutcome: marker.outcome,
            releaseKey: marker.key ?? null,
            releaseRunId: marker.runId ?? null,
            ...(marker.reason ? { releaseReason: marker.reason } : {}),
          })}::jsonb
        )`,
      })
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.id, wake.id),
          eq(agentWakeupRequests.status, "skipped"),
        ),
      );
  }
}

/** Annotates saved comment queues; admission may already have adopted them. */
async function markQueuesReleased(tx: Db, companyId: string, wakes: HeldWake[], marker: ReleaseMarker) {
  const ids = wakes.filter((wake) => wake.kind === "comment_queue").map((wake) => wake.id);
  if (ids.length === 0) return;
  await tx
    .update(agentWakeupRequests)
    .set({
      payload: sql`jsonb_set(
        coalesce(${agentWakeupRequests.payload}, '{}'::jsonb),
        '{executionWait}',
        (coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) - 'releaseClaim') || ${JSON.stringify({
          releasedAt: marker.at,
          releaseOutcome: marker.outcome,
          releaseKey: marker.key ?? null,
          releaseRunId: marker.runId ?? null,
        })}::jsonb
      )`,
    })
    .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.id, ids)));
}

const CANCELLED_QUEUE_ERRORS: Record<string, string> = {
  not_assignee:
    "The execution hold ended after the task was reassigned. The saved comments remain on the task for its current assignee.",
  unassigned:
    "The execution hold ended after the task was unassigned. The saved comments remain on the task.",
  task_closed:
    "The execution hold ended after the task was closed. The saved comments remain on the task.",
};

/**
 * A saved queue whose agent no longer owns open work is closed, so no later
 * pass revisits it. The comments themselves stay in the thread.
 */
async function cancelHeldQueues(tx: Db, companyId: string, wakes: HeldWake[], at: Date, reason: string) {
  const ids = wakes.filter((wake) => wake.kind === "comment_queue").map((wake) => wake.id);
  if (ids.length === 0) return;
  await tx
    .update(agentWakeupRequests)
    .set({
      status: "cancelled",
      finishedAt: at,
      updatedAt: at,
      error: CANCELLED_QUEUE_ERRORS[reason] ?? CANCELLED_QUEUE_ERRORS.not_assignee,
      payload: sql`jsonb_set(
        coalesce(${agentWakeupRequests.payload}, '{}'::jsonb),
        '{executionWait}',
        (coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) - 'releaseClaim') || ${JSON.stringify({
          releasedAt: at.toISOString(),
          releaseOutcome: "not_applicable",
          releaseReason: reason,
        })}::jsonb
      )`,
    })
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.id, ids),
        eq(agentWakeupRequests.status, DEFERRED_STATUS),
      ),
    );
}

async function setClaim(
  tx: Db,
  companyId: string,
  wakes: HeldWake[],
  claim: { key: string; at: string; attempts: number; error?: string },
) {
  await tx
    .update(agentWakeupRequests)
    .set({
      payload: sql`jsonb_set(
        coalesce(${agentWakeupRequests.payload}, '{}'::jsonb),
        '{executionWait}',
        coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify({ releaseClaim: claim })}::jsonb
      )`,
    })
    .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.id, wakes.map((wake) => wake.id))));
}

type DeliveryPlan = {
  state: "deliver";
  task: typeof issues.$inferSelect;
  agentId: string;
  key: string;
  wakes: HeldWake[];
  attempts: number;
  finalizedWaitIds: string[];
};

/**
 * Release what the execution holds of one issue kept back, once no execution
 * blocker is left. Safe to call from any path and any number of times: the
 * issue row lock serializes releasers, a claim marks an in-flight delivery,
 * and the idempotency key recognizes a delivery an interrupted call admitted.
 */
export async function releaseHeldExecutionWaits(
  db: Db,
  wake: Wake,
  input: { companyId: string; issueId: string; now?: Date },
): Promise<HeldExecutionWaitRelease> {
  if (!isHeldExecutionWaitReleaseEnabled()) return { state: "disabled" };
  const now = input.now ?? new Date();
  const attemptedAt = now.toISOString();
  if (await getExecutionBlocker(db, input.companyId, input.issueId)) return { state: "held" };

  const plan = await db.transaction(async (rawTx): Promise<HeldExecutionWaitRelease | DeliveryPlan> => {
    const tx = rawTx as unknown as Db;
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '5000', true)`,
    );
    // The same lock admission takes: no wake can be held or admitted for
    // this task while the release decides.
    const [task] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .for("update");
    if (!task) return { state: "task_missing" };
    if (await getExecutionBlocker(tx, task.companyId, task.id)) return { state: "held" };

    const held = await loadHeldWakes(tx, task);
    if (held.length === 0) return { state: "no_held_wakes" };
    const assigneeAgentId =
      task.assigneeAgentId && !["done", "cancelled"].includes(task.status) ? task.assigneeAgentId : null;
    const ownerWakes = held.filter((wake) => wake.agentId === assigneeAgentId);
    const others = held.filter((wake) => wake.agentId !== assigneeAgentId);

    // Finalize everything that is not the current assignee's. Receipts are
    // replaceable automatic signals and are closed for any other agent. Saved
    // comment queues are closed for a previous assignee and for the assignee
    // of a closed task; a queue for an agent that was only mentioned is not
    // this release's to decide.
    const finalizedWaitIds: string[] = [];
    if (others.length > 0) {
      const owners = await formerOwners(tx, task.companyId, [...new Set(others.map((wake) => wake.recoveryActionId))]);
      if (task.assigneeAgentId) owners.add(task.assigneeAgentId);
      const receipts = others.filter((wake) => wake.kind === "receipt");
      const queues = others.filter((wake) => wake.kind === "comment_queue" && owners.has(wake.agentId));
      const reason = ["done", "cancelled"].includes(task.status)
        ? "task_closed"
        : task.assigneeAgentId ? "not_assignee" : "unassigned";
      await markReceiptsReleased(tx, task.companyId, receipts, { at: attemptedAt, outcome: "not_applicable", reason });
      await cancelHeldQueues(tx, task.companyId, queues, now, reason);
      finalizedWaitIds.push(...receipts.map((wake) => wake.id), ...queues.map((wake) => wake.id));
    }
    if (!assigneeAgentId || ownerWakes.length === 0) {
      return { state: "not_applicable", agentId: assigneeAgentId, finalizedWaitIds };
    }

    // A reconciled continuation that can still be delivered to this assignee
    // owns the next turn; its delivery releases these wakes afterwards. One
    // that will be invalidated (the owner changed) does not hold them back.
    const [continuation] = await tx
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, task.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
          eq(issueRecoveryActions.status, "resolved"),
          eq(issueRecoveryActions.returnOwnerAgentId, assigneeAgentId),
          sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        ),
      )
      .limit(1);
    if (continuation) return { state: "continuation_pending", agentId: assigneeAgentId, finalizedWaitIds };

    // Held automatic signals are covered once the assignee has run on the
    // task after the last of them. A saved comment queue is not: a run queued
    // without a hold adopts it, so a queue that is still saved needs a wake.
    const receipts = ownerWakes.filter((wake) => wake.kind === "receipt");
    const queues = ownerWakes.filter((wake) => wake.kind === "comment_queue");
    if (queues.length === 0) {
      const lastHeldAt = new Date(Math.max(...receipts.map((wake) => wake.heldAt.getTime())));
      const [laterRun] = await tx
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
        await markReceiptsReleased(tx, task.companyId, receipts, {
          at: attemptedAt, outcome: "covered", runId: laterRun.id,
        });
        return {
          state: "covered",
          agentId: assigneeAgentId,
          runId: laterRun.id,
          deliveredWaitIds: receipts.map((wake) => wake.id),
          finalizedWaitIds,
        };
      }
    }

    // A chat retry authorized for this task still owns its next turn.
    const [delegated] = await tx
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .innerJoin(
        chatActions,
        and(
          eq(chatActions.companyId, issueRecoveryActions.companyId),
          sql`${chatActions.id}::text = ${issueRecoveryActions.evidence}->'continuationDeliveryOwner'->>'actionId'`,
        ),
      )
      .where(
        and(
          eq(issueRecoveryActions.companyId, task.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'delegated'`,
          inArray(chatActions.status, IN_FLIGHT_CHAT_ACTION_STATUSES),
        ),
      )
      .limit(1);
    if (delegated) return { state: "delegated", agentId: assigneeAgentId, finalizedWaitIds };

    const key = heldExecutionWaitReleaseIdempotencyKey({
      issueId: task.id,
      agentId: assigneeAgentId,
      heldWakes: ownerWakes,
    });
    // An interrupted earlier attempt may already have been admitted. Its key
    // is on the claim: the held set it was computed over can have shrunk
    // since (admission adopts saved comment queues).
    const keys = [...new Set([key, ...ownerWakes.map((wake) => wake.claim?.key).filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )])];
    const [admitted] = await tx
      .select({
        id: agentWakeupRequests.id,
        runId: agentWakeupRequests.runId,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, task.companyId),
          eq(agentWakeupRequests.agentId, assigneeAgentId),
          inArray(agentWakeupRequests.idempotencyKey, keys),
          sql`${agentWakeupRequests.status} <> 'skipped'`,
        ),
      )
      .limit(1);
    if (admitted) {
      const marker = { at: attemptedAt, outcome: "delivered" as const, key: admitted.idempotencyKey, runId: admitted.runId };
      await markReceiptsReleased(tx, task.companyId, receipts, marker);
      await markQueuesReleased(tx, task.companyId, queues, marker);
      return {
        state: "delivered",
        agentId: assigneeAgentId,
        runId: admitted.runId,
        deliveredWaitIds: ownerWakes.map((wake) => wake.id),
        finalizedWaitIds,
      };
    }
    const retryBefore = now.getTime() - HELD_EXECUTION_WAIT_RELEASE_RETRY_MS;
    const liveClaim = ownerWakes.find((wake) => {
      const at = wake.claim?.at ? new Date(wake.claim.at).getTime() : Number.NaN;
      return Number.isFinite(at) && at > retryBefore;
    });
    if (liveClaim) return { state: "claimed", agentId: assigneeAgentId, finalizedWaitIds };
    const attempts = Math.max(0, ...ownerWakes.map((wake) => Number(wake.claim?.attempts ?? 0) || 0));
    await setClaim(tx, task.companyId, ownerWakes, { key, at: attemptedAt, attempts });
    return { state: "deliver", task, agentId: assigneeAgentId, key, wakes: ownerWakes, attempts, finalizedWaitIds };
  });
  if (plan.state !== "deliver") return plan as HeldExecutionWaitRelease;

  const { task, agentId, key, wakes, finalizedWaitIds } = plan as DeliveryPlan;
  const recoveryActionIds = [...new Set(wakes.map((held) => held.recoveryActionId))];
  let run: Awaited<ReturnType<Wake>> | null = null;
  try {
    run = await wake(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_recovery_action_restored",
      idempotencyKey: key,
      // The closed holds are referenced as `releasedRecoveryActionIds`, never
      // as `recoveryActionId`: that key makes the wake recovery-scoped, so the
      // agent would be told to recover the task instead of doing the work.
      payload: {
        issueId: task.id,
        mutation: "execution_hold_released",
        releasedRecoveryActionIds: recoveryActionIds,
        releasedExecutionWaitIds: wakes.map((held) => held.id),
        heldSignalCount: wakes.reduce((sum, held) => sum + held.signalCount, 0),
      },
      requestedByActorType: "system",
      requestedByActorId: "execution-recovery",
      contextSnapshot: {
        issueId: task.id,
        taskId: task.id,
        wakeReason: "issue_recovery_action_restored",
        source: HELD_EXECUTION_WAIT_RELEASE_SOURCE,
        releasedRecoveryActionIds: recoveryActionIds,
      },
    });
  } catch (err) {
    // Declined by a gate that may clear later (for example a paused owner).
    // The claim stays, so the next attempt comes at the retry pace.
    await setClaim(db, task.companyId, wakes, {
      key,
      at: new Date().toISOString(),
      attempts: plan.attempts + 1,
      error: err instanceof Error ? err.message.slice(0, 200) : "wake_failed",
    }).catch(() => undefined);
    logger.info(
      { issueId: task.id, agentId, recoveryActionIds, err },
      "Held execution wait release declined; will retry",
    );
    return { state: "retry", agentId, finalizedWaitIds };
  }
  // A null result means admission recorded its own receipt (another gate);
  // that receipt, not this release, now owns the signal.
  const marker = { at: new Date().toISOString(), outcome: "delivered" as const, key, runId: run?.id ?? null };
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await markReceiptsReleased(tx, task.companyId, wakes, marker);
    await markQueuesReleased(tx, task.companyId, wakes, marker);
  });
  logger.info(
    {
      issueId: task.id,
      agentId,
      runId: run?.id ?? null,
      recoveryActionIds,
      releasedExecutionWaitIds: wakes.map((held) => held.id),
      finalizedWaitIds,
    },
    "Delivered wakes held by closed execution recovery actions",
  );
  return {
    state: "delivered",
    agentId,
    runId: run?.id ?? null,
    deliveredWaitIds: wakes.map((held) => held.id),
    finalizedWaitIds,
  };
}

/** Not yet settled by the sweep, or a retry whose last attempt is old enough. */
function releasePendingCondition(retryBefore: Date) {
  return sql`(
    not (${issueRecoveryActions.evidence} ? 'heldWakeRelease')
    or (
      ${issueRecoveryActions.evidence}->'heldWakeRelease'->>'state' = 'retry'
      and coalesce((${issueRecoveryActions.evidence}->'heldWakeRelease'->>'attemptedAt')::timestamptz, 'epoch'::timestamptz)
        <= ${retryBefore.toISOString()}::timestamptz
    )
  )`;
}

/**
 * Backstop for every path that ends a hold without calling the release
 * itself (explicit user continuation, verified replacement, conversation
 * fold, an interrupted caller), and the retry loop for declined deliveries.
 * Candidates are recently closed execution recovery actions that no longer
 * hold anything; the release itself is issue-scoped and idempotent.
 */
export async function deliverReleasedExecutionWaits(db: Db, wake: Wake, now = new Date()) {
  const result = { checked: 0, delivered: 0, covered: 0, finalized: 0, retried: 0 };
  if (!isHeldExecutionWaitReleaseEnabled()) return result;
  const lookback = new Date(now.getTime() - HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS);
  const retryBefore = new Date(now.getTime() - HELD_EXECUTION_WAIT_RELEASE_RETRY_MS);
  const candidates = await db
    .select({
      id: issueRecoveryActions.id,
      companyId: issueRecoveryActions.companyId,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      heldWakeRelease: sql<Record<string, unknown> | null>`${issueRecoveryActions.evidence}->'heldWakeRelease'`,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
        inArray(issueRecoveryActions.status, ["resolved", "cancelled"]),
        // Closed recently, or its reconciled continuation settled recently
        // (delivery waits while the owner is paused).
        sql`greatest(
          ${issueRecoveryActions.resolvedAt},
          (${issueRecoveryActions.evidence}->>'continuationDeliveryAt')::timestamptz
        ) >= ${lookback.toISOString()}::timestamptz`,
        // Still an effective hold: nothing was released.
        sql`coalesce(${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay', '') <> 'blocked'`,
        // The reconciled continuation releases the wakes once it is delivered.
        sql`coalesce(${issueRecoveryActions.evidence}->>'continuationDelivery', '') <> 'pending'`,
        releasePendingCondition(retryBefore),
      ),
    )
    .orderBy(desc(issueRecoveryActions.resolvedAt))
    .limit(25);

  const released = new Map<string, HeldExecutionWaitRelease>();
  for (const action of candidates) {
    result.checked += 1;
    const attemptedAt = now.toISOString();
    try {
      const issueKey = `${action.companyId}:${action.sourceIssueId}`;
      let outcome = released.get(issueKey);
      if (!outcome) {
        outcome = await releaseHeldExecutionWaits(db, wake, {
          companyId: action.companyId,
          issueId: action.sourceIssueId,
          now,
        });
        released.set(issueKey, outcome);
        if (outcome.state === "delivered") result.delivered += 1;
        else if (outcome.state === "covered") result.covered += 1;
        else if (outcome.state === "retry") result.retried += 1;
        if (outcome.finalizedWaitIds?.length) result.finalized += outcome.finalizedWaitIds.length;
      }
      const attempts = Number(readRecord(action.heldWakeRelease).attempts ?? 0) || 0;
      await db
        .update(issueRecoveryActions)
        .set({
          evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
            heldWakeRelease: FINAL_RELEASE_STATES.has(outcome.state)
              ? { state: outcome.state, attemptedAt, runId: outcome.runId ?? null }
              : { state: "retry", reason: outcome.state, attemptedAt, attempts: attempts + 1 },
          })}::jsonb`,
        })
        .where(eq(issueRecoveryActions.id, action.id));
    } catch (err) {
      logger.warn(
        { err, recoveryActionId: action.id, issueId: action.sourceIssueId },
        "Held execution wait release remains pending for retry",
      );
    }
  }
  return result;
}
