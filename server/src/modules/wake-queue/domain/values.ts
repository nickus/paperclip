// Small, shared domain values for the wake-queue module: string readers, the
// two failed-run codes, and the recovery retry reason they gate. The
// application and adapter layers both need these, so they live here once
// instead of twice.

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";
export const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON = "execution_review_participant_recovery";

/**
 * Payload key a release writes onto a deferred wake it kept because the
 * wake's agent was paused. It names the finishing run whose release reached
 * the wake, so a later sweep can run that same release again once the agent
 * resumes. Wake callers never set it; enqueue strips it from their payloads.
 */
export const HELD_FOR_PAUSED_AGENT_PAYLOAD_KEY = "heldForPausedAgent";

/**
 * Context key a promoted run carries when some of its queued comments
 * arrived while the previous run on the task was working and that run never
 * saw them: `{ runId, commentIds }`. The wake payload turns it into a note
 * that tells the agent to re-check what that run did.
 */
export const QUEUED_DURING_PREVIOUS_RUN_CONTEXT_KEY = "queuedDuringPreviousRun";

export function isWorkspaceValidationFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

export function isConfigurationIncompleteFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE || run.errorCode === "model_not_found";
}
