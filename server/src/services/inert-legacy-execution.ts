import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  activityLog,
  costEvents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  CHAT_CONTROL_RECOVERY_STOP_CODE,
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
} from "./chat-control-recovery-stop.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";

type Run = typeof heartbeatRuns.$inferSelect;

/**
 * A legacy run that stopped before its adapter was dispatched cannot have
 * performed provider actions. Its reconciliation hold carries no information a
 * human could add, so it may be reconciled as `not_performed` automatically.
 *
 * Set PAPERCLIP_AUTO_RECONCILE_INERT_RUNS=0 to keep every such hold for an
 * operator (the behaviour before this policy existed).
 */
export const INERT_RUN_AUTO_RECONCILE_ENV = "PAPERCLIP_AUTO_RECONCILE_INERT_RUNS";
export const INERT_RUN_RECONCILIATION_POLICY = "inert_legacy_run_v1";

/**
 * How long the automatic no-replay disposition leaves a possibly-inert run to
 * this policy. Sandbox release is asynchronous; after this window the regular
 * disposition applies, so an unreleased environment never waits forever.
 */
export const INERT_RUN_SETTLE_GRACE_MS = 10 * 60_000;

const INERT_TERMINAL_STATUSES = ["cancelled", "failed"] as const;
// Only system bookkeeping may exist for a run that never reached its adapter.
const INERT_RUN_EVENT_TYPES = ["lifecycle", "error"] as const;
const RELEASED_LEASE_STATUSES = ["released", "expired", "failed"] as const;
// Error codes of deliberate operator stops: interrupt-by-comment and the chat
// control stops. The board Stop and subtree pause/cancel routes stamp
// `resultJson.cancelledByActorType` instead.
const OPERATOR_STOP_ERROR_CODES = [
  "operator_interrupted",
  CHAT_CONTROL_RECOVERY_STOP_CODE,
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
] as const;
const OPERATOR_STOP_ACTOR_TYPES = ["user", "board"] as const;

/**
 * True when an operator deliberately stopped the run (board Stop, subtree
 * pause/cancel, interrupt-by-comment, chat control stop). Recovery stands down
 * for these runs, and an automatic continuation would undo the operator's
 * decision, so their holds always stay with an operator. An agent or budget
 * pause is not a stop of this kind: the continuation waits until the agent can
 * be invoked again.
 */
export function isOperatorStoppedRun(run: Pick<Run, "errorCode" | "resultJson">) {
  if ((OPERATOR_STOP_ERROR_CODES as readonly string[]).includes(run.errorCode ?? "")) return true;
  const actorType = run.resultJson?.cancelledByActorType;
  return typeof actorType === "string" && (OPERATOR_STOP_ACTOR_TYPES as readonly string[]).includes(actorType);
}

export function isInertRunAutoReconcileEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env[INERT_RUN_AUTO_RECONCILE_ENV]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * Row-level shape of a run that never reached adapter dispatch. The legacy
 * controller claims a run in the `preparing` stage and moves it to
 * `dispatching` (while still running) immediately before `adapter.execute`.
 * A terminal run still in `preparing` therefore never handed work to a
 * provider. Runs an operator stopped are excluded (see `isOperatorStoppedRun`).
 * Null-safe: every branch evaluates to true or false.
 */
export function inertLegacyRunRowCondition(): SQL {
  return sql`(
    ${heartbeatRuns.runtimeMode} = 'legacy'
    and ${heartbeatRuns.status} in ('cancelled', 'failed')
    and coalesce(${heartbeatRuns.executionStage}, '') = 'preparing'
    and ${heartbeatRuns.finishedAt} is not null
    and ${heartbeatRuns.processPid} is null
    and ${heartbeatRuns.processGroupId} is null
    and ${heartbeatRuns.processStartedAt} is null
    and ${heartbeatRuns.exitCode} is null
    and ${heartbeatRuns.signal} is null
    and ${heartbeatRuns.externalRunId} is null
    and ${heartbeatRuns.sessionIdAfter} is null
    and ${heartbeatRuns.lastOutputAt} is null
    and ${heartbeatRuns.lastOutputSeq} = 0
    and coalesce(${heartbeatRuns.lastOutputBytes}, 0) = 0
    and coalesce(${heartbeatRuns.errorCode}, '') not in (${sql.join(
      OPERATOR_STOP_ERROR_CODES.map((code) => sql`${code}`),
      sql`, `,
    )})
    and coalesce(${heartbeatRuns.resultJson}->>'cancelledByActorType', '') not in (${sql.join(
      OPERATOR_STOP_ACTOR_TYPES.map((actorType) => sql`${actorType}`),
      sql`, `,
    )})
  )`;
}

/** A possibly-inert run that the regular disposition should leave alone for now. */
export function inertLegacyRunGraceCondition(now: Date): SQL {
  const cutoff = new Date(now.getTime() - INERT_RUN_SETTLE_GRACE_MS);
  return sql`(${inertLegacyRunRowCondition()} and coalesce(${heartbeatRuns.finishedAt} > ${cutoff.toISOString()}::timestamptz, false))`;
}

function hasPositiveUsage(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (Array.isArray(value)) return value.some((item) => hasPositiveUsage(item, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasPositiveUsage(item, depth + 1),
    );
  }
  return false;
}

function isBlank(value: string | null | undefined) {
  return !value || value.trim().length === 0;
}

export type InertRunFacts = {
  policy: typeof INERT_RUN_RECONCILIATION_POLICY;
  runId: string;
  executionStage: "preparing";
  status: string;
  errorCode: string | null;
  runEventTypes: string[];
  environmentLeases: Array<{ id: string; status: string; provider: string | null }>;
};

export type InertRunAssessment =
  | { kind: "inert"; facts: InertRunFacts }
  /** Everything else is inert but a provider environment is still held. */
  | { kind: "awaiting_release"; reason: string }
  | { kind: "not_inert"; reason: string };

/** Row-only checks; pure so they can be unit tested without a database. */
export function assessInertLegacyRunRow(
  run: Pick<
    Run,
    | "id"
    | "runtimeMode"
    | "status"
    | "executionStage"
    | "finishedAt"
    | "processPid"
    | "processGroupId"
    | "processStartedAt"
    | "exitCode"
    | "signal"
    | "externalRunId"
    | "sessionIdAfter"
    | "lastOutputAt"
    | "lastOutputSeq"
    | "lastOutputBytes"
    | "stdoutExcerpt"
    | "stderrExcerpt"
    | "usageJson"
    | "scheduledRetryAttempt"
    | "scheduledRetryReason"
    | "contextSnapshot"
    | "errorCode"
    | "resultJson"
  >,
): { inert: true } | { inert: false; reason: string } {
  const fail = (reason: string) => ({ inert: false as const, reason });
  if (run.runtimeMode !== "legacy") return fail("runtime_not_legacy");
  if (!(INERT_TERMINAL_STATUSES as readonly string[]).includes(run.status)) return fail("status_not_eligible");
  if (!run.finishedAt) return fail("not_finished");
  // The operator chose to stop this run; continuing it would undo that choice.
  if (isOperatorStoppedRun(run)) return fail("operator_stopped");
  // Null means the run predates the dispatch fence, or never used it: unknown.
  if (run.executionStage !== "preparing") return fail("adapter_dispatch_not_excluded");
  if (run.processPid != null || run.processGroupId != null || run.processStartedAt)
    return fail("process_recorded");
  if (run.exitCode != null || !isBlank(run.signal)) return fail("process_exit_recorded");
  if (!isBlank(run.externalRunId)) return fail("external_run_recorded");
  if (!isBlank(run.sessionIdAfter)) return fail("provider_session_recorded");
  if (run.lastOutputAt || (run.lastOutputSeq ?? 0) > 0 || (run.lastOutputBytes ?? 0) > 0)
    return fail("output_recorded");
  if (!isBlank(run.stdoutExcerpt) || !isBlank(run.stderrExcerpt)) return fail("output_recorded");
  if (hasPositiveUsage(run.usageJson)) return fail("usage_recorded");
  // Exhausted retries deliberately hand the task to an operator.
  if (executionFailureRetryCount(run) > 0) return fail("retry_budget_consumed");
  // Never chain automatic continuations: a reconciled continuation that stops
  // again before dispatch waits for an operator.
  if (run.contextSnapshot?.source === "execution.reconciled") return fail("continuation_of_reconciled_run");
  return { inert: true };
}

/**
 * Full inertness proof for one terminal legacy run. Reads only rows keyed by
 * the run id. Any sign of adapter activity, agent API use, cost or output
 * refuses the automatic path; the existing operator flow then applies.
 */
export async function assessInertLegacyRun(db: Db, run: Run): Promise<InertRunAssessment> {
  const row = assessInertLegacyRunRow(run);
  if (!row.inert) return { kind: "not_inert", reason: row.reason };

  const events = await db
    .select({ eventType: heartbeatRunEvents.eventType, stream: heartbeatRunEvents.stream })
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id)))
    .limit(200);
  const adapterEvent = events.find(
    (event) =>
      !(INERT_RUN_EVENT_TYPES as readonly string[]).includes(event.eventType) ||
      (event.stream !== null && event.stream !== "system"),
  );
  if (adapterEvent) return { kind: "not_inert", reason: `run_event:${adapterEvent.eventType}` };

  // Agent API calls made with this run's credentials are recorded as agent
  // activity for the run (comments, status changes, documents, tool actions).
  const [agentActivity] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(eq(activityLog.runId, run.id), eq(activityLog.actorType, "agent")))
    .limit(1);
  if (agentActivity) return { kind: "not_inert", reason: "agent_activity_recorded" };

  const [cost] = await db
    .select({ id: costEvents.id })
    .from(costEvents)
    .where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id)))
    .limit(1);
  if (cost) return { kind: "not_inert", reason: "cost_recorded" };

  const leases = await db
    .select({
      id: environmentLeases.id,
      status: environmentLeases.status,
      provider: environmentLeases.provider,
      releasedAt: environmentLeases.releasedAt,
    })
    .from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  const held = leases.find(
    (lease) =>
      !lease.releasedAt || !(RELEASED_LEASE_STATUSES as readonly string[]).includes(lease.status),
  );
  if (held) return { kind: "awaiting_release", reason: `environment_lease_${held.status}` };

  return {
    kind: "inert",
    facts: {
      policy: INERT_RUN_RECONCILIATION_POLICY,
      runId: run.id,
      executionStage: "preparing",
      status: run.status,
      errorCode: run.errorCode ?? null,
      runEventTypes: [...new Set(events.map((event) => event.eventType))].sort(),
      environmentLeases: leases.map((lease) => ({
        id: lease.id,
        status: lease.status,
        provider: lease.provider,
      })),
    },
  };
}

export function describeInertRunEvidence(facts: InertRunFacts) {
  const leaseText = facts.environmentLeases.length
    ? `${facts.environmentLeases.length} environment lease(s) released`
    : "no environment lease acquired";
  return (
    `Automatic reconciliation (${facts.policy}): the run ended ${facts.status}` +
    `${facts.errorCode ? ` (${facts.errorCode})` : ""} while still preparing, before adapter dispatch. ` +
    `No process, provider session, output, usage, cost or agent API activity was recorded; ${leaseText}.`
  );
}
