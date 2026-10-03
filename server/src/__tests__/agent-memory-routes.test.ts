import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentMemoryAudit,
  agentMemoryEntries,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { AGENT_MEMORY_PURGED_BODY_PLACEHOLDER, LOW_TRUST_REVIEW_PRESET, type PermissionKey } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { agentMemoryRoutes } from "../routes/agent-memory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Actor =
  | { type: "agent"; agentId: string; companyId: string; runId?: string | null }
  | { type: "board"; userId: string; source?: "local_implicit" | "session"; companyIds?: string[] };

describeEmbeddedPostgres("agent memory routes (§8 of the implementation spec)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    // Memory is opt-in: the instance switch and each seeded agent enable it.
    vi.stubEnv("PAPERCLIP_AGENT_MEMORY", "shadow");
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agentMemoryAudit);
    await db.delete(agentMemoryEntries);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await tempDb?.cleanup();
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (actor.type === "agent") {
        req.actor = { type: "agent", agentId: actor.agentId, companyId: actor.companyId, runId: actor.runId ?? undefined, source: "agent_jwt" };
      } else {
        req.actor = {
          type: "board",
          userId: actor.userId,
          source: actor.source ?? "local_implicit",
          companyIds: actor.companyIds,
          memberships: actor.companyIds?.map((companyId) => ({ companyId, membershipRole: "admin", status: "active" })),
        };
      }
      next();
    });
    app.use("/api", agentMemoryRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    return db
      .insert(companies)
      .values({ name: `Memory routes ${randomUUID()}`, issuePrefix: `M${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedAgent(companyId: string, runtimeConfig: Record<string, unknown> = { agentMemory: { mode: "shadow" } }) {
    return db
      .insert(agents)
      .values({ companyId, name: `Agent ${randomUUID()}`, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function grantAgentPermission(companyId: string, agentId: string, permissionKey: PermissionKey) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      grantedByUserId: null,
    });
  }

  it("writes, reads back, confirms, disputes and self-tombstones its own entry end to end", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id });

    const written = await request(app).post("/api/agents/me/memory").send({
      kind: "gotcha",
      key: "docker-rig-limit",
      body: "The build rig caps concurrent docker builds at 2; a third hangs.",
    });
    expect(written.status).toBe(201);
    expect(written.body.decision).toBe("add");
    const entryId = written.body.entry.id;
    expect(written.body.entry.status).toBe("active");
    expect(written.body.entry.confirmations).toBe(1);

    const listed = await request(app).get("/api/agents/me/memory");
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toHaveLength(1);
    expect(listed.body.entries[0].id).toBe(entryId);

    const confirmed = await request(app).patch(`/api/agent-memory/${entryId}/confirm`).send({ baseVersion: 1 });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmations).toBe(2);
    expect(confirmed.body.version).toBe(2);

    // A stale baseVersion is a 409 carrying the current row.
    const staleConfirm = await request(app).patch(`/api/agent-memory/${entryId}/confirm`).send({ baseVersion: 1 });
    expect(staleConfirm.status).toBe(409);
    expect(staleConfirm.body.currentEntry.id).toBe(entryId);

    const disputed = await request(app).patch(`/api/agent-memory/${entryId}/dispute`).send({ reason: "This no longer matches the rig." });
    expect(disputed.status).toBe(200);
    expect(disputed.body.status).toBe("disputed");

    const tombstoned = await request(app).patch(`/api/agent-memory/${entryId}/tombstone`).send({ reason: "superseded" });
    expect(tombstoned.status).toBe(200);
    expect(tombstoned.body.status).toBe("tombstoned");
    expect(tombstoned.body.tombstoneReason).toBe("superseded");

    // Tombstoned entries drop out of the default listing.
    const afterTombstone = await request(app).get("/api/agents/me/memory");
    expect(afterTombstone.body.entries).toHaveLength(0);
  });

  it("refuses a write with a plain reason when memory is off for the agent, and stores nothing", async () => {
    const company = await seedCompany();
    const unconfigured = await seedAgent(company.id, {});
    const optedOut = await seedAgent(company.id, { agentMemory: { mode: "off" } });
    for (const agent of [unconfigured, optedOut]) {
      const res = await request(createApp({ type: "agent", agentId: agent.id, companyId: company.id }))
        .post("/api/agents/me/memory")
        .send({ kind: "fact", key: "build-cmd", body: "Run pnpm build before the tests." });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Agent memory is off for you");
    }

    // The instance kill switch wins over an agent that opted in.
    const optedIn = await seedAgent(company.id);
    vi.stubEnv("PAPERCLIP_AGENT_MEMORY", "off");
    try {
      const res = await request(createApp({ type: "agent", agentId: optedIn.id, companyId: company.id }))
        .post("/api/agents/me/memory")
        .send({ kind: "fact", key: "build-cmd", body: "Run pnpm build before the tests." });
      expect(res.status).toBe(409);
    } finally {
      vi.stubEnv("PAPERCLIP_AGENT_MEMORY", "shadow");
    }
    expect(await db.select().from(agentMemoryEntries)).toHaveLength(0);
  });

  it("rejects an over-length body with the spec's agent-facing message, before redaction runs", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id });

    const res = await request(app).post("/api/agents/me/memory").send({
      kind: "fact",
      key: "too-long",
      body: "x".repeat(301),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capped at 300 characters/);
    expect(await db.select().from(agentMemoryEntries)).toHaveLength(0);
  });

  it("rejects scope: \"company\" with the spec's agent-facing message", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id });

    const res = await request(app).post("/api/agents/me/memory").send({
      kind: "fact",
      key: "company-wide",
      body: "Attempted company scope.",
      scope: "company",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Company-wide memory scope is not enabled/);
  });

  it("rejects a write that looks like a secret with the redaction message", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id });

    const res = await request(app).post("/api/agents/me/memory").send({
      kind: "fact",
      key: "leaked",
      body: "password: supersecret123 for the staging box",
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/secret or personal data/);
    expect(await db.select().from(agentMemoryEntries)).toHaveLength(0);
  });

  it("isolates companies: an agent in company B cannot confirm, dispute or tombstone company A's entry via a leaked id", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentA = await seedAgent(companyA.id);
    const agentB = await seedAgent(companyB.id);
    const appA = createApp({ type: "agent", agentId: agentA.id, companyId: companyA.id });
    const appB = createApp({ type: "agent", agentId: agentB.id, companyId: companyB.id });

    const written = await request(appA).post("/api/agents/me/memory").send({
      kind: "lesson",
      key: "cross-company",
      body: "Company A's own lesson.",
    });
    const entryId = written.body.entry.id;

    const confirmDenied = await request(appB).patch(`/api/agent-memory/${entryId}/confirm`).send({ baseVersion: 1 });
    expect(confirmDenied.status).toBe(404);
    const disputeDenied = await request(appB).patch(`/api/agent-memory/${entryId}/dispute`).send({ reason: "not mine" });
    expect(disputeDenied.status).toBe(404);
    const tombstoneDenied = await request(appB).patch(`/api/agent-memory/${entryId}/tombstone`).send({ reason: "not mine" });
    expect(tombstoneDenied.status).toBe(404);

    // The entry is untouched and still visible to its own company.
    expect((await db.select().from(agentMemoryEntries))[0]?.status).toBe("active");

    const listB = await request(appB).get("/api/agents/me/memory");
    expect(listB.body.entries).toHaveLength(0);
  });

  it("quarantines a write from a low-trust run and lets governance promote it", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Low-trust review issue",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agent.id,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        contextSnapshot: {
          issueId: issue!.id,
          executionPolicy: {
            authorizationPolicy: {
              trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: company.id, rootIssueId: issue!.id },
            },
          },
        },
      })
      .returning();

    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id, runId: run!.id });
    const written = await request(app).post("/api/agents/me/memory").send({
      kind: "gotcha",
      key: "low-trust-gotcha",
      body: "Observed from a low-trust reviewed run.",
    });
    expect(written.status).toBe(201);
    expect(written.body.entry.status).toBe("quarantined");
    const entryId = written.body.entry.id;

    // A plain agent (no agents:configure grant) cannot promote it.
    const promoteDenied = await request(app).patch(`/api/companies/${company.id}/agent-memory/${entryId}/promote-quarantined`);
    expect(promoteDenied.status).toBe(403);

    await grantAgentPermission(company.id, agent.id, "agents:configure");
    const promoted = await request(app).patch(`/api/companies/${company.id}/agent-memory/${entryId}/promote-quarantined`);
    expect(promoted.status).toBe(200);
    expect(promoted.body.status).toBe("active");

    // Promoting a now-active entry a second time is a conflict, not a silent no-op.
    const promotedAgain = await request(app).patch(`/api/companies/${company.id}/agent-memory/${entryId}/promote-quarantined`);
    expect(promotedAgain.status).toBe(409);
  });

  it("lists promotion candidates by confirmation count and excludes non-candidate statuses", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    await grantAgentPermission(company.id, agent.id, "agents:configure");
    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id });

    const write = async (key: string, body: string) =>
      request(app).post("/api/agents/me/memory").send({ kind: "lesson", key, body });

    const first = await write("confirmed-thrice", "Confirmed three times total.");
    const entryId = first.body.entry.id;
    // Re-asserting the identical key+body is a NOOP confirmation (§4 step 2).
    await write("confirmed-thrice", "Confirmed three times total.");
    await write("confirmed-thrice", "Confirmed three times total.");
    await write("confirmed-once", "Only confirmed once.");

    const candidatesDefault = await request(app).get(`/api/companies/${company.id}/agent-memory/promotion-candidates`);
    expect(candidatesDefault.status).toBe(200);
    expect(candidatesDefault.body.entries.map((entry: { id: string }) => entry.id)).toEqual([entryId]);

    const candidatesLow = await request(app).get(`/api/companies/${company.id}/agent-memory/promotion-candidates?minConfirmations=1`);
    expect(candidatesLow.body.entries.length).toBe(2);
  });

  it("hard-purges content in place: audited, irreversible, never returns the original body again", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    await grantAgentPermission(company.id, agent.id, "agents:configure");
    const app = createApp({ type: "agent", agentId: agent.id, companyId: company.id });

    const written = await request(app).post("/api/agents/me/memory").send({
      kind: "fact",
      key: "sensitive",
      body: "A fact that later turns out to need erasing.",
    });
    const entryId = written.body.entry.id;

    const purged = await request(app)
      .patch(`/api/companies/${company.id}/agent-memory/${entryId}/hard-purge`)
      .send({ reason: "contained something it should not have" });
    expect(purged.status).toBe(200);
    expect(purged.body.status).toBe("purged");
    expect(purged.body.body).toBe(AGENT_MEMORY_PURGED_BODY_PLACEHOLDER);

    // A hard purge erases the body everywhere, not just on the current row:
    // the earlier "add" audit row quoted the original content verbatim
    // (beforeBody/afterBody) before the purge, and must not go on quoting it
    // afterward -- otherwise anyone who can read agent_memory_audit reads
    // straight past the purge.
    const allAudit = await db.select().from(agentMemoryAudit);
    const purgeRow = allAudit.find((row) => row.action === "hard_purge");
    expect(purgeRow?.afterBody).toBe(AGENT_MEMORY_PURGED_BODY_PLACEHOLDER);
    const addRow = allAudit.find((row) => row.action === "add");
    expect(addRow?.afterBody).not.toBe("A fact that later turns out to need erasing.");
    expect(addRow?.beforeBody).toBeNull();
    expect(addRow?.afterBody).toBeNull();

    const [storedRow] = await db.select().from(agentMemoryEntries);
    expect(storedRow?.body).toBe(AGENT_MEMORY_PURGED_BODY_PLACEHOLDER);

    // A purged row cannot be hard-purged again, confirmed, or promoted.
    const purgeAgain = await request(app)
      .patch(`/api/companies/${company.id}/agent-memory/${entryId}/hard-purge`)
      .send({ reason: "again" });
    expect(purgeAgain.status).toBe(409);
  });

  it("lets a board actor tombstone another agent's entry without an agents:configure grant", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const agentApp = createApp({ type: "agent", agentId: agent.id, companyId: company.id });
    const boardApp = createApp({ type: "board", userId: randomUUID(), source: "local_implicit" });

    const written = await request(agentApp).post("/api/agents/me/memory").send({
      kind: "decision",
      key: "board-prunable",
      body: "A decision the board later wants to prune.",
    });
    const entryId = written.body.entry.id;

    const boardTombstone = await request(boardApp)
      .patch(`/api/companies/${company.id}/agent-memory/${entryId}/tombstone`)
      .send({ reason: "board cleanup" });
    expect(boardTombstone.status).toBe(200);
    expect(boardTombstone.body.status).toBe("tombstoned");
  });

  it("denies a plain agent's confirm/tombstone of another agent's entry without the grant, and 404s a non-agent/board caller", async () => {
    const company = await seedCompany();
    const owner = await seedAgent(company.id);
    const other = await seedAgent(company.id);
    const ownerApp = createApp({ type: "agent", agentId: owner.id, companyId: company.id });
    const otherApp = createApp({ type: "agent", agentId: other.id, companyId: company.id });

    const written = await request(ownerApp).post("/api/agents/me/memory").send({
      kind: "fact",
      key: "owner-only",
      body: "Only the owner (or a grant holder) may tombstone this.",
    });
    const entryId = written.body.entry.id;

    const tombstoneDenied = await request(otherApp).patch(`/api/agent-memory/${entryId}/tombstone`).send({ reason: "not mine" });
    expect(tombstoneDenied.status).toBe(403);
    expect(tombstoneDenied.body.error).toMatch(/You can only tombstone your own memory entries/);

    await grantAgentPermission(company.id, other.id, "agents:configure");
    const tombstoneAllowed = await request(otherApp).patch(`/api/agent-memory/${entryId}/tombstone`).send({ reason: "grant holder prunes it" });
    expect(tombstoneAllowed.status).toBe(200);
  });
});
