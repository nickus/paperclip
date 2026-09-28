import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import { heartbeatService } from "../services/heartbeat.js";
import {
  deliverReconciledExecutions,
  reconcileInertLegacyExecutions,
  settleUnrecoverableExecutions,
} from "../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import {
  deliverReleasedExecutionWaits,
  HELD_EXECUTION_WAIT_RELEASE_ENV,
  HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS,
  HELD_EXECUTION_WAIT_RELEASE_RETRY_MS,
  heldExecutionWaitReleaseIdempotencyKey,
  releaseHeldExecutionWaits,
} from "../services/execution-wait-release.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  INERT_RUN_AUTO_RECONCILE_ENV,
  INERT_RUN_RELEASE_RECHECK_MS,
  INERT_RUN_SETTLE_GRACE_MS,
} from "../services/inert-legacy-execution.js";
import {
  legacyExecutionRecoveryFingerprint,
  LEGACY_RECOVERY_CAUSE,
  terminalizeLegacyExecution,
} from "../services/legacy-execution-recovery.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  reportSkippedDependencyWake,
} from "../services/issue-dependency-wakeups.js";
import { logger } from "../middleware/logger.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution hold release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("execution recovery holds", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-hold-release-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env[INERT_RUN_AUTO_RECONCILE_ENV];
    delete process.env[HELD_EXECUTION_WAIT_RELEASE_ENV];
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `EH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Hold Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship the feature",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  /** A legacy run the agent pause stopped while it was still preparing. */
  async function seedStoppedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    finishedAt?: Date;
    overrides?: Partial<typeof heartbeatRuns.$inferInsert>;
    stop?: Partial<typeof heartbeatRuns.$inferInsert>;
  }) {
    const runId = randomUUID();
    const finishedAt = input.finishedAt ?? new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "running",
      runtimeMode: "legacy",
      executionStage: "preparing",
      // Seeded events below take the low sequence numbers.
      nextEventSeq: 10,
      startedAt: new Date(finishedAt.getTime() - 60_000),
      contextSnapshot: { issueId: input.issueId },
      ...input.overrides,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId,
      agentId: input.agentId,
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "run started",
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const updated = await terminalizeLegacyExecution({
      db,
      run: run!,
      status: "cancelled",
      patch: { finishedAt, error: "Cancelled due to agent pause", errorCode: "agent_paused", ...input.stop },
    });
    expect(updated?.status).toBe("cancelled");
    return updated!;
  }

  async function legacyActions(issueId: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
        ),
      );
  }

  describe("one recovery record per terminal run", () => {
    it("does not open a second hold when a settled run is revisited", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      // A recorded process makes this run ineligible for automatic reconciliation.
      const run = await seedStoppedRun({ companyId, agentId, issueId, overrides: { processPid: 4242 } });
      expect(await legacyActions(issueId)).toHaveLength(1);

      // The automatic disposition closes the action but keeps a no-replay hold.
      await settleUnrecoverableExecutions(db, new Date());
      const [settled] = await legacyActions(issueId);
      expect(settled).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });

      // Periodic recovery revisits the same terminal run.
      await terminalizeLegacyExecution({ db, run, status: run.status, fromStatuses: [run.status] });
      await terminalizeLegacyExecution({ db, run, status: run.status, fromStatuses: [run.status] });

      const actions = await legacyActions(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: settled!.id,
        fingerprint: legacyExecutionRecoveryFingerprint(run.id),
      });
    });

    it("refreshes the open record in place, including under concurrent revisits", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const run = await seedStoppedRun({ companyId, agentId, issueId, overrides: { processPid: 4243 } });
      const [first] = await legacyActions(issueId);
      await Promise.all([
        terminalizeLegacyExecution({ db, run, status: run.status, fromStatuses: [run.status] }),
        terminalizeLegacyExecution({ db, run, status: run.status, fromStatuses: [run.status] }),
      ]);
      const actions = await legacyActions(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.id).toBe(first!.id);
      expect(actions[0]!.attemptCount).toBeGreaterThan(first!.attemptCount);
    });

    it("does not resurrect an old run's record over a newer incident", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const older = await seedStoppedRun({ companyId, agentId, issueId, overrides: { processPid: 4244 } });
      const newer = await seedStoppedRun({ companyId, agentId, issueId, overrides: { processPid: 4245 } });
      const before = await legacyActions(issueId);
      const active = before.filter((row) => row.status === "active");
      expect(active).toHaveLength(1);
      expect(active[0]!.fingerprint).toBe(legacyExecutionRecoveryFingerprint(newer.id));

      await terminalizeLegacyExecution({ db, run: older, status: older.status, fromStatuses: [older.status] });

      const after = await legacyActions(issueId);
      expect(after).toHaveLength(before.length);
      expect(after.find((row) => row.status === "active")!.id).toBe(active[0]!.id);
    });
  });

  describe("automatic reconciliation of runs that never reached the adapter", () => {
    it("reconciles an inert run as not performed and releases its hold", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const run = await seedStoppedRun({ companyId, agentId, issueId });
      await db.insert(environmentLeases).values({
        companyId, issueId, heartbeatRunId: run.id, status: "released", provider: "kubernetes",
        providerLeaseId: "sandbox-1", releasedAt: new Date(), cleanupStatus: "success",
      });
      const [action] = await legacyActions(issueId);
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });

      // The regular disposition leaves a possibly-inert run alone during the window.
      await settleUnrecoverableExecutions(db, new Date());
      expect((await legacyActions(issueId))[0]).toMatchObject({ status: "active" });

      const result = await reconcileInertLegacyExecutions(db, new Date());
      expect(result).toMatchObject({ reconciled: 1 });
      const [reconciled] = await legacyActions(issueId);
      expect(reconciled).toMatchObject({
        id: action!.id,
        status: "resolved",
        outcome: "restored",
        evidence: {
          continuationDelivery: "pending",
          executionReconciliation: {
            runId: run.id,
            providerStopped: true,
            actionOutcome: "not_performed",
            actorId: "execution-recovery",
          },
          inertRunAssessment: { verdict: "inert", executionStage: "preparing" },
        },
      });
      expect(reconciled!.evidence).not.toHaveProperty("automaticRecovery");
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task!.status).toBe("in_progress");

      // The operator path's delivery sends the owner one issue-scoped continuation.
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(agentId, expect.objectContaining({
        reason: "issue_recovery_action_restored",
        idempotencyKey: `execution-reconciliation:${action!.id}`,
        payload: { issueId, recoveryActionId: action!.id },
      }));
    });

    it("passes the regular continuation admission with an automatic decision", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const responsibleUserId = randomUUID();
      await db.insert(authUsers).values({
        id: responsibleUserId, name: "Operator", email: `${responsibleUserId}@example.test`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId }).where(eq(companies.id, companyId));
      // Occupy the agent's only slot so admission queues without launching a provider.
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
      const run = await seedStoppedRun({ companyId, agentId, issueId });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "manual", status: "running", startedAt: new Date(),
      });
      const [action] = await legacyActions(issueId);
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });

      await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);

      const wakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${action!.id}`));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ status: "queued", agentId });
      const [continuation] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakes[0]!.runId!));
      expect(continuation).toMatchObject({
        retryOfRunId: run.id,
        contextSnapshot: expect.objectContaining({ issueId, previousRunId: run.id, source: "execution.reconciled" }),
      });
      const [delivered] = await legacyActions(issueId);
      expect(delivered!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: continuation!.id });
    });

    it("keeps the continuation pending while the owner is paused", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({ companyId, agentId, issueId });
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
      const wake = vi.fn();
      await deliverReconciledExecutions(db, wake as never);
      expect(wake).not.toHaveBeenCalled();
      expect((await legacyActions(issueId))[0]!.evidence).toMatchObject({ continuationDelivery: "pending" });
    });

    it("declines when the operator path would refuse the decision", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId, companyId, name: "Reviewer", role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      await seedStoppedRun({ companyId, agentId, issueId });
      // The run belongs to a different agent than the recorded owner.
      await db.update(heartbeatRuns).set({ agentId: otherAgentId }).where(eq(heartbeatRuns.agentId, agentId));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, notInert: 1 });
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "active",
        evidence: { inertRunAssessment: { verdict: "not_inert" } },
      });
      expect((await legacyActions(issueId))[0]!.evidence).not.toHaveProperty("executionReconciliation");
    });

    it("waits for the sandbox to be released before reconciling", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const run = await seedStoppedRun({ companyId, agentId, issueId });
      const [lease] = await db.insert(environmentLeases).values({
        companyId, issueId, heartbeatRunId: run.id, status: "active", provider: "kubernetes", providerLeaseId: "sandbox-2",
      }).returning();
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, awaitingRelease: 1 });
      expect((await legacyActions(issueId))[0]).toMatchObject({ status: "active" });
      expect((await legacyActions(issueId))[0]!.evidence).not.toHaveProperty("inertRunAssessment");

      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
        .where(eq(environmentLeases.id, lease!.id));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
    });

    it("never reconciles a run with tool-call evidence and hands it back to the regular disposition", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const run = await seedStoppedRun({ companyId, agentId, issueId });
      // An agent API call made with this run's credentials.
      await db.insert(activityLog).values({
        companyId, actorType: "agent", actorId: agentId, agentId, runId: run.id,
        action: "issue.comment_added", entityType: "issue", entityId: issueId,
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, notInert: 1 });
      const [assessed] = await legacyActions(issueId);
      expect(assessed).toMatchObject({
        status: "active",
        evidence: { inertRunAssessment: { verdict: "not_inert", reason: "agent_activity_recorded" } },
      });
      expect(assessed!.evidence).not.toHaveProperty("executionReconciliation");

      // Assessed runs are not held back by the reconciliation window.
      await settleUnrecoverableExecutions(db, new Date());
      const [settled] = await legacyActions(issueId);
      expect(settled).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: settled!.id });
    });

    it.each([
      ["an adapter invocation event", "run_event:adapter.invoke"],
      ["a tool call event", "run_event:tool_call"],
    ])("never reconciles a run with %s", async (_label, reason) => {
      const { companyId, agentId, issueId } = await seedCompany();
      const run = await seedStoppedRun({ companyId, agentId, issueId });
      await db.insert(heartbeatRunEvents).values({
        companyId, runId: run.id, agentId, seq: 2,
        eventType: reason.replace("run_event:", ""), stream: "system", level: "info", message: "adapter activity",
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, notInert: 1 });
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "active",
        evidence: { inertRunAssessment: { verdict: "not_inert", reason } },
      });
    });

    it.each([
      ["a recorded process", { processPid: 5150 }],
      ["recorded output", { lastOutputSeq: 3, lastOutputAt: new Date(), lastOutputBytes: 120 }],
      ["a dispatched adapter", { executionStage: "dispatching" }],
      ["an unknown dispatch stage", { executionStage: null }],
    ] as const)("leaves a run with %s to the regular disposition", async (_label, overrides) => {
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({ companyId, agentId, issueId, overrides });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0, reconciled: 0 });
      await settleUnrecoverableExecutions(db, new Date());
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "resolved",
        evidence: { automaticRecovery: { replay: "blocked" } },
      });
    });

    it("keeps a board operator's Stop: no automatic continuation", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, invocationSource: "assignment", status: "running",
        runtimeMode: "legacy", executionStage: "preparing", controllerBootId: randomUUID(),
        startedAt: new Date(Date.now() - 30_000), contextSnapshot: { issueId }, nextEventSeq: 10,
      });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      // The call the board-only run cancel route makes.
      const cancelled = await heartbeat.cancelRun(runId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: null },
      });
      expect(cancelled).toMatchObject({ status: "cancelled", executionStage: "preparing" });
      const [action] = await legacyActions(issueId);
      expect(action).toMatchObject({ status: "active" });

      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0, reconciled: 0 });
      // No reconciliation window either: the regular disposition applies at once.
      await settleUnrecoverableExecutions(db, new Date());
      const [settled] = await legacyActions(issueId);
      expect(settled).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });
      expect(settled!.evidence).not.toHaveProperty("executionReconciliation");

      const wake = vi.fn();
      await deliverReconciledExecutions(db, wake as never);
      expect(wake).not.toHaveBeenCalled();
      expect(await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"),
      ))).toHaveLength(0);
    });

    it.each([
      ["a subtree pause or cancel", { resultJson: { cancelledByActorType: "user", cancelledByUserId: null } }],
      ["an interrupt by comment", { errorCode: "operator_interrupted" }],
      ["a chat control stop", { errorCode: "chat_control_completed_source" }],
    ])("leaves a run stopped by %s to an operator", async (_label, stop) => {
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({ companyId, agentId, issueId, stop });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0, reconciled: 0 });
      await settleUnrecoverableExecutions(db, new Date());
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "resolved",
        evidence: { automaticRecovery: { replay: "blocked" } },
      });
    });

    it("does not let continuations waiting for paused owners crowd out other owners", async () => {
      const paused = await seedCompany();
      for (let i = 0; i < 25; i += 1) {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId, companyId: paused.companyId, title: `Task ${i}`, status: "in_progress",
          priority: "medium", assigneeAgentId: paused.agentId, issueNumber: 10 + i,
          identifier: `PS-${i}-${issueId.slice(0, 4)}`,
        });
        await seedStoppedRun({ companyId: paused.companyId, agentId: paused.agentId, issueId });
      }
      await seedStoppedRun(paused);
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, paused.agentId));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 25 });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });

      const active = await seedCompany();
      const [activeAction] = await (async () => {
        await seedStoppedRun(active);
        expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
        return legacyActions(active.issueId);
      })();
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(active.agentId, expect.objectContaining({
        idempotencyKey: `execution-reconciliation:${activeAction!.id}`,
      }));
      const pausedPending = (await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.companyId, paused.companyId)))
        .filter((row) => row.evidence.continuationDelivery === "pending");
      expect(pausedPending).toHaveLength(26);

      // Delivered once the owner is invokable again.
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, paused.agentId));
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(26);
    });

    it("leaves a continuation out of the delivery batch while a first-class blocker is unresolved", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({ companyId, agentId, issueId });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
      // A blocker added after the reconciliation.
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium",
        issueNumber: 2, identifier: `BLK-${blockerId.slice(0, 4)}`,
      });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      await deliverReconciledExecutions(db, wake);
      expect(wake).not.toHaveBeenCalled();
      expect((await legacyActions(issueId))[0]!.evidence).toMatchObject({ continuationDelivery: "pending" });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_recovery_action_restored" }));
    });

    it("does not chain automatic continuations", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({
        companyId, agentId, issueId,
        overrides: { contextSnapshot: { issueId, source: "execution.reconciled" } },
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0 });
      expect((await legacyActions(issueId))[0]).toMatchObject({ status: "active" });
    });

    it("keeps every hold for an operator when the kill switch is off", async () => {
      process.env[INERT_RUN_AUTO_RECONCILE_ENV] = "0";
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({ companyId, agentId, issueId });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0, reconciled: 0 });
      await settleUnrecoverableExecutions(db, new Date());
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "resolved",
        evidence: { automaticRecovery: { replay: "blocked" } },
      });
    });

    it("returns the run to the regular disposition after the window", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      await seedStoppedRun({
        companyId, agentId, issueId,
        finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000),
      });
      await settleUnrecoverableExecutions(db, new Date());
      expect((await legacyActions(issueId))[0]).toMatchObject({ status: "resolved" });
    });
  });

  describe("wakes held by a recovery action", () => {
    async function holdDependencyAndCommentWakes() {
      const fixture = await seedCompany();
      const { companyId, agentId, issueId } = fixture;
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId, companyId, title: "Blocker", status: "done", priority: "medium",
        issueNumber: 2, identifier: `BLK-${blockerId.slice(0, 4)}`,
      });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
      const run = await seedStoppedRun({ companyId, agentId, issueId, overrides: { processPid: 4300 } });
      const [action] = await legacyActions(issueId);
      const heartbeat = heartbeatService(db);
      expect(await heartbeat.wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        payload: { issueId, resolvedBlockerIssueId: blockerId, blockerIssueIds: [blockerId] },
        requestedByActorType: "system", requestedByActorId: "issue_update",
        idempotencyKey: `issue_blockers_resolved:state:${issueId}`,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON },
      })).toBeNull();
      expect(await heartbeat.wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId }, requestedByActorType: "system", requestedByActorId: "agent-comment",
        contextSnapshot: { issueId, taskId: issueId },
      })).toBeNull();
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        status: "skipped",
        reason: "execution_reconciliation_required",
        coalescedCount: 1,
        payload: { issueId, executionWait: { recoveryActionId: action!.id } },
      });
      expect(await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued"),
      ))).toHaveLength(0);
      return { ...fixture, run, action: action!, receipt: receipts[0]! };
    }

    it("logs every skipped dependency wake with its issue, agent, reason and recovery action", async () => {
      const warn = vi.spyOn(logger, "warn");
      const { agentId, issueId, action } = await holdDependencyAndCommentWakes();
      const lines = warn.mock.calls.filter(([fields]) =>
        (fields as Record<string, unknown>)?.event === "dependency_wake_skipped");
      expect(lines).toHaveLength(1);
      expect(lines[0]![0]).toMatchObject({
        issueId,
        agentId,
        reason: "execution_reconciliation_required",
        recoveryActionId: action.id,
        wakeStatus: "skipped",
        detail: "execution_recovery",
      });
    });

    it("reports a skip without a recovery hold at info level", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const observedFrom = new Date(Date.now() - 1_000);
      await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "issue_dependencies_blocked", status: "skipped",
        payload: { issueId, heartbeatSkip: { reason: "issue_dependencies_blocked" } },
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      const report = await reportSkippedDependencyWake(db, { agentId, issueId, observedFrom }, log as never);
      expect(report).toMatchObject({ issueId, agentId, reason: "issue_dependencies_blocked", recoveryActionId: null });
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "dependency_wake_skipped", issueId, agentId, reason: "issue_dependencies_blocked" }),
        "dependency wake skipped",
      );
      expect(log.warn).not.toHaveBeenCalled();
    });

    it("delivers held wakes once when an operator closes the hold without a continuation", async () => {
      const { agentId, issueId, action, receipt } = await holdDependencyAndCommentWakes();
      await db.update(issueRecoveryActions).set({
        status: "cancelled", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      }).where(eq(issueRecoveryActions.id, action.id));
      expect(await getExecutionBlocker(db, action.companyId, issueId)).toBeNull();

      const runId = randomUUID();
      const wake = vi.fn(async () => ({ id: runId }) as never);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 1 });
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(agentId, expect.objectContaining({
        reason: "issue_recovery_action_restored",
        idempotencyKey: heldExecutionWaitReleaseIdempotencyKey({
          issueId, agentId, heldWakes: [{ id: receipt.id, signalCount: 2 }],
        }),
        payload: expect.objectContaining({
          issueId,
          releasedRecoveryActionIds: [action.id],
          releasedExecutionWaitIds: [receipt.id],
          heldSignalCount: 2,
        }),
        contextSnapshot: expect.objectContaining({
          issueId, source: "execution.hold_released", releasedRecoveryActionIds: [action.id],
        }),
      }));
      // Not recovery-scoped: the released wake asks for the work itself.
      const [, opts] = wake.mock.calls[0] as unknown as [string, { payload: object; contextSnapshot: object }];
      expect(opts.payload).not.toHaveProperty("recoveryActionId");
      expect(opts.contextSnapshot).not.toHaveProperty("recoveryActionId");
      const [released] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
      expect(released!.payload).toMatchObject({
        executionWait: { recoveryActionId: action.id, releaseOutcome: "delivered", releaseRunId: runId, releasedSignalCount: 2 },
      });
      const [marked] = await legacyActions(issueId);
      expect(marked!.evidence).toMatchObject({ heldWakeRelease: { state: "delivered", runId } });

      // Idempotent across sweeps.
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ checked: 0 });
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["cancelled by an operator", { status: "cancelled", outcome: "cancelled" }],
      ["restored by an operator", { status: "resolved", outcome: "restored" }],
    ] as const)("tells the owner to do the work, not to recover, when the hold was %s", async (_label, closed) => {
      const { companyId, agentId, issueId, action } = await holdDependencyAndCommentWakes();
      await db.update(issueRecoveryActions).set({ ...closed, resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(issueRecoveryActions.id, action.id));
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 1 });
      const [, opts] = wake.mock.calls[0] as unknown as [string, { contextSnapshot: Record<string, unknown> }];

      // Render exactly what the adapter would receive for this wake.
      const wakePayload = await buildPaperclipWakePayload({
        db, companyId, agentId, contextSnapshot: { ...opts.contextSnapshot },
      });
      expect(wakePayload).toMatchObject({ reason: "issue_recovery_action_restored", recovery: null });
      const prompt = renderPaperclipWakePrompt(wakePayload);
      expect(prompt).toContain("Ship the feature");
      expect(prompt).not.toContain("Recovery contract");
      expect(prompt).not.toContain("recovery cause:");
    });

    it("does not wake again when the owner already ran on the task after the held signals", async () => {
      const { companyId, agentId, issueId, action, receipt } = await holdDependencyAndCommentWakes();
      await db.update(issueRecoveryActions).set({
        status: "resolved", outcome: "restored", resolvedAt: new Date(),
        evidence: { ...action.evidence, continuationDelivery: "delivered" },
      }).where(eq(issueRecoveryActions.id, action.id));
      const continuationId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: continuationId, companyId, agentId, invocationSource: "automation", status: "succeeded",
        contextSnapshot: { issueId }, createdAt: new Date(receipt.updatedAt.getTime() + 1_000),
      });
      const wake = vi.fn();
      expect(await deliverReleasedExecutionWaits(db, wake as never)).toMatchObject({ covered: 1, delivered: 0 });
      expect(wake).not.toHaveBeenCalled();
    });

    it("leaves pending reconciled continuations and live holds alone", async () => {
      const { issueId, action } = await holdDependencyAndCommentWakes();
      const wake = vi.fn();
      // Still an effective hold.
      await db.update(issueRecoveryActions).set({
        status: "resolved", resolvedAt: new Date(),
        evidence: { ...action.evidence, automaticRecovery: { replay: "blocked" } },
      }).where(eq(issueRecoveryActions.id, action.id));
      expect(await deliverReleasedExecutionWaits(db, wake as never)).toMatchObject({ checked: 0 });
      // Reconciled; its continuation delivery owns the wake.
      await db.update(issueRecoveryActions).set({
        evidence: { ...action.evidence, continuationDelivery: "pending" },
      }).where(eq(issueRecoveryActions.id, action.id));
      expect(await deliverReleasedExecutionWaits(db, wake as never)).toMatchObject({ checked: 0 });
      expect(wake).not.toHaveBeenCalled();
      expect(await getExecutionBlocker(db, action.companyId, issueId)).toBeNull();
    });

    it("can be switched off", async () => {
      process.env[HELD_EXECUTION_WAIT_RELEASE_ENV] = "0";
      const { action } = await holdDependencyAndCommentWakes();
      await db.update(issueRecoveryActions).set({ status: "cancelled", resolvedAt: new Date() })
        .where(eq(issueRecoveryActions.id, action.id));
      const wake = vi.fn();
      expect(await deliverReleasedExecutionWaits(db, wake as never)).toMatchObject({ checked: 0 });
      expect(wake).not.toHaveBeenCalled();
    });

    it("releases the held dependency wake end to end after automatic reconciliation", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const run = await seedStoppedRun({ companyId, agentId, issueId });
      const [action] = await legacyActions(issueId);
      const heartbeat = heartbeatService(db);
      expect(await heartbeat.wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        payload: { issueId }, requestedByActorType: "system", requestedByActorId: "issue_update",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON },
      })).toBeNull();

      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
      const continuationRunId = randomUUID();
      const wake = vi.fn(async () => {
        await db.insert(heartbeatRuns).values({
          id: continuationRunId, companyId, agentId, invocationSource: "automation", status: "queued",
          contextSnapshot: { issueId, recoveryActionId: action!.id, previousRunId: run.id },
        });
        return { id: continuationRunId } as never;
      });
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      const [delivered] = await legacyActions(issueId);
      expect(delivered!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId });

      // The continuation covers the held dependency wake; its delivery says so.
      const [receipt] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "execution_reconciliation_required"),
      ));
      expect(receipt!.payload).toMatchObject({
        executionWait: { recoveryActionId: action!.id, releaseOutcome: "covered", releaseRunId: continuationRunId },
      });
      // The sweep finds nothing left and settles the action.
      const releaseWake = vi.fn();
      expect(await deliverReleasedExecutionWaits(db, releaseWake as never)).toMatchObject({ checked: 1, covered: 0 });
      expect(releaseWake).not.toHaveBeenCalled();
      expect((await legacyActions(issueId))[0]!.evidence).toMatchObject({ heldWakeRelease: { state: "no_held_wakes" } });
    });
  });

  describe("releasing held wakes on every path that ends the last hold", () => {
    const HELD = "execution_reconciliation_required";
    // Recorded output makes a run ineligible for automatic reconciliation
    // without a process id that the operator path would probe.
    const workedRun = { lastOutputSeq: 3, lastOutputAt: new Date(), lastOutputBytes: 64 };

    function createApp(wake: ReturnType<typeof vi.fn>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = { type: "board", source: "local_implicit" };
        next();
      });
      app.use("/api", issueRoutes(db, {} as any, { recoveryActionEnqueueWakeup: wake as never }));
      app.use(errorHandler);
      return app;
    }

    async function addAgent(companyId: string, name: string) {
      const id = randomUUID();
      await db.insert(agents).values({
        id, companyId, name, role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      return id;
    }

    /** Real admission queues runs without starting a provider process. */
    async function prepareRealAdmission(companyId: string, agentId: string) {
      const userId = randomUUID();
      await db.insert(authUsers).values({
        id: userId, name: "Operator", email: `${userId}@example.test`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await db.update(companies).set({ defaultResponsibleUserId: userId }).where(eq(companies.id, companyId));
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "manual", status: "running", startedAt: new Date(),
      });
      return userId;
    }

    /** An automatic signal that admission keeps back as a skipped receipt. */
    async function holdSignal(agentId: string, issueId: string) {
      expect(await heartbeatService(db).wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId }, requestedByActorType: "system", requestedByActorId: "agent-comment",
        contextSnapshot: { issueId, taskId: issueId },
      })).toBeNull();
    }

    /** A user comment admission saved behind the hold (the shape it records). */
    async function saveCommentQueue(input: { companyId: string; agentId: string; issueId: string; actionId: string }) {
      const userId = `user-${randomUUID()}`;
      const [comment] = await db.insert(issueComments).values({
        companyId: input.companyId, issueId: input.issueId, authorType: "user", authorUserId: userId,
        body: "Please also update the changelog.",
      }).returning();
      const [queue] = await db.insert(agentWakeupRequests).values({
        companyId: input.companyId, agentId: input.agentId, source: "on_demand", triggerDetail: "manual",
        reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: userId,
        payload: {
          issueId: input.issueId,
          commentId: comment!.id,
          executionWait: {
            recoveryActionId: input.actionId, reason: "execution_recovery",
            message: "Waiting for execution recovery. Your message is saved.",
          },
          _paperclipWakeContext: {
            issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_commented",
            commentId: comment!.id, wakeCommentId: comment!.id, wakeCommentIds: [comment!.id],
          },
        },
      }).returning();
      return { comment: comment!, queue: queue! };
    }

    async function heldTask() {
      const fixture = await seedCompany();
      const run = await seedStoppedRun({ ...fixture, overrides: workedRun });
      const [action] = await legacyActions(fixture.issueId);
      await holdSignal(fixture.agentId, fixture.issueId);
      await holdSignal(fixture.agentId, fixture.issueId);
      const [receipt] = await wakeRows(fixture.issueId, HELD);
      expect(receipt).toMatchObject({ agentId: fixture.agentId, coalescedCount: 1 });
      const saved = await saveCommentQueue({ ...fixture, actionId: action!.id });
      return { ...fixture, run, action: action!, receipt: receipt!, ...saved };
    }

    async function wakeRows(issueId: string, reason?: string) {
      const rows = await db.select().from(agentWakeupRequests)
        .where(reason ? eq(agentWakeupRequests.reason, reason) : undefined);
      return rows.filter((row) => row.payload?.issueId === issueId);
    }

    async function row(id: string) {
      return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
    }

    async function closeHold(actionId: string, set: Partial<typeof issueRecoveryActions.$inferInsert> = {}) {
      await db.update(issueRecoveryActions).set({
        status: "cancelled", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date(), ...set,
      }).where(eq(issueRecoveryActions.id, actionId));
    }

    const releaseKeyPrefix = (issueId: string, agentId: string) => `execution-hold-released:${issueId}:${agentId}:`;

    /** Stands in for admission: queues a run and adopts the agent's saved comments. */
    function admittingWake() {
      return vi.fn(async (agentId: string, opts: { payload?: Record<string, unknown> }) => {
        const runId = randomUUID();
        await db.update(agentWakeupRequests).set({ status: "coalesced", runId, finishedAt: new Date() }).where(and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          eq(agentWakeupRequests.reason, "issue_commented"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${String(opts.payload?.issueId)}`,
        ));
        return { id: runId } as never;
      });
    }

    it("releases once when an operator cancels the hold through the resolve route", async () => {
      const { companyId, agentId, issueId, action, receipt, queue } = await heldTask();
      const wake = admittingWake();
      const app = createApp(wake);
      await request(app).post(`/api/issues/${issueId}/recovery-actions/resolve`)
        .send({ actionId: action.id, outcome: "cancelled", sourceIssueStatus: "in_review" })
        .expect(200);
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();

      // Delivered by the route itself, to the current assignee, as one wake.
      expect(wake).toHaveBeenCalledTimes(1);
      const [target, opts] = wake.mock.calls[0] as unknown as [string, Record<string, any>];
      expect(target).toBe(agentId);
      expect(opts.idempotencyKey.startsWith(releaseKeyPrefix(issueId, agentId))).toBe(true);
      expect(opts.payload).toMatchObject({
        issueId, releasedRecoveryActionIds: [action.id], heldSignalCount: 3,
      });
      expect([...opts.payload.releasedExecutionWaitIds].sort()).toEqual([receipt.id, queue.id].sort());
      expect(opts.payload).not.toHaveProperty("recoveryActionId");

      // Neither the sweep nor a replayed request delivers it again.
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ checked: 1, delivered: 0 });
      await request(app).post(`/api/issues/${issueId}/recovery-actions/resolve`)
        .send({ actionId: action.id, outcome: "cancelled", sourceIssueStatus: "in_review" })
        .expect(200);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "no_held_wakes" });
      expect(wake).toHaveBeenCalledTimes(1);
      expect((await row(receipt.id)).payload).toMatchObject({
        executionWait: { releaseOutcome: "delivered", releasedSignalCount: 2 },
      });
    });

    it("releases once when an operator restores the task for review through the route", async () => {
      const { agentId, issueId, action } = await heldTask();
      const wake = admittingWake();
      await request(createApp(wake)).post(`/api/issues/${issueId}/recovery-actions/resolve`)
        .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "in_review" })
        .expect(200);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_recovery_action_restored" }));
      await deliverReleasedExecutionWaits(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("finalizes held wakes without a wake when the route closes the task", async () => {
      const { issueId, action, receipt, queue } = await heldTask();
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      await request(createApp(wake)).post(`/api/issues/${issueId}/recovery-actions/resolve`)
        .send({ actionId: action.id, outcome: "restored", sourceIssueStatus: "done" })
        .expect(200);
      expect(wake).not.toHaveBeenCalled();
      expect((await row(receipt.id)).payload).toMatchObject({
        executionWait: { releaseOutcome: "not_applicable", releaseReason: "task_closed" },
      });
      // The saved queue is closed; the comment stays on the task.
      expect(await row(queue.id)).toMatchObject({
        status: "cancelled",
        payload: { executionWait: { releaseOutcome: "not_applicable", releaseReason: "task_closed" } },
      });
      const snapshot = [await row(receipt.id), await row(queue.id)];
      await deliverReleasedExecutionWaits(db, wake);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId: (await row(receipt.id)).companyId, issueId }))
        .toMatchObject({ state: "no_held_wakes" });
      expect(wake).not.toHaveBeenCalled();
      expect([await row(receipt.id), await row(queue.id)]).toEqual(snapshot);
    });

    it("lets a route reconciliation's continuation carry the held wakes, then records them once", async () => {
      const { companyId, agentId, issueId, run, action, receipt, queue, comment } = await heldTask();
      await prepareRealAdmission(companyId, agentId);
      const routeWake = vi.fn(async () => ({ id: randomUUID() }) as never);
      await request(createApp(routeWake)).post(`/api/issues/${issueId}/recovery-actions/resolve`)
        .send({
          actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
          executionReconciliation: {
            runId: run.id, providerStopped: true, actionOutcome: "not_performed",
            outcomeEvidence: "The provider log shows the request was never submitted before the stop.",
          },
        })
        .expect(200);
      // The pending continuation owns the next turn.
      expect(routeWake).not.toHaveBeenCalled();
      expect(await releaseHeldExecutionWaits(db, routeWake, { companyId, issueId })).toMatchObject({
        state: "continuation_pending",
      });

      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      const wake = vi.fn(heartbeat.wakeup);
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      const [continuationWake] = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${action.id}`));
      expect(continuationWake).toMatchObject({ status: "queued" });
      // The continuation adopted the saved comment and covers the held signals.
      expect(await row(queue.id)).toMatchObject({ status: "coalesced", runId: continuationWake!.runId });
      const [continuation] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, continuationWake!.runId!));
      expect(continuation!.contextSnapshot).toMatchObject({ wakeCommentIds: [comment.id] });
      expect((await row(receipt.id)).payload).toMatchObject({
        executionWait: { releaseOutcome: "covered", releaseRunId: continuation!.id },
      });

      await deliverReleasedExecutionWaits(db, wake);
      await deliverReconciledExecutions(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(await db.select().from(agentWakeupRequests)
        .where(like(agentWakeupRequests.idempotencyKey, "execution-hold-released:%"))).toHaveLength(0);
    });

    it("releases once when a settled no-replay hold is later reconciled through the route", async () => {
      const { companyId, agentId, issueId, run, action, receipt } = await heldTask();
      await settleUnrecoverableExecutions(db, new Date());
      const [settled] = await legacyActions(issueId);
      expect(settled).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });
      // A settled hold is still a hold: nothing is released by the sweep.
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ checked: 0 });
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "held" });

      await request(createApp(wake)).post(`/api/issues/${issueId}/recovery-actions/resolve`)
        .send({
          actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
          executionReconciliation: {
            runId: run.id, providerStopped: true, actionOutcome: "completed",
            outcomeEvidence: "The pushed branch and the recorded comment match the provider receipts.",
          },
        })
        .expect(200);
      expect(wake).not.toHaveBeenCalled();
      const continuationRunId = randomUUID();
      const continuationWake = vi.fn(async (_agentId: string, opts: { idempotencyKey?: string | null }) => {
        if (!opts.idempotencyKey?.startsWith("execution-reconciliation:")) return { id: randomUUID() } as never;
        await db.insert(heartbeatRuns).values({
          id: continuationRunId, companyId, agentId, invocationSource: "automation", status: "queued",
          contextSnapshot: { issueId, recoveryActionId: action.id, previousRunId: run.id },
        });
        return { id: continuationRunId } as never;
      });
      await deliverReconciledExecutions(db, continuationWake as never);
      // One continuation wake. This stand-in continuation does not adopt the
      // saved comment the way admission does, so the comment still needs a
      // delivery of its own: exactly one release wake.
      expect(continuationWake).toHaveBeenCalledTimes(2);
      expect((continuationWake.mock.calls[1] as unknown as [string, Record<string, any>])[1].idempotencyKey
        .startsWith(releaseKeyPrefix(issueId, agentId))).toBe(true);
      expect((await row(receipt.id)).payload).toMatchObject({ executionWait: { releaseOutcome: "delivered" } });
      await deliverReleasedExecutionWaits(db, continuationWake as never);
      await deliverReconciledExecutions(db, continuationWake as never);
      expect(continuationWake).toHaveBeenCalledTimes(2);
    });

    it("delivers the saved comment through real admission when the hold is cancelled", async () => {
      const { companyId, agentId, issueId, action, receipt, queue, comment } = await heldTask();
      await prepareRealAdmission(companyId, agentId);
      await closeHold(action.id);
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      const wake = vi.fn(heartbeat.wakeup);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "delivered" });
      expect(wake).toHaveBeenCalledTimes(1);
      const [released] = await db.select().from(agentWakeupRequests)
        .where(like(agentWakeupRequests.idempotencyKey, `${releaseKeyPrefix(issueId, agentId)}%`));
      expect(released).toMatchObject({ status: "queued", agentId });
      expect(await row(queue.id)).toMatchObject({ status: "coalesced", runId: released!.runId });
      const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, released!.runId!));
      expect(queuedRun!.contextSnapshot).toMatchObject({
        issueId, source: "execution.hold_released", wakeCommentIds: [comment.id],
      });
      expect((await row(receipt.id)).payload).toMatchObject({
        executionWait: { releaseOutcome: "delivered", releaseRunId: queuedRun!.id },
      });
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "no_held_wakes" });
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("delivers to the current assignee and finalizes the previous assignee's held wakes", async () => {
      const { companyId, agentId: previousId, issueId, action, receipt, queue } = await heldTask();
      const currentId = await addAgent(companyId, "Maintainer");
      await db.update(issues).set({ assigneeAgentId: currentId }).where(eq(issues.id, issueId));
      // The new assignee's own signal is held too.
      await holdSignal(currentId, issueId);
      const currentReceipt = (await wakeRows(issueId, HELD)).find((wake) => wake.agentId === currentId)!;
      await closeHold(action.id);

      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 1, finalized: 2 });
      expect(wake).toHaveBeenCalledTimes(1);
      const [target, opts] = wake.mock.calls[0] as unknown as [string, Record<string, any>];
      expect(target).toBe(currentId);
      expect(opts.payload.releasedExecutionWaitIds).toEqual([currentReceipt.id]);

      // The previous assignee's receipt is closed, and its saved queue is
      // cancelled; the comment itself stays on the task.
      const previousReceipt = await row(receipt.id);
      expect(previousReceipt.payload).toMatchObject({
        executionWait: { releaseOutcome: "not_applicable", releaseReason: "not_assignee", releasedSignalCount: 2 },
      });
      const previousQueue = await row(queue.id);
      expect(previousQueue).toMatchObject({ status: "cancelled", agentId: previousId });
      expect(previousQueue.finishedAt).not.toBeNull();

      // Nothing is revisited: later passes neither wake nor touch those rows.
      const snapshot = [await row(receipt.id), await row(queue.id), await row(currentReceipt.id)];
      await db.update(issueRecoveryActions).set({
        evidence: sql`${issueRecoveryActions.evidence} - 'heldWakeRelease'`,
      }).where(eq(issueRecoveryActions.id, action.id));
      await deliverReleasedExecutionWaits(db, wake);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "no_held_wakes" });
      expect(wake).toHaveBeenCalledTimes(1);
      expect([await row(receipt.id), await row(queue.id), await row(currentReceipt.id)]).toEqual(snapshot);
    });

    it("wakes no one when only a previous assignee had held wakes", async () => {
      const { companyId, issueId, action, receipt, queue } = await heldTask();
      const currentId = await addAgent(companyId, "Maintainer");
      await db.update(issues).set({ assigneeAgentId: currentId }).where(eq(issues.id, issueId));
      await closeHold(action.id);
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({
        state: "not_applicable", agentId: currentId,
      });
      expect(wake).not.toHaveBeenCalled();
      expect(await row(queue.id)).toMatchObject({ status: "cancelled" });
      expect((await row(receipt.id)).payload).toMatchObject({ executionWait: { releaseOutcome: "not_applicable" } });
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "no_held_wakes" });
    });

    it("leaves a saved queue of an agent that was only mentioned alone", async () => {
      const { companyId, issueId, action } = await heldTask();
      const mentionedId = await addAgent(companyId, "Reviewer");
      const mention = await saveCommentQueue({ companyId, agentId: mentionedId, issueId, actionId: action.id });
      await closeHold(action.id);
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      await releaseHeldExecutionWaits(db, wake, { companyId, issueId });
      expect(await row(mention.queue.id)).toMatchObject({ status: "deferred_issue_execution" });
    });

    it("delivers exactly once under concurrent releasers", async () => {
      const { companyId, agentId, issueId, action } = await heldTask();
      await closeHold(action.id);
      let calls = 0;
      const wake = vi.fn(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { id: randomUUID() } as never;
      });
      const results = await Promise.all([
        releaseHeldExecutionWaits(db, wake, { companyId, issueId }),
        releaseHeldExecutionWaits(db, wake, { companyId, issueId }),
        deliverReleasedExecutionWaits(db, wake),
        releaseHeldExecutionWaits(db, wake, { companyId, issueId }),
      ]);
      expect(calls).toBe(1);
      expect(wake).toHaveBeenCalledWith(agentId, expect.anything());
      expect(results.filter((result) => "state" in result && result.state === "delivered")).toHaveLength(1);
      await deliverReleasedExecutionWaits(db, wake);
      expect(calls).toBe(1);
    });

    it("recognizes a delivery an interrupted releaser already made", async () => {
      const { companyId, agentId, issueId, action, receipt, queue } = await heldTask();
      await closeHold(action.id);
      const key = heldExecutionWaitReleaseIdempotencyKey({
        issueId, agentId, heldWakes: [{ id: receipt.id, signalCount: 2 }, { id: queue.id, signalCount: 1 }],
      });
      // The earlier attempt claimed, was admitted, and stopped before marking.
      const stale = new Date(Date.now() - HELD_EXECUTION_WAIT_RELEASE_RETRY_MS - 1_000).toISOString();
      for (const id of [receipt.id, queue.id]) {
        await db.update(agentWakeupRequests).set({
          payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{executionWait,releaseClaim}', ${JSON.stringify({ key, at: stale, attempts: 0 })}::jsonb)`,
        }).where(eq(agentWakeupRequests.id, id));
      }
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", status: "queued" });
      await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", reason: "issue_recovery_action_restored", status: "queued",
        idempotencyKey: key, runId, payload: { issueId },
      });
      // Admission adopted the saved queue into that run.
      await db.update(agentWakeupRequests).set({ status: "coalesced", runId }).where(eq(agentWakeupRequests.id, queue.id));

      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "delivered", runId });
      expect(wake).not.toHaveBeenCalled();
      expect((await row(receipt.id)).payload).toMatchObject({ executionWait: { releaseOutcome: "delivered", releaseRunId: runId } });
    });

    it("retries a declined delivery at the retry pace with the same key, then delivers once", async () => {
      const { companyId, issueId, action } = await heldTask();
      await closeHold(action.id);
      const wake = vi.fn()
        .mockRejectedValueOnce(new Error("Agent is paused"))
        .mockResolvedValue({ id: randomUUID() });
      expect(await releaseHeldExecutionWaits(db, wake as never, { companyId, issueId })).toMatchObject({ state: "retry" });
      expect(await releaseHeldExecutionWaits(db, wake as never, { companyId, issueId })).toMatchObject({ state: "claimed" });
      expect(wake).toHaveBeenCalledTimes(1);
      const later = new Date(Date.now() + HELD_EXECUTION_WAIT_RELEASE_RETRY_MS + 1_000);
      expect(await releaseHeldExecutionWaits(db, wake as never, { companyId, issueId, now: later })).toMatchObject({
        state: "delivered",
      });
      expect(wake).toHaveBeenCalledTimes(2);
      const keys = wake.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
      expect(keys[1]).toBe(keys[0]);
    });

    it("keeps wakes held until the last hold on the task is gone", async () => {
      const { companyId, agentId, issueId, action } = await heldTask();
      // A second incident on the same task while the first is still open.
      await seedStoppedRun({ companyId, agentId, issueId, overrides: workedRun });
      const newer = (await legacyActions(issueId)).find((candidate) => candidate.status === "active")!;
      expect(newer.id).not.toBe(action.id);
      const wake = admittingWake();
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "held" });
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 0 });
      expect(wake).not.toHaveBeenCalled();

      await closeHold(newer.id);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 1 });
      expect(wake).toHaveBeenCalledTimes(1);
      await deliverReleasedExecutionWaits(db, wake, new Date(Date.now() + HELD_EXECUTION_WAIT_RELEASE_RETRY_MS + 1_000));
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("delivers signals held for longer than a day", async () => {
      const { companyId, issueId, action, receipt } = await heldTask();
      await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) })
        .where(eq(agentWakeupRequests.id, receipt.id));
      await closeHold(action.id);
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 1 });
      expect((wake.mock.calls[0] as unknown as [string, Record<string, any>])[1].payload.releasedExecutionWaitIds)
        .toContain(receipt.id);
      void companyId;
    });

    it("releases again, once, for a new hold on the same task", async () => {
      const { companyId, agentId, issueId, action } = await heldTask();
      await closeHold(action.id);
      const wake = admittingWake();
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "delivered" });
      // A later incident holds a new signal.
      await seedStoppedRun({ companyId, agentId, issueId, overrides: workedRun });
      const next = (await legacyActions(issueId)).find((candidate) => candidate.status === "active")!;
      await holdSignal(agentId, issueId);
      await closeHold(next.id);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "delivered" });
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({ state: "no_held_wakes" });
      expect(wake).toHaveBeenCalledTimes(2);
      const [first, second] = wake.mock.calls.map((call) => (call[1] as unknown as { idempotencyKey: string }).idempotencyKey);
      expect(second).not.toBe(first);
    });

    it("releases after a hold ends through an explicit continuation that changes the disposition", async () => {
      const { companyId, agentId, issueId, action } = await heldTask();
      await settleUnrecoverableExecutions(db, new Date());
      // The shape an explicit user continuation leaves: no longer a hold.
      const [settled] = await legacyActions(issueId);
      await db.update(issueRecoveryActions).set({
        outcome: "cancelled", resolvedAt: new Date(),
        evidence: { ...settled!.evidence, automaticRecovery: {
          ...(settled!.evidence.automaticRecovery as object), replay: "explicit_user_continuation",
        } },
      }).where(eq(issueRecoveryActions.id, action.id));
      const wake = vi.fn(async () => ({ id: randomUUID() }) as never);
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ delivered: 1 });
      expect(wake).toHaveBeenCalledWith(agentId, expect.anything());
      await deliverReleasedExecutionWaits(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("keeps a paused owner's held wakes past the lookback and delivers them once it is resumed", async () => {
      const { agentId, issueId, action, receipt, queue } = await heldTask();
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      await closeHold(action.id);
      const wake = admittingWake();
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ checked: 1, delivered: 0 });
      // No wake is spent on an owner that would only decline it.
      expect(wake).not.toHaveBeenCalled();
      expect((await legacyActions(issueId))[0]!.evidence).toMatchObject({
        heldWakeRelease: { state: "retry", reason: "owner_unavailable" },
      });

      // Paused for longer than the lookback: still retried, still kept.
      const dayLater = new Date(Date.now() + HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS + 60 * 60_000);
      expect(await deliverReleasedExecutionWaits(db, wake, dayLater)).toMatchObject({ checked: 1, delivered: 0 });
      expect(await row(queue.id)).toMatchObject({ status: "deferred_issue_execution" });

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      const resumed = new Date(dayLater.getTime() + HELD_EXECUTION_WAIT_RELEASE_RETRY_MS + 1_000);
      expect(await deliverReleasedExecutionWaits(db, wake, resumed)).toMatchObject({ delivered: 1 });
      expect(wake).toHaveBeenCalledTimes(1);
      expect(await row(queue.id)).toMatchObject({ status: "coalesced" });
      expect((await row(receipt.id)).payload).toMatchObject({
        executionWait: { releaseOutcome: "delivered", releasedSignalCount: 2 },
      });
      await deliverReleasedExecutionWaits(db, wake, new Date(resumed.getTime() + HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS));
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("keeps retrying a declined delivery past the lookback, backing off, then delivers once", async () => {
      const { issueId, action, receipt } = await heldTask();
      await closeHold(action.id);
      let declining = true;
      const admit = admittingWake();
      const wake = vi.fn(async (agentId: string, opts: { payload?: Record<string, unknown> }) => {
        if (declining) throw new Error("Budget limit reached");
        return admit(agentId, opts);
      });
      expect(await deliverReleasedExecutionWaits(db, wake as never)).toMatchObject({ retried: 1 });
      const dayLater = new Date(Date.now() + HELD_EXECUTION_WAIT_RELEASE_LOOKBACK_MS + 60 * 60_000);
      expect(await deliverReleasedExecutionWaits(db, wake as never, dayLater)).toMatchObject({ retried: 1 });
      expect((await legacyActions(issueId))[0]!.evidence).toMatchObject({
        heldWakeRelease: { state: "retry", reason: "retry", backoff: 2 },
      });
      declining = false;
      // Two retries in a row: the next attempt waits two retry intervals.
      const tooSoon = new Date(dayLater.getTime() + HELD_EXECUTION_WAIT_RELEASE_RETRY_MS + 60_000);
      expect(await deliverReleasedExecutionWaits(db, wake as never, tooSoon)).toMatchObject({ checked: 0 });
      const due = new Date(dayLater.getTime() + 2 * HELD_EXECUTION_WAIT_RELEASE_RETRY_MS + 1_000);
      expect(await deliverReleasedExecutionWaits(db, wake as never, due)).toMatchObject({ delivered: 1 });
      expect(wake).toHaveBeenCalledTimes(3);
      const keys = wake.mock.calls.map((call) => (call[1] as unknown as { idempotencyKey: string }).idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect((await row(receipt.id)).payload).toMatchObject({ executionWait: { releaseOutcome: "delivered" } });
    });

    it("finalizes a terminated owner's held wakes instead of retrying them", async () => {
      const { companyId, agentId, issueId, action, receipt, queue } = await heldTask();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, agentId));
      await closeHold(action.id);
      const wake = admittingWake();
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({
        state: "not_applicable", agentId,
      });
      expect(wake).not.toHaveBeenCalled();
      expect((await row(receipt.id)).payload).toMatchObject({
        executionWait: { releaseOutcome: "not_applicable", releaseReason: "owner_not_invokable" },
      });
      expect(await row(queue.id)).toMatchObject({ status: "cancelled" });
      expect(await deliverReleasedExecutionWaits(db, wake)).toMatchObject({ checked: 1, retried: 0 });
      expect((await legacyActions(issueId))[0]!.evidence).toMatchObject({ heldWakeRelease: { state: "no_held_wakes" } });
      expect(wake).not.toHaveBeenCalled();
    });

    it("keeps a saved comment held when admission does not adopt it", async () => {
      const { companyId, issueId, action, receipt, queue } = await heldTask();
      await closeHold(action.id);
      // A gate declines the wake and records its own receipt.
      const gated = vi.fn(async () => null);
      expect(await releaseHeldExecutionWaits(db, gated as never, { companyId, issueId })).toMatchObject({ state: "retry" });
      // That receipt owns the automatic signals; the saved comment is still waiting.
      expect((await row(receipt.id)).payload).toMatchObject({ executionWait: { releaseOutcome: "delivered" } });
      expect(await row(queue.id)).toMatchObject({
        status: "deferred_issue_execution",
        payload: { executionWait: expect.not.objectContaining({ releasedAt: expect.anything() }) },
      });

      const wake = admittingWake();
      const later = new Date(Date.now() + HELD_EXECUTION_WAIT_RELEASE_RETRY_MS + 1_000);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId, now: later })).toMatchObject({
        state: "delivered", deliveredWaitIds: [queue.id],
      });
      expect(await row(queue.id)).toMatchObject({
        status: "coalesced", payload: { executionWait: { releaseOutcome: "delivered" } },
      });
    });

    it("delivers the held wakes of the agent a pending review stage waits on", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const reviewerId = await addAgent(companyId, "Reviewer");
      await db.update(issues).set({
        status: "in_review",
        executionState: {
          status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        },
      }).where(eq(issues.id, issueId));
      await seedStoppedRun({ companyId, agentId: reviewerId, issueId, overrides: workedRun });
      const [action] = await legacyActions(issueId);
      expect(action).toMatchObject({ returnOwnerAgentId: agentId, evidence: { reviewParticipantAgentId: reviewerId } });
      await holdSignal(reviewerId, issueId);
      const [receipt] = (await wakeRows(issueId, HELD)).filter((wake) => wake.agentId === reviewerId);
      expect(receipt).toBeDefined();
      const { queue } = await saveCommentQueue({ companyId, agentId: reviewerId, issueId, actionId: action!.id });
      await closeHold(action!.id);

      const wake = admittingWake();
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId })).toMatchObject({
        state: "delivered", agentId: reviewerId,
      });
      expect(wake).toHaveBeenCalledTimes(1);
      expect((wake.mock.calls[0] as unknown as [string])[0]).toBe(reviewerId);
      expect((await row(receipt!.id)).payload).toMatchObject({ executionWait: { releaseOutcome: "delivered" } });
      // The review stage still waits on this agent: its saved comment is delivered, not cancelled.
      expect(await row(queue.id)).toMatchObject({ status: "coalesced" });
    });

    it("promotes a mention saved behind the hold when the assignee had nothing held", async () => {
      const { companyId, agentId, issueId } = await seedCompany();
      const userId = await prepareRealAdmission(companyId, agentId);
      const reviewerId = await addAgent(companyId, "Reviewer");
      await prepareRealAdmission(companyId, reviewerId);
      await seedStoppedRun({ companyId, agentId, issueId, overrides: workedRun });
      const [action] = await legacyActions(issueId);
      const [comment] = await db.insert(issueComments).values({
        companyId, issueId, authorType: "user", authorUserId: userId, body: "@Reviewer please take a look.",
      }).returning();
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      expect(await heartbeat.wakeup(reviewerId, {
        source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned",
        payload: { issueId, commentId: comment!.id }, requestedByActorType: "user", requestedByActorId: userId,
        contextSnapshot: {
          issueId, taskId: issueId, commentId: comment!.id, wakeCommentId: comment!.id,
          wakeReason: "issue_comment_mentioned",
        },
      })).toBeNull();
      const [mention] = (await wakeRows(issueId)).filter((wake) => wake.agentId === reviewerId);
      expect(mention).toMatchObject({
        status: "deferred_issue_execution", payload: { executionWait: { recoveryActionId: action!.id } },
      });

      // Still held: nothing is promoted.
      const promote = heartbeat.promoteDeferredWakesAfterExecutionHold;
      const wake = vi.fn(heartbeat.wakeup);
      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId, promote })).toMatchObject({ state: "held" });
      expect(await row(mention!.id)).toMatchObject({ status: "deferred_issue_execution" });

      await closeHold(action!.id);
      expect(await deliverReleasedExecutionWaits(db, wake, new Date(), { promote })).toMatchObject({ checked: 1 });
      expect(wake).not.toHaveBeenCalled();
      const promoted = await row(mention!.id);
      expect(promoted.status).not.toBe("deferred_issue_execution");
      const reviewerRuns = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, reviewerId)))
        .filter((run) => run.contextSnapshot?.issueId === issueId);
      expect(reviewerRuns).toHaveLength(1);
      expect(reviewerRuns[0]).toMatchObject({ id: promoted.runId, status: "queued" });
      // The held run itself is not retried.
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter((run) => run.contextSnapshot?.issueId === issueId)).toHaveLength(1);

      expect(await releaseHeldExecutionWaits(db, wake, { companyId, issueId, promote })).toMatchObject({
        state: "no_held_wakes", promotedDeferredWakes: false,
      });
    });
  });

  describe("automatic reconciliation of a settled hold whose run did nothing", () => {
    async function settledInertHold(input: { stop?: Partial<typeof heartbeatRuns.$inferInsert> } = {}) {
      const fixture = await seedCompany();
      // The reconciliation window passed before the run was assessed.
      const run = await seedStoppedRun({
        ...fixture, finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000), stop: input.stop,
      });
      await settleUnrecoverableExecutions(db, new Date());
      const [settled] = await legacyActions(fixture.issueId);
      return { ...fixture, run, settled: settled! };
    }

    it("reconciles it as not performed, hands the task back and releases its held wakes", async () => {
      const { companyId, agentId, issueId, run, settled } = await settledInertHold();
      expect(settled).toMatchObject({
        status: "resolved", outcome: "blocked",
        evidence: { automaticRecovery: { replay: "blocked", issueStatusBefore: "in_progress" } },
      });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("blocked");
      await heartbeatService(db).wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        payload: { issueId }, requestedByActorType: "system", requestedByActorId: "issue_update",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON },
      });

      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
      const [reconciled] = await legacyActions(issueId);
      expect(reconciled).toMatchObject({
        id: settled.id, status: "resolved", outcome: "restored",
        evidence: {
          continuationDelivery: "pending",
          executionReconciliation: { runId: run.id, providerStopped: true, actionOutcome: "not_performed" },
          inertRunAssessment: {
            verdict: "inert", settledDisposition: { replay: "blocked", policy: "preserve_without_replay_v1" },
          },
        },
      });
      expect(reconciled!.evidence).not.toHaveProperty("automaticRecovery");
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("todo");

      const continuationRunId = randomUUID();
      const wake = vi.fn(async () => {
        await db.insert(heartbeatRuns).values({
          id: continuationRunId, companyId, agentId, invocationSource: "automation", status: "queued",
          contextSnapshot: { issueId, recoveryActionId: settled.id, previousRunId: run.id },
        });
        return { id: continuationRunId } as never;
      });
      await deliverReconciledExecutions(db, wake);
      await deliverReleasedExecutionWaits(db, wake);
      expect(wake).toHaveBeenCalledTimes(1);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "execution_reconciliation_required"));
      expect(receipt!.payload).toMatchObject({ executionWait: { releaseOutcome: "covered", releaseRunId: continuationRunId } });
      // Settled once; a later pass does not revisit it.
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0 });
    });

    it("rechecks a settled hold at a bounded pace while its sandbox is releasing", async () => {
      const fixture = await seedCompany();
      const run = await seedStoppedRun({ ...fixture, finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000) });
      const [lease] = await db.insert(environmentLeases).values({
        companyId: fixture.companyId, issueId: fixture.issueId, heartbeatRunId: run.id,
        status: "active", provider: "kubernetes", providerLeaseId: "sandbox-9",
      }).returning();
      await settleUnrecoverableExecutions(db, new Date());
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 1, awaitingRelease: 1 });
      expect((await legacyActions(fixture.issueId))[0]!.evidence).toMatchObject({
        automaticRecovery: { replay: "blocked" }, inertRunAssessment: { verdict: "awaiting_release" },
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0 });

      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
        .where(eq(environmentLeases.id, lease!.id));
      const later = new Date(Date.now() + INERT_RUN_RELEASE_RECHECK_MS + 1_000);
      expect(await reconcileInertLegacyExecutions(db, later)).toMatchObject({ reconciled: 1 });
    });

    it("waits for an unresolved first-class blocker before continuing the task", async () => {
      const fixture = await seedCompany();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId, companyId: fixture.companyId, title: "Blocker", status: "todo", priority: "medium",
        issueNumber: 2, identifier: `BLK-${blockerId.slice(0, 4)}`,
      });
      await db.insert(issueRelations).values({
        companyId: fixture.companyId, issueId: blockerId, relatedIssueId: fixture.issueId, type: "blocks",
      });
      await seedStoppedRun({ ...fixture, finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000) });
      await settleUnrecoverableExecutions(db, new Date());
      // Its continuation could not be admitted yet: nothing is reconciled, and
      // no pending continuation is left to retry on every sweep.
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, deferred: 1 });
      const [waiting] = await legacyActions(fixture.issueId);
      expect(waiting).toMatchObject({
        status: "resolved",
        evidence: {
          automaticRecovery: { replay: "blocked" },
          inertRunAssessment: { verdict: "deferred", reason: "first_class_blocker_unresolved" },
        },
      });
      expect(waiting!.evidence).not.toHaveProperty("continuationDelivery");
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!.status).toBe("blocked");
      // Rechecked at a bounded pace, and continued once the blocker is done.
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0 });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
      const later = new Date(Date.now() + INERT_RUN_RELEASE_RECHECK_MS + 1_000);
      expect(await reconcileInertLegacyExecutions(db, later)).toMatchObject({ reconciled: 1 });
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!.status).toBe("todo");
    });

    it("keeps a task that was blocked before the hold blocked", async () => {
      const fixture = await seedCompany();
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));
      await seedStoppedRun({ ...fixture, finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000) });
      await settleUnrecoverableExecutions(db, new Date());
      expect((await legacyActions(fixture.issueId))[0]!.evidence).toMatchObject({
        automaticRecovery: { issueStatusBefore: "blocked" },
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!.status).toBe("blocked");
    });

    it("keeps a blocked task blocked when the status before the hold was not recorded", async () => {
      const fixture = await seedCompany();
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));
      await seedStoppedRun({ ...fixture, finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000) });
      await settleUnrecoverableExecutions(db, new Date());
      // Holds settled by an earlier version carry no status from before the hold.
      const [settled] = await legacyActions(fixture.issueId);
      const { issueStatusBefore, ...automaticRecovery } = settled!.evidence.automaticRecovery as Record<string, unknown>;
      expect(issueStatusBefore).toBe("blocked");
      await db.update(issueRecoveryActions).set({ evidence: { ...settled!.evidence, automaticRecovery } })
        .where(eq(issueRecoveryActions.id, settled!.id));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 1 });
      expect((await db.select().from(issues).where(eq(issues.id, fixture.issueId)))[0]!.status).toBe("blocked");
    });

    it("leaves a settled hold to an operator once the board parks its task, and continues it back in work", async () => {
      const { companyId, issueId, settled } = await settledInertHold();
      await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, deferred: 1 });
      const wake = vi.fn();
      await deliverReconciledExecutions(db, wake as never);
      expect(wake).not.toHaveBeenCalled();
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "resolved",
        evidence: {
          automaticRecovery: { replay: "blocked" },
          inertRunAssessment: { verdict: "deferred", reason: "status_changed:backlog" },
        },
      });
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: settled.id });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("backlog");

      // Rechecked at a bounded pace; back in work, it is continued as is.
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0 });
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      const later = new Date(Date.now() + INERT_RUN_RELEASE_RECHECK_MS + 1_000);
      expect(await reconcileInertLegacyExecutions(db, later)).toMatchObject({ reconciled: 1 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_progress");
    });

    it("does not let settled holds of tasks another run took over fill the batch", async () => {
      const busy = await seedCompany();
      const finishedAt = new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000);
      for (let i = 0; i < 25; i += 1) {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId, companyId: busy.companyId, title: `Task ${i}`, status: "in_progress",
          priority: "medium", assigneeAgentId: busy.agentId, issueNumber: 10 + i,
          identifier: `TK-${i}-${issueId.slice(0, 4)}`,
        });
        // Another run still holds the task's checkout.
        const holderId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: holderId, companyId: busy.companyId, agentId: busy.agentId, invocationSource: "assignment",
          status: "failed", runtimeMode: "legacy", contextSnapshot: { issueId: randomUUID() },
        });
        await db.update(issues).set({ checkoutRunId: holderId }).where(eq(issues.id, issueId));
        await seedStoppedRun({ companyId: busy.companyId, agentId: busy.agentId, issueId, finishedAt });
        await settleUnrecoverableExecutions(db, new Date());
        expect((await legacyActions(issueId))[0]).toMatchObject({
          status: "resolved", outcome: "cancelled", evidence: { automaticRecovery: { replay: "blocked" } },
        });
      }
      // A new hold of a run stopped moments ago.
      const fresh = await seedCompany();
      await seedStoppedRun({ ...fresh });
      expect((await legacyActions(fresh.issueId))[0]).toMatchObject({ status: "active" });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 1, reconciled: 1 });
      expect((await legacyActions(fresh.issueId))[0]).toMatchObject({ outcome: "restored" });
    });

    it.each([
      ["a board operator's stop", { resultJson: { cancelledByActorType: "user", cancelledByUserId: null } }],
      ["an interrupt by comment", { errorCode: "operator_interrupted" }],
    ])("never revisits a settled hold after %s", async (_label, stop) => {
      const { issueId } = await settledInertHold({ stop });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0, reconciled: 0 });
      expect((await legacyActions(issueId))[0]).toMatchObject({
        status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } },
      });
    });

    it("never revisits a settled hold whose run shows work", async () => {
      const fixture = await seedCompany();
      const run = await seedStoppedRun({ ...fixture, finishedAt: new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000) });
      await settleUnrecoverableExecutions(db, new Date());
      await db.insert(activityLog).values({
        companyId: fixture.companyId, actorType: "agent", actorId: fixture.agentId, agentId: fixture.agentId,
        runId: run.id, action: "issue.comment_added", entityType: "issue", entityId: fixture.issueId,
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ reconciled: 0, notInert: 1 });
      const [held] = await legacyActions(fixture.issueId);
      expect(held).toMatchObject({
        status: "resolved",
        evidence: {
          automaticRecovery: { replay: "blocked" },
          inertRunAssessment: { verdict: "not_inert", reason: "agent_activity_recorded" },
        },
      });
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0 });
      expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueId)).toMatchObject({ recoveryActionId: held!.id });
    });

    it("does not let settled holds of closed or reassigned tasks fill the batch", async () => {
      const closed = await seedCompany();
      const otherId = randomUUID();
      await db.insert(agents).values({
        id: otherId, companyId: closed.companyId, name: "Maintainer", role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      const finishedAt = new Date(Date.now() - INERT_RUN_SETTLE_GRACE_MS - 60_000);
      for (let i = 0; i < 26; i += 1) {
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId, companyId: closed.companyId, title: `Task ${i}`, status: "in_progress",
          priority: "medium", assigneeAgentId: closed.agentId, issueNumber: 10 + i,
          identifier: `CL-${i}-${issueId.slice(0, 4)}`,
        });
        await seedStoppedRun({ companyId: closed.companyId, agentId: closed.agentId, issueId, finishedAt });
        await settleUnrecoverableExecutions(db, new Date());
        // Closed, or handed to someone else, after the disposition.
        await db.update(issues).set(i % 2 === 0 ? { status: "done" } : { assigneeAgentId: otherId })
          .where(eq(issues.id, issueId));
      }
      const open = await seedCompany();
      await seedStoppedRun({ ...open, finishedAt });
      await settleUnrecoverableExecutions(db, new Date());
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 1, reconciled: 1 });
      expect((await legacyActions(open.issueId))[0]).toMatchObject({ outcome: "restored" });
    });

    it("never revisits a hold an operator reconciled", async () => {
      const { issueId, settled } = await settledInertHold();
      await db.update(issueRecoveryActions).set({
        evidence: { ...settled.evidence, executionReconciliation: { runId: settled.evidence.runId, actorId: "operator" } },
      }).where(eq(issueRecoveryActions.id, settled.id));
      expect(await reconcileInertLegacyExecutions(db, new Date())).toMatchObject({ checked: 0 });
      void issueId;
    });
  });
});
