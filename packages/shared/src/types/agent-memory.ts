import type { SourceTrustMetadata } from "../trust-policy.js";

/**
 * Native agent memory (mem0 ideas borrowed: deterministic ADD/UPDATE/DELETE/
 * NOOP decision, compare-and-swap updates, a non-destructive audit trail —
 * no vector store, no LLM, no second service). See
 * `packages/db/src/schema/agent_memory_entries.ts` for the table and
 * `server/src/services/agent-memory.ts` for the service.
 */

export const AGENT_MEMORY_SCOPES = ["agent", "company"] as const; // "company" write path disabled in v1
export type AgentMemoryScope = (typeof AGENT_MEMORY_SCOPES)[number];

export const AGENT_MEMORY_KINDS = ["gotcha", "lesson", "fact", "decision"] as const;
export type AgentMemoryKind = (typeof AGENT_MEMORY_KINDS)[number];

export const AGENT_MEMORY_STATUSES = [
  "active", // visible, ranked, injectable
  "quarantined", // low-trust source; never injected; governance/board can promote -> active
  "disputed", // an agent or the board challenged it; hidden from injection pending review
  "expired", // expiresAt passed and not confirmed since; hidden, kept for audit
  "tombstoned", // explicitly forgotten (self, or pruned by a configure-grant actor/board)
  "purged", // hard-purge: content overwritten in place, irreversible, audited
] as const;
export type AgentMemoryStatus = (typeof AGENT_MEMORY_STATUSES)[number];

/** Statuses that block/are visited by a new write's ADD-vs-UPDATE decision. */
export const AGENT_MEMORY_LIVE_STATUSES: readonly AgentMemoryStatus[] = ["active", "quarantined"];

/** Default statuses returned by a read path with no explicit status filter. */
export const AGENT_MEMORY_DEFAULT_VISIBLE_STATUSES: readonly AgentMemoryStatus[] = [
  "active",
  "quarantined",
  "disputed",
];

export const AGENT_MEMORY_AUDIT_ACTIONS = [
  "add",
  "update",
  "noop_confirm",
  "dispute",
  "tombstone",
  "quarantine_promote",
  "hard_purge",
  "evict_cap",
  "expire_sweep",
] as const;
export type AgentMemoryAuditAction = (typeof AGENT_MEMORY_AUDIT_ACTIONS)[number];

export const AGENT_MEMORY_ACTOR_TYPES = ["agent", "user", "system"] as const;
export type AgentMemoryActorType = (typeof AGENT_MEMORY_ACTOR_TYPES)[number];

export interface AgentMemoryActor {
  type: AgentMemoryActorType;
  id: string;
  agentId?: string | null;
  runId?: string | null;
}

/** mem0-style decision outcome for a single write. */
export type AgentMemoryWriteDecision = "add" | "update" | "delete_then_add" | "noop";

export interface AgentMemoryEntryRow {
  id: string;
  companyId: string;
  scope: AgentMemoryScope;
  agentId: string | null;
  kind: AgentMemoryKind;
  key: string;
  body: string;
  projectId: string | null;
  status: AgentMemoryStatus;
  version: number;
  sourceRunId: string | null;
  sourceIssueId: string | null;
  createdByAgentId: string;
  sourceTrust: SourceTrustMetadata | null;
  confirmations: number;
  confirmingRunIds: string[];
  accessCount: number;
  lastUsedAt: Date | null;
  lastConfirmedAt: Date;
  expiresAt: Date;
  tombstoneReason: string | null;
  tombstonedByActorType: AgentMemoryActorType | null;
  tombstonedByActorId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentMemoryAuditRow {
  id: string;
  companyId: string;
  entryId: string;
  action: AgentMemoryAuditAction;
  actorType: AgentMemoryActorType;
  actorId: string;
  runId: string | null;
  beforeBody: string | null;
  afterBody: string | null;
  beforeVersion: number | null;
  afterVersion: number | null;
  reason: string | null;
  createdAt: Date;
}

export interface AgentMemoryWriteResult {
  decision: AgentMemoryWriteDecision;
  entry: AgentMemoryEntryRow;
}

/** Fixed placeholder body written in place by a governance hard-purge. */
export const AGENT_MEMORY_PURGED_BODY_PLACEHOLDER = "[purged: content removed by governance action]";
