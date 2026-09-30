// Shared wake-reason and retry-reason constants, and the pure classifiers
// that read them off a run's context snapshot. `heartbeat.ts` and this
// module's own Postgres adapter both decide on the same context snapshot
// shape, so this file is their one shared source for it: a second,
// independently maintained copy in either file could silently drift out of
// sync with the other and change only one of the two gates that read it.

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turns_continuation";
export const TIME_CAP_CONTINUATION_RETRY_REASON = "time_cap_continuation";
export const WORKSPACE_BUSY_RETRY_REASON = "workspace_busy";
export const AI_CONNECTION_BUSY_RETRY_REASON = "ai_connection_busy";
export const INTERACTION_CONTINUATION_INFRA_RETRY_REASON = "interaction_continuation_infra_retry";
export const INTERACTION_CONTINUATION_INFRA_WAKE_REASON = "interaction_continuation_infra_retry";
export const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
export const RESOLVED_INTERACTION_CONTINUATION_STATUSES = new Set([
  "accepted",
  "answered",
  "cancelled",
  "rejected",
]);

/**
 * True for a continuation of a run that stopped at a per-run budget (turn
 * limit or hard time cap) while it was still working. These continuations
 * share one lane: they spend no failure budget, need the issue to stay
 * in_progress and keep its execution lock, and are bounded per chain.
 */
export function isProductiveContinuationRetryReason(
  retryReason: string | null | undefined,
): boolean {
  return (
    retryReason === MAX_TURN_CONTINUATION_RETRY_REASON ||
    retryReason === TIME_CAP_CONTINUATION_RETRY_REASON
  );
}

/**
 * True for a resource-wait retry whose original run did not
 * execute under assignee-ship (a comment or review-participant wake). Such a
 * retry has an expected assignee mismatch, so the scheduled-retry gate and
 * the queued-run staleness check must not treat it as a reassignment.
 */
export function isNonAssigneeWorkspaceBusyRetry(
  retryReason: string | null | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  return (
    (retryReason === WORKSPACE_BUSY_RETRY_REASON &&
      contextSnapshot.workspaceBusyDeferredWhileAssignee === false) ||
    (retryReason === AI_CONNECTION_BUSY_RETRY_REASON &&
      contextSnapshot.aiConnectionBusyDeferredWhileAssignee === false)
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload?: Record<string, unknown> | null,
): string | null {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

/**
 * `allowedWakeReasons` is the issue-tree-control module's own set of wake
 * reasons that excuse an interaction wake. This file stays free of service
 * imports, so the caller passes the set in rather than this function reading
 * it from the service directly.
 */
export function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
  allowedWakeReasons: ReadonlySet<string>,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !allowedWakeReasons.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot));
}

/**
 * True for a wake that delivers a response to an issue thread interaction
 * (an answered question, an accepted or rejected confirmation). Such a wake
 * carries the interaction instead of a comment id.
 */
export function isIssueInteractionResponseWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
): boolean {
  if (readNonEmptyString(contextSnapshot?.wakeReason) !== "issue_commented") return false;
  const interactionStatus = readNonEmptyString(contextSnapshot?.interactionStatus);
  return Boolean(
    readNonEmptyString(contextSnapshot?.interactionId) &&
      interactionStatus &&
      RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus),
  );
}

/**
 * Decides whether a wake may run while issue dependencies are still blocked.
 * New input on the issue has to reach the assignee, who can answer it without
 * starting the blocked work:
 * - a comment or mention wake (the interaction wake rule above);
 * - a response to a thread interaction;
 * - any other wake that still carries comment ids.
 * Retries re-run earlier input and stay gated, as do all other wakes.
 *
 * The last rule ignores the wake reason on purpose, because the reason does
 * not tell whether a comment is waiting: a later wake that coalesces into a
 * queued comment wake replaces its reason, a new run adopts queued comments
 * under its own reason, and an assignment made with a comment carries that
 * comment. The comment ids are the only trace in all three cases. The price
 * is that an automatic wake that copies comment ids from an earlier run also
 * gets one bounded interaction run. Telling those apart would need a check
 * that no earlier run of the agent has already received the comments.
 */
export function allowsDependencyBlockedWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
  allowedWakeReasons: ReadonlySet<string>,
): boolean {
  if (allowsIssueInteractionWake(contextSnapshot, allowedWakeReasons)) return true;
  if (
    readNonEmptyString(contextSnapshot?.retryReason) ||
    readNonEmptyString(contextSnapshot?.retryOfRunId)
  ) {
    return false;
  }
  if (isIssueInteractionResponseWake(contextSnapshot)) return true;
  return extractWakeCommentIds(contextSnapshot).length > 0;
}

export function isResolvedInteractionContinuationWakeContext(contextSnapshot: unknown): boolean {
  const context = parseObject(contextSnapshot);
  const interactionId = readNonEmptyString(context.interactionId);
  const interactionStatus = readNonEmptyString(context.interactionStatus);
  if (!interactionId || !interactionStatus) return false;
  if (!RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus)) return false;

  const mutation = readNonEmptyString(context.mutation);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const retryReason = readNonEmptyString(context.retryReason);
  return (
    (mutation === "interaction" && wakeReason === "issue_commented") ||
    wakeReason === INTERACTION_CONTINUATION_INFRA_WAKE_REASON ||
    retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
  );
}
