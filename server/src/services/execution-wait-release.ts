import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
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
import { parseIssueExecutionState } from "./issue-execution-policy.js";
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
 *   The agent a pending review stage waits on is served the same way.
 * - Held signals of anyone else, or of a task that is done or cancelled, are
 *   finalized: receipts are marked released without a wake, and saved comment
 *   queues of an agent that no longer owns open work on the task are
 *   cancelled (the comments stay in the thread). A terminated owner's held
 *   wakes are finalized the same way.
 * - A paused owner, or one awaiting approval, keeps its held wakes; the
 *   release is retried until the owner can be invoked again.
 * - Other wakes the hold kept back (mentions of other agents, answers to an
 *   agent's question) are not this release's to deliver. Once nothing else
 *   is left for the release to do, they go through the regular deferred-wake
 *   promotion that the held run's own release stood down from.
 *
 * Paths that end a hold call it directly; `deliverReleasedExecutionWaits` is
 * the periodic backstop for every other path and for retries.
 *
 * Disabled with PAPERCLIP_RELEASE_HELD_EXECUTION_WAITS=0.
 */
export const HELD_EXECUTION_WAIT_RELEASE_ENV = "PAPERCLIP_RELEASE_HELD_EXECUTION_WAITS";
export const HELD_EXECUTION_WAIT_REASON = "execution_reconciliation_required";
export const HELD_EXECUTION_WAIT_RELEASE_SOURCE = "execution.hold_released";
/**
 * The backstop sweep takes up actions closed this recently. An action whose
 * release is waiting to be retried stays a candidate however old it is.
 */
export const HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS = 24 * 60 * 60_000;
/** A declined delivery or an interrupted claim is retried at this pace. */
export const HELD_EXECUTION_WAIT_RELEASE_RETRY_MS = 5 * 60_000;
/** Repeated retries back off up to this many retry intervals. */
export const HELD_EXECUTION_WAIT_RELEASE_MAX_BACKOFF_STEPS = 12;

const DEFERRED_STATUS = "deferred_issue_execution";
const DEFERRED_CONTEXT_KEY = "_paperclipWakeContext";
const COMMENT_WAKE_REASONS = ["issue_commented", "issue_reopened_via_comment"];
// Chat retries that still own the next turn of a chat-bound task.
const IN_FLIGHT_CHAT_ACTION_STATUSES = ["preparing", "issued", "processing"];

type Wake = ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"];

/**
 * Runs the regular deferred-wake promotion for an issue whose execution hold
 * ended, on behalf of the held run whose own release stood down for the hold.
 */
export type PromoteDeferredWakesAfterHold = (input: {
  companyId: string;
  issueId: string;
  runId: string;
}) => Promise<unknown>;

// Owners that cannot take a wake until someone changes their status.
const UNAVAILABLE_OWNER_STATUSES = ["paused", "pending_approval"];
// Owners that will never take a wake again.
const FINISHED_OWNER_STATUSES = ["terminated"];

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
  /** The owner is paused or awaiting approval; its wakes stay held. */
  | "owner_unavailable"
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
  /** Per recipient, when a pending review stage adds one to the assignee. */
  recipients?: HeldExecutionWaitRelease[];
  /** The regular promotion was run for other wakes the hold kept back. */
  promotedDeferredWakes?: boolean;
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

/**
 * Annotates saved comment queues that admission adopted. A queue that is
 * still saved was not delivered (the wake joined a live run, waited behind
 * another one, or a gate declined it) and stays unmarked, so the next release
 * still sees it.
 */
async function markQueuesReleased(tx: Db, companyId: string, wakes: HeldWake[], marker: ReleaseMarker) {
  const ids = wakes.filter((wake) => wake.kind === "comment_queue").map((wake) => wake.id);
  if (ids.length === 0) return [] as string[];
  const marked = await tx
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
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.id, ids),
        ne(agentWakeupRequests.status, DEFERRED_STATUS),
      ),
    )
    .returning({ id: agentWakeupRequests.id });
  return marked.map((row) => row.id);
}

const CANCELLED_QUEUE_ERRORS: Record<string, string> = {
  not_assignee:
    "The execution hold ended after the task was reassigned. The saved comments remain on the task for its current assignee.",
  unassigned:
    "The execution hold ended after the task was unassigned. The saved comments remain on the task.",
  task_closed:
    "The execution hold ended after the task was closed. The saved comments remain on the task.",
  owner_not_invokable:
    "The execution hold ended after the task's assignee was terminated. The saved comments remain on the task.",
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
  agentId: string;
  key: string;
  wakes: HeldWake[];
  attempts: number;
};

/** The agent a pending review stage of an open task waits on, if any. */
function pendingReviewParticipant(task: typeof issues.$inferSelect) {
  if (task.status !== "in_review") return null;
  const state = parseIssueExecutionState(task.executionState);
  const participant = state?.status === "pending" ? state.currentParticipant : null;
  return participant?.type === "agent" && participant.agentId ? participant.agentId : null;
}

/**
 * What to do with one recipient's held wakes. Runs under the issue lock.
 */
async function planRecipient(
  tx: Db,
  task: typeof issues.$inferSelect,
  agentId: string,
  ownerWakes: HeldWake[],
  now: Date,
): Promise<HeldExecutionWaitRelease | DeliveryPlan> {
  const attemptedAt = now.toISOString();
  const [owner] = await tx
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, task.companyId), eq(agents.id, agentId)));
  if (!owner || FINISHED_OWNER_STATUSES.includes(owner.status)) {
    // This owner will never take a wake again: finalize its held wakes like
    // those of a previous assignee. The comments stay on the task.
    await markReceiptsReleased(tx, task.companyId, ownerWakes, {
      at: attemptedAt, outcome: "not_applicable", reason: "owner_not_invokable",
    });
    await cancelHeldQueues(tx, task.companyId, ownerWakes, now, "owner_not_invokable");
    return { state: "not_applicable", agentId, finalizedWaitIds: ownerWakes.map((wake) => wake.id) };
  }
  // A wake would only be declined. Nothing is spent; the release is retried
  // until the owner is resumed or approved.
  if (UNAVAILABLE_OWNER_STATUSES.includes(owner.status)) return { state: "owner_unavailable", agentId };

  // A reconciled continuation that can still be delivered to this owner owns
  // the next turn; its delivery releases these wakes afterwards. One that will
  // be invalidated (the owner changed) does not hold them back.
  const [continuation] = await tx
    .select({ id: issueRecoveryActions.id })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, task.companyId),
        eq(issueRecoveryActions.sourceIssueId, task.id),
        inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
        eq(issueRecoveryActions.status, "resolved"),
        eq(issueRecoveryActions.returnOwnerAgentId, agentId),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      ),
    )
    .limit(1);
  if (continuation) return { state: "continuation_pending", agentId };

  // Held automatic signals are covered once the owner has run on the task
  // after the last of them. A saved comment queue is not: a run queued
  // without a hold adopts it, so a queue that is still saved needs a wake.
  // Both timestamps come from the database clock.
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
          eq(heartbeatRuns.agentId, agentId),
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
        agentId,
        runId: laterRun.id,
        deliveredWaitIds: receipts.map((wake) => wake.id),
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
  if (delegated) return { state: "delegated", agentId };

  const key = heldExecutionWaitReleaseIdempotencyKey({ issueId: task.id, agentId, heldWakes: ownerWakes });
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
        eq(agentWakeupRequests.agentId, agentId),
        // The release wake is issue-scoped; this keeps the lookup on the
        // issue's rows while the issue row is locked.
        sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
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
      agentId,
      runId: admitted.runId,
      deliveredWaitIds: ownerWakes.map((wake) => wake.id),
    };
  }
  const retryBefore = now.getTime() - HELD_EXECUTION_WAIT_RELEASE_RETRY_MS;
  const liveClaim = ownerWakes.find((wake) => {
    const at = wake.claim?.at ? new Date(wake.claim.at).getTime() : Number.NaN;
    return Number.isFinite(at) && at > retryBefore;
  });
  if (liveClaim) return { state: "claimed", agentId };
  const attempts = Math.max(0, ...ownerWakes.map((wake) => Number(wake.claim?.attempts ?? 0) || 0));
  await setClaim(tx, task.companyId, ownerWakes, { key, at: attemptedAt, attempts });
  return { state: "deliver", agentId, key, wakes: ownerWakes, attempts };
}

async function deliverPlan(
  db: Db,
  wake: Wake,
  task: typeof issues.$inferSelect,
  plan: DeliveryPlan,
): Promise<HeldExecutionWaitRelease> {
  const { agentId, key, wakes } = plan;
  const recoveryActionIds = [...new Set(wakes.map((held) => held.recoveryActionId))];
  const retryLater = async (error: string, pending: HeldWake[] = wakes) => {
    // The claim stays, so the next attempt comes at the retry pace.
    await setClaim(db, task.companyId, pending, {
      key,
      at: new Date().toISOString(),
      attempts: plan.attempts + 1,
      error,
    }).catch(() => undefined);
    return { state: "retry" as const, agentId };
  };
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
    // Declined by a gate that may clear later (for example a budget block).
    logger.info(
      { issueId: task.id, agentId, recoveryActionIds, err },
      "Held execution wait release declined; will retry",
    );
    return retryLater(err instanceof Error ? err.message.slice(0, 200) : "wake_failed");
  }
  // A null result means admission recorded its own receipt (another gate);
  // that receipt, not this release, now owns the automatic signals. Saved
  // comments are marked only once admission adopted them.
  const marker = { at: new Date().toISOString(), outcome: "delivered" as const, key, runId: run?.id ?? null };
  const markedQueueIds = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await markReceiptsReleased(tx, task.companyId, wakes, marker);
    return markQueuesReleased(tx, task.companyId, wakes, marker);
  });
  const savedQueues = wakes.filter((held) => held.kind === "comment_queue" && !markedQueueIds.includes(held.id));
  if (!run && savedQueues.length > 0) {
    logger.info(
      { issueId: task.id, agentId, recoveryActionIds, savedQueueIds: savedQueues.map((held) => held.id) },
      "Held execution wait release was not admitted; saved comments wait for a retry",
    );
    return retryLater("not_admitted", savedQueues);
  }
  logger.info(
    {
      issueId: task.id,
      agentId,
      runId: run?.id ?? null,
      recoveryActionIds,
      releasedExecutionWaitIds: wakes.map((held) => held.id),
    },
    "Delivered wakes held by closed execution recovery actions",
  );
  return {
    state: "delivered",
    agentId,
    runId: run?.id ?? null,
    deliveredWaitIds: wakes.map((held) => held.id),
  };
}

/** Recipient results in the shape of one: a pending one decides, then a delivery. */
function combineRecipients(results: HeldExecutionWaitRelease[], finalizedWaitIds: string[]): HeldExecutionWaitRelease {
  const primary =
    results.find((result) => !FINAL_RELEASE_STATES.has(result.state)) ??
    results.find((result) => result.state === "delivered") ??
    results.find((result) => result.state === "covered") ??
    results[0]!;
  const combined: HeldExecutionWaitRelease = {
    ...primary,
    finalizedWaitIds: [...finalizedWaitIds, ...results.flatMap((result) => result.finalizedWaitIds ?? [])],
  };
  if (results.length > 1) {
    combined.deliveredWaitIds = results.flatMap((result) => result.deliveredWaitIds ?? []);
    combined.recipients = results;
  }
  return combined;
}

/**
 * Wakes the hold kept back that are not the release's to deliver (mentions of
 * other agents, answers to an agent's question, approvals) are still saved.
 * The held run's own release stood down for the hold, so nothing else would
 * promote them; run that promotion now. It applies every regular gate, and
 * stands down again if the task is held or another run owns it.
 */
async function promoteRemainingHeldWakes(
  db: Db,
  promote: PromoteDeferredWakesAfterHold,
  task: typeof issues.$inferSelect,
) {
  const [saved] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, task.companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
        eq(agentWakeupRequests.status, DEFERRED_STATUS),
        sql`${agentWakeupRequests.payload}->'executionWait'->>'recoveryActionId' is not null`,
      ),
    )
    .limit(1);
  if (!saved) return false;
  // The legacy run of the most recently closed execution hold on this task:
  // only a legacy run's release stands down while its outcome is held.
  const [held] = await db
    .select({ runId: heartbeatRuns.id })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
      ),
    )
    .where(
      and(
        eq(issueRecoveryActions.companyId, task.companyId),
        eq(issueRecoveryActions.sourceIssueId, task.id),
        inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
        inArray(issueRecoveryActions.status, ["resolved", "cancelled"]),
        eq(heartbeatRuns.runtimeMode, "legacy"),
      ),
    )
    .orderBy(desc(issueRecoveryActions.resolvedAt))
    .limit(1);
  if (!held) return false;
  const promoted = await promote({ companyId: task.companyId, issueId: task.id, runId: held.runId });
  return promoted !== false;
}

/**
 * Release what the execution holds of one issue kept back, once no execution
 * blocker is left. Safe to call from any path and any number of times: the
 * issue row lock serializes releasers, a claim marks an in-flight delivery,
 * and the idempotency key recognizes a delivery an interrupted call admitted.
 */
export async function releaseHeldExecutionWaits(
  db: Db,
  wake: Wake,
  input: { companyId: string; issueId: string; now?: Date; promote?: PromoteDeferredWakesAfterHold },
): Promise<HeldExecutionWaitRelease> {
  if (!isHeldExecutionWaitReleaseEnabled()) return { state: "disabled" };
  const now = input.now ?? new Date();
  const attemptedAt = now.toISOString();
  if (await getExecutionBlocker(db, input.companyId, input.issueId)) return { state: "held" };

  type Planned = {
    task: typeof issues.$inferSelect;
    outcomes: Array<HeldExecutionWaitRelease | DeliveryPlan>;
    finalizedWaitIds: string[];
  };
  const planned = await db.transaction(async (rawTx): Promise<HeldExecutionWaitRelease | Planned> => {
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
    if (held.length === 0) return { task, outcomes: [{ state: "no_held_wakes" }], finalizedWaitIds: [] };
    const open = !["done", "cancelled"].includes(task.status);
    const assigneeAgentId = task.assigneeAgentId && open ? task.assigneeAgentId : null;
    // A pending review stage waits on its participant, who may not be the
    // assignee; that agent's held wakes are its own to receive.
    const reviewerAgentId = open ? pendingReviewParticipant(task) : null;
    const recipients = [...new Set([assigneeAgentId, reviewerAgentId].filter(
      (agentId): agentId is string => typeof agentId === "string",
    ))];
    const others = held.filter((wake) => !recipients.includes(wake.agentId));

    // Finalize everything that is not a recipient's. Receipts are replaceable
    // automatic signals and are closed for any other agent. Saved comment
    // queues are closed for a previous assignee and for the assignee of a
    // closed task; a queue for an agent that was only mentioned is not this
    // release's to decide.
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
    const outcomes: Planned["outcomes"] = [];
    for (const agentId of recipients) {
      const ownerWakes = held.filter((wake) => wake.agentId === agentId);
      if (ownerWakes.length > 0) outcomes.push(await planRecipient(tx, task, agentId, ownerWakes, now));
    }
    if (outcomes.length === 0) outcomes.push({ state: "not_applicable", agentId: assigneeAgentId });
    return { task, outcomes, finalizedWaitIds };
  });
  if (!("outcomes" in planned)) return planned;

  const { task } = planned;
  const results: HeldExecutionWaitRelease[] = [];
  for (const outcome of planned.outcomes) {
    results.push(outcome.state === "deliver" ? await deliverPlan(db, wake, task, outcome as DeliveryPlan) : outcome as HeldExecutionWaitRelease);
  }
  const combined = combineRecipients(results, planned.finalizedWaitIds);
  if (
    input.promote &&
    (combined.state === "no_held_wakes" || combined.state === "not_applicable") &&
    !["done", "cancelled"].includes(task.status)
  ) {
    try {
      combined.promotedDeferredWakes = await promoteRemainingHeldWakes(db, input.promote, task);
    } catch (err) {
      // Nothing else promotes them: the sweep retries.
      logger.warn({ err, issueId: task.id }, "Promotion of wakes saved behind a closed execution hold failed");
      return { ...combined, state: "retry", promotedDeferredWakes: false };
    }
  }
  return combined;
}

/**
 * Not yet settled by the sweep, or a retry whose last attempt is old enough.
 * Repeated retries back off, except while an owner is paused or awaiting
 * approval: its resumption is picked up at the base pace.
 */
function releasePendingCondition(now: Date) {
  return sql`(
    not (${issueRecoveryActions.evidence} ? 'heldWakeRelease')
    or (
      ${issueRecoveryActions.evidence}->'heldWakeRelease'->>'state' = 'retry'
      and coalesce((${issueRecoveryActions.evidence}->'heldWakeRelease'->>'attemptedAt')::timestamptz, 'epoch'::timestamptz)
        + make_interval(secs => (${HELD_EXECUTION_WAIT_RELEASE_RETRY_MS / 1000})::double precision * greatest(1, least(
          coalesce((${issueRecoveryActions.evidence}->'heldWakeRelease'->>'backoff')::int, 0),
          (${HELD_EXECUTION_WAIT_RELEASE_MAX_BACKOFF_STEPS})::int
        )))
        <= ${now.toISOString()}::timestamptz
    )
  )`;
}

/**
 * Backstop for every path that ends a hold without calling the release
 * itself (explicit user continuation, verified replacement, conversation
 * fold, an interrupted caller), and the retry loop for declined deliveries.
 * Candidates are recently closed execution recovery actions that no longer
 * hold anything, and older ones whose release is still being retried; the
 * release itself is issue-scoped and idempotent.
 */
export async function deliverReleasedExecutionWaits(
  db: Db,
  wake: Wake,
  now = new Date(),
  options: { promote?: PromoteDeferredWakesAfterHold } = {},
) {
  const result = { checked: 0, delivered: 0, covered: 0, finalized: 0, retried: 0 };
  if (!isHeldExecutionWaitReleaseEnabled()) return result;
  const lookback = new Date(now.getTime() - HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS);
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
        // (delivery waits while the owner is paused), or a release that is
        // still being retried (a paused or budget-blocked owner can stay so
        // for longer than the lookback).
        sql`(
          greatest(
            ${issueRecoveryActions.resolvedAt},
            (${issueRecoveryActions.evidence}->>'continuationDeliveryAt')::timestamptz
          ) >= ${lookback.toISOString()}::timestamptz
          or ${issueRecoveryActions.evidence}->'heldWakeRelease'->>'state' = 'retry'
        )`,
        // Still an effective hold: nothing was released.
        sql`coalesce(${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay', '') <> 'blocked'`,
        // The reconciled continuation releases the wakes once it is delivered.
        sql`coalesce(${issueRecoveryActions.evidence}->>'continuationDelivery', '') <> 'pending'`,
        releasePendingCondition(now),
      ),
    )
    // First attempts first, then the retries waiting longest.
    .orderBy(
      sql`case when ${issueRecoveryActions.evidence} ? 'heldWakeRelease' then 1 else 0 end`,
      sql`(${issueRecoveryActions.evidence}->'heldWakeRelease'->>'attemptedAt')::timestamptz asc nulls first`,
      desc(issueRecoveryActions.resolvedAt),
    )
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
          promote: options.promote,
        });
        released.set(issueKey, outcome);
        if (outcome.state === "delivered") result.delivered += 1;
        else if (outcome.state === "covered") result.covered += 1;
        else if (outcome.state === "retry") result.retried += 1;
        if (outcome.finalizedWaitIds?.length) result.finalized += outcome.finalizedWaitIds.length;
      }
      const previous = readRecord(action.heldWakeRelease);
      const attempts = Number(previous.attempts ?? 0) || 0;
      const backoff = Number(previous.backoff ?? 0) || 0;
      await db
        .update(issueRecoveryActions)
        .set({
          evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
            heldWakeRelease: FINAL_RELEASE_STATES.has(outcome.state)
              ? { state: outcome.state, attemptedAt, runId: outcome.runId ?? null }
              : {
                  state: "retry",
                  reason: outcome.state,
                  attemptedAt,
                  attempts: attempts + 1,
                  backoff: outcome.state === "owner_unavailable" ? 0 : backoff + 1,
                },
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
