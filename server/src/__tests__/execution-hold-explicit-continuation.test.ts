import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import {
  deliverReconciledExecutions,
  releaseExecutionHoldForExplicitIntent,
  settleUnrecoverableExecutions,
} from "../services/execution-recovery-resolution.js";
import { LEGACY_RECOVERY_CAUSE, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping explicit-continuation execution hold tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER_ID = "board-owner";

// A legacy, non-conversation adapter's run that stopped with unverified
// action outcomes settles as a no-replay hold: recorded work is kept, but
// nothing wakes the task's assignee again until a human says to continue.
// Board/user intent that is itself such a decision - a comment that reopens
// the task or @-mentions its assignee, or a status PATCH back to todo/
// in_progress - ends the hold without an agent ever being able to trigger it.
describeEmbeddedPostgres("explicit board/user continuation of a no-replay execution hold", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-hold-explicit-continuation-");
    db = createDb(tempDb.connectionString);
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
    // The route's own wake dispatch, after the comment/status update commits,
    // is fire-and-forget (the response does not wait for it) - drain that
    // short window first, or this truncate can race a still-open transaction
    // of its own and deadlock instead of just waiting its turn.
    await drainBackgroundWakeDispatch();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function drainBackgroundWakeDispatch() {
    return new Promise((resolve) => setTimeout(resolve, 500));
  }

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

  /**
   * A held task: its assignee's last run used an ordinary, non-conversation
   * ("process") adapter, stopped with unverified action outcomes, and the
   * automatic disposition already settled it as a no-replay hold - the issue
   * is `blocked` and nothing will wake the assignee again without a human
   * decision.
   */
  async function seedHeldTask() {
    const companyId = randomUUID();
    const assigneeId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `X${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
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
    await db.insert(agents).values({
      id: assigneeId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the change",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: assigneeId,
      createdByUserId: BOARD_USER_ID,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    // A run the process adapter already did real work on: recorded output,
    // so it is not eligible for the separate, generic inert-run policy.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeId,
      invocationSource: "assignment",
      status: "running",
      runtimeMode: "legacy",
      executionStage: "dispatching",
      nextEventSeq: 10,
      startedAt: new Date(Date.now() - 60_000),
      lastOutputAt: new Date(),
      lastOutputSeq: 3,
      lastOutputBytes: 128,
      contextSnapshot: { issueId },
    });
    await db.insert(heartbeatRunEvents).values({
      companyId, runId, agentId: assigneeId, seq: 1, eventType: "lifecycle",
      stream: "system", level: "info", message: "run started",
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await terminalizeLegacyExecution({
      db, run: run!, status: "cancelled",
      patch: { finishedAt: new Date(), error: "Cancelled due to agent pause", errorCode: "agent_paused" },
    });
    // The automatic disposition settles it without replay (no conversation
    // turn to review the recorded work for this adapter) and blocks the task.
    await settleUnrecoverableExecutions(db, new Date());
    const blocker = await getExecutionBlocker(db, companyId, issueId);
    expect(blocker).not.toBeNull();
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task!.status).toBe("blocked");
    return { companyId, assigneeId, issueId, runId, recoveryActionId: blocker!.recoveryActionId! };
  }

  async function legacyAction(issueId: string) {
    const [row] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    ));
    return row;
  }

  it("a board/user PATCH that moves the task back to todo releases the hold and wakes the assignee once", async () => {
    const seeded = await seedHeldTask();
    const app = createApp(boardActor(seeded.companyId));

    const res = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).toBeNull();
    const action = await legacyAction(seeded.issueId);
    expect(action).toMatchObject({
      status: "resolved",
      outcome: "restored",
      evidence: {
        continuationDelivery: "pending",
        executionReconciliation: { runId: seeded.runId, providerStopped: true, actionOutcome: "mixed" },
      },
    });

    const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
    await deliverReconciledExecutions(db, wake);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(seeded.assigneeId, expect.anything());

    // Idempotent: a second delivery pass does nothing further.
    await deliverReconciledExecutions(db, wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("a board/user comment that @-mentions the assignee releases the hold", async () => {
    const seeded = await seedHeldTask();
    const app = createApp(boardActor(seeded.companyId));
    const [assignee] = await db.select().from(agents).where(eq(agents.id, seeded.assigneeId));

    const res = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ comment: `@${assignee!.name} please pick this back up.` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The comment-create response says the hold is gone, not queued behind it.
    expect(res.body.executionHold).toBeNull();

    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).toBeNull();
    expect(await legacyAction(seeded.issueId)).toMatchObject({ status: "resolved", outcome: "restored" });
  });

  it("an agent-authored comment does not release the hold, and the response reports it as still held", async () => {
    const seeded = await seedHeldTask();
    // The agent is its own assignee, acting through its own API key/run - no
    // route lets an agent spend this explicit-continuation decision. Unlike
    // a board/user comment, an agent's comment also never implicitly
    // reopens a blocked issue (see `shouldImplicitlyMoveCommentedIssueToTodo`),
    // so this is a genuine "still held" case end to end.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: seeded.companyId, agentId: seeded.assigneeId,
      invocationSource: "assignment", status: "running", startedAt: new Date(),
      contextSnapshot: {},
    });
    const app = createApp(agentActor(seeded.companyId, seeded.assigneeId, runId));

    const res = await request(app)
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ comment: "Still working on this." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The comment-create response says the comment is queued behind the
    // hold, rather than leaving its author to discover that only later.
    expect(res.body.executionHold).toMatchObject({ recoveryActionId: seeded.recoveryActionId });

    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).not.toBeNull();
    expect(await legacyAction(seeded.issueId)).toMatchObject({ status: "resolved", outcome: "blocked" });
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task!.status).toBe("blocked");
  });

  it("GET recovery-actions reports the settled no-replay hold as an effective hold", async () => {
    const seeded = await seedHeldTask();
    const app = createApp(boardActor(seeded.companyId));

    const res = await request(app).get(`/api/issues/${seeded.issueId}/recovery-actions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // `active` stays null (this hold is resolved, not active/escalated) -
    // existing readers of that field keep seeing exactly what they always
    // did - but the hold itself is no longer invisible.
    expect(res.body.active).toBeNull();
    expect(res.body.effectiveHold).toMatchObject({
      id: seeded.recoveryActionId,
      status: "resolved",
      cause: LEGACY_RECOVERY_CAUSE,
      nextAction: expect.stringContaining("Automatic recovery stopped"),
    });
    expect(res.body.actions).toEqual([res.body.effectiveHold]);
  });

  it("the resolve route accepts sourceIssueStatus backlog to reconcile a parked issue without un-parking it", async () => {
    const seeded = await seedHeldTask();
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, seeded.issueId));
    const app = createApp(boardActor(seeded.companyId));

    const res = await request(app)
      .post(`/api/issues/${seeded.issueId}/recovery-actions/resolve`)
      .send({
        actionId: seeded.recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "backlog",
        executionReconciliation: {
          runId: seeded.runId,
          providerStopped: true,
          actionOutcome: "mixed",
          outcomeEvidence: "Verified the previous process stopped; recorded work stands.",
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue.status).toBe("backlog");
    expect(await getExecutionBlocker(db, seeded.companyId, seeded.issueId)).toBeNull();

    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task!.status).toBe("backlog");
  });

  it("releaseExecutionHoldForExplicitIntent is a no-op off a resume-reconcilable hold", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    // No matching recovery action at all: never throws, just reports nothing to release.
    expect(await releaseExecutionHoldForExplicitIntent(db, { companyId, issueId, actorId: BOARD_USER_ID })).toBe(false);
  });
});
