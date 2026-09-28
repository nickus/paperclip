import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

/**
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.cycleKey) {
    return IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches a wake in any idempotent status
 *   (including `completed`). This suppresses a duplicate for the SAME ready
 *   state, including the current blocked cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const legacyKeyList = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
    }),
  );
  return covering ?? null;
}

/** Receipt statuses written when a wake was not dispatched now. */
const UNDELIVERED_WAKE_STATUSES = ["skipped", "deferred_issue_execution"] as const;

export type SkippedDependencyWakeReport = {
  issueId: string | null;
  agentId: string;
  reason: string;
  recoveryActionId: string | null;
  wakeRequestId: string | null;
  wakeStatus: string | null;
  coalescedCount: number | null;
  idempotencyKey: string | null;
  error?: string;
};

type ReportLogger = Pick<typeof defaultLogger, "info" | "warn">;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Emit one structured line for a dependency wake that admission did not
 * dispatch. Dependency readiness is level-triggered and its backstop retries
 * quietly, so without this line a held dependency wake leaves no trace outside
 * the wake table. The receipt written by admission supplies the gate: its
 * reason, and for an execution recovery hold the recovery action id.
 * Never throws; reporting must not change wake behaviour.
 */
export async function reportSkippedDependencyWake(
  db: Db,
  input: {
    agentId: string;
    issueId: string | null;
    idempotencyKey?: string | null;
    /** Receipts written or coalesced at or after this instant belong to this wake. */
    observedFrom: Date;
    error?: unknown;
  },
  log: ReportLogger = defaultLogger,
): Promise<SkippedDependencyWakeReport | null> {
  try {
    let receipt: {
      id: string;
      status: string;
      reason: string | null;
      payload: Record<string, unknown> | null;
      coalescedCount: number;
    } | null = null;
    if (input.issueId) {
      const [agent] = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      if (agent) {
        [receipt] = await db
          .select({
            id: agentWakeupRequests.id,
            status: agentWakeupRequests.status,
            reason: agentWakeupRequests.reason,
            payload: agentWakeupRequests.payload,
            coalescedCount: agentWakeupRequests.coalescedCount,
          })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, agent.companyId),
              eq(agentWakeupRequests.agentId, input.agentId),
              sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
              inArray(agentWakeupRequests.status, [...UNDELIVERED_WAKE_STATUSES]),
              gte(agentWakeupRequests.updatedAt, input.observedFrom),
            ),
          )
          .orderBy(desc(agentWakeupRequests.updatedAt))
          .limit(1);
      }
    }
    const payload = readObject(receipt?.payload);
    const executionWait = readObject(payload.executionWait);
    const heartbeatSkip = readObject(payload.heartbeatSkip);
    const report: SkippedDependencyWakeReport = {
      issueId: input.issueId,
      agentId: input.agentId,
      reason:
        receipt?.reason ??
        (input.error ? "wake_rejected" : "not_recorded"),
      recoveryActionId: readString(executionWait.recoveryActionId),
      wakeRequestId: receipt?.id ?? null,
      wakeStatus: receipt?.status ?? null,
      coalescedCount: receipt?.coalescedCount ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      ...(input.error
        ? { error: input.error instanceof Error ? input.error.message.slice(0, 200) : String(input.error).slice(0, 200) }
        : {}),
    };
    const detail = readString(executionWait.reason) ?? readString(heartbeatSkip.reason);
    const fields = {
      event: "dependency_wake_skipped",
      wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
      ...report,
      ...(detail ? { detail } : {}),
    };
    // A recovery hold keeps dependency-ready work parked until someone acts.
    if (report.recoveryActionId) log.warn(fields, "dependency wake held by execution recovery");
    else log.info(fields, "dependency wake skipped");
    return report;
  } catch (err) {
    try {
      log.warn(
        { event: "dependency_wake_skipped", agentId: input.agentId, issueId: input.issueId, err },
        "dependency wake skipped; receipt lookup failed",
      );
    } catch {
      // Reporting is best effort.
    }
    return null;
  }
}
