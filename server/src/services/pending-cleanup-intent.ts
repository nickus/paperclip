/**
 * Why a lease sits in `pending_cleanup`.
 *
 * A reusable sandbox keeps state the next run of the same task needs (the
 * agent CLI's session store and memory live in the sandbox). When its release
 * could not reach the provider (a worker restart, an RPC timeout), the lease is
 * parked for the cleanup sweep. Without a record of the intent the sweep can
 * only destroy, and the follow-up run loses that state. The marker tells the
 * sweep to retry the release instead:
 *
 *   release  retry the provider release (stop the run's work, keep the
 *            sandbox idle for the next run); destroy only as a fallback
 *   destroy  tear the resource down; never keep it
 *
 * A parked lease without a marker (older rows, orphan recovery) is destroyed,
 * as before the marker existed.
 */
export type PendingCleanupIntent = "release" | "destroy";

export const PENDING_CLEANUP_INTENT_METADATA_KEY = "pendingCleanupIntent";
/** The run status a retried release reports to the provider (see releaseRunLease). */
export const PENDING_CLEANUP_RELEASE_RUN_STATUS_METADATA_KEY = "pendingCleanupReleaseRunStatus";
/**
 * When the lease was parked for a release (ISO time). The cleanup sweep's
 * claims and failed attempts move the lease's own timestamps, so the retry
 * reads this to tell whether the task used another sandbox since the run
 * ended, and to rank a kept sandbox by when its run ended, not by when the
 * retry finished.
 */
export const PENDING_CLEANUP_PARKED_AT_METADATA_KEY = "pendingCleanupParkedAt";

export function readPendingCleanupIntent(
  metadata: Record<string, unknown> | null | undefined,
): PendingCleanupIntent | null {
  const value = metadata?.[PENDING_CLEANUP_INTENT_METADATA_KEY];
  return value === "release" || value === "destroy" ? value : null;
}

export function readPendingCleanupReleaseRunStatus(
  metadata: Record<string, unknown> | null | undefined,
): "released" | "expired" | "failed" | null {
  const value = metadata?.[PENDING_CLEANUP_RELEASE_RUN_STATUS_METADATA_KEY];
  return value === "released" || value === "expired" || value === "failed" ? value : null;
}

export function readPendingCleanupParkedAt(
  metadata: Record<string, unknown> | null | undefined,
): Date | null {
  const value = metadata?.[PENDING_CLEANUP_PARKED_AT_METADATA_KEY];
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
