import { z } from "zod";
import { AGENT_MEMORY_KINDS } from "../types/agent-memory.js";
import { AGENT_MEMORY_BODY_MAX_CHARS, AGENT_MEMORY_KEY_MAX_CHARS } from "../constants.js";

export const agentMemoryKindSchema = z.enum(AGENT_MEMORY_KINDS);

// Lowercase slug: starts alnum, then alnum/`_`/`-`. No uppercase, no spaces
// (deliberately narrower than the generic `token()` helper's charset — a
// memory key is always caller-chosen or sha256-derived, never free text).
export const AGENT_MEMORY_KEY_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

export const agentMemoryWriteInputSchema = z.object({
  kind: agentMemoryKindSchema,
  key: z.string().trim().min(1).max(AGENT_MEMORY_KEY_MAX_CHARS).regex(AGENT_MEMORY_KEY_REGEX),
  body: z.string().trim().min(1).max(AGENT_MEMORY_BODY_MAX_CHARS),
  // "company" scope is schema-ready but its write path is disabled in v1
  // (see packages/db/src/schema/agent_memory_entries.ts); rejecting anything
  // but "agent" here is what disables it.
  scope: z.literal("agent").default("agent"),
  projectId: z.string().guid().optional(),
  supersedes: z.string().guid().optional(), // mem0-style hint: treat as UPDATE of this id
  forget: z.string().guid().optional(), // mem0-style hint: tombstone this id, then ADD
}).strict();
export type AgentMemoryWriteInput = z.infer<typeof agentMemoryWriteInputSchema>;

export const agentMemoryConfirmInputSchema = z.object({
  baseVersion: z.number().int().min(1),
}).strict();
export type AgentMemoryConfirmInput = z.infer<typeof agentMemoryConfirmInputSchema>;

export const agentMemoryDisputeInputSchema = z.object({
  reason: z.string().trim().min(1).max(AGENT_MEMORY_BODY_MAX_CHARS),
}).strict();
export type AgentMemoryDisputeInput = z.infer<typeof agentMemoryDisputeInputSchema>;

export const agentMemoryTombstoneInputSchema = z.object({
  reason: z.string().trim().min(1).max(AGENT_MEMORY_BODY_MAX_CHARS),
}).strict();
export type AgentMemoryTombstoneInput = z.infer<typeof agentMemoryTombstoneInputSchema>;

export const agentMemoryHardPurgeInputSchema = z.object({
  reason: z.string().trim().min(1).max(AGENT_MEMORY_BODY_MAX_CHARS),
}).strict();
export type AgentMemoryHardPurgeInput = z.infer<typeof agentMemoryHardPurgeInputSchema>;
