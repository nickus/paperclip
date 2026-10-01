import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter, type WakeQueuePostgresAdapterDeps } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { RUN_QUEUED_COMMENTS_UNDELIVERED_ACTION } from "../run-queued-comments.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native queued-comment tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Shaped like the arbiter's decision for a run whose completion contract is
// satisfied.
const DONE_DECISION: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
  statusAction: "done",
  toStatus: "done",
  reasonCode: "completion_contract_satisfied",
  unblockDescriptor: null,
  effects: [{ kind: "release_checkout" }],
};

// Shaped like an authorized issue-scope cancellation of the native run.
const CANCEL_DECISION: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
  statusAction: "cancelled",
  toStatus: "cancelled",
  reasonCode: "cancellation_issue_authorized",
  unblockDescriptor: null,
  effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }],
};

// Shaped like the arbiter's decision for a task that was already closed when
// the run finished.
const PRESERVE_DONE_DECISION: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
  statusAction: "preserve",
  toStatus: "done",
  reasonCode: "terminal_status_preserved",
  unblockDescriptor: null,
  effects: [],
};

const stubDeps: WakeQueuePostgresAdapterDeps = {
  resolveResponsibleUserId: async () => "responsible-user",
  getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
  resolveSessionBeforeForWakeup: async () => null,
};

// A native run's status decision closes its task from the run's final
// report, not through the issue routes, so the routes' check for comments
// queued during the run never sees it. These tests cover the native path:
// comments another actor posted while the run worked, which wait in a
// deferred wake of the run's agent, still reach the agent or the board.
describeEmbeddedPostgres("native status decisions and comments queued during the run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-queued-comments-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const builderId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const agentRow = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agents).values([agentRow(builderId, "Builder"), agentRow(reviewerId, "Reviewer")]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the change",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: builderId,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "queued-comments-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "queued-comments-v1",
        objective: "Ship the change",
        criteria: [{ id: "objective", requirement: "Ship the change" }],
      },
      canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: builderId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: randomUUID(),
      runnerInstanceId: randomUUID(),
      completionContractId: contractId,
      completionContractSha256: `contract-${contractId}`,
      startedAt: new Date(Date.now() - 10 * 60_000),
      contextSnapshot: { issueId, taskId: issueId },
    });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fp-${resultId}`,
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: `sha-${resultId}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: "queued-comments-v1",
      assessmentJson: {},
      inputDigest: `digest-${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "arbitrating",
      attempt: 0,
      resultId,
    });
    return { companyId, builderId, reviewerId, issueId, runId, assessmentId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** A reviewer's hold comment, queued for the builder behind its running run, as the comment route does. */
  async function queueReviewerHold(seeded: Seeded) {
    const [comment] = await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "agent",
      authorAgentId: seeded.reviewerId,
      body: "Hold: the API contract changed, do not ship this yet.",
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.builderId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "agent",
      requestedByActorId: seeded.reviewerId,
      payload: {
        issueId: seeded.issueId,
        commentId: comment!.id,
        mutation: "comment",
        _paperclipWakeContext: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          wakeReason: "issue_commented",
          wakeCommentIds: [comment!.id],
        },
      },
    }).returning();
    return { comment: comment!, wakeId: wake!.id };
  }

  async function commit(seeded: Seeded, decision: NativeStatusDecision) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    return commitNativeStatusDecision({
      db,
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      assessmentId: seeded.assessmentId,
      priorStatus: issue!.status,
      priorStatusVersion: Number(issue!.statusVersion),
      priorDecisionId: issue!.lastStatusDecisionId,
      decision,
    });
  }

  /** What the heartbeat executor does once the native run has finished: release the task and drain its queue. */
  async function finishRunAndRelease(seeded: Seeded) {
    await db.update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.runId));
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    return release({ companyId: seeded.companyId, runId: seeded.runId, now: new Date() });
  }

  async function undeliveredEntries(issueId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.action, RUN_QUEUED_COMMENTS_UNDELIVERED_ACTION),
      eq(activityLog.entityId, issueId),
    ));
  }

  it.each(["unseen", "in_run_prompt"] as const)(
    "names a hold comment the run never saw when an issue cancellation retires its wake (%s)",
    async (scenario) => {
      const seeded = await seed();
      const { comment, wakeId } = await queueReviewerHold(seeded);
      if (scenario === "in_run_prompt") {
        // The comment reached the run in its prompt, so the run saw it.
        await db.update(heartbeatRuns)
          .set({ contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, wakeCommentIds: [comment.id] } })
          .where(eq(heartbeatRuns.id, seeded.runId));
      }

      const committed = await commit(seeded, CANCEL_DECISION);

      expect(committed.issue.status).toBe("cancelled");
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
      expect(wake).toMatchObject({ status: "cancelled", error: "Cancelled by native issue cancellation" });
      const [effect] = await db.select().from(statusDecisionEffects).where(and(
        eq(statusDecisionEffects.decisionId, committed.decision.id),
        eq(statusDecisionEffects.effectKind, "cancel_continuations"),
      ));
      const undelivered = await undeliveredEntries(seeded.issueId);
      if (scenario === "unseen") {
        expect(undelivered).toEqual([expect.objectContaining({
          runId: seeded.runId,
          details: {
            wakeId,
            commentIds: [comment.id],
            reason: "The task was cancelled before its run saw these comments",
          },
        })]);
        expect(effect!.payload).toMatchObject({
          cancelledWakeIds: [wakeId],
          undeliveredQueuedComments: [{ wakeId, commentIds: [comment.id] }],
        });
      } else {
        expect(undelivered).toHaveLength(0);
        expect(effect!.payload).not.toHaveProperty("undeliveredQueuedComments");
      }
    },
  );

  it("reopens a task the native run completed without seeing a hold comment, and tells the next run", async () => {
    const seeded = await seed();
    const { comment, wakeId } = await queueReviewerHold(seeded);

    const committed = await commit(seeded, DONE_DECISION);
    expect(committed.issue.status).toBe("done");

    const result = await finishRunAndRelease(seeded);

    expect(result.outcome.kind).toBe("promoted");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("todo");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake!.status).toBe("queued");
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
    expect(next!.contextSnapshot).toMatchObject({
      wakeCommentIds: [comment.id],
      queuedDuringPreviousRun: { runId: seeded.runId, commentIds: [comment.id] },
    });
    expect(await undeliveredEntries(seeded.issueId)).toHaveLength(0);
  });

  it("keeps a task closed that the board closed while the native run worked, and names the hold comment", async () => {
    const seeded = await seed();
    const { comment, wakeId } = await queueReviewerHold(seeded);
    // A board user closes the task while the run is still working.
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, seeded.issueId));
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      details: { status: "done" },
    });

    const committed = await commit(seeded, PRESERVE_DONE_DECISION);
    expect(committed.issue.status).toBe("done");

    const result = await finishRunAndRelease(seeded);

    expect(result.outcome.kind).toBe("released");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("done");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake!.status).toBe("cancelled");
    expect(await undeliveredEntries(seeded.issueId)).toEqual([expect.objectContaining({
      runId: seeded.runId,
      details: {
        wakeId,
        commentIds: [comment.id],
        reason: "Someone other than its run closed the task before the run saw these comments",
      },
    })]);
  });
});
