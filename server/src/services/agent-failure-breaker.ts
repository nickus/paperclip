import { and, desc, eq, gt, gte, inArray, max } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";

/**
 * Retry breaker for agents whose runs keep failing the same way.
 *
 * A setup or adapter failure caused by the agent's own configuration (a
 * disabled secret, a bad model id, an unreachable environment) fails every
 * run identically. Without a breaker each automatic wake (timer, assignment,
 * mention, recovery) starts another run that fails the same way. Once the
 * agent's last {@link AGENT_FAILURE_BREAKER_THRESHOLD} finished runs failed
 * with the same error, automatic wakes are skipped and one board-visible
 * notice is recorded instead.
 *
 * The breaker holds only while the agent is in `error` status, and it only
 * counts runs created after the agent's latest configuration revision. So a
 * person lifts it by changing the configuration, clearing the agent's error,
 * or starting a run that succeeds. Wakes a person requests are never held.
 */

export const AGENT_FAILURE_BREAKER_THRESHOLD = 3;
export const AGENT_FAILURE_BREAKER_SKIP_REASON = "agent.failure_breaker_open";
export const AGENT_FAILURE_BREAKER_ACTIVITY_ACTION = "agent.automatic_wakes_paused";

// Failures that repeat identically until the configuration changes. Quota,
// timeout and transient upstream codes have their own retry schedules.
const BREAKER_ERROR_CODES = new Set([
  "setup_failed",
  "configuration_incomplete",
  "model_not_found",
  "workspace_validation_failed",
  "adapter_failed",
]);

// Finished outcomes that say whether the agent can run. Cancelled and
// interrupted runs say nothing either way, so they neither count nor reset.
const DECISIVE_RUN_STATUSES = ["succeeded", "failed", "timed_out"] as const;

const MAX_FINGERPRINT_LENGTH = 200;
const MAX_NOTICE_ERROR_LENGTH = 240;

export interface AgentFailureBreakerRun {
  id: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  createdAt: Date;
}

export interface AgentFailureBreakerTrip {
  errorCode: string;
  error: string;
  runIds: string[];
  /** When the newest failure in the streak was created. */
  latestFailureAt: Date;
}

function firstLine(value: string): string {
  const newline = value.indexOf("\n");
  return newline === -1 ? value : value.slice(0, newline);
}

/**
 * A stable "kind" for a failed run: the error code plus its message with ids,
 * hex digests and numbers blanked out, so the same failure on different runs
 * compares equal. Returns null for runs the breaker does not count.
 */
export function agentFailureFingerprint(run: Pick<AgentFailureBreakerRun, "status" | "errorCode" | "error">): string | null {
  if (run.status !== "failed" || !run.errorCode || !BREAKER_ERROR_CODES.has(run.errorCode)) return null;
  const message = firstLine(run.error ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINGERPRINT_LENGTH);
  return `${run.errorCode}:${message}`;
}

/**
 * Decide from an agent's most recent decisive runs (newest first) whether the
 * breaker is open: the newest `threshold` runs all failed with the same
 * fingerprint.
 */
export function evaluateAgentFailureBreaker(
  recentRuns: readonly AgentFailureBreakerRun[],
  threshold = AGENT_FAILURE_BREAKER_THRESHOLD,
): AgentFailureBreakerTrip | null {
  if (threshold < 1 || recentRuns.length < threshold) return null;
  const streak = recentRuns.slice(0, threshold);
  const fingerprint = agentFailureFingerprint(streak[0]!);
  if (!fingerprint) return null;
  if (!streak.every((run) => agentFailureFingerprint(run) === fingerprint)) return null;
  const newest = streak[0]!;
  return {
    errorCode: newest.errorCode!,
    error: firstLine(newest.error ?? "").trim(),
    runIds: streak.map((run) => run.id),
    latestFailureAt: newest.createdAt,
  };
}

/** Read the agent's recent runs and evaluate the breaker. */
export async function readAgentFailureBreaker(
  db: Db,
  agent: { id: string; companyId: string },
  threshold = AGENT_FAILURE_BREAKER_THRESHOLD,
): Promise<AgentFailureBreakerTrip | null> {
  const [latestRevision] = await db
    .select({ createdAt: max(agentConfigRevisions.createdAt) })
    .from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.agentId, agent.id));
  const configChangedAt = latestRevision?.createdAt ?? null;
  const recentRuns = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      error: heartbeatRuns.error,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        inArray(heartbeatRuns.status, [...DECISIVE_RUN_STATUSES]),
        // Only failures under the current configuration count.
        configChangedAt ? gt(heartbeatRuns.createdAt, configChangedAt) : undefined,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(threshold);
  return evaluateAgentFailureBreaker(recentRuns, threshold);
}

/**
 * Whether an automatic wake has already been held for this streak, so the
 * notice is recorded once per trip rather than once per skipped wake.
 */
export async function hasHeldWakeForAgentFailureBreaker(
  db: Db,
  agent: { id: string; companyId: string },
  trip: AgentFailureBreakerTrip,
): Promise<boolean> {
  const [held] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.agentId, agent.id),
        eq(agentWakeupRequests.companyId, agent.companyId),
        eq(agentWakeupRequests.reason, AGENT_FAILURE_BREAKER_SKIP_REASON),
        gte(agentWakeupRequests.requestedAt, trip.latestFailureAt),
      ),
    )
    .limit(1);
  return Boolean(held);
}

/** The operator-facing explanation stored on the agent and the skipped wake. */
export function describeAgentFailureBreaker(
  trip: AgentFailureBreakerTrip,
  threshold = AGENT_FAILURE_BREAKER_THRESHOLD,
): string {
  const error = trip.error.length > MAX_NOTICE_ERROR_LENGTH
    ? `${trip.error.slice(0, MAX_NOTICE_ERROR_LENGTH - 1)}…`
    : trip.error;
  return (
    `Automatic wakes are paused: the last ${threshold} runs failed with the same error ` +
    `(${trip.errorCode}${error ? `: ${error}` : ""}). ` +
    "Fix the agent's configuration, then start a run or clear the error to resume automatic wakes."
  );
}
