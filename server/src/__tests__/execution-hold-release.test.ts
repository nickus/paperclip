import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  heldExecutionWaitReleaseIdempotencyKey,
} from "../services/execution-wait-release.js";
import {
  INERT_RUN_AUTO_RECONCILE_ENV,
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
        idempotencyKey: heldExecutionWaitReleaseIdempotencyKey(action.id),
        payload: expect.objectContaining({
          issueId,
          releasedRecoveryActionId: action.id,
          releasedExecutionWaitIds: [receipt.id],
          heldSignalCount: 2,
        }),
        contextSnapshot: expect.objectContaining({
          issueId, source: "execution.hold_released", releasedRecoveryActionId: action.id,
        }),
      }));
      // Not recovery-scoped: the released wake asks for the work itself.
      const [, opts] = wake.mock.calls[0] as unknown as [string, { payload: object; contextSnapshot: object }];
      expect(opts.payload).not.toHaveProperty("recoveryActionId");
      expect(opts.contextSnapshot).not.toHaveProperty("recoveryActionId");
      const [released] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
      expect(released!.payload).toMatchObject({
        executionWait: { releasedByRecoveryActionId: action.id, releaseOutcome: "delivered", releaseRunId: runId },
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

      // The continuation already covers the held dependency wake.
      const releaseWake = vi.fn();
      expect(await deliverReleasedExecutionWaits(db, releaseWake as never)).toMatchObject({ covered: 1 });
      expect(releaseWake).not.toHaveBeenCalled();
    });
  });
});
