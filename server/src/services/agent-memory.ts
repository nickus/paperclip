import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentMemoryAudit, agentMemoryEntries, heartbeatRuns, issues } from "@paperclipai/db";
import {
  AGENT_MEMORY_AGE_DECAY_DAYS,
  AGENT_MEMORY_CONFIRMATION_WEIGHT,
  AGENT_MEMORY_DEFAULT_EXPIRY_DAYS,
  AGENT_MEMORY_DEFAULT_VISIBLE_STATUSES,
  AGENT_MEMORY_DISUSE_DECAY_DAYS,
  AGENT_MEMORY_HARD_CAP_PER_AGENT,
  AGENT_MEMORY_KIND_WEIGHTS,
  AGENT_MEMORY_LIVE_STATUSES,
  AGENT_MEMORY_MAX_CONFIRMATIONS_TRACKED,
  AGENT_MEMORY_MAX_WRITES_PER_AGENT_PER_DAY,
  AGENT_MEMORY_MAX_WRITES_PER_RUN,
  AGENT_MEMORY_MIN_CONFIRMATIONS_PROTECTED,
  AGENT_MEMORY_NEAR_DUPLICATE_SIMILARITY_MIN,
  AGENT_MEMORY_PROJECT_MATCH_WEIGHT,
  AGENT_MEMORY_PURGED_BODY_PLACEHOLDER,
  AGENT_MEMORY_UPDATE_SIMILARITY_MIN,
  AGENT_MEMORY_USE_WEIGHT,
  type AgentMemoryActor,
  type AgentMemoryActorType,
  type AgentMemoryEntryRow,
  type AgentMemoryKind,
  type AgentMemoryScope,
  type AgentMemoryStatus,
  type AgentMemoryWriteResult,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import {
  PAPERCLIP_RUN_BRIEF_MEMORY_MAX_LINES,
  type PaperclipRunBriefMemory,
} from "@paperclipai/adapter-utils/wake-run-brief";
import { conflict, forbidden, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { createFeedbackRedactionState, sanitizeFeedbackText } from "./feedback-redaction.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

const AGENT_MEMORY_LONG_QUOTED_TEXT_RE = /["'`][^"'`]{120,}["'`]/;
const AGENT_MEMORY_KEY_UNIQUE_INDEX = "agent_memory_company_scope_agent_key_active_uq";
const AGENT_MEMORY_SWEEP_ACTOR_ID = "agent-memory-sweep";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * What a hard purge leaves behind in a shadow-mode `agent_memory.shadow_rendered`
 * activity-log row that quoted the purged entry's body (heartbeat.ts logs the
 * whole rendered Memory section verbatim, by entryIds). Mirrors
 * AGENT_MEMORY_PURGED_BODY_PLACEHOLDER's role on the entry/audit rows -- see
 * the scrub step in hardPurgeAgentMemoryEntry below.
 */
const AGENT_MEMORY_PURGED_ACTIVITY_SECTION_PLACEHOLDER =
  "[redacted: this run's logged Memory section quoted a since hard-purged entry]";

/**
 * Thrown by writeAgentMemoryEntry/confirmAgentMemoryEntry (and the other
 * CAS-guarded mutations below) when the row changed between the caller's
 * read and this write. Route layer: 409, body `{ currentEntry }`.
 */
export class AgentMemoryConflictError extends Error {
  currentEntry: AgentMemoryEntryRow;
  constructor(currentEntry: AgentMemoryEntryRow, message?: string) {
    super(
      message
        ?? `This entry changed since you read it (now at version=${currentEntry.version}). Re-read it with GET /api/agents/me/memory and retry with the current baseVersion.`,
    );
    this.name = "AgentMemoryConflictError";
    this.currentEntry = currentEntry;
  }
}

/**
 * Reserved for the route layer's near-duplicate hint text (§11 of the
 * implementation spec). The decision algorithm's own near-duplicate branch
 * (§4 step 3) resolves as a NOOP confirmation of the existing entry rather
 * than throwing — this class is exported for API completeness but nothing
 * in this file throws it yet.
 */
export class AgentMemoryNearDuplicateError extends Error {
  currentEntry: AgentMemoryEntryRow;
  constructor(currentEntry: AgentMemoryEntryRow, message?: string) {
    super(
      message
        ?? `A similar memory already exists (id=${currentEntry.id}, key="${currentEntry.key}"); it was confirmed instead.`,
    );
    this.name = "AgentMemoryNearDuplicateError";
    this.currentEntry = currentEntry;
  }
}

function isAgentMemoryKeyConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    const constraintName = maybe.constraint ?? maybe.constraint_name;
    if (maybe.code === "23505" && constraintName === AGENT_MEMORY_KEY_UNIQUE_INDEX) return true;
    current = maybe.cause;
  }
  return false;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// --- Normalized token-Jaccard similarity (no LLM, no embeddings) ----------

/** lowercase, strip punctuation, collapse whitespace, drop tokens <= 2 chars. */
export function normalizeAgentMemoryTokens(input: string): Set<string> {
  const lowered = input.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ");
  const tokens = lowered.split(/\s+/).filter((token) => token.length > 2);
  return new Set(tokens);
}

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function agentMemoryBodySimilarity(a: string, b: string): number {
  return jaccardSimilarity(normalizeAgentMemoryTokens(a), normalizeAgentMemoryTokens(b));
}

// --- Row mapping ------------------------------------------------------------

function mapAgentMemoryEntryRow(row: typeof agentMemoryEntries.$inferSelect): AgentMemoryEntryRow {
  return {
    id: row.id,
    companyId: row.companyId,
    scope: row.scope as AgentMemoryScope,
    agentId: row.agentId,
    kind: row.kind as AgentMemoryKind,
    key: row.key,
    body: row.body,
    projectId: row.projectId,
    status: row.status as AgentMemoryStatus,
    version: row.version,
    sourceRunId: row.sourceRunId,
    sourceIssueId: row.sourceIssueId,
    createdByAgentId: row.createdByAgentId,
    sourceTrust: (row.sourceTrust as SourceTrustMetadata | null) ?? null,
    confirmations: row.confirmations,
    confirmingRunIds: row.confirmingRunIds ?? [],
    accessCount: row.accessCount,
    lastUsedAt: row.lastUsedAt,
    lastConfirmedAt: row.lastConfirmedAt,
    expiresAt: row.expiresAt,
    tombstoneReason: row.tombstoneReason,
    tombstonedByActorType: row.tombstonedByActorType as AgentMemoryActorType | null,
    tombstonedByActorId: row.tombstonedByActorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nextConfirmingRunIds(current: readonly string[], runId: string | null): string[] {
  if (!runId) return [...current];
  const deduped = current.filter((id) => id !== runId);
  const next = [...deduped, runId];
  return next.length > AGENT_MEMORY_MAX_CONFIRMATIONS_TRACKED
    ? next.slice(next.length - AGENT_MEMORY_MAX_CONFIRMATIONS_TRACKED)
    : next;
}

// --- Redaction (§7 of the implementation spec) ------------------------------

async function prepareAgentMemoryBody(input: {
  db: DbOrTx;
  companyId: string;
  runId: string | null;
  rawBody: string;
}): Promise<string> {
  const rejected = () =>
    unprocessable(
      "This entry looks like it contains a secret or personal data and was not stored. Memory entries must be short, factual notes — not quoted user text, credentials, or tokens.",
    );

  const capped = input.rawBody.length > 300 ? input.rawBody.slice(0, 300) : input.rawBody;
  if (AGENT_MEMORY_LONG_QUOTED_TEXT_RE.test(capped)) throw rejected();

  const state = createFeedbackRedactionState();
  const afterFeedbackRedaction = sanitizeFeedbackText(capped, state, "memory.body", 300);
  if (state.redactedFields.size > 0) throw rejected();

  if (input.runId) {
    const registry = createRunSecretRedactionRegistry(input.db as Db);
    const afterSecretRedaction = await registry.redactForRun(input.companyId, input.runId, afterFeedbackRedaction);
    if (afterSecretRedaction !== afterFeedbackRedaction) throw rejected();
  }

  return afterFeedbackRedaction;
}

// --- Write-time rate caps (§6.3) --------------------------------------------

async function assertAgentMemoryWriteCapsNotExceeded(input: {
  db: DbOrTx;
  companyId: string;
  actor: AgentMemoryActor;
  now: Date;
}): Promise<void> {
  const tooMany = () =>
    tooManyRequests(
      "You've reached the memory write limit for this run/today. Confirm an existing entry instead of adding a new one, or wait.",
    );

  if (input.actor.runId) {
    const [{ count: runCount }] = await input.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(agentMemoryAudit)
      .where(and(
        eq(agentMemoryAudit.companyId, input.companyId),
        eq(agentMemoryAudit.runId, input.actor.runId),
        inArray(agentMemoryAudit.action, ["add", "update", "noop_confirm"]),
      ));
    if (runCount >= AGENT_MEMORY_MAX_WRITES_PER_RUN) throw tooMany();
  }

  if (input.actor.type === "agent" && input.actor.id) {
    const since = new Date(input.now.getTime() - DAY_MS);
    const [{ count: dayCount }] = await input.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(agentMemoryAudit)
      .where(and(
        eq(agentMemoryAudit.companyId, input.companyId),
        eq(agentMemoryAudit.actorType, "agent"),
        eq(agentMemoryAudit.actorId, input.actor.id),
        inArray(agentMemoryAudit.action, ["add", "update", "noop_confirm"]),
        gte(agentMemoryAudit.createdAt, since),
      ));
    if (dayCount >= AGENT_MEMORY_MAX_WRITES_PER_AGENT_PER_DAY) throw tooMany();
  }
}

// --- Query helpers -----------------------------------------------------------

async function selectEntryById(db: DbOrTx, companyId: string, id: string): Promise<AgentMemoryEntryRow | null> {
  const [row] = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.companyId, companyId), eq(agentMemoryEntries.id, id)));
  return row ? mapAgentMemoryEntryRow(row) : null;
}

/**
 * Route-layer support for the `/api/agent-memory/:id/...` family (§8.1),
 * which has no `companyId` path segment to scope by. Deliberately
 * unscoped by company -- callers must run the same fetch-then-check-tenant
 * pattern `getAccessibleResource` (`server/src/routes/authz.ts`) uses
 * elsewhere, so a cross-company id returns the same 404 a missing one
 * would, never a 403 that would leak existence across tenants.
 */
export async function getAgentMemoryEntryById(db: Db, id: string): Promise<AgentMemoryEntryRow | null> {
  const [row] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, id));
  return row ? mapAgentMemoryEntryRow(row) : null;
}

async function selectLiveEntryById(
  db: DbOrTx,
  input: { companyId: string; agentId: string; scope: AgentMemoryScope; id: string },
): Promise<AgentMemoryEntryRow | null> {
  const [row] = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(
      eq(agentMemoryEntries.companyId, input.companyId),
      eq(agentMemoryEntries.scope, input.scope),
      eq(agentMemoryEntries.agentId, input.agentId),
      eq(agentMemoryEntries.id, input.id),
      inArray(agentMemoryEntries.status, AGENT_MEMORY_LIVE_STATUSES),
    ));
  return row ? mapAgentMemoryEntryRow(row) : null;
}

async function selectLiveEntryByKey(
  db: DbOrTx,
  input: { companyId: string; agentId: string; scope: AgentMemoryScope; key: string },
): Promise<AgentMemoryEntryRow | null> {
  const [row] = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(
      eq(agentMemoryEntries.companyId, input.companyId),
      eq(agentMemoryEntries.scope, input.scope),
      eq(agentMemoryEntries.agentId, input.agentId),
      eq(agentMemoryEntries.key, input.key),
      inArray(agentMemoryEntries.status, AGENT_MEMORY_LIVE_STATUSES),
    ));
  return row ? mapAgentMemoryEntryRow(row) : null;
}

async function selectLiveEntries(
  db: DbOrTx,
  input: { companyId: string; agentId: string; scope: AgentMemoryScope },
): Promise<AgentMemoryEntryRow[]> {
  const rows = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(
      eq(agentMemoryEntries.companyId, input.companyId),
      eq(agentMemoryEntries.scope, input.scope),
      eq(agentMemoryEntries.agentId, input.agentId),
      inArray(agentMemoryEntries.status, AGENT_MEMORY_LIVE_STATUSES),
    ));
  return rows.map(mapAgentMemoryEntryRow);
}

function findNearDuplicate(
  liveEntries: readonly AgentMemoryEntryRow[],
  excludeKey: string,
  body: string,
): AgentMemoryEntryRow | null {
  const candidateTokens = normalizeAgentMemoryTokens(body);
  let best: { row: AgentMemoryEntryRow; score: number } | null = null;
  for (const row of liveEntries) {
    if (row.key === excludeKey) continue;
    const score = jaccardSimilarity(candidateTokens, normalizeAgentMemoryTokens(row.body));
    if (score < AGENT_MEMORY_NEAR_DUPLICATE_SIMILARITY_MIN) continue;
    if (
      !best
      || score > best.score
      || (score === best.score && (row.key < best.row.key || (row.key === best.row.key && row.id < best.row.id)))
    ) {
      best = { row, score };
    }
  }
  return best?.row ?? null;
}

// --- Row mutations shared by the decision algorithm and the explicit routes -

async function insertAddRow(
  tx: Tx,
  params: {
    id?: string;
    companyId: string;
    agentId: string;
    scope: AgentMemoryScope;
    actor: AgentMemoryActor;
    sourceIssueId: string | null;
    sourceTrust: SourceTrustMetadata | null;
    candidate: { kind: AgentMemoryKind; key: string; body: string; projectId?: string | null };
    now: Date;
  },
): Promise<AgentMemoryWriteResult> {
  const id = params.id ?? randomUUID();
  const status: AgentMemoryStatus = params.sourceTrust ? "quarantined" : "active";
  const [inserted] = await tx
    .insert(agentMemoryEntries)
    .values({
      id,
      companyId: params.companyId,
      scope: params.scope,
      agentId: params.agentId,
      kind: params.candidate.kind,
      key: params.candidate.key,
      body: params.candidate.body,
      projectId: params.candidate.projectId ?? null,
      status,
      version: 1,
      sourceRunId: params.actor.runId ?? null,
      sourceIssueId: params.sourceIssueId,
      createdByAgentId: params.agentId,
      sourceTrust: params.sourceTrust as unknown as Record<string, unknown> | null,
      confirmations: 1,
      confirmingRunIds: params.actor.runId ? [params.actor.runId] : [],
      accessCount: 0,
      lastUsedAt: null,
      lastConfirmedAt: params.now,
      expiresAt: addDays(params.now, AGENT_MEMORY_DEFAULT_EXPIRY_DAYS),
      createdAt: params.now,
      updatedAt: params.now,
    })
    .returning();
  const entry = mapAgentMemoryEntryRow(inserted);
  await tx.insert(agentMemoryAudit).values({
    companyId: params.companyId,
    entryId: entry.id,
    action: "add",
    actorType: params.actor.type,
    actorId: params.actor.id,
    runId: params.actor.runId ?? null,
    beforeBody: null,
    afterBody: entry.body,
    beforeVersion: null,
    afterVersion: entry.version,
    reason: null,
  });
  return { decision: "add", entry };
}

async function tombstoneEntryRow(
  tx: Tx,
  params: { row: AgentMemoryEntryRow; reason: string; actor: AgentMemoryActor; now: Date },
): Promise<AgentMemoryEntryRow> {
  const updated = await tx
    .update(agentMemoryEntries)
    .set({
      status: "tombstoned",
      tombstoneReason: params.reason,
      tombstonedByActorType: params.actor.type,
      tombstonedByActorId: params.actor.id,
      version: params.row.version + 1,
      updatedAt: params.now,
    })
    .where(and(eq(agentMemoryEntries.id, params.row.id), eq(agentMemoryEntries.version, params.row.version)))
    .returning();
  if (updated.length === 0) {
    const fresh = await selectEntryById(tx, params.row.companyId, params.row.id);
    throw new AgentMemoryConflictError(fresh ?? params.row);
  }
  const entry = mapAgentMemoryEntryRow(updated[0]);
  await tx.insert(agentMemoryAudit).values({
    companyId: entry.companyId,
    entryId: entry.id,
    action: "tombstone",
    actorType: params.actor.type,
    actorId: params.actor.id,
    runId: params.actor.runId ?? null,
    beforeBody: null,
    afterBody: null,
    beforeVersion: params.row.version,
    afterVersion: entry.version,
    reason: params.reason,
  });
  return entry;
}

async function noopConfirmWithRetry(
  tx: Tx,
  params: { row: AgentMemoryEntryRow; actor: AgentMemoryActor; now: Date },
): Promise<AgentMemoryWriteResult> {
  let current = params.row;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const nextVersion = current.version + 1;
    const updated = await tx
      .update(agentMemoryEntries)
      .set({
        confirmations: current.confirmations + 1,
        confirmingRunIds: nextConfirmingRunIds(current.confirmingRunIds, params.actor.runId ?? null),
        lastConfirmedAt: params.now,
        expiresAt: addDays(params.now, AGENT_MEMORY_DEFAULT_EXPIRY_DAYS),
        version: nextVersion,
        updatedAt: params.now,
      })
      .where(and(eq(agentMemoryEntries.id, current.id), eq(agentMemoryEntries.version, current.version)))
      .returning();
    if (updated.length > 0) {
      const entry = mapAgentMemoryEntryRow(updated[0]);
      await tx.insert(agentMemoryAudit).values({
        companyId: entry.companyId,
        entryId: entry.id,
        action: "noop_confirm",
        actorType: params.actor.type,
        actorId: params.actor.id,
        runId: params.actor.runId ?? null,
        beforeBody: null,
        afterBody: null,
        beforeVersion: current.version,
        afterVersion: entry.version,
        reason: null,
      });
      return { decision: "noop", entry };
    }
    const fresh = await selectEntryById(tx, current.companyId, current.id);
    if (!fresh) throw notFound("Memory entry not found");
    current = fresh;
  }
  throw new AgentMemoryConflictError(current);
}

async function updateBodyCas(
  tx: Tx,
  params: { row: AgentMemoryEntryRow; body: string; actor: AgentMemoryActor; now: Date },
): Promise<AgentMemoryWriteResult> {
  const updated = await tx
    .update(agentMemoryEntries)
    .set({
      body: params.body,
      confirmations: params.row.confirmations + 1,
      confirmingRunIds: nextConfirmingRunIds(params.row.confirmingRunIds, params.actor.runId ?? null),
      lastConfirmedAt: params.now,
      expiresAt: addDays(params.now, AGENT_MEMORY_DEFAULT_EXPIRY_DAYS),
      version: params.row.version + 1,
      updatedAt: params.now,
    })
    .where(and(eq(agentMemoryEntries.id, params.row.id), eq(agentMemoryEntries.version, params.row.version)))
    .returning();
  if (updated.length === 0) {
    const fresh = await selectEntryById(tx, params.row.companyId, params.row.id);
    throw new AgentMemoryConflictError(fresh ?? params.row);
  }
  const entry = mapAgentMemoryEntryRow(updated[0]);
  await tx.insert(agentMemoryAudit).values({
    companyId: entry.companyId,
    entryId: entry.id,
    action: "update",
    actorType: params.actor.type,
    actorId: params.actor.id,
    runId: params.actor.runId ?? null,
    beforeBody: params.row.body,
    afterBody: entry.body,
    beforeVersion: params.row.version,
    afterVersion: entry.version,
    reason: null,
  });
  return { decision: "update", entry };
}

async function deleteThenAdd(
  tx: Tx,
  params: {
    old: AgentMemoryEntryRow;
    companyId: string;
    agentId: string;
    scope: AgentMemoryScope;
    actor: AgentMemoryActor;
    sourceIssueId: string | null;
    sourceTrust: SourceTrustMetadata | null;
    candidate: { kind: AgentMemoryKind; key: string; body: string; projectId?: string | null };
    now: Date;
  },
): Promise<AgentMemoryWriteResult> {
  const newId = randomUUID();
  const reason = `contradicted_by_new_entry:${newId}`;
  // Tombstone first: the live-row partial unique index covers
  // active/quarantined/disputed, so the old row must leave that set before
  // a second row can be inserted under the same key.
  await tombstoneEntryRow(tx, { row: params.old, reason, actor: params.actor, now: params.now });
  const added = await insertAddRow(tx, {
    id: newId,
    companyId: params.companyId,
    agentId: params.agentId,
    scope: params.scope,
    actor: params.actor,
    sourceIssueId: params.sourceIssueId,
    sourceTrust: params.sourceTrust,
    candidate: params.candidate,
    now: params.now,
  });
  return { ...added, decision: "delete_then_add" };
}

// --- Public service API (§3.2 of the implementation spec) ------------------

/**
 * Resolves the server-filled `sourceIssueId`/`sourceTrust` for a run-scoped
 * memory write: the run's bound issue (from `heartbeatRuns.contextSnapshot.issueId`,
 * the same field every other run-scoped write resolves it from -- see
 * `routes/pipelines.ts`), fed through `resolveActorSourceTrustForIssue`
 * exactly like an issue comment or feedback-vote write does. A run with no
 * bound issue (or no run at all) writes at standard trust -- there is
 * nothing to quarantine against. Shared by the explicit
 * `POST /api/agents/me/memory` route (§8.1) and the run-end `Remember:`
 * capture point (§9), so both resolve provenance the same way.
 */
export async function resolveAgentMemoryWriteSourceTrust(
  db: Db,
  input: { companyId: string; agentId: string; runId: string | null },
): Promise<{ sourceIssueId: string | null; sourceTrust: SourceTrustMetadata | null }> {
  if (!input.runId) return { sourceIssueId: null, sourceTrust: null };

  const [run] = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    ));
  const snapshot = (run?.contextSnapshot ?? null) as { issueId?: unknown } | null;
  const issueId = typeof snapshot?.issueId === "string" ? snapshot.issueId : null;
  if (!issueId) return { sourceIssueId: null, sourceTrust: null };

  const [issue] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return { sourceIssueId: null, sourceTrust: null };

  const sourceTrust = await resolveActorSourceTrustForIssue({
    db,
    issue,
    actor: { actorType: "agent", actorId: input.agentId, agentId: input.agentId, runId: input.runId },
  });
  return { sourceIssueId: issue.id, sourceTrust };
}

export interface WriteAgentMemoryEntryInput {
  db: Db;
  companyId: string;
  agentId: string;
  actor: AgentMemoryActor;
  sourceIssueId: string | null;
  sourceTrust: SourceTrustMetadata | null;
  candidate: { kind: AgentMemoryKind; key: string; body: string; projectId?: string | null };
  hints: { supersedes?: string | null; forget?: string | null };
}

/**
 * The four-way ADD/UPDATE/DELETE-then-ADD/NOOP decision (§4), run inside one
 * transaction with the insert/update it drives.
 */
export async function writeAgentMemoryEntry(input: WriteAgentMemoryEntryInput): Promise<AgentMemoryWriteResult> {
  const scope: AgentMemoryScope = "agent"; // v1: company scope write path is disabled (§1.4)
  const now = new Date();

  const body = await prepareAgentMemoryBody({
    db: input.db,
    companyId: input.companyId,
    runId: input.actor.runId ?? null,
    rawBody: input.candidate.body,
  });
  await assertAgentMemoryWriteCapsNotExceeded({ db: input.db, companyId: input.companyId, actor: input.actor, now });

  const candidate = { ...input.candidate, body };

  return input.db.transaction(async (tx) => {
    if (input.hints.forget) {
      const target = await selectLiveEntryById(tx, {
        companyId: input.companyId,
        agentId: input.agentId,
        scope,
        id: input.hints.forget,
      });
      if (target) {
        await tombstoneEntryRow(tx, { row: target, reason: "forget_hint", actor: input.actor, now });
      }
      return insertAddRow(tx, {
        companyId: input.companyId,
        agentId: input.agentId,
        scope,
        actor: input.actor,
        sourceIssueId: input.sourceIssueId,
        sourceTrust: input.sourceTrust,
        candidate,
        now,
      });
    }

    if (input.hints.supersedes) {
      const target = await selectLiveEntryById(tx, {
        companyId: input.companyId,
        agentId: input.agentId,
        scope,
        id: input.hints.supersedes,
      });
      if (target) return updateBodyCas(tx, { row: target, body, actor: input.actor, now });
      // Hint target missing or no longer live: fall through to the normal
      // key/near-duplicate match below, same as if no hint had been given.
    }

    const liveEntries = await selectLiveEntries(tx, { companyId: input.companyId, agentId: input.agentId, scope });
    const keyMatch = liveEntries.find((row) => row.key === candidate.key);
    if (keyMatch) {
      const similarity = agentMemoryBodySimilarity(keyMatch.body, body);
      if (similarity < AGENT_MEMORY_UPDATE_SIMILARITY_MIN) {
        return deleteThenAdd(tx, {
          old: keyMatch,
          companyId: input.companyId,
          agentId: input.agentId,
          scope,
          actor: input.actor,
          sourceIssueId: input.sourceIssueId,
          sourceTrust: input.sourceTrust,
          candidate,
          now,
        });
      }
      if (similarity < 1) {
        return updateBodyCas(tx, { row: keyMatch, body, actor: input.actor, now });
      }
      return noopConfirmWithRetry(tx, { row: keyMatch, actor: input.actor, now });
    }

    const nearDuplicate = findNearDuplicate(liveEntries, candidate.key, body);
    if (nearDuplicate) {
      return noopConfirmWithRetry(tx, { row: nearDuplicate, actor: input.actor, now });
    }

    try {
      // A savepoint: if the insert loses the unique-index race (23505), only
      // this nested transaction rolls back. Without it, Postgres marks the
      // whole outer transaction aborted and the fallback select below (same
      // tx) would fail with "current transaction is aborted".
      return await tx.transaction((savepoint) => insertAddRow(savepoint, {
        companyId: input.companyId,
        agentId: input.agentId,
        scope,
        actor: input.actor,
        sourceIssueId: input.sourceIssueId,
        sourceTrust: input.sourceTrust,
        candidate,
        now,
      }));
    } catch (error) {
      if (!isAgentMemoryKeyConflict(error)) throw error;
      // Concurrent insert race: another writer won the partial unique index
      // on (company, scope, agent, key) between our match-check above and
      // this insert. Resolve the loser's write as a confirmation of the
      // winner's row rather than surfacing the constraint violation.
      const winner = await selectLiveEntryByKey(tx, {
        companyId: input.companyId,
        agentId: input.agentId,
        scope,
        key: candidate.key,
      });
      if (!winner) throw error;
      return noopConfirmWithRetry(tx, { row: winner, actor: input.actor, now });
    }
  });
}

export async function confirmAgentMemoryEntry(input: {
  db: Db;
  companyId: string;
  id: string;
  actor: AgentMemoryActor;
  baseVersion: number;
}): Promise<AgentMemoryEntryRow> {
  const now = new Date();
  return input.db.transaction(async (tx) => {
    const row = await selectEntryById(tx, input.companyId, input.id);
    if (!row) throw notFound("Memory entry not found");
    const updated = await tx
      .update(agentMemoryEntries)
      .set({
        confirmations: row.confirmations + 1,
        confirmingRunIds: nextConfirmingRunIds(row.confirmingRunIds, input.actor.runId ?? null),
        lastConfirmedAt: now,
        expiresAt: addDays(now, AGENT_MEMORY_DEFAULT_EXPIRY_DAYS),
        version: row.version + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMemoryEntries.id, row.id), eq(agentMemoryEntries.version, input.baseVersion)))
      .returning();
    if (updated.length === 0) {
      const fresh = await selectEntryById(tx, input.companyId, input.id);
      throw new AgentMemoryConflictError(fresh ?? row);
    }
    const entry = mapAgentMemoryEntryRow(updated[0]);
    await tx.insert(agentMemoryAudit).values({
      companyId: entry.companyId,
      entryId: entry.id,
      action: "noop_confirm",
      actorType: input.actor.type,
      actorId: input.actor.id,
      runId: input.actor.runId ?? null,
      beforeBody: null,
      afterBody: null,
      beforeVersion: row.version,
      afterVersion: entry.version,
      reason: null,
    });
    return entry;
  });
}

export async function disputeAgentMemoryEntry(input: {
  db: Db;
  companyId: string;
  id: string;
  actor: AgentMemoryActor;
  reason: string;
}): Promise<AgentMemoryEntryRow> {
  const now = new Date();
  return input.db.transaction(async (tx) => {
    const row = await selectEntryById(tx, input.companyId, input.id);
    if (!row) throw notFound("Memory entry not found");
    if (!AGENT_MEMORY_LIVE_STATUSES.includes(row.status)) {
      throw conflict("This entry cannot be disputed in its current state.", { currentEntry: row });
    }
    const updated = await tx
      .update(agentMemoryEntries)
      .set({ status: "disputed", version: row.version + 1, updatedAt: now })
      .where(and(eq(agentMemoryEntries.id, row.id), eq(agentMemoryEntries.version, row.version)))
      .returning();
    if (updated.length === 0) {
      const fresh = await selectEntryById(tx, input.companyId, input.id);
      throw new AgentMemoryConflictError(fresh ?? row);
    }
    const entry = mapAgentMemoryEntryRow(updated[0]);
    await tx.insert(agentMemoryAudit).values({
      companyId: entry.companyId,
      entryId: entry.id,
      action: "dispute",
      actorType: input.actor.type,
      actorId: input.actor.id,
      runId: input.actor.runId ?? null,
      beforeBody: null,
      afterBody: null,
      beforeVersion: row.version,
      afterVersion: entry.version,
      reason: input.reason,
    });
    return entry;
  });
}

export async function tombstoneAgentMemoryEntry(input: {
  db: Db;
  companyId: string;
  id: string;
  actor: AgentMemoryActor;
  reason: string;
  requireOwnEntry: boolean;
}): Promise<AgentMemoryEntryRow> {
  const now = new Date();
  return input.db.transaction(async (tx) => {
    const row = await selectEntryById(tx, input.companyId, input.id);
    if (!row) throw notFound("Memory entry not found");
    if (input.requireOwnEntry && row.createdByAgentId !== input.actor.agentId) {
      throw forbidden(
        "You can only tombstone your own memory entries. An actor with agents:configure, or a board user, can prune another agent's entries.",
      );
    }
    if (row.status === "purged") {
      throw conflict("A purged entry cannot be tombstoned.", { currentEntry: row });
    }
    return tombstoneEntryRow(tx, { row, reason: input.reason, actor: input.actor, now });
  });
}

export async function promoteQuarantinedAgentMemoryEntry(input: {
  db: Db;
  companyId: string;
  id: string;
  actor: AgentMemoryActor;
}): Promise<AgentMemoryEntryRow> {
  const now = new Date();
  return input.db.transaction(async (tx) => {
    const row = await selectEntryById(tx, input.companyId, input.id);
    if (!row) throw notFound("Memory entry not found");
    if (row.status !== "quarantined") {
      throw conflict("Only a quarantined entry can be promoted.", { currentEntry: row });
    }
    const updated = await tx
      .update(agentMemoryEntries)
      .set({ status: "active", version: row.version + 1, updatedAt: now })
      .where(and(eq(agentMemoryEntries.id, row.id), eq(agentMemoryEntries.version, row.version)))
      .returning();
    if (updated.length === 0) {
      const fresh = await selectEntryById(tx, input.companyId, input.id);
      throw new AgentMemoryConflictError(fresh ?? row);
    }
    const entry = mapAgentMemoryEntryRow(updated[0]);
    await tx.insert(agentMemoryAudit).values({
      companyId: entry.companyId,
      entryId: entry.id,
      action: "quarantine_promote",
      actorType: input.actor.type,
      actorId: input.actor.id,
      runId: input.actor.runId ?? null,
      beforeBody: null,
      afterBody: null,
      beforeVersion: row.version,
      afterVersion: entry.version,
      reason: null,
    });
    return entry;
  });
}

export async function hardPurgeAgentMemoryEntry(input: {
  db: Db;
  companyId: string;
  id: string;
  actor: AgentMemoryActor;
  reason: string;
}): Promise<AgentMemoryEntryRow> {
  const now = new Date();
  return input.db.transaction(async (tx) => {
    const row = await selectEntryById(tx, input.companyId, input.id);
    if (!row) throw notFound("Memory entry not found");
    if (row.status === "purged") {
      throw conflict("This entry has already been purged.", { currentEntry: row });
    }
    const updated = await tx
      .update(agentMemoryEntries)
      .set({
        body: AGENT_MEMORY_PURGED_BODY_PLACEHOLDER,
        status: "purged",
        version: row.version + 1,
        updatedAt: now,
      })
      .where(and(eq(agentMemoryEntries.id, row.id), eq(agentMemoryEntries.version, row.version)))
      .returning();
    if (updated.length === 0) {
      const fresh = await selectEntryById(tx, input.companyId, input.id);
      throw new AgentMemoryConflictError(fresh ?? row);
    }
    const entry = mapAgentMemoryEntryRow(updated[0]);
    // The one documented exception to "every mutation's audit trail is
    // non-destructive": a hard purge exists to erase content (e.g. a leaked
    // secret) everywhere, so beforeBody is not preserved here either.
    await tx.insert(agentMemoryAudit).values({
      companyId: entry.companyId,
      entryId: entry.id,
      action: "hard_purge",
      actorType: input.actor.type,
      actorId: input.actor.id,
      runId: input.actor.runId ?? null,
      beforeBody: null,
      afterBody: AGENT_MEMORY_PURGED_BODY_PLACEHOLDER,
      beforeVersion: row.version,
      afterVersion: entry.version,
      reason: input.reason,
    });
    // "Everywhere" means everywhere: this entry's own earlier add/update
    // audit rows quote its pre-purge body verbatim (beforeBody/afterBody),
    // and a shadow-mode wake that rendered it logs the whole Memory section
    // text into activity_log (heartbeat.ts, "agent_memory.shadow_rendered").
    // Both are scrubbed here, in the same transaction as the purge itself,
    // so a hard purge cannot be defeated by reading either table instead of
    // the entry.
    await tx
      .update(agentMemoryAudit)
      .set({ beforeBody: null, afterBody: null })
      .where(and(
        eq(agentMemoryAudit.companyId, entry.companyId),
        eq(agentMemoryAudit.entryId, entry.id),
        ne(agentMemoryAudit.action, "hard_purge"),
      ));
    await tx
      .update(activityLog)
      .set({
        details: sql`jsonb_set(${activityLog.details}, '{renderedSection}', ${JSON.stringify(AGENT_MEMORY_PURGED_ACTIVITY_SECTION_PLACEHOLDER)}::jsonb)`,
      })
      .where(and(
        eq(activityLog.companyId, entry.companyId),
        eq(activityLog.action, "agent_memory.shadow_rendered"),
        sql`${activityLog.details} -> 'entryIds' @> ${JSON.stringify([entry.id])}::jsonb`,
      ));
    return entry;
  });
}

function agentMemoryVisibilityCondition(requestedStatuses: readonly AgentMemoryStatus[], now: Date) {
  const liveish: AgentMemoryStatus[] = ["active", "quarantined", "disputed"];
  const wantsExpired = requestedStatuses.includes("expired");
  const nonExpiredRequested = requestedStatuses.filter((status) => status !== "expired");
  const clauses: ReturnType<typeof and>[] = [];

  const liveishRequested = nonExpiredRequested.filter((status) => liveish.includes(status));
  const terminalRequested = nonExpiredRequested.filter((status) => !liveish.includes(status));
  if (liveishRequested.length > 0) {
    clauses.push(and(
      inArray(agentMemoryEntries.status, liveishRequested),
      gte(agentMemoryEntries.expiresAt, now),
    ));
  }
  if (terminalRequested.length > 0) {
    clauses.push(inArray(agentMemoryEntries.status, terminalRequested));
  }
  if (wantsExpired) {
    clauses.push(eq(agentMemoryEntries.status, "expired"));
    clauses.push(and(inArray(agentMemoryEntries.status, liveish), lt(agentMemoryEntries.expiresAt, now)));
  }
  return clauses.length === 1 ? clauses[0] : sql.join(clauses.map((clause) => sql`(${clause})`), sql` or `);
}

function encodeAgentMemoryCursor(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeAgentMemoryCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed?.createdAt === "string" && typeof parsed?.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function listAgentMemoryEntries(input: {
  db: Db;
  companyId: string;
  agentId: string;
  status?: AgentMemoryStatus[];
  limit?: number;
  cursor?: string;
}): Promise<{ entries: AgentMemoryEntryRow[]; nextCursor: string | null }> {
  const now = new Date();
  const limit = input.limit ?? 50;
  const requestedStatuses = input.status ?? [...AGENT_MEMORY_DEFAULT_VISIBLE_STATUSES];
  const cursor = decodeAgentMemoryCursor(input.cursor);

  const conditions = [
    eq(agentMemoryEntries.companyId, input.companyId),
    eq(agentMemoryEntries.agentId, input.agentId),
    agentMemoryVisibilityCondition(requestedStatuses, now),
  ];
  if (cursor) {
    conditions.push(sql`(${agentMemoryEntries.createdAt}, ${agentMemoryEntries.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
  }

  const rows = await input.db
    .select()
    .from(agentMemoryEntries)
    .where(and(...conditions))
    .orderBy(sql`${agentMemoryEntries.createdAt} desc`, sql`${agentMemoryEntries.id} desc`)
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const entries = page.map(mapAgentMemoryEntryRow);
  const last = entries.at(-1);
  const nextCursor = rows.length > limit && last
    ? encodeAgentMemoryCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
    : null;
  return { entries, nextCursor };
}

/**
 * Board read route support (§8.2): the same keyset-paginated listing as
 * `listAgentMemoryEntries`, but `agentId` is optional so a board actor can
 * list/filter across every agent in the company. Additive -- does not
 * change `listAgentMemoryEntries`'s own (agent-mandatory) contract, which
 * the agent-self route keeps using unchanged.
 */
export async function listAgentMemoryEntriesForCompany(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  status?: AgentMemoryStatus[];
  limit?: number;
  cursor?: string;
}): Promise<{ entries: AgentMemoryEntryRow[]; nextCursor: string | null }> {
  const now = new Date();
  const limit = input.limit ?? 50;
  const requestedStatuses = input.status ?? [...AGENT_MEMORY_DEFAULT_VISIBLE_STATUSES];
  const cursor = decodeAgentMemoryCursor(input.cursor);

  const conditions = [
    eq(agentMemoryEntries.companyId, input.companyId),
    agentMemoryVisibilityCondition(requestedStatuses, now),
  ];
  if (input.agentId) conditions.push(eq(agentMemoryEntries.agentId, input.agentId));
  if (cursor) {
    conditions.push(sql`(${agentMemoryEntries.createdAt}, ${agentMemoryEntries.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
  }

  const rows = await input.db
    .select()
    .from(agentMemoryEntries)
    .where(and(...conditions))
    .orderBy(sql`${agentMemoryEntries.createdAt} desc`, sql`${agentMemoryEntries.id} desc`)
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const entries = page.map(mapAgentMemoryEntryRow);
  const last = entries.at(-1);
  const nextCursor = rows.length > limit && last
    ? encodeAgentMemoryCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
    : null;
  return { entries, nextCursor };
}

/** Governance query: active entries confirmed often enough to be worth a human/governance look (§3.2, owner decision 7). */
export async function listPromotionCandidates(input: {
  db: Db;
  companyId: string;
  minConfirmations?: number;
}): Promise<AgentMemoryEntryRow[]> {
  const now = new Date();
  const minConfirmations = input.minConfirmations ?? 3;
  const rows = await input.db
    .select()
    .from(agentMemoryEntries)
    .where(and(
      eq(agentMemoryEntries.companyId, input.companyId),
      eq(agentMemoryEntries.status, "active"),
      gte(agentMemoryEntries.expiresAt, now),
      gte(agentMemoryEntries.confirmations, minConfirmations),
    ))
    .orderBy(sql`${agentMemoryEntries.confirmations} desc`, sql`${agentMemoryEntries.lastConfirmedAt} desc`);
  return rows.map(mapAgentMemoryEntryRow);
}

// --- Ranking (§5) ------------------------------------------------------------

export function computeAgentMemoryScore(row: AgentMemoryEntryRow, now: Date, issueProjectId: string | null): number {
  const kindWeight = AGENT_MEMORY_KIND_WEIGHTS[row.kind] ?? 0;
  const confirmationTerm = AGENT_MEMORY_CONFIRMATION_WEIGHT * Math.log(1 + row.confirmations);
  const projectTerm = issueProjectId && row.projectId && row.projectId === issueProjectId
    ? AGENT_MEMORY_PROJECT_MATCH_WEIGHT
    : 0;
  const useTerm = AGENT_MEMORY_USE_WEIGHT * Math.log(1 + row.accessCount);
  const ageDays = (now.getTime() - row.lastConfirmedAt.getTime()) / DAY_MS;
  const disuseDays = (now.getTime() - (row.lastUsedAt ?? row.createdAt).getTime()) / DAY_MS;
  return (
    kindWeight
    + confirmationTerm
    + projectTerm
    + useTerm
    - ageDays / AGENT_MEMORY_AGE_DECAY_DAYS
    - disuseDays / AGENT_MEMORY_DISUSE_DECAY_DAYS
  );
}

/** Pure function over already-loaded rows (§5); sorted highest score first, deterministic tie-break by key then id. */
export function rankAgentMemoryEntries(
  rows: readonly AgentMemoryEntryRow[],
  options: { now: Date; issueProjectId: string | null; limit?: number },
): AgentMemoryEntryRow[] {
  const scored = rows.map((row) => ({ row, score: computeAgentMemoryScore(row, options.now, options.issueProjectId) }));
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.row.key !== right.row.key) return left.row.key < right.row.key ? -1 : 1;
    if (left.row.id === right.row.id) return 0;
    return left.row.id < right.row.id ? -1 : 1;
  });
  const sorted = scored.map((entry) => entry.row);
  return typeof options.limit === "number" ? sorted.slice(0, options.limit) : sorted;
}

// --- Forgetting: expiry + hard cap sweep (§6) -------------------------------

export async function sweepAgentMemory(input: {
  db: Db;
  now?: Date;
  capPerAgent?: number;
}): Promise<{ expired: number; evicted: number }> {
  const now = input.now ?? new Date();
  const capPerAgent = input.capPerAgent ?? AGENT_MEMORY_HARD_CAP_PER_AGENT;
  const db = input.db;

  // 1. Expiry sweep: flip the stored status of read-time-expired live-ish
  // rows so indexes and the cap sweep below can select on status directly.
  const toExpire = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(
      inArray(agentMemoryEntries.status, AGENT_MEMORY_LIVE_STATUSES.concat("disputed")),
      lt(agentMemoryEntries.expiresAt, now),
    ));

  let expired = 0;
  for (const dbRow of toExpire) {
    const row = mapAgentMemoryEntryRow(dbRow);
    const flipped = await db.transaction(async (tx) => {
      const updated = await tx
        .update(agentMemoryEntries)
        .set({ status: "expired", version: row.version + 1, updatedAt: now })
        .where(and(eq(agentMemoryEntries.id, row.id), eq(agentMemoryEntries.version, row.version)))
        .returning();
      if (updated.length === 0) return false;
      await tx.insert(agentMemoryAudit).values({
        companyId: row.companyId,
        entryId: row.id,
        action: "expire_sweep",
        actorType: "system",
        actorId: AGENT_MEMORY_SWEEP_ACTOR_ID,
        runId: null,
        beforeBody: null,
        afterBody: null,
        beforeVersion: row.version,
        afterVersion: row.version + 1,
        reason: null,
      });
      return true;
    });
    if (flipped) expired += 1;
  }

  // 2. Hard cap sweep, per (companyId, agentId).
  const overCapGroups = await db
    .select({
      companyId: agentMemoryEntries.companyId,
      agentId: agentMemoryEntries.agentId,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(agentMemoryEntries)
    .where(and(isNotNull(agentMemoryEntries.agentId), ne(agentMemoryEntries.status, "purged")))
    .groupBy(agentMemoryEntries.companyId, agentMemoryEntries.agentId)
    .having(sql`count(*) > ${capPerAgent}`);

  let evicted = 0;
  for (const group of overCapGroups) {
    const agentId = group.agentId;
    if (!agentId) continue;
    const dbRows = await db
      .select()
      .from(agentMemoryEntries)
      .where(and(
        eq(agentMemoryEntries.companyId, group.companyId),
        eq(agentMemoryEntries.agentId, agentId),
        ne(agentMemoryEntries.status, "purged"),
      ));
    const rows = dbRows.map(mapAgentMemoryEntryRow);
    let overflow = rows.length - capPerAgent;
    if (overflow <= 0) continue;

    const toDelete: AgentMemoryEntryRow[] = [];
    const byScoreAscending = (a: AgentMemoryEntryRow, b: AgentMemoryEntryRow) => {
      const scoreDiff = computeAgentMemoryScore(a, now, null) - computeAgentMemoryScore(b, now, null);
      if (scoreDiff !== 0) return scoreDiff;
      return a.updatedAt.getTime() - b.updatedAt.getTime();
    };

    const expiredOrTombstoned = rows
      .filter((row) => row.status === "expired" || row.status === "tombstoned")
      .sort(byScoreAscending);
    for (const row of expiredOrTombstoned) {
      if (overflow <= 0) break;
      toDelete.push(row);
      overflow -= 1;
    }

    if (overflow > 0) {
      const deletableIds = new Set(toDelete.map((row) => row.id));
      const protectedConfirmationsFloor = AGENT_MEMORY_MIN_CONFIRMATIONS_PROTECTED;
      const activeCandidates = rows
        .filter((row) => row.status === "active" && row.confirmations < protectedConfirmationsFloor && !deletableIds.has(row.id))
        .sort(byScoreAscending);
      for (const row of activeCandidates) {
        if (overflow <= 0) break;
        toDelete.push(row);
        overflow -= 1;
      }
    }

    if (toDelete.length === 0) continue;
    await db.transaction(async (tx) => {
      for (const row of toDelete) {
        await tx.insert(agentMemoryAudit).values({
          companyId: row.companyId,
          entryId: row.id,
          action: "evict_cap",
          actorType: "system",
          actorId: AGENT_MEMORY_SWEEP_ACTOR_ID,
          runId: null,
          beforeBody: null,
          afterBody: null,
          beforeVersion: row.version,
          afterVersion: null,
          reason: null,
        });
      }
      await tx.delete(agentMemoryEntries).where(inArray(agentMemoryEntries.id, toDelete.map((row) => row.id)));
    });
    evicted += toDelete.length;
  }

  return { expired, evicted };
}

// --- Run Brief support (§9/§10) ---------------------------------------------

/**
 * Bumps `accessCount`/`lastUsedAt` for entries actually shown in a
 * non-shadow Run Brief (§6.2): "use" means "was shown to an agent," not
 * "was merely loaded from the DB." Not an audited mutation -- access
 * bookkeeping is not one of the AGENT_MEMORY_AUDIT_ACTIONS, the same way a
 * read is never audited.
 */
export async function markAgentMemoryEntriesUsed(db: Db, input: {
  companyId: string;
  entryIds: readonly string[];
  now?: Date;
}): Promise<void> {
  if (input.entryIds.length === 0) return;
  const now = input.now ?? new Date();
  await db
    .update(agentMemoryEntries)
    .set({ accessCount: sql`${agentMemoryEntries.accessCount} + 1`, lastUsedAt: now })
    .where(and(
      eq(agentMemoryEntries.companyId, input.companyId),
      inArray(agentMemoryEntries.id, [...input.entryIds]),
    ));
}

/**
 * Run Brief support (§9/§10): the agent's own top-ranked active memory, in
 * the shape `renderMemory`/`normalizePaperclipRunBrief` expect. Always
 * computes the section when called -- the shadow-vs-on branch lives in the
 * caller (heartbeat.ts, §10.4): shadow mode still needs the rendered text
 * to log via activity, it just never attaches it to the wake payload.
 * `recordAccess` (default true) gates the accessCount/lastUsedAt bump;
 * the caller passes false in shadow mode, since an entry that is only
 * logged was never actually shown to the agent.
 */
export async function loadRunBriefMemory(input: {
  db: Db;
  companyId: string;
  agentId: string;
  issueProjectId: string | null;
  now?: Date;
  recordAccess?: boolean;
}): Promise<PaperclipRunBriefMemory | null> {
  const now = input.now ?? new Date();
  // Only "active" entries are ever injectable (quarantined/disputed never
  // are, and expired/tombstoned/purged are already hidden by the default
  // visible-status filter this would otherwise apply).
  const { entries } = await listAgentMemoryEntries({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    status: ["active"],
    limit: AGENT_MEMORY_HARD_CAP_PER_AGENT,
  });
  if (entries.length === 0) return null;
  const ranked = rankAgentMemoryEntries(entries, {
    now,
    issueProjectId: input.issueProjectId,
    limit: PAPERCLIP_RUN_BRIEF_MEMORY_MAX_LINES,
  });
  if (ranked.length === 0) return null;
  if (input.recordAccess !== false) {
    await markAgentMemoryEntriesUsed(input.db, {
      companyId: input.companyId,
      entryIds: ranked.map((row) => row.id),
      now,
    });
  }
  return {
    companyId: input.companyId,
    agentId: input.agentId,
    total: entries.length,
    entries: ranked.map((row) => ({
      id: row.id,
      kind: row.kind,
      scope: "agent" as const,
      confirmations: row.confirmations,
      ageDays: Math.max(
        0,
        Math.floor((now.getTime() - row.lastConfirmedAt.getTime()) / DAY_MS),
      ),
      key: row.key,
      body: row.body,
    })),
  };
}
