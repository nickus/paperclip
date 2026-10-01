import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres malformed-id route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A malformed (e.g. truncated) UUID in a path parameter must never reach
 * Postgres and 500 — it is client input, not a server fault. These exercise
 * the full stack (route -> service -> real Postgres -> the central error
 * handler) for both an id that is validated up front (the heartbeat run id
 * pattern) and one that previously was not (an issue comment id, which
 * `issueComments.id` stores as a `uuid` column).
 */
describeEmbeddedPostgres("malformed ids in issue routes (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-malformed-id-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueComments),
      () => db.delete(issues),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed() {
    const prefix = `M${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Worker`,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Issue for malformed-id checks",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const actor = { type: "agent", source: "agent_jwt", companyId, agentId, runId: randomUUID() };
    return { companyId, agentId, issueId, actor };
  }

  it.each(["get", "delete", "patch"] as const)(
    "%s /issues/:id/comments/:commentId returns 400 for a truncated comment id instead of 500",
    async (method) => {
      const { issueId, actor } = await seed();
      const truncatedCommentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa"; // missing the last group

      const res = await request(app(actor))[method](
        `/api/issues/${issueId}/comments/${truncatedCommentId}`,
      ).send(method === "patch" ? { body: "irrelevant" } : {});

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toBe("Invalid id: expected a UUID");
    },
  );

  it("GET /issues/:id/comments/:commentId still 404s for a well-formed but unknown comment id", async () => {
    const { issueId, actor } = await seed();

    const res = await request(app(actor)).get(`/api/issues/${issueId}/comments/${randomUUID()}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Comment not found");
  });

  it("GET /issues/:id/comments/:commentId returns a real comment for a valid id unchanged", async () => {
    const { issueId, actor } = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId: actor.companyId as string,
      issueId,
      body: "A real comment",
      authorAgentId: actor.agentId as string,
    });

    const res = await request(app(actor)).get(`/api/issues/${issueId}/comments/${commentId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: commentId, body: "A real comment" });
  });

  it("GET /issues/:id returns 404 (not 500) for a truncated issue id", async () => {
    const { actor } = await seed();
    const truncatedIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa"; // missing the last group

    const res = await request(app(actor)).get(`/api/issues/${truncatedIssueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("GET /issues/:id still works for a valid issue id", async () => {
    const { issueId, actor } = await seed();

    const res = await request(app(actor)).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(issueId);
  });
});
