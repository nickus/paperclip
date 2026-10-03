import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import {
  resolveAgentMemoryEffectiveMode,
  resolveAgentMemoryInstanceMode,
} from "@paperclipai/adapter-utils/wake-run-brief";
import {
  AGENT_MEMORY_STATUSES,
  agentMemoryConfirmInputSchema,
  agentMemoryDisputeInputSchema,
  agentMemoryHardPurgeInputSchema,
  agentMemoryTombstoneInputSchema,
  agentMemoryWriteInputSchema,
  type AgentMemoryActor,
  type AgentMemoryStatus,
  type AgentMemoryWriteInput,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  AgentMemoryConflictError,
  confirmAgentMemoryEntry,
  disputeAgentMemoryEntry,
  getAgentMemoryEntryById,
  hardPurgeAgentMemoryEntry,
  listAgentMemoryEntries,
  listAgentMemoryEntriesForCompany,
  listPromotionCandidates,
  promoteQuarantinedAgentMemoryEntry,
  resolveAgentMemoryWriteSourceTrust,
  tombstoneAgentMemoryEntry,
  writeAgentMemoryEntry,
} from "../services/agent-memory.js";
import { authorizationDeniedDetails, authorizationService } from "../services/authorization.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";

/**
 * `POST /api/agents/me/memory`'s own validation step (§3.1, §11 of the
 * implementation spec). A plain `validate(agentMemoryWriteInputSchema)`
 * would surface the generic "Validation error" 400 for every rejected
 * field; the spec asks for two specific, agent-facing messages instead
 * (body too long, and the still-disabled "company" scope), so this wraps
 * the same `schema.parse` call `validate()` uses and only overrides the
 * message for those two cases -- any other validation failure (bad key
 * regex, missing kind, etc.) still falls through to the ordinary Zod 400.
 */
function validateAgentMemoryWriteBody(req: Request, _res: Response, next: NextFunction) {
  try {
    req.body = agentMemoryWriteInputSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      if (err.issues.some((issue) => issue.path[0] === "body")) {
        throw badRequest(
          "Memory entries are capped at 300 characters; shorten this to the one fact or gotcha that matters.",
        );
      }
      if (err.issues.some((issue) => issue.path[0] === "scope")) {
        throw badRequest("Company-wide memory scope is not enabled yet; write to your own agent scope.");
      }
    }
    throw err;
  }
  next();
}

function parseAgentMemoryStatusFilter(raw: unknown): AgentMemoryStatus[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    if (!(AGENT_MEMORY_STATUSES as readonly string[]).includes(value)) {
      throw badRequest(`Invalid status filter: "${value}". Expected one of: ${AGENT_MEMORY_STATUSES.join(", ")}.`);
    }
  }
  return values as AgentMemoryStatus[];
}

function parseAgentMemoryListLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw badRequest("limit must be a positive integer.");
  return Math.min(Math.floor(parsed), 200);
}

/** Maps the authenticated request actor onto the service's actor shape (§3.2). */
function agentMemoryActorFromRequest(req: Request): AgentMemoryActor {
  if (req.actor.type === "agent") {
    return {
      type: "agent",
      id: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }
  return {
    type: "user",
    id: req.actor.userId ?? "board",
    agentId: null,
    runId: null,
  };
}

/**
 * Governance grant used by §8.3's three routes: an agent actor holding
 * `agents:configure`, or any board actor (owner decision: "a human board
 * member can hold" the same grant an agent governance run holds -- the
 * route layer admits every board actor rather than routing a board user
 * through the permission-grant table the way an agent is, since nothing
 * in the spec asks for a narrower board-side gate here). `assertCompanyAccess`
 * still enforces active membership and (for a board actor, on this
 * mutating method) non-viewer access before either branch is reached.
 */
async function assertAgentMemoryGovernanceAccess(db: Db, req: Request, companyId: string) {
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "board") return;
  const decision = await authorizationService(db).decide({
    actor: req.actor,
    action: "agents:configure",
    resource: { type: "company", companyId },
  });
  if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
}

function respondToAgentMemoryConflict(res: Response, error: AgentMemoryConflictError) {
  res.status(409).json({ error: error.message, currentEntry: error.currentEntry });
}

/**
 * The writing agent's effective memory mode (instance kill switch narrowed by
 * the agent's own `runtimeConfig.agentMemory.mode`, opt-in per agent).
 */
async function loadAgentMemoryEffectiveMode(db: Db, companyId: string, agentId: string) {
  const runtimeConfig = await db
    .select({ runtimeConfig: agents.runtimeConfig })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0]?.runtimeConfig ?? null);
  const agentMemory = (runtimeConfig as Record<string, unknown> | null)?.agentMemory;
  return resolveAgentMemoryEffectiveMode({
    instanceMode: resolveAgentMemoryInstanceMode(),
    agentRuntimeConfigMode:
      agentMemory && typeof agentMemory === "object" ? (agentMemory as Record<string, unknown>).mode : undefined,
  });
}

export function agentMemoryRoutes(db: Db) {
  const router = Router();

  // --- §8.1 Agent-self routes -------------------------------------------

  router.get("/agents/me/memory", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw unauthorized("Agent authentication required");
    }
    const status = parseAgentMemoryStatusFilter(req.query.status);
    const limit = parseAgentMemoryListLimit(req.query.limit);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await listAgentMemoryEntries({
      db,
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      status,
      limit,
      cursor,
    });
    res.json(result);
  });

  router.post("/agents/me/memory", validateAgentMemoryWriteBody, async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw unauthorized("Agent authentication required");
    }
    const companyId = req.actor.companyId;
    const agentId = req.actor.agentId;
    const runId = req.actor.runId ?? null;
    const body = req.body as AgentMemoryWriteInput;

    // A write that would never be shown or kept in use is refused with a
    // plain reason instead of being stored silently.
    if ((await loadAgentMemoryEffectiveMode(db, companyId, agentId)) === "off") {
      throw conflict(
        "Agent memory is off for you, so nothing was stored. This is not an error in your work: carry on without it, and do not retry.",
        { code: "agent_memory_off" },
      );
    }

    const { sourceIssueId, sourceTrust } = await resolveAgentMemoryWriteSourceTrust(db, { companyId, agentId, runId });

    try {
      const result = await writeAgentMemoryEntry({
        db,
        companyId,
        agentId,
        actor: { type: "agent", id: agentId, agentId, runId },
        sourceIssueId,
        sourceTrust,
        candidate: { kind: body.kind, key: body.key, body: body.body, projectId: body.projectId ?? null },
        hints: { supersedes: body.supersedes ?? null, forget: body.forget ?? null },
      });
      // §8.1: 201 on add/update (delete-then-add also lands a new row), 200 on noop.
      res.status(result.decision === "noop" ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof AgentMemoryConflictError) {
        respondToAgentMemoryConflict(res, error);
        return;
      }
      throw error;
    }
  });

  router.patch("/agent-memory/:id/confirm", validate(agentMemoryConfirmInputSchema), async (req, res) => {
    if (req.actor.type !== "agent" && req.actor.type !== "board") throw unauthorized();
    const entry = await getAccessibleResource(
      req,
      res,
      getAgentMemoryEntryById(db, req.params.id as string),
      "Memory entry not found",
    );
    if (!entry) return;

    const isOwner = req.actor.type === "agent" && req.actor.agentId === entry.createdByAgentId;
    if (!isOwner && req.actor.type !== "board") {
      const decision = await authorizationService(db).decide({
        actor: req.actor,
        action: "agents:configure",
        resource: { type: "company", companyId: entry.companyId },
      });
      if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }

    try {
      const updated = await confirmAgentMemoryEntry({
        db,
        companyId: entry.companyId,
        id: entry.id,
        actor: agentMemoryActorFromRequest(req),
        baseVersion: req.body.baseVersion,
      });
      res.json(updated);
    } catch (error) {
      if (error instanceof AgentMemoryConflictError) {
        respondToAgentMemoryConflict(res, error);
        return;
      }
      throw error;
    }
  });

  router.patch("/agent-memory/:id/dispute", validate(agentMemoryDisputeInputSchema), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized("Agent authentication required");
    const entry = await getAccessibleResource(
      req,
      res,
      getAgentMemoryEntryById(db, req.params.id as string),
      "Memory entry not found",
    );
    if (!entry) return;
    const updated = await disputeAgentMemoryEntry({
      db,
      companyId: entry.companyId,
      id: entry.id,
      actor: agentMemoryActorFromRequest(req),
      reason: req.body.reason,
    });
    res.json(updated);
  });

  router.patch("/agent-memory/:id/tombstone", validate(agentMemoryTombstoneInputSchema), async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized("Agent authentication required");
    const entry = await getAccessibleResource(
      req,
      res,
      getAgentMemoryEntryById(db, req.params.id as string),
      "Memory entry not found",
    );
    if (!entry) return;

    let requireOwnEntry = true;
    if (req.actor.agentId !== entry.createdByAgentId) {
      const decision = await authorizationService(db).decide({
        actor: req.actor,
        action: "agents:configure",
        resource: { type: "company", companyId: entry.companyId },
      });
      requireOwnEntry = !decision.allowed;
    }

    const updated = await tombstoneAgentMemoryEntry({
      db,
      companyId: entry.companyId,
      id: entry.id,
      actor: agentMemoryActorFromRequest(req),
      reason: req.body.reason,
      requireOwnEntry,
    });
    res.json(updated);
  });

  // --- §8.2 Board routes --------------------------------------------------

  router.get("/companies/:companyId/agent-memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
    const status = parseAgentMemoryStatusFilter(req.query.status);
    const limit = parseAgentMemoryListLimit(req.query.limit);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await listAgentMemoryEntriesForCompany({ db, companyId, agentId, status, limit, cursor });
    res.json(result);
  });

  router.patch("/companies/:companyId/agent-memory/:id/tombstone", validate(agentMemoryTombstoneInputSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const updated = await tombstoneAgentMemoryEntry({
      db,
      companyId,
      id: req.params.id as string,
      actor: agentMemoryActorFromRequest(req),
      reason: req.body.reason,
      requireOwnEntry: false,
    });
    res.json(updated);
  });

  // --- §8.3 Governance routes ----------------------------------------------

  router.get("/companies/:companyId/agent-memory/promotion-candidates", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertAgentMemoryGovernanceAccess(db, req, companyId);
    const minConfirmationsRaw = typeof req.query.minConfirmations === "string" ? Number(req.query.minConfirmations) : undefined;
    if (minConfirmationsRaw !== undefined && (!Number.isFinite(minConfirmationsRaw) || minConfirmationsRaw < 1)) {
      throw badRequest("minConfirmations must be a positive integer.");
    }
    const entries = await listPromotionCandidates({ db, companyId, minConfirmations: minConfirmationsRaw });
    res.json({ entries });
  });

  router.patch("/companies/:companyId/agent-memory/:id/promote-quarantined", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertAgentMemoryGovernanceAccess(db, req, companyId);
    const updated = await promoteQuarantinedAgentMemoryEntry({
      db,
      companyId,
      id: req.params.id as string,
      actor: agentMemoryActorFromRequest(req),
    });
    res.json(updated);
  });

  router.patch("/companies/:companyId/agent-memory/:id/hard-purge", validate(agentMemoryHardPurgeInputSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertAgentMemoryGovernanceAccess(db, req, companyId);
    const updated = await hardPurgeAgentMemoryEntry({
      db,
      companyId,
      id: req.params.id as string,
      actor: agentMemoryActorFromRequest(req),
      reason: req.body.reason,
    });
    res.json(updated);
  });

  return router;
}
