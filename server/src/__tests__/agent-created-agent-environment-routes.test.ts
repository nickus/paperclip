import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  approvals,
  companies,
  companyMemberships,
  createDb,
  environments,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-created agent environment route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

/**
 * An agent that creates another agent (a hire or a direct create) places it in
 * its own execution environment. A create that names no environment would
 * otherwise fall back to the instance default, which can be the host itself,
 * so an agent confined to an isolated environment could start a new agent
 * outside it.
 */
describeEmbeddedPostgres("environment of agents created by agents", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-created-environment-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Hires and creates both check the environment driver against the adapter,
  // so every agent here uses an adapter that can run in a sandbox environment.
  async function seed(options: { requireBoardApprovalForNewAgents: boolean }) {
    const nonce = randomUUID().slice(0, 8);
    const [isolated, other] = await db
      .insert(environments)
      .values([
        { name: `Isolated ${nonce}`, driver: "sandbox" },
        { name: `Other ${nonce}`, driver: "sandbox" },
      ])
      .returning();
    const [company] = await db
      .insert(companies)
      .values({
        name: `Environment Co ${nonce}`,
        issuePrefix: `EN${nonce.slice(0, 4).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
        requireBoardApprovalForNewAgents: options.requireBoardApprovalForNewAgents,
      })
      .returning();
    const [creator] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Hiring Manager",
        role: "general",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
        defaultEnvironmentId: isolated!.id,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company!.id, agentId: creator!.id, status: "running", contextSnapshot: {} })
      .returning();
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: creator!.id,
      companyId: company!.id,
      runId: run!.id,
      source: "agent_jwt",
    };
    return { company: company!, creator: creator!, isolated: isolated!, other: other!, agentActor };
  }

  async function environmentOf(agentId: string) {
    const [row] = await db
      .select({ defaultEnvironmentId: agents.defaultEnvironmentId })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.defaultEnvironmentId ?? null;
  }

  async function agentCount(companyId: string) {
    return (await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId))).length;
  }

  for (const requireBoardApprovalForNewAgents of [true, false]) {
    it(`places a hire with no environment in the hiring agent's (board approval ${requireBoardApprovalForNewAgents ? "on" : "off"})`, async () => {
      const { company, isolated, agentActor } = await seed({ requireBoardApprovalForNewAgents });
      for (const defaultEnvironmentId of [undefined, null]) {
        const res = await request(createApp(db, agentActor))
          .post(`/api/companies/${company.id}/agent-hires`)
          .send({
            name: `Builder ${String(defaultEnvironmentId)}`,
            role: "engineer",
            adapterType: "codex_local",
            ...(defaultEnvironmentId === undefined ? {} : { defaultEnvironmentId }),
          });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await environmentOf(res.body.agent.id)).toBe(isolated.id);
      }
    });
  }

  it("refuses a hire an agent places in another environment", async () => {
    const { company, other, agentActor } = await seed({ requireBoardApprovalForNewAgents: false });
    const before = await agentCount(company.id);
    const res = await request(createApp(db, agentActor))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Escapee", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: other.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("own execution environment");
    expect(await agentCount(company.id)).toBe(before);
  });

  it("accepts a hire that names the hiring agent's own environment", async () => {
    const { company, isolated, agentActor } = await seed({ requireBoardApprovalForNewAgents: false });
    const res = await request(createApp(db, agentActor))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Teammate", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: isolated.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await environmentOf(res.body.agent.id)).toBe(isolated.id);
  });

  it("applies the same rule to a direct create by an agent", async () => {
    const { company, isolated, other, agentActor } = await seed({ requireBoardApprovalForNewAgents: false });
    const app = createApp(db, agentActor);

    // Direct creates validate the environment against the adapter, so use
    // one that runs in sandboxes.
    const inherited = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "Direct", role: "engineer", adapterType: "codex_local" });
    expect(inherited.status, JSON.stringify(inherited.body)).toBe(201);
    expect(await environmentOf(inherited.body.id)).toBe(isolated.id);

    const refused = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "Direct elsewhere", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: other.id });
    expect(refused.status).toBe(403);
  });

  it("keeps the board's choice of environment", async () => {
    const { company, other } = await seed({ requireBoardApprovalForNewAgents: false });
    const res = await request(createApp(db, {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [company.id],
    }))
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Board pick", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: other.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await environmentOf(res.body.agent.id)).toBe(other.id);
  });
});
