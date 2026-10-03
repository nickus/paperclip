import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

// Status/kind/scope value sets are owned by @paperclipai/shared (see
// packages/shared/src/types/agent-memory.ts), matching the convention every
// other status-bearing table in this directory follows (plain `text()`
// columns here, enum typing and validation at the service/validator layer).
export const agentMemoryEntries = pgTable(
  "agent_memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    scope: text("scope").notNull().default("agent"), // "agent" | "company" (company disabled in v1 at the service layer)
    agentId: uuid("agent_id").references(() => agents.id), // null only for scope="company" (disabled)

    kind: text("kind").notNull(), // "gotcha" | "lesson" | "fact" | "decision"
    key: text("key").notNull(), // slug, <= 64 chars, caller-chosen or derived from content
    body: text("body").notNull(), // <= 300 chars, redacted before insert
    projectId: uuid("project_id"), // optional ranking hint; no FK enforcement across companies

    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1), // CAS token; bumped on every UPDATE/confirm

    // Provenance (server-filled from the run token; never client-supplied).
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id),
    createdByAgentId: uuid("created_by_agent_id").notNull().references(() => agents.id),
    sourceTrust: jsonb("source_trust").$type<Record<string, unknown> | null>(), // SourceTrustMetadata | null; non-null => quarantined on insert

    // Confirmations / use (ADD-vs-UPDATE decision input and decay-by-disuse ranking input).
    confirmations: integer("confirmations").notNull().default(1),
    confirmingRunIds: jsonb("confirming_run_ids").$type<string[]>().notNull().default([]), // capped at 10
    accessCount: integer("access_count").notNull().default(0), // incremented each time the entry is read into a brief
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // default now()+14d; reset on confirm
    tombstoneReason: text("tombstone_reason"), // required when status=tombstoned
    tombstonedByActorType: text("tombstoned_by_actor_type"), // "agent" | "user" | "system"
    tombstonedByActorId: text("tombstoned_by_actor_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One active/quarantined/disputed row per (company, scope, agent, key).
    // A second "same key" write is a confirm/revise, never a second active row.
    companyScopeAgentKeyActiveUq: uniqueIndex("agent_memory_company_scope_agent_key_active_uq")
      .on(table.companyId, table.scope, table.agentId, table.key)
      .where(sql`${table.status} in ('active','quarantined','disputed')`),
    companyAgentStatusIdx: index("agent_memory_company_agent_status_idx")
      .on(table.companyId, table.agentId, table.status),
    companyAgentExpiresIdx: index("agent_memory_company_agent_expires_idx")
      .on(table.companyId, table.agentId, table.expiresAt),
    bodyTrgmIdx: index("agent_memory_body_trgm_idx").using("gin", table.body.op("gin_trgm_ops")),
    sourceRunIdx: index("agent_memory_source_run_idx").on(table.sourceRunId),
  }),
);

export const agentMemoryAudit = pgTable(
  "agent_memory_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    entryId: uuid("entry_id").notNull().references(() => agentMemoryEntries.id),
    action: text("action").notNull(), // "add" | "update" | "noop_confirm" | "dispute" | "tombstone" | "quarantine_promote" | "hard_purge" | "evict_cap" | "expire_sweep"
    actorType: text("actor_type").notNull(), // "agent" | "user" | "system"
    actorId: text("actor_id").notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    beforeBody: text("before_body"), // null on "add"
    afterBody: text("after_body"), // null on "tombstone"/"hard_purge" terminal state cleanup
    beforeVersion: integer("before_version"),
    afterVersion: integer("after_version"),
    reason: text("reason"), // tombstone/dispute/purge reason; null for add/update
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEntryIdx: index("agent_memory_audit_company_entry_idx").on(table.companyId, table.entryId),
    companyCreatedIdx: index("agent_memory_audit_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
