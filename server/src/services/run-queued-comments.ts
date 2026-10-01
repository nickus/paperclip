import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  issueComments,
  type Db,
} from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import {
  queuedCommentIdsFromRunContext,
  queuedCommentIdsFromWakePayload,
} from "./issue-queued-comment-queue.js";
import { logActivity } from "./activity-log.js";

// Comments that other actors (board users, other agents) post on a task while
// its assignee's run holds the task's execution lock do not reach that run:
// they wait as a deferred wake and only start the next run. The helpers below
// let the issue routes show them to the run before it reports an outcome, and
// let the release drain tell which of them the finished run never saw.

/**
 * Statuses that close a run's work on its task with a reported outcome.
 * `blocked` is deliberately absent: pausing is the right reaction to a hold.
 */
export const RUN_COMPLETION_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "in_review",
  "cancelled",
]);

export const ISSUE_COMMENTS_QUEUED_DURING_RUN_CODE = "issue_comments_queued_during_run";

export const ISSUE_COMMENTS_QUEUED_DURING_RUN_MESSAGE =
  "These comments arrived while you were working and you have not seen them. " +
  "Re-check your conclusion (and pause or revert work if they ask you to) before changing the status.";

/**
 * Activity action that records which queued comments a run has been shown
 * (in a status-change conflict or by reading its queue). Activity rows
 * outlive the run, unlike the run's own result JSON, which the run's final
 * write replaces; the release drain reads them after the run has finished.
 */
export const RUN_QUEUED_COMMENTS_DELIVERED_ACTION = "issue.queued_comments_delivered";

export type RunQueuedCommentsDeliveryVia = "status_change_conflict" | "queue_read";

/** The run a lookup is for. Only the fields the lookup reads. */
export type QueuedCommentsRunFacts = {
  id: string;
  agentId: string;
  contextSnapshot: unknown;
};

export type QueuedCommentForRun = {
  id: string;
  issueId: string;
  authorType: "agent" | "user" | "system";
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  presentation: unknown;
  metadata: unknown;
  sourceTrust: SourceTrustMetadata | null;
  createdAt: Date;
};

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function uniqueStrings(values: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Comment ids that earlier conflicts or queue reads already showed to `runId`. */
export async function listQueuedCommentIdsDeliveredToRun(
  executor: Executor,
  input: { companyId: string; issueId: string; runId: string },
): Promise<Set<string>> {
  const rows = await executor
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, RUN_QUEUED_COMMENTS_DELIVERED_ACTION),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
      ),
    );
  const delivered = new Set<string>();
  for (const row of rows) {
    const details = row.details as Record<string, unknown> | null;
    const ids = Array.isArray(details?.commentIds) ? details.commentIds : [];
    for (const id of uniqueStrings(ids)) delivered.add(id);
  }
  return delivered;
}

/** Comment ids this run already has: its own prompt batch plus earlier deliveries. */
export async function listQueuedCommentIdsSeenByRun(
  executor: Executor,
  input: { companyId: string; issueId: string; run: QueuedCommentsRunFacts },
): Promise<Set<string>> {
  const seen = await listQueuedCommentIdsDeliveredToRun(executor, {
    companyId: input.companyId,
    issueId: input.issueId,
    runId: input.run.id,
  });
  for (const id of queuedCommentIdsFromRunContext(input.run.contextSnapshot)) seen.add(id);
  return seen;
}

/**
 * The comments still queued for `run`'s agent on the task that the run has
 * not seen: every deferred comment wake of that agent on the task, minus the
 * comments the agent wrote itself (in any run), the comments the run wrote,
 * the comments already in the run's prompt, and the comments an earlier
 * conflict or queue read showed it. Oldest first.
 */
export async function findQueuedCommentsUnseenByRun(
  executor: Executor,
  input: { companyId: string; issueId: string; run: QueuedCommentsRunFacts },
): Promise<QueuedCommentForRun[]> {
  const wakes = await executor
    .select({ payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.run.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt));
  const queuedIds = uniqueStrings(wakes.flatMap((wake) => queuedCommentIdsFromWakePayload(wake.payload)));
  if (queuedIds.length === 0) return [];

  const seen = await listQueuedCommentIdsSeenByRun(executor, input);
  const unseenIds = queuedIds.filter((id) => !seen.has(id));
  if (unseenIds.length === 0) return [];

  const rows = await executor
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      authorType: issueComments.authorType,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      body: issueComments.body,
      presentation: issueComments.presentation,
      metadata: issueComments.metadata,
      sourceTrust: issueComments.sourceTrust,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        inArray(issueComments.id, unseenIds),
        isNull(issueComments.deletedAt),
        or(isNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, input.run.agentId)),
        or(isNull(issueComments.createdByRunId), ne(issueComments.createdByRunId, input.run.id)),
      ),
    )
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  return rows.map((row) => ({
    ...row,
    // Older rows predate the explicit author type column.
    authorType: row.authorType ?? (row.authorAgentId ? "agent" : "user"),
  }));
}

/**
 * Of `commentIds` (one deferred wake's queued comments), the ones that
 * arrived while the finished `run` was working and that it never saw:
 * created after it started, not written by its agent or by the run, and
 * neither in its prompt nor shown to it later. A run that never started saw
 * nothing and did nothing, so nothing it did needs re-checking.
 */
export async function filterQueuedCommentIdsUnseenByFinishedRun(
  executor: Executor,
  input: {
    companyId: string;
    issueId: string;
    run: QueuedCommentsRunFacts & { startedAt: Date | null };
    commentIds: string[];
  },
): Promise<string[]> {
  const commentIds = uniqueStrings(input.commentIds);
  if (!input.run.startedAt || commentIds.length === 0) return [];
  const seen = await listQueuedCommentIdsSeenByRun(executor, input);
  const candidates = commentIds.filter((id) => !seen.has(id));
  if (candidates.length === 0) return [];
  const rows = await executor
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        inArray(issueComments.id, candidates),
        isNull(issueComments.deletedAt),
        gte(issueComments.createdAt, input.run.startedAt),
        or(isNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, input.run.agentId)),
        or(isNull(issueComments.createdByRunId), ne(issueComments.createdByRunId, input.run.id)),
      ),
    );
  const unseen = new Set(rows.map((row) => row.id));
  return candidates.filter((id) => unseen.has(id));
}

/** Display names for the authors of `comments`, keyed by agent or user id. */
export async function resolveQueuedCommentAuthorNames(
  executor: Executor,
  input: { companyId: string; comments: Array<Pick<QueuedCommentForRun, "authorAgentId" | "authorUserId">> },
): Promise<{ agents: Map<string, string>; users: Map<string, string> }> {
  const agentIds = uniqueStrings(input.comments.map((comment) => comment.authorAgentId));
  const userIds = uniqueStrings(input.comments.map((comment) => comment.authorUserId));
  const [agentRows, userRows] = await Promise.all([
    agentIds.length === 0
      ? []
      : executor
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds))),
    userIds.length === 0
      ? []
      : executor
          .select({ id: authUsers.id, name: authUsers.name })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds)),
  ]);
  return {
    agents: new Map(agentRows.map((row) => [row.id, row.name])),
    users: new Map(userRows.map((row) => [row.id, row.name])),
  };
}

/**
 * Records that `runId` has been shown `commentIds`, so the next status change
 * of the same run goes through and the release drain does not count them as
 * unseen.
 */
export async function recordQueuedCommentsDeliveredToRun(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    commentIds: string[];
    via: RunQueuedCommentsDeliveryVia;
    attemptedStatus?: string | null;
  },
) {
  const commentIds = uniqueStrings(input.commentIds);
  if (commentIds.length === 0) return;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.agentId,
    agentId: input.agentId,
    runId: input.runId,
    action: RUN_QUEUED_COMMENTS_DELIVERED_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: {
      runId: input.runId,
      commentIds,
      via: input.via,
      ...(input.attemptedStatus ? { attemptedStatus: input.attemptedStatus } : {}),
    },
  });
}
