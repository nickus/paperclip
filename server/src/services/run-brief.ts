import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  agents,
  heartbeatRuns,
  issueRelations,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  resolveAdapterExecutionTargetTimeout,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  PAPERCLIP_RUN_BRIEF_LABEL_MAX_CHARS,
  PAPERCLIP_RUN_BRIEF_PROMPT_MAX_CHARS,
  PAPERCLIP_RUN_BRIEF_SIBLING_STATUSES,
  PAPERCLIP_RUN_BRIEF_SIBLINGS_MAX_LINES,
  PAPERCLIP_RUN_BRIEF_SUMMARY_MAX_CHARS,
  PAPERCLIP_RUN_BRIEF_TEAM_MAX_MEMBERS,
  comparePaperclipRunBriefSiblings,
  normalizePaperclipRunBriefSibling,
  paperclipRunBriefOneLine,
  paperclipRunBriefRecoveryAuthority,
  type PaperclipRunBrief,
  type PaperclipRunBriefAuthority,
  type PaperclipRunBriefEnvironment,
  type PaperclipRunBriefPriorRun,
  type PaperclipRunBriefSessionReason,
  type PaperclipRunBriefSibling,
  type PaperclipRunBriefSiblings,
  type PaperclipRunBriefTeam,
} from "@paperclipai/adapter-utils/wake-run-brief";

export {
  isPaperclipWakeRunBriefEnabled as isRunBriefEnabled,
  isPaperclipRunBriefSiblingsEnabled as isRunBriefSiblingsEnabled,
} from "@paperclipai/adapter-utils/wake-run-brief";

export const RUN_BRIEF_PRIOR_RUN_LIMIT = 3;
// Enough rows to report an honest count; the renderer shows fewer.
const RUN_BRIEF_ROW_LIMIT = 50;
const RUN_BRIEF_LIST_LIMIT = 10;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const fenceLine = /^(?:`{3,}|~{3,})\S*$|^(?:-{3,}|\*{3,}|_{3,})$/;

/**
 * The last meaningful line of a run's summary, collapsed to one line of at
 * most `maxChars` characters. Fence and rule lines are skipped because they
 * carry no content of their own.
 */
export function finalLineSummary(
  value: unknown,
  maxChars = PAPERCLIP_RUN_BRIEF_SUMMARY_MAX_CHARS,
): string | null {
  if (typeof value !== "string") return null;
  const lines = value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !fenceLine.test(line));
  return paperclipRunBriefOneLine(lines.at(-1) ?? null, maxChars);
}

export type PriorRunRow = {
  id: string;
  status: string;
  livenessState?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  errorCode?: string | null;
  /** The run's retained trust preset (`executionPolicy.trustPreset`). */
  trustPreset?: string | null;
};

export const RUN_BRIEF_WITHHELD_SUMMARY = "[low-trust run output withheld]";

/** SQL for a run's retained trust preset without loading its whole context. */
export const heartbeatRunTrustPresetSql = sql<string | null>`${heartbeatRuns.contextSnapshot} #>> '{executionPolicy,trustPreset}'`;

function priorRunSummary(row: PriorRunRow): string | null {
  const result = object(row.result);
  for (const candidate of [
    object(result.nativeResult).summary,
    result.summary,
    result.result,
    result.message,
    row.error,
    row.errorCode,
  ]) {
    const line = finalLineSummary(candidate);
    if (line) return line;
  }
  return null;
}

/**
 * Newest-first digest of the most recent runs, excluding the current one.
 * `rows` must be ordered oldest first.
 */
export function digestPriorRuns(
  rows: PriorRunRow[],
  options: {
    excludeRunId?: string | null;
    limit?: number;
    /**
     * Withhold the output of low-trust review runs, as quarantined comments
     * are withheld from higher-trust readers.
     */
    withholdLowTrust?: boolean;
  } = {},
): PaperclipRunBriefPriorRun[] {
  const limit = options.limit ?? RUN_BRIEF_PRIOR_RUN_LIMIT;
  return rows
    .filter((row) => row.id !== options.excludeRunId)
    .slice(-limit)
    .reverse()
    .map((row) => ({
      id: row.id,
      status: row.status,
      liveness: row.livenessState ?? null,
      summary:
        options.withholdLowTrust && row.trustPreset === LOW_TRUST_REVIEW_PRESET
          ? RUN_BRIEF_WITHHELD_SUMMARY
          : priorRunSummary(row),
    }));
}

function interactionPrompt(row: {
  kind: string;
  title: string | null;
  summary: string | null;
  payload: unknown;
}): string | null {
  const payload = object(row.payload);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value : null;
  let prompt = text(payload.prompt);
  if (!prompt && row.kind === "ask_user_questions") {
    const questions = Array.isArray(payload.questions)
      ? payload.questions.map(object)
      : [];
    const first = text(questions[0]?.prompt);
    prompt =
      text(payload.title) ??
      (first && questions.length > 1
        ? `${first} (+${questions.length - 1} more)`
        : first);
  }
  if (!prompt && row.kind === "suggest_tasks" && Array.isArray(payload.tasks)) {
    prompt = `review ${payload.tasks.length} suggested task(s)`;
  }
  if (!prompt && row.kind === "connection_intent") {
    const service = text(payload.serviceName);
    prompt = service ? `connect ${service}` : null;
  }
  return paperclipRunBriefOneLine(
    prompt ?? text(row.title) ?? text(row.summary),
    PAPERCLIP_RUN_BRIEF_PROMPT_MAX_CHARS,
  );
}

function interactionAnswerBy(
  row: {
    addresseeAgentId: string | null;
    addresseeAgentName: string | null;
    addresseeUserId: string | null;
    effectiveResolverPolicy: string;
  },
  agentId: string | null | undefined,
): string {
  if (row.addresseeAgentId && row.addresseeAgentId === agentId) return "you";
  if (row.addresseeAgentId)
    return `agent ${row.addresseeAgentName ?? "(unknown)"}`;
  if (row.addresseeUserId) return "a board user";
  if (row.effectiveResolverPolicy === "human_only") return "any board user";
  if (row.effectiveResolverPolicy === "not_creator")
    return "anyone but its creator";
  return "anyone";
}

function assigneeLabel(
  row: {
    assigneeAgentId: string | null;
    assigneeAgentName: string | null;
    assigneeUserId: string | null;
  },
  agentId: string | null | undefined,
): string {
  if (row.assigneeAgentId && row.assigneeAgentId === agentId) return "you";
  if (row.assigneeAgentId)
    return `agent ${row.assigneeAgentName ?? "(unknown)"}`;
  if (row.assigneeUserId) return "a board user";
  return "unassigned";
}

function readPriorRuns(value: unknown): PaperclipRunBriefPriorRun[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const run = object(entry);
    return typeof run.id === "string" && typeof run.status === "string"
      ? [
          {
            id: run.id,
            status: run.status,
            liveness: typeof run.liveness === "string" ? run.liveness : null,
            summary: typeof run.summary === "string" ? run.summary : null,
          },
        ]
      : [];
  });
}

export type RunBriefTeamRow = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reportsTo: string | null;
};

// Code-unit comparison: the order must not depend on the host's locale.
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const byName = (left: RunBriefTeamRow, right: RunBriefTeamRow) =>
  compareText(left.name.toLowerCase(), right.name.toLowerCase()) ||
  compareText(left.name, right.name) ||
  compareText(left.id, right.id);

/**
 * The company roster for the Run Brief: every agent except terminated ones, in
 * reporting-line order (each manager followed by their reports, siblings by
 * name). The order depends only on the roster, so the rendered section stays
 * byte-identical from run to run while the roster does. When there are more
 * agents than `limit`, the woken agent, their manager, their direct reports
 * and their peers are kept first; the others fill the rest in the same order.
 */
export function buildRunBriefTeam(
  rows: RunBriefTeamRow[],
  options: {
    companyId: string;
    agentId?: string | null;
    limit?: number;
  },
): PaperclipRunBriefTeam | null {
  const limit = options.limit ?? PAPERCLIP_RUN_BRIEF_TEAM_MAX_MEMBERS;
  const roster = rows.filter((row) => row.status !== "terminated");
  if (roster.length === 0) return null;
  const byId = new Map(roster.map((row) => [row.id, row]));
  // A manager who is not on the roster (terminated, or missing) leaves the
  // agent at the top level.
  const managerOf = (row: RunBriefTeamRow) =>
    row.reportsTo && row.reportsTo !== row.id
      ? (byId.get(row.reportsTo) ?? null)
      : null;
  const reportsOf = new Map<string | null, RunBriefTeamRow[]>();
  for (const row of roster) {
    const key = managerOf(row)?.id ?? null;
    const reports = reportsOf.get(key);
    if (reports) reports.push(row);
    else reportsOf.set(key, [row]);
  }
  for (const reports of reportsOf.values()) reports.sort(byName);

  const ordered: RunBriefTeamRow[] = [];
  const seen = new Set<string>();
  const visit = (start: RunBriefTeamRow) => {
    // Iterative depth-first walk; `seen` also breaks reporting cycles.
    const stack = [start];
    while (stack.length > 0) {
      const row = stack.pop()!;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      ordered.push(row);
      const reports = reportsOf.get(row.id) ?? [];
      for (let index = reports.length - 1; index >= 0; index -= 1) {
        stack.push(reports[index]!);
      }
    }
  };
  for (const root of reportsOf.get(null) ?? []) visit(root);
  // Agents in a reporting cycle have no top-level ancestor; they come last.
  for (const row of [...roster].sort(byName)) visit(row);

  let listed = ordered;
  if (ordered.length > limit) {
    const self = options.agentId ? byId.get(options.agentId) : undefined;
    const manager = self ? managerOf(self) : null;
    const nearest = self
      ? [
          self,
          ...(manager ? [manager] : []),
          ...(reportsOf.get(self.id) ?? []),
          ...(reportsOf.get(manager?.id ?? null) ?? []),
        ]
      : [];
    const keep = new Set<string>();
    for (const row of [...nearest, ...ordered]) {
      if (keep.size >= limit) break;
      keep.add(row.id);
    }
    listed = ordered.filter((row) => keep.has(row.id));
  }
  // Names and titles are free text of any length; bound them here so the
  // stored wake payload stays small, as the renderer would anyway.
  const label = (value: string | null | undefined) =>
    paperclipRunBriefOneLine(value, PAPERCLIP_RUN_BRIEF_LABEL_MAX_CHARS);
  return {
    companyId: options.companyId,
    total: roster.length,
    members: listed.map((row) => ({
      id: row.id,
      name: label(row.name),
      role: label(row.role),
      title: label(row.title),
      status: label(row.status),
      reportsTo: label(managerOf(row)?.name),
      you: row.id === options.agentId,
    })),
  };
}

/** Read the company roster for the Run Brief (see `buildRunBriefTeam`). */
export async function loadRunBriefTeam(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
}): Promise<PaperclipRunBriefTeam | null> {
  const rows = await input.db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(
      and(eq(agents.companyId, input.companyId), ne(agents.status, "terminated")),
    );
  return buildRunBriefTeam(rows, {
    companyId: input.companyId,
    agentId: input.agentId,
  });
}

export type RunBriefSiblingRow = {
  id: string;
  status: string;
  /** `contextSnapshot.issueId`: null for a run without an issue. */
  issueId: string | null;
  /** From the issue row; null when it is missing or in another company. */
  issueIdentifier: string | null;
  issueTitle: string | null;
  createdAt: Date;
  startedAt: Date | null;
  lastOutputAt: Date | null;
  /** The run's retained trust preset (`executionPolicy.trustPreset`). */
  trustPreset?: string | null;
};

export const RUN_BRIEF_WITHHELD_SIBLING_TITLE = "[low-trust run; title withheld]";

/**
 * The woken agent's other live runs for the Run Brief, in the order the
 * renderer lists them, at most `limit` of them; `total` counts every one.
 * `rows` must already be limited to the agent's live runs. The current run is
 * dropped, and so are runs on `excludeIssueId` (the current run's issue): a
 * follow-up queued on that issue continues this run's own work, and telling
 * the run to keep off its own issue would contradict its authority line. The
 * issue title of a low-trust run is withheld, as that run's output is withheld
 * from higher-trust readers.
 */
export function buildRunBriefSiblings(
  rows: RunBriefSiblingRow[],
  options: {
    companyId: string;
    excludeRunId: string;
    excludeIssueId?: string | null;
    now: Date;
    limit?: number;
  },
): PaperclipRunBriefSiblings | null {
  const iso = (value: Date | null) => value?.toISOString() ?? null;
  const runs = rows
    .filter(
      (row) =>
        row.id !== options.excludeRunId &&
        !(options.excludeIssueId && row.issueId === options.excludeIssueId),
    )
    .flatMap((row): PaperclipRunBriefSibling[] => {
      const run = normalizePaperclipRunBriefSibling({
        id: row.id,
        status: row.status,
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        issueTitle:
          row.trustPreset === LOW_TRUST_REVIEW_PRESET
            ? RUN_BRIEF_WITHHELD_SIBLING_TITLE
            : row.issueTitle,
        queuedAt: iso(row.createdAt),
        startedAt: iso(row.startedAt),
        lastOutputAt: iso(row.lastOutputAt),
      });
      return run ? [run] : [];
    })
    .sort(comparePaperclipRunBriefSiblings);
  if (runs.length === 0) return null;
  return {
    companyId: options.companyId,
    asOf: options.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    total: runs.length,
    runs: runs.slice(0, options.limit ?? PAPERCLIP_RUN_BRIEF_SIBLINGS_MAX_LINES),
  };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the woken agent's other live runs (queued, running or waiting on a
 * scheduled retry), with the same run fields the company live-runs route
 * serves, plus each run's issue identifier and title. See
 * `buildRunBriefSiblings`.
 */
export async function loadRunBriefSiblings(input: {
  db: Db;
  companyId: string;
  agentId: string;
  runId: string;
  excludeIssueId?: string | null;
  now?: Date;
}): Promise<PaperclipRunBriefSiblings | null> {
  const { db, companyId } = input;
  const now = input.now ?? new Date();
  const runRows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      trustPreset: heartbeatRunTrustPresetSql,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        inArray(heartbeatRuns.status, [...PAPERCLIP_RUN_BRIEF_SIBLING_STATUSES]),
        ne(heartbeatRuns.id, input.runId),
      ),
    )
    // Oldest first, so a capped read keeps the runs that have been live
    // longest; the count is then a floor, as for blockers.
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(RUN_BRIEF_ROW_LIMIT);
  if (runRows.length === 0) return null;
  // A context issue id is plain JSON text; only well-formed ids reach the
  // uuid column, and only issues of this company are read.
  const issueIds = [
    ...new Set(
      runRows.flatMap((row) =>
        row.issueId && uuidPattern.test(row.issueId) ? [row.issueId] : [],
      ),
    ),
  ];
  const issueRows = issueIds.length
    ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)))
    : [];
  const issueById = new Map(issueRows.map((row) => [row.id, row]));
  return buildRunBriefSiblings(
    runRows.map((row) => {
      const issue = row.issueId ? issueById.get(row.issueId) : undefined;
      return {
        ...row,
        issueIdentifier: issue?.identifier ?? null,
        issueTitle: issue?.title ?? null,
      };
    }),
    {
      companyId,
      excludeRunId: input.runId,
      excludeIssueId: input.excludeIssueId,
      now,
    },
  );
}

/**
 * The Run Brief of a run without an issue: only the environment (filled in at
 * dispatch), the agent's other live runs and the company roster.
 */
export async function loadTeamOnlyRunBrief(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  /** Attach the agent's other live runs (see `loadRunBriefSiblings`). */
  includeSiblings?: boolean;
}): Promise<PaperclipRunBrief | null> {
  const team = await loadRunBriefTeam(input);
  const siblings =
    input.includeSiblings && input.agentId && input.runId
      ? await loadRunBriefSiblings({
          db: input.db,
          companyId: input.companyId,
          agentId: input.agentId,
          runId: input.runId,
        })
      : null;
  if (!team && !siblings) return null;
  return {
    version: 1,
    issueId: null,
    issueIdentifier: null,
    authority: "execute",
    environment: null,
    blockerCount: 0,
    blockers: [],
    pendingInteractionCount: 0,
    pendingInteractions: [],
    priorRuns: [],
    ...(team ? { team } : {}),
    ...(siblings ? { siblings } : {}),
  };
}

/**
 * Collect the Run Brief for an issue-scoped wake. Environment details are not
 * known yet at this point; heartbeat attaches them once the session and the
 * workspace are resolved (see `withRunBriefEnvironment`).
 */
export async function loadRunBrief(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  issue: { id: string; identifier: string | null };
  authority: PaperclipRunBriefAuthority;
  /** `priorRuns` of the execution continuation built for this run, if any. */
  priorRuns?: unknown;
  /** True when the reader itself is a low-trust review run. */
  exposeLowTrustRaw?: boolean;
  /** Attach the company roster (see `loadRunBriefTeam`). */
  includeTeam?: boolean;
  /** Attach the agent's other live runs (see `loadRunBriefSiblings`). */
  includeSiblings?: boolean;
}): Promise<PaperclipRunBrief> {
  const { db, companyId } = input;
  const issueId = input.issue.id;
  const blockerRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      assigneeAgentName: agents.name,
    })
    .from(issueRelations)
    .innerJoin(
      issues,
      and(eq(issueRelations.issueId, issues.id), eq(issues.companyId, companyId)),
    )
    .leftJoin(
      agents,
      and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, companyId)),
    )
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
        // Same rule as dependency readiness: only `done` resolves a blocker.
        ne(issues.status, "done"),
      ),
    )
    .orderBy(asc(issues.createdAt), asc(issues.id))
    .limit(RUN_BRIEF_ROW_LIMIT);
  const interactionRows = await db
    .select({
      id: issueThreadInteractions.id,
      kind: issueThreadInteractions.kind,
      title: issueThreadInteractions.title,
      summary: issueThreadInteractions.summary,
      payload: issueThreadInteractions.payload,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
      addresseeAgentName: agents.name,
    })
    .from(issueThreadInteractions)
    .leftJoin(
      agents,
      and(
        eq(agents.id, issueThreadInteractions.addresseeAgentId),
        eq(agents.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .orderBy(
      asc(issueThreadInteractions.createdAt),
      asc(issueThreadInteractions.id),
    )
    .limit(RUN_BRIEF_ROW_LIMIT);
  // Reuse the digest the execution continuation already computed for this
  // run; otherwise read the same scope: this agent's runs on the issue.
  const priorRuns =
    readPriorRuns(input.priorRuns) ??
    digestPriorRuns(
      (
        await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            livenessState: heartbeatRuns.livenessState,
            result: heartbeatRuns.resultJson,
            error: heartbeatRuns.error,
            errorCode: heartbeatRuns.errorCode,
            trustPreset: heartbeatRunTrustPresetSql,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              input.agentId ? eq(heartbeatRuns.agentId, input.agentId) : undefined,
              input.runId ? ne(heartbeatRuns.id, input.runId) : undefined,
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
          .limit(RUN_BRIEF_PRIOR_RUN_LIMIT)
      ).reverse(),
      { withholdLowTrust: input.exposeLowTrustRaw !== true },
    );
  const team = input.includeTeam
    ? await loadRunBriefTeam({ db, companyId, agentId: input.agentId })
    : null;
  // Needs the run id: without it the current run would list itself.
  const siblings =
    input.includeSiblings && input.agentId && input.runId
      ? await loadRunBriefSiblings({
          db,
          companyId,
          agentId: input.agentId,
          runId: input.runId,
          excludeIssueId: issueId,
        })
      : null;
  return {
    version: 1,
    issueId,
    issueIdentifier: input.issue.identifier,
    authority: input.authority,
    environment: null,
    blockerCount: blockerRows.length,
    blockers: blockerRows.slice(0, RUN_BRIEF_LIST_LIMIT).map((row) => ({
      id: row.id,
      identifier: row.identifier,
      status: row.status,
      assignee: assigneeLabel(row, input.agentId),
    })),
    pendingInteractionCount: interactionRows.length,
    pendingInteractions: interactionRows
      .slice(0, RUN_BRIEF_LIST_LIMIT)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        prompt: interactionPrompt(row),
        answerBy: interactionAnswerBy(row, input.agentId),
      })),
    priorRuns: priorRuns.slice(0, RUN_BRIEF_PRIOR_RUN_LIMIT),
    // After the issue orientation; absent when not requested or empty.
    ...(team ? { team } : {}),
    ...(siblings ? { siblings } : {}),
  };
}

/** Which authority wording applies to a wake, from its payload fields. */
export function resolveRunBriefAuthority(input: {
  wakeRole: unknown;
  recoveryScoped: boolean;
  /** The cause the wake text's recovery instruction is chosen by. */
  recoveryCause?: string | null;
  taskWatchdog: boolean;
  workMode: string | null | undefined;
  /**
   * Whether the woken agent is the issue's assignee; null or undefined when
   * that is not known, which keeps the role-based wording.
   */
  ownsIssue?: boolean | null;
}): PaperclipRunBriefAuthority {
  if (input.wakeRole === "reviewer" || input.wakeRole === "approver")
    return "review";
  if (input.recoveryScoped) {
    const authority = paperclipRunBriefRecoveryAuthority(input.recoveryCause);
    // "Go again" and "record your disposition" address the original owner;
    // any other agent woken on the recovery keeps the hand-back contract.
    return authority !== "recovery" && input.ownsIssue === false
      ? "recovery"
      : authority;
  }
  if (input.taskWatchdog) return "watchdog";
  // A mention or a question on someone else's issue is not a hand-off.
  if (input.ownsIssue === false) return "comment";
  if (input.workMode === "planning") return "planning";
  if (input.workMode === "ask") return "ask";
  return "execute";
}

/**
 * The run's wall-clock timeout as the adapter will apply it (sandbox targets
 * default to a backstop when none is configured) and an approximate deadline.
 * Adapters read `timeoutSec` with a fallback of 0, and so does this.
 */
export function runBriefTimeout(input: {
  executionTarget: AdapterExecutionTarget | null | undefined;
  configuredTimeoutSec: unknown;
  nowMs?: number;
}): Pick<PaperclipRunBriefEnvironment, "timeoutSec" | "deadlineAt"> {
  const configured =
    typeof input.configuredTimeoutSec === "number" &&
    Number.isFinite(input.configuredTimeoutSec)
      ? input.configuredTimeoutSec
      : 0;
  const { timeoutSec } = resolveAdapterExecutionTargetTimeout(
    input.executionTarget,
    configured,
  );
  if (!(timeoutSec > 0)) return { timeoutSec: null, deadlineAt: null };
  return {
    // Rounded up for display; the deadline keeps the exact value.
    timeoutSec: Math.ceil(timeoutSec),
    deadlineAt: new Date(
      (input.nowMs ?? Date.now()) + timeoutSec * 1_000,
    ).toISOString(),
  };
}

/**
 * Derive the brief's session reason from the heartbeat's resume decision.
 * Order matters: a later override (rotation, credential change) explains a
 * fresh session better than the earlier config check.
 */
export function resolveRunBriefSessionReason(input: {
  resumed: boolean;
  explicitResume: boolean;
  taskSessionReused: boolean;
  rotated: boolean;
  credentialChanged: boolean;
  resetForWake: boolean;
  resetForConfig: boolean;
}): PaperclipRunBriefSessionReason {
  if (input.resumed) {
    if (input.explicitResume) return "explicit_resume";
    return input.taskSessionReused ? "saved_task_session" : "runtime_session";
  }
  if (input.rotated) return "session_rotated";
  if (input.credentialChanged) return "credential_changed";
  if (input.resetForWake) return "fresh_session_requested";
  if (input.resetForConfig) return "config_changed";
  return "no_saved_session";
}

/**
 * Return a copy of the wake payload with the brief's environment filled in, or
 * the payload unchanged when it carries no brief.
 */
export function withRunBriefEnvironment(
  wakePayload: unknown,
  environment: PaperclipRunBriefEnvironment,
): unknown {
  const payload = object(wakePayload);
  const brief = object(payload.runBrief);
  if (brief.version !== 1) return wakePayload;
  return { ...payload, runBrief: { ...brief, environment } };
}

export function runBriefWorkspaceState(input: {
  reused: boolean;
  mode: string | null | undefined;
}): PaperclipRunBriefEnvironment["workspace"] {
  if (input.reused) return "reused";
  // Shared project and agent-home workspaces persist across tasks and runs.
  return input.mode === "shared_workspace" || input.mode === "agent_default"
    ? "shared"
    : "fresh";
}
