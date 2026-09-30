import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

type AdapterContext = { runId: string; agent: { id: string }; context?: Record<string, unknown> };
type AdapterResult = {
  exitCode: number;
  signal: null;
  timedOut: boolean;
  errorMessage: string | null;
  summary: string;
  provider: string;
  model: string;
};

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterContext): Promise<AdapterResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Reassignment route test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue reassignment route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER_ID = "board-owner";

function succeeded(summary: string): AdapterResult {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary, provider: "test", model: "test-model" };
}

// An agent's run often ends its turn by handing the task to someone else
// (PATCH /api/issues/:id with a new assignee, usually with a comment). That
// run is finishing its work, not being preempted: it must keep running, end
// with its own outcome, and let the new assignee start once it is done.
describeEmbeddedPostgres("issue reassignment from the assignee's own run", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Map<string, ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-reassignment-own-run-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    // Exercise the direct (legacy) adapter execution path.
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(authUsers).values({
      id: BOARD_USER_ID,
      name: "Board Owner",
      email: "board-owner@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 30_000);

  afterEach(async () => {
    for (const [runId, child] of children) {
      runningProcesses.delete(runId);
      child.kill();
    }
    children.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => succeeded("Reassignment route test run."));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await tempDb?.cleanup();
  });

  function boardActor(companyId: string) {
    return {
      type: "board",
      userId: BOARD_USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const builderId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: BOARD_USER_ID,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: BOARD_USER_ID,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const agentRow = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agents).values([agentRow(builderId, "Builder"), agentRow(reviewerId, "Reviewer")]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build, then hand over",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderId,
      createdByUserId: BOARD_USER_ID,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, builderId, reviewerId, issueId };
  }

  async function runsFor(agentId: string, issueId: string) {
    return db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
    ));
  }

  async function wakesFor(agentId: string, issueId: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    ));
  }

  async function recoveryActionsFor(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  /**
   * Starts the builder's run and lets its adapter perform `handOff` mid-run.
   * `nextTurn`, if given, is the next adapter turn (the new assignee's).
   */
  async function runBuilderThatHandsOff(
    seeded: Awaited<ReturnType<typeof seed>>,
    handOff: (runId: string) => Promise<void>,
    nextTurn?: (ctx: AdapterContext) => Promise<void>,
    builderOutcome: AdapterResult = succeeded("Handed the task over."),
  ) {
    let builderRunId: string | null = null;
    mockAdapterExecute.mockImplementationOnce(async (ctx) => {
      builderRunId = ctx.runId;
      await handOff(ctx.runId);
      return builderOutcome;
    });
    if (nextTurn) {
      mockAdapterExecute.mockImplementationOnce(async (ctx) => {
        await nextTurn(ctx);
        return succeeded("Reviewed the task.");
      });
    }
    const queued = await heartbeat.wakeup(seeded.builderId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: seeded.issueId },
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
    });
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(builderRunId).toBe(queued!.id);
    return queued!.id;
  }

  it("keeps the run that hands its task to another agent, then starts the new assignee after it finishes", async () => {
    const seeded = await seed();
    let handOffStatus = 0;
    let handOffBody: unknown = null;

    const builderRunId = await runBuilderThatHandsOff(seeded, async (runId) => {
      const res = await request(createApp(agentActor(seeded.companyId, seeded.builderId, runId)))
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ assigneeAgentId: seeded.reviewerId, comment: "Implementation is done; please review." });
      handOffStatus = res.status;
      handOffBody = res.body;

      // The handing-off run is still live after its own request returns.
      const [live] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(live).toMatchObject({ status: "running", errorCode: null });
      // The new assignee's wake waits behind it instead of starting beside it.
      await vi.waitFor(async () => {
        const [parked] = await wakesFor(seeded.reviewerId, seeded.issueId);
        expect(parked).toMatchObject({ status: "deferred_issue_execution", runId: null });
      });
      expect(await runsFor(seeded.reviewerId, seeded.issueId)).toHaveLength(0);
    }, async (ctx) => {
      // The reviewer's turn starts only after the builder's run has finished.
      expect(ctx.agent.id).toBe(seeded.reviewerId);
      const [builderRun] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, seeded.builderId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${seeded.issueId}`,
      ));
      expect(builderRun).toMatchObject({ status: "succeeded" });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    });

    expect(handOffStatus, JSON.stringify(handOffBody)).toBe(200);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, builderRunId));
    expect(finished).toMatchObject({ status: "succeeded", errorCode: null });

    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task).toMatchObject({ assigneeAgentId: seeded.reviewerId });

    // The run's normal release promoted the new assignee's wake exactly once.
    const reviewerRuns = await runsFor(seeded.reviewerId, seeded.issueId);
    expect(reviewerRuns).toHaveLength(1);
    expect(reviewerRuns[0]).toMatchObject({ status: "succeeded" });
    expect(reviewerRuns[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_assigned" });
    const reviewerWakes = await wakesFor(seeded.reviewerId, seeded.issueId);
    expect(reviewerWakes.map((wake) => wake.status)).not.toContain("deferred_issue_execution");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);

    expect(await recoveryActionsFor(seeded.issueId)).toHaveLength(0);
  });

  it("starts the new assignee after a handing-off run that fails later, without a recovery hold", async () => {
    const seeded = await seed();
    // An adapter without conversation continuation: its failed runs need
    // reconciliation while their agent still owns the task.
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.companyId, seeded.companyId));
    let handOffStatus = 0;
    let handOffBody: unknown = null;
    const builderRunId = await runBuilderThatHandsOff(seeded, async (runId) => {
      const res = await request(createApp(agentActor(seeded.companyId, seeded.builderId, runId)))
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ assigneeAgentId: seeded.reviewerId, comment: "Implementation is done; please review." });
      handOffStatus = res.status;
      handOffBody = res.body;
      await vi.waitFor(async () => {
        const [parked] = await wakesFor(seeded.reviewerId, seeded.issueId);
        expect(parked).toMatchObject({ status: "deferred_issue_execution" });
      });
    }, async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    }, { ...succeeded("Provider exited after the hand-off."), exitCode: 1, errorMessage: "provider exited with code 1" });

    expect(handOffStatus, JSON.stringify(handOffBody)).toBe(200);
    // The run keeps its own outcome.
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, builderRunId));
    expect(finished).toMatchObject({ status: "failed" });
    expect(finished!.errorCode).not.toBe("issue_reassigned");
    // The task is no longer the failed run's, so nothing is held for it and
    // the new assignee's wake does not wait for a reconciliation that never comes.
    expect(await recoveryActionsFor(seeded.issueId)).toHaveLength(0);
    const reviewerRuns = await runsFor(seeded.reviewerId, seeded.issueId);
    expect(reviewerRuns).toHaveLength(1);
    expect(reviewerRuns[0]).toMatchObject({ status: "succeeded" });
    expect(reviewerRuns[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_assigned" });
    expect((await wakesFor(seeded.reviewerId, seeded.issueId)).map((wake) => wake.status))
      .not.toContain("deferred_issue_execution");
  });

  it("keeps the run that hands its task back to a board user", async () => {
    const seeded = await seed();
    let handOffStatus = 0;
    let handOffBody: unknown = null;

    const builderRunId = await runBuilderThatHandsOff(seeded, async (runId) => {
      const res = await request(createApp(agentActor(seeded.companyId, seeded.builderId, runId)))
        .patch(`/api/issues/${seeded.issueId}`)
        .send({
          assigneeAgentId: null,
          assigneeUserId: BOARD_USER_ID,
          comment: "Ready for your decision.",
        });
      handOffStatus = res.status;
      handOffBody = res.body;
      const [live] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(live).toMatchObject({ status: "running", errorCode: null });
    });

    expect(handOffStatus, JSON.stringify(handOffBody)).toBe(200);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, builderRunId));
    expect(finished).toMatchObject({ status: "succeeded", errorCode: null });
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task).toMatchObject({ assigneeAgentId: null, assigneeUserId: BOARD_USER_ID });
    // Nothing is left to recover or to run.
    expect(await recoveryActionsFor(seeded.issueId)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId)))
      .toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  async function commentsOf(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  function wakeCommentIdsOf(context: unknown) {
    return (context as { wakeCommentIds?: unknown } | null)?.wakeCommentIds;
  }

  function renderedWakeCommentIds(context: Record<string, unknown> | undefined) {
    const wake = context?.paperclipWake as { comments?: Array<{ id?: unknown }> } | undefined;
    return (wake?.comments ?? []).map((comment) => comment.id);
  }

  it("carries a message queued for the previous owner during its hand-off run to the new owner once", async () => {
    const seeded = await seed();
    let queuedCommentId = "";
    let handOffCommentId = "";
    let reviewerContext: Record<string, unknown> | undefined;

    const builderRunId = await runBuilderThatHandsOff(seeded, async (runId) => {
      // A board user writes to the task while the builder is still working
      // on it. The message waits for the builder's next turn.
      const posted = await request(createApp(boardActor(seeded.companyId)))
        .post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Please also cover the empty-input case." });
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      queuedCommentId = posted.body.id;
      await vi.waitFor(async () => {
        const [queued] = await wakesFor(seeded.builderId, seeded.issueId).then((wakes) =>
          wakes.filter((wake) => wake.status === "deferred_issue_execution"));
        expect(queued).toBeDefined();
      });

      // The builder then hands the task over from the same run.
      const res = await request(createApp(agentActor(seeded.companyId, seeded.builderId, runId)))
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ assigneeAgentId: seeded.reviewerId, comment: "Implementation is done; please review." });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await vi.waitFor(async () => {
        const [parked] = await wakesFor(seeded.reviewerId, seeded.issueId);
        expect(parked).toMatchObject({ status: "deferred_issue_execution", runId: null });
      });
    }, async (ctx) => {
      expect(ctx.agent.id).toBe(seeded.reviewerId);
      reviewerContext = ctx.context;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    });

    handOffCommentId = (await commentsOf(seeded.issueId)).find((comment) => comment.authorAgentId === seeded.builderId)!.id;
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, builderRunId));
    expect(finished).toMatchObject({ status: "succeeded", errorCode: null });

    // The new owner's single run receives the queued message ahead of the
    // hand-off note, which stays the wake's latest comment.
    const reviewerRuns = await runsFor(seeded.reviewerId, seeded.issueId);
    expect(reviewerRuns).toHaveLength(1);
    expect(reviewerRuns[0]).toMatchObject({ status: "succeeded" });
    expect(wakeCommentIdsOf(reviewerRuns[0]!.contextSnapshot)).toEqual([queuedCommentId, handOffCommentId]);
    expect(reviewerRuns[0]!.contextSnapshot).toMatchObject({ wakeCommentId: handOffCommentId });
    expect(renderedWakeCommentIds(reviewerContext)).toEqual([queuedCommentId, handOffCommentId]);

    // The previous owner does not run again for it: its queued wake now
    // belongs to the new owner's run.
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(1);
    const builderWakes = await wakesFor(seeded.builderId, seeded.issueId);
    const carried = builderWakes.filter((wake) => wake.id !== finished!.wakeupRequestId);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ status: "coalesced", runId: reviewerRuns[0]!.id });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    expect(await recoveryActionsFor(seeded.issueId)).toHaveLength(0);
  });

  it("gives the new owner only its own hand-off note when nothing was queued for the previous owner", async () => {
    const seeded = await seed();
    let reviewerContext: Record<string, unknown> | undefined;

    await runBuilderThatHandsOff(seeded, async (runId) => {
      const res = await request(createApp(agentActor(seeded.companyId, seeded.builderId, runId)))
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ assigneeAgentId: seeded.reviewerId, comment: "Implementation is done; please review." });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await vi.waitFor(async () => {
        const [parked] = await wakesFor(seeded.reviewerId, seeded.issueId);
        expect(parked).toMatchObject({ status: "deferred_issue_execution" });
      });
    }, async (ctx) => {
      reviewerContext = ctx.context;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    });

    const handOffCommentId = (await commentsOf(seeded.issueId)).find((comment) => comment.authorAgentId === seeded.builderId)!.id;
    const reviewerRuns = await runsFor(seeded.reviewerId, seeded.issueId);
    expect(reviewerRuns).toHaveLength(1);
    expect(wakeCommentIdsOf(reviewerRuns[0]!.contextSnapshot)).toEqual([handOffCommentId]);
    expect(renderedWakeCommentIds(reviewerContext)).toEqual([handOffCommentId]);
    expect((await wakesFor(seeded.builderId, seeded.issueId)).map((wake) => wake.status)).not.toContain("coalesced");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  });

  it("carries the previous owner's queued message when the new owner's wake arrives after the hand-off run released the task", async () => {
    const seeded = await seed();
    // The hand-off run has already finished and released the task, and the
    // board user's message it did not read is still queued for its agent.
    const builderRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: builderRunId,
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      runtimeMode: "legacy",
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, wakeReason: "issue_assigned" },
    });
    await db.update(issues).set({ assigneeAgentId: seeded.reviewerId }).where(eq(issues.id, seeded.issueId));
    const [queuedComment] = await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "user",
      authorUserId: BOARD_USER_ID,
      body: "Please also cover the empty-input case.",
    }).returning();
    const [handOffComment] = await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "agent",
      authorAgentId: seeded.builderId,
      createdByRunId: builderRunId,
      body: "Implementation is done; please review.",
    }).returning();
    const [queuedWake] = await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: BOARD_USER_ID,
      payload: {
        issueId: seeded.issueId,
        commentId: queuedComment!.id,
        mutation: "comment",
        _paperclipWakeContext: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          wakeReason: "issue_commented",
          commentId: queuedComment!.id,
          wakeCommentId: queuedComment!.id,
          wakeCommentIds: [queuedComment!.id],
        },
      },
    }).returning();

    let reviewerContext: Record<string, unknown> | undefined;
    mockAdapterExecute.mockImplementationOnce(async (ctx) => {
      reviewerContext = ctx.context;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
      return succeeded("Reviewed the task.");
    });
    // The new owner's wake, as the update route sends it for this hand-off.
    const queued = await heartbeat.wakeup(seeded.reviewerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: seeded.issueId, commentId: handOffComment!.id, mutation: "update", handoffSourceRunId: builderRunId },
      requestedByActorType: "agent",
      requestedByActorId: seeded.builderId,
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        commentId: handOffComment!.id,
        wakeCommentId: handOffComment!.id,
        source: "issue.update",
        handoffSourceRunId: builderRunId,
      },
    });
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const reviewerRuns = await runsFor(seeded.reviewerId, seeded.issueId);
    expect(reviewerRuns).toHaveLength(1);
    expect(wakeCommentIdsOf(reviewerRuns[0]!.contextSnapshot)).toEqual([queuedComment!.id, handOffComment!.id]);
    expect(renderedWakeCommentIds(reviewerContext)).toEqual([queuedComment!.id, handOffComment!.id]);
    const [carried] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queuedWake!.id));
    expect(carried).toMatchObject({ status: "coalesced", runId: reviewerRuns[0]!.id });
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(1);
  });

  /** A live run of `agentId` on `issueId`, backed by a real process so Stop can terminate it. */
  async function seedLiveRun(input: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(),
      startedAt: new Date(),
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_assigned" },
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.set(runId, child);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    return runId;
  }

  it("still stops the assignee's live run when a board user reassigns the task", async () => {
    const seeded = await seed();
    const liveRunId = await seedLiveRun({
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      issueId: seeded.issueId,
    });
    await db.update(issues).set({ executionRunId: liveRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, seeded.issueId));

    const res = await request(createApp(boardActor(seeded.companyId)))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ assigneeAgentId: seeded.reviewerId, comment: "Moving this to the reviewer." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, liveRunId));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task).toMatchObject({ assigneeAgentId: seeded.reviewerId });
  });

  it("still hands a message queued for the previous owner to the new owner when a board user reassigns the task", async () => {
    const seeded = await seed();
    const liveRunId = await seedLiveRun({
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      issueId: seeded.issueId,
    });
    await db.update(issues).set({ executionRunId: liveRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, seeded.issueId));
    const board = createApp(boardActor(seeded.companyId));
    const posted = await request(board)
      .post(`/api/issues/${seeded.issueId}/comments`)
      .send({ body: "Please also cover the empty-input case." });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    await vi.waitFor(async () => {
      const queued = (await wakesFor(seeded.builderId, seeded.issueId))
        .filter((wake) => wake.status === "deferred_issue_execution");
      expect(queued).toHaveLength(1);
    });

    const res = await request(board)
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ assigneeAgentId: seeded.reviewerId, comment: "Moving this to the reviewer." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, liveRunId));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    await vi.waitFor(async () => {
      expect(await runsFor(seeded.reviewerId, seeded.issueId)).toHaveLength(1);
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const reassignCommentId = (await commentsOf(seeded.issueId))
      .find((comment) => comment.body === "Moving this to the reviewer.")!.id;
    const [reviewerRun] = await runsFor(seeded.reviewerId, seeded.issueId);
    expect(wakeCommentIdsOf(reviewerRun!.contextSnapshot)).toEqual([posted.body.id, reassignCommentId]);
    const [carried] = (await wakesFor(seeded.builderId, seeded.issueId))
      .filter((wake) => wake.payload?.mutation === "comment");
    expect(carried).toMatchObject({ status: "coalesced", runId: reviewerRun!.id });
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(1);
  });

  it("still stops the task's live run when a different run of the same agent reassigns it", async () => {
    const seeded = await seed();
    const liveRunId = await seedLiveRun({
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      issueId: seeded.issueId,
    });
    await db.update(issues).set({ executionRunId: liveRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, seeded.issueId));
    // The same agent, working another task, hands this one over.
    const otherIssueId = randomUUID();
    const otherRunId = await seedLiveRun({
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      issueId: otherIssueId,
    });

    const res = await request(createApp(agentActor(seeded.companyId, seeded.builderId, otherRunId)))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ assigneeAgentId: seeded.reviewerId, comment: "Reviewer should take this one." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, liveRunId));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    const [actorRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRunId));
    expect(actorRun).toMatchObject({ status: "running", errorCode: null });
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task).toMatchObject({ assigneeAgentId: seeded.reviewerId });
  });
});
