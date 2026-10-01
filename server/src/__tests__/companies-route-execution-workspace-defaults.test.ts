import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company execution workspace defaults tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company execution workspace defaults route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-workspace-defaults-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api/companies", companyRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  const boardActor = {
    type: "board",
    userId: "local-board",
    companyIds: [],
    memberships: [],
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Defaults Co",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    return companyId;
  }

  async function storedDefaults(companyId: string) {
    return await db
      .select({ executionWorkspaceDefaults: companies.executionWorkspaceDefaults })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.executionWorkspaceDefaults);
  }

  it("starts with no company default", async () => {
    const companyId = await seedCompany();

    const res = await request(createApp(boardActor)).get(`/api/companies/${companyId}`);

    expect(res.status).toBe(200);
    expect(res.body.executionWorkspaceDefaults).toEqual({});
  });

  it("persists a board update and returns it on later reads", async () => {
    const companyId = await seedCompany();
    const app = createApp(boardActor);

    const patched = await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ executionWorkspaceDefaults: { sharedWorkspaceConcurrency: "allow" } });

    expect(patched.status).toBe(200);
    expect(patched.body.executionWorkspaceDefaults).toEqual({ sharedWorkspaceConcurrency: "allow" });
    expect(await storedDefaults(companyId)).toEqual({ sharedWorkspaceConcurrency: "allow" });

    const read = await request(app).get(`/api/companies/${companyId}`);
    expect(read.status).toBe(200);
    expect(read.body.executionWorkspaceDefaults).toEqual({ sharedWorkspaceConcurrency: "allow" });

    // An unrelated update leaves the stored default alone.
    const renamed = await request(app).patch(`/api/companies/${companyId}`).send({ description: "Updated" });
    expect(renamed.status).toBe(200);
    expect(await storedDefaults(companyId)).toEqual({ sharedWorkspaceConcurrency: "allow" });
  });

  it("clears the company default with an empty object", async () => {
    const companyId = await seedCompany();
    const app = createApp(boardActor);
    await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ executionWorkspaceDefaults: { sharedWorkspaceConcurrency: "serialize" } })
      .expect(200);

    const cleared = await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ executionWorkspaceDefaults: {} });

    expect(cleared.status).toBe(200);
    expect(cleared.body.executionWorkspaceDefaults).toEqual({});
    expect(await storedDefaults(companyId)).toEqual({});
  });

  it.each([
    { sharedWorkspaceConcurrency: "parallel" },
    { sharedWorkspaceConcurrency: null },
    { sharedWorkspaceConcurency: "allow" },
  ])("rejects an invalid board update %j without changing the stored default", async (value) => {
    const companyId = await seedCompany();
    const app = createApp(boardActor);
    await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ executionWorkspaceDefaults: { sharedWorkspaceConcurrency: "serialize" } })
      .expect(200);

    const res = await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ executionWorkspaceDefaults: value });

    expect(res.status).toBe(400);
    expect(await storedDefaults(companyId)).toEqual({ sharedWorkspaceConcurrency: "serialize" });
  });

  it("does not let a CEO agent change the company default", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: randomUUID(),
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ executionWorkspaceDefaults: { sharedWorkspaceConcurrency: "allow" } });

    expect(res.status).toBe(400);
    expect(await storedDefaults(companyId)).toEqual({});
  });
});
