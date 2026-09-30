import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reassignment deferred-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A task is handed to another agent while a run of its previous owner is
// live. The route stops that run first, then commits the new assignee and
// wakes it. (A run that hands over its own task is not stopped; see
// issue-reassignment-own-run-routes.test.ts.) The
// stopped conversation run still owns its environment lease until its
// executor finishes cleanup, so admission parks the new assignee's wake as a
// `deferred_issue_execution` row. These tests cover what must happen once
// that previous owner has settled.
describeEmbeddedPostgres("deferred wakes after a run hands its task to another agent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Map<string, ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reassignment-deferred-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const [runId, child] of children) {
      runningProcesses.delete(runId);
      child.kill();
    }
    children.clear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const reviewerId = randomUUID();
    const builderId = randomUUID();
    const thirdAgentId = randomUUID();
    const issueId = randomUUID();
    const reviewerRunId = randomUUID();
    const reviewerWakeId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const agentRow = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      // One slot each; the tests occupy it so no model is ever invoked.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agents).values([
      agentRow(reviewerId, "Reviewer"),
      agentRow(builderId, "Builder"),
      agentRow(thirdAgentId, "Fixer"),
    ]);
    for (const agentId of [builderId, thirdAgentId]) {
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId: randomUUID(), wakeReason: "test_busy_slot" },
      });
    }
    await db.insert(agentWakeupRequests).values({
      id: reviewerWakeId,
      companyId,
      agentId: reviewerId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "claimed",
      payload: { issueId },
      runId: null,
    });
    await db.insert(heartbeatRuns).values({
      id: reviewerRunId,
      companyId,
      agentId: reviewerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(),
      startedAt: new Date(),
      wakeupRequestId: reviewerWakeId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      // The run's executor lives on and still owns the environment lease: it
      // releases it during its own cleanup, after the Stop returns.
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await db.update(agentWakeupRequests).set({ runId: reviewerRunId }).where(eq(agentWakeupRequests.id, reviewerWakeId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review, then hand back",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: reviewerId,
      executionRunId: reviewerRunId,
      checkoutRunId: reviewerRunId,
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId,
      issueId,
      heartbeatRunId: reviewerRunId,
      provider: "local",
      status: "active",
      leasePolicy: "ephemeral",
    }).returning();
    // A live provider process, so Stop records an acknowledged cancellation.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.set(reviewerRunId, child);
    runningProcesses.set(reviewerRunId, { child, graceSec: 1, processGroupId: null });
    return { companyId, reviewerId, builderId, thirdAgentId, issueId, reviewerRunId, leaseId: lease!.id };
  }

  /** The stop, update and wake sequence of a hand-over while the previous owner's run is live. */
  async function reassignFromOwnRun(input: {
    companyId: string;
    issueId: string;
    fromAgentId: string;
    fromRunId: string;
    toAgentId: string;
  }) {
    const heartbeat = heartbeatService(db);
    const issueMutationStopId = randomUUID();
    const cancelled = await heartbeat.cancelRun(input.fromRunId, "Cancelled before issue reassignment", {
      errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId },
      eventMessage: "run cancelled before issue reassignment",
      eventPayload: { issueId: input.issueId },
    });
    expect(cancelled?.status).toBe("cancelled");
    await issueService(db).update(input.issueId, {
      status: "todo",
      assigneeAgentId: input.toAgentId,
      actorAgentId: input.fromAgentId,
      actorRunId: input.fromRunId,
      actorRunStopId: issueMutationStopId,
    });
    const [comment] = await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "agent",
      authorAgentId: input.fromAgentId,
      createdByRunId: input.fromRunId,
      body: "Review done. Handing back for the fixes.",
    }).returning();
    return heartbeat.wakeup(input.toAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId: input.issueId,
        commentId: comment!.id,
        mutation: "update",
        interruptedRunId: input.fromRunId,
      },
      requestedByActorType: "agent",
      requestedByActorId: input.fromAgentId,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        commentId: comment!.id,
        wakeCommentId: comment!.id,
        source: "issue.update",
        interruptedRunId: input.fromRunId,
      },
    });
  }

  async function settleLease(leaseId: string) {
    await db.update(environmentLeases).set({
      status: "released",
      releasedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(environmentLeases.id, leaseId));
  }

  async function wakesFor(agentId: string, issueId: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    ));
  }

  async function runsFor(agentId: string, issueId: string) {
    return db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
    ));
  }

  it("parks the new assignee's wake while the stopped run still owns its lease", async () => {
    const seeded = await seed();
    const run = await reassignFromOwnRun({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      fromAgentId: seeded.reviewerId,
      fromRunId: seeded.reviewerRunId,
      toAgentId: seeded.builderId,
    });

    expect(run).toBeNull();
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.reviewerRunId));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(stopped!.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task).toMatchObject({ assigneeAgentId: seeded.builderId, executionRunId: null, checkoutRunId: null });
    const [parked] = await wakesFor(seeded.builderId, seeded.issueId);
    expect(parked).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(parked!.payload).toHaveProperty("executionWait");
  });

  it("promotes the parked wake exactly once after the stopped run settles, from the periodic sweep", async () => {
    const seeded = await seed();
    await reassignFromOwnRun({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      fromAgentId: seeded.reviewerId,
      fromRunId: seeded.reviewerRunId,
      toAgentId: seeded.builderId,
    });

    // Still held: the sweep must not start the new owner beside the old one.
    await heartbeatService(db).resumeQueuedRuns();
    expect((await wakesFor(seeded.builderId, seeded.issueId))[0]!.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(0);

    await settleLease(seeded.leaseId);
    await Promise.all([
      heartbeatService(db).resumeQueuedRuns(),
      heartbeatService(db).resumeQueuedRuns(),
    ]);
    await heartbeatService(db).resumeQueuedRuns();

    const [promoted] = await wakesFor(seeded.builderId, seeded.issueId);
    expect(promoted!.status).not.toBe("deferred_issue_execution");
    const runs = await runsFor(seeded.builderId, seeded.issueId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", wakeupRequestId: promoted!.id });
    expect(promoted!.runId).toBe(runs[0]!.id);
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: seeded.issueId, wakeReason: "issue_assigned" });
  });

  it("promotes the parked wake exactly once from the stopped run's cleanup", async () => {
    const seeded = await seed();
    await reassignFromOwnRun({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      fromAgentId: seeded.reviewerId,
      fromRunId: seeded.reviewerRunId,
      toAgentId: seeded.builderId,
    });
    const heartbeat = heartbeatService(db);

    // Cleanup that has not released the lease yet changes nothing.
    expect(await heartbeat.promoteDeferredWakesAfterRunSettled(seeded.reviewerRunId)).toBe(false);

    await settleLease(seeded.leaseId);
    const results = await Promise.all([
      heartbeat.promoteDeferredWakesAfterRunSettled(seeded.reviewerRunId),
      heartbeat.promoteDeferredWakesAfterRunSettled(seeded.reviewerRunId),
    ]);
    expect(results).toContain(true);
    expect(await heartbeat.promoteDeferredWakesAfterRunSettled(seeded.reviewerRunId)).toBe(false);

    const runs = await runsFor(seeded.builderId, seeded.issueId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("queued");
    const [task] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(task!.executionRunId).toBe(runs[0]!.id);
  });

  it("cancels a parked assignment wake whose agent lost the task before the owner settled", async () => {
    const seeded = await seed();
    await reassignFromOwnRun({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      fromAgentId: seeded.reviewerId,
      fromRunId: seeded.reviewerRunId,
      toAgentId: seeded.builderId,
    });
    // A board user moves the task on again before the old run has settled.
    await issueService(db).update(seeded.issueId, { assigneeAgentId: seeded.thirdAgentId, actorUserId: "board-user" });
    const [comment] = await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "user",
      authorUserId: "board-user",
      body: "Moving this to the fixer instead.",
    }).returning();
    const next = await heartbeatService(db).wakeup(seeded.thirdAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: seeded.issueId, mutation: "update", commentId: comment!.id },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        commentId: comment!.id,
        wakeCommentId: comment!.id,
        source: "issue.update",
      },
    });
    expect(next).toBeNull();

    await settleLease(seeded.leaseId);
    await heartbeatService(db).resumeQueuedRuns();
    await heartbeatService(db).resumeQueuedRuns();

    const [stale] = await wakesFor(seeded.builderId, seeded.issueId);
    expect(stale).toMatchObject({ status: "cancelled", runId: null });
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(0);
    const thirdRuns = await runsFor(seeded.thirdAgentId, seeded.issueId);
    expect(thirdRuns).toHaveLength(1);
    expect(thirdRuns[0]!.status).toBe("queued");
  });

  it("cancels a parked assignment wake once the task was unassigned", async () => {
    const seeded = await seed();
    await reassignFromOwnRun({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      fromAgentId: seeded.reviewerId,
      fromRunId: seeded.reviewerRunId,
      toAgentId: seeded.builderId,
    });
    await issueService(db).update(seeded.issueId, { assigneeAgentId: null, actorUserId: "board-user" });

    await settleLease(seeded.leaseId);
    await heartbeatService(db).resumeQueuedRuns();

    const [stale] = await wakesFor(seeded.builderId, seeded.issueId);
    expect(stale).toMatchObject({ status: "cancelled", runId: null });
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(0);
  });

  it("leaves wakes parked behind a settled run whose outcome still needs reconciliation", async () => {
    const seeded = await seed();
    await reassignFromOwnRun({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      fromAgentId: seeded.reviewerId,
      fromRunId: seeded.reviewerRunId,
      toAgentId: seeded.builderId,
    });
    // The previous owner's run ended without proof that its provider actions
    // settled, and its hold was recorded while it still owned the task. Its
    // queue waits for the release after that hold, not for the drain after
    // the executor settled.
    await db.update(heartbeatRuns).set({
      status: "failed",
      errorCode: "adapter_failed",
      resultJson: {},
    }).where(eq(heartbeatRuns.id, seeded.reviewerRunId));
    await db.insert(issueRecoveryActions).values({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      returnOwnerAgentId: seeded.reviewerId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${seeded.reviewerRunId}`,
      evidence: { runId: seeded.reviewerRunId, originalFailureCode: "adapter_failed" },
      nextAction: "Reconcile the stopped run before continuing.",
    });
    await settleLease(seeded.leaseId);

    // The open hold is an execution blocker, so the settled-run drain stands down.
    expect(await heartbeatService(db).promoteDeferredWakesAfterRunSettled(seeded.reviewerRunId)).toBe(false);
    await heartbeatService(db).resumeQueuedRuns();

    const [wake] = await wakesFor(seeded.builderId, seeded.issueId);
    expect(wake!.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(0);
  });

  it("leaves queued work parked after a Stop that did not hand the task over", async () => {
    const seeded = await seed();
    // The task belongs to the builder; the reviewer's run is only a participant.
    await db.update(issues).set({ assigneeAgentId: seeded.builderId }).where(eq(issues.id, seeded.issueId));
    const [comment] = await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "user",
      authorUserId: "board-user",
      body: "One more thing for the builder",
    }).returning();
    const parked = await heartbeatService(db).wakeup(seeded.builderId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: seeded.issueId, commentId: comment!.id },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, commentId: comment!.id, wakeReason: "issue_commented" },
    });
    expect(parked).toBeNull();
    // An operator Stop of the reviewer's run leaves queued work for the next
    // explicit wake, as before.
    await heartbeatService(db).cancelRun(seeded.reviewerRunId);
    await settleLease(seeded.leaseId);
    expect(await heartbeatService(db).promoteDeferredWakesAfterRunSettled(seeded.reviewerRunId)).toBe(false);
    await heartbeatService(db).resumeQueuedRuns();

    const [wake] = await wakesFor(seeded.builderId, seeded.issueId);
    expect(wake!.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.builderId, seeded.issueId)).toHaveLength(0);
  });
});
