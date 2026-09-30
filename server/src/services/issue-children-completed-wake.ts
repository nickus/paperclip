import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_CHILDREN_COMPLETED_WAKE_REASON = "issue_children_completed";

/**
 * Wake statuses that mean the parent's assignee already got (or is about to
 * get) this child's completion: the wake is pending, ran, or was merged into
 * another run of the same issue. A skipped, failed or cancelled wake never
 * reached the assignee, so it does not count and the next completion may
 * wake the parent again.
 */
const DELIVERED_CHILDREN_COMPLETED_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
  "coalesced",
] as const;

/**
 * One key per parent, completed child and parent waiting cycle.
 *
 * `parentWaitingCycle` is the id of the latest finished run of the parent's
 * assignee on the parent (`null` when it has none). A parent starts waiting
 * again only after its assignee has run on it, so a child that is closed,
 * reopened and closed again before that happens produces the same key and
 * wakes the parent once. After the assignee has run and left the parent
 * waiting on its children, the next completion gets a new key.
 */
export function buildIssueChildrenCompletedWakeIdempotencyKey(input: {
  parentIssueId: string;
  completedChildIssueId: string;
  parentWaitingCycle: string | null;
}) {
  return [
    ISSUE_CHILDREN_COMPLETED_WAKE_REASON,
    input.parentIssueId,
    input.completedChildIssueId,
    input.parentWaitingCycle ?? "none",
  ].join(":");
}

/** The wake that already delivered this key to the parent's assignee, if any. */
export async function findDeliveredIssueChildrenCompletedWake(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    parentIssueId: string;
    agentId: string;
    idempotencyKey: string;
  },
) {
  const [row] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        // Matches agent_wakeup_requests_company_payload_issue_idx.
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.parentIssueId}`,
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [
          ...DELIVERED_CHILDREN_COMPLETED_WAKE_STATUSES,
        ]),
      ),
    )
    .limit(1);
  return row ?? null;
}
