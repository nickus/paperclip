import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentRuntimeState,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  createDb,
  environments,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent update config validation route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * An agent's adapter config is checked the same way when it is created and
 * when it is updated, so a configuration that cannot run is refused up front
 * instead of failing every run at setup.
 */
describeEmbeddedPostgres("agent adapter config validation on update", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-update-config-validation-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretBindings);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySecrets);
    await db.delete(companies);
    await db.delete(environments);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { adapterConfig?: Record<string, unknown> } = {}) {
    const nonce = randomUUID().slice(0, 8);
    const [company] = await db
      .insert(companies)
      .values({
        name: `Config Co ${nonce}`,
        issuePrefix: `CF${nonce.slice(0, 4).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
        requireBoardApprovalForNewAgents: false,
      })
      .returning();
    const [activeSecret, disabledSecret] = await db
      .insert(companySecrets)
      .values([
        { companyId: company!.id, key: `active-${nonce}`, name: `Active ${nonce}`, status: "active" },
        { companyId: company!.id, key: `disabled-${nonce}`, name: `Disabled ${nonce}`, status: "disabled" },
      ])
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Builder",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: options.adapterConfig ?? {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [company!.id],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return { app, company: company!, agent: agent!, activeSecret: activeSecret!, disabledSecret: disabledSecret! };
  }

  async function storedAdapterConfig(agentId: string) {
    const [row] = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId));
    return (row?.adapterConfig ?? {}) as Record<string, unknown>;
  }

  it("refuses to bind a disabled secret on update, naming the variable and the secret state", async () => {
    const { app, agent, disabledSecret } = await seed();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: { SERVICE_TOKEN: { type: "secret_ref", secretId: disabledSecret.id } } } });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("secret_inactive");
    expect(res.body.error).toContain("env.SERVICE_TOKEN");
    expect(res.body.error).toContain("disabled");
    expect((await storedAdapterConfig(agent.id)).env).toBeUndefined();
  });

  it("refuses to bind a disabled secret on create as well", async () => {
    const { app, company, disabledSecret } = await seed();

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({
        name: "New builder",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: { env: { SERVICE_TOKEN: { type: "secret_ref", secretId: disabledSecret.id } } },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("secret_inactive");
  });

  it("binds an active secret on update", async () => {
    const { app, agent, activeSecret } = await seed();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: { SERVICE_TOKEN: { type: "secret_ref", secretId: activeSecret.id } } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedAdapterConfig(agent.id)).env).toMatchObject({
      SERVICE_TOKEN: { type: "secret_ref", secretId: activeSecret.id },
    });
  });

  it("keeps an agent whose stored binding points at a disabled secret editable", async () => {
    const nonce = randomUUID();
    const { app, agent } = await seed();
    const [staleSecret] = await db
      .insert(companySecrets)
      .values({ companyId: agent.companyId, key: `stale-${nonce}`, name: `Stale ${nonce}`, status: "disabled" })
      .returning();
    await db
      .update(agents)
      .set({ adapterConfig: { env: { SERVICE_TOKEN: { type: "secret_ref", secretId: staleSecret!.id, version: "latest" } } } })
      .where(eq(agents.id, agent.id));

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "gpt-5.4" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedAdapterConfig(agent.id)).toMatchObject({ model: "gpt-5.4" });
  });

  it("refuses a model id with surrounding whitespace or a non-string model", async () => {
    const { app, agent } = await seed();

    const padded = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "gpt-5.4\n" } });
    expect(padded.status, JSON.stringify(padded.body)).toBe(422);
    expect(padded.body.code).toBe("invalid_adapter_config");
    expect(padded.body.error).toContain("adapterConfig.model");

    const numeric = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: 5 } });
    expect(numeric.status, JSON.stringify(numeric.body)).toBe(422);
    expect(numeric.body.code).toBe("invalid_adapter_config");

    expect((await storedAdapterConfig(agent.id)).model).toBeUndefined();
  });

  it("accepts a model id that is newer than any model list the server knows", async () => {
    const { app, agent } = await seed();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "gpt-99-preview-2031" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedAdapterConfig(agent.id)).model).toBe("gpt-99-preview-2031");
  });

  it("refuses to move an agent onto an archived environment, like create does", async () => {
    const { app, company, agent } = await seed();
    const [archived, usable] = await db
      .insert(environments)
      .values([
        { name: `Archived ${randomUUID().slice(0, 8)}`, driver: "sandbox", status: "archived" },
        { name: `Usable ${randomUUID().slice(0, 8)}`, driver: "sandbox" },
      ])
      .returning();

    const created = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "Archived pick", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: archived!.id });
    expect(created.status, JSON.stringify(created.body)).toBe(422);
    expect(created.body.error).toBe("Environment is archived.");

    const updated = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ defaultEnvironmentId: archived!.id });
    expect(updated.status, JSON.stringify(updated.body)).toBe(422);
    expect(updated.body.error).toBe("Environment is archived.");

    const moved = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ defaultEnvironmentId: usable!.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  });
});
