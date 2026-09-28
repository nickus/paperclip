/** Resource waits and productive continuations are not failed provider attempts. */
export function executionFailureRetryCount(run: {
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}): number {
  if (run.scheduledRetryReason === "max_turns_continuation") return 0;
  if (run.scheduledRetryReason === "ai_connection_busy") {
    const count = run.contextSnapshot?.failureRetriesBeforeAiConnectionWait;
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  if (run.scheduledRetryReason === "workspace_busy") {
    // Only a server-created workspace retry can consume this field. Its
    // scheduler overwrites caller context with the predecessor's durable count.
    const count = run.contextSnapshot?.failureRetriesBeforeWorkspaceWait;
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  if (run.scheduledRetryReason === "model_endpoint_unreachable_retry") {
    // Same shape as ai_connection_busy/workspace_busy above: a down model
    // endpoint is an outage wait, not a failed provider attempt, so its own
    // retry count must not feed the reconciliation gate's failure budget —
    // only the count from BEFORE the outage began does.
    const count = run.contextSnapshot?.failureRetriesBeforeModelEndpointWait;
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  // Historical ambiguous counters remain conservative rather than resetting.
  return run.scheduledRetryAttempt ?? 0;
}
