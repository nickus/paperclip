import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
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
    `Skipping embedded Postgres unbound-run write tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A run woken without a task (an on-demand or timer wake with no issue in its
 * payload) carries a valid run id but no source issue. It must still be able
 * to work a task the normal way: check it out, update it, comment, and close
 * it. Writes to issues it did not check out count against the per-run
 * cross-issue cap like any other run's.
 */
describeEmbeddedPostgres("issue writes from a run without a task (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unbound-run-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueComments),
      () => db.delete(activityLog),
      () => db.delete(agentWakeupRequests),
      () => db.delete(issues),
      () => db.delete(heartbeatRuns),
      () => db.delete(companyMemberships),
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
    const prefix = `U${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      // The wake named no issue, so the run context has none.
      contextSnapshot: { wakeReason: "manual" },
    });
    const [taskIssueId, otherIssueId] = [randomUUID(), randomUUID()];
    await db.insert(issues).values([
      {
        id: taskIssueId,
        companyId,
        identifier: `${prefix}-1`,
        title: "Task the run picks up",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        identifier: `${prefix}-2`,
        title: "Another issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    const actor = { type: "agent", source: "agent_jwt", companyId, agentId, runId };
    return { companyId, agentId, runId, taskIssueId, otherIssueId, actor };
  }

  async function influenceRows(companyId: string, runId: string) {
    return db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)))
      .then((rows) => rows.filter((row) => row.action.startsWith("issue.cross_issue_influence")));
  }

  it("checks out, updates, comments on, and closes its task without touching the cap", async () => {
    const { companyId, runId, taskIssueId, actor } = await seed();
    const api = app(actor);

    const checkout = await request(api)
      .post(`/api/issues/${taskIssueId}/checkout`)
      .send({ agentId: actor.agentId, expectedStatuses: ["todo"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    const comment = await request(api)
      .post(`/api/issues/${taskIssueId}/comments`)
      .send({ body: "Working on it." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    const done = await request(api)
      .patch(`/api/issues/${taskIssueId}`)
      .send({ status: "done", comment: "Finished." });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe("done");

    expect(await influenceRows(companyId, runId)).toEqual([]);
  });

  it("counts a write to an issue it did not check out instead of refusing it", async () => {
    const { companyId, runId, otherIssueId, actor } = await seed();

    const res = await request(app(actor))
      .post(`/api/issues/${otherIssueId}/comments`)
      .send({ body: "A note on a neighbouring issue." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(await influenceRows(companyId, runId)).toEqual([
      { action: "issue.cross_issue_influence_observed", entityId: otherIssueId },
    ]);
  });

  it("takes only the first issue it works as its task; a second checkout is counted", async () => {
    const { companyId, runId, taskIssueId, otherIssueId, actor } = await seed();
    const api = app(actor);

    for (const issueId of [taskIssueId, otherIssueId]) {
      const checkout = await request(api)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId: actor.agentId, expectedStatuses: ["todo"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    }
    for (const issueId of [taskIssueId, otherIssueId, taskIssueId]) {
      const comment = await request(api)
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Progress note." });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    }

    expect(await influenceRows(companyId, runId)).toEqual([
      { action: "issue.cross_issue_influence_observed", entityId: otherIssueId },
    ]);
  });

  it("still refuses a run id that is not the calling agent's", async () => {
    const { otherIssueId, actor } = await seed();

    const res = await request(app({ ...actor, runId: randomUUID() }))
      .post(`/api/issues/${otherIssueId}/comments`)
      .send({ body: "Should not land." });
    expect(res.status).toBe(403);
    expect(res.body.details?.code ?? res.body.code).toBe("cross_issue_influence_run_context_required");
  });
});
