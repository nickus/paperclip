import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  authUsers,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import {
  registerServerAdapter,
  runningProcesses,
  unregisterServerAdapter,
  type ServerAdapterModule,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import {
  AGENT_PAUSE_RESUME_POLICY,
  AGENT_PAUSE_STOP_SETTLE_GRACE_MS,
  deliverReconciledExecutions,
  RESUME_RECONCILIATION_CONFIRMATION,
  RESUME_RECONCILIATION_REQUIRED_CODE,
  settleUnrecoverableExecutions,
} from "../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { LEGACY_RECOVERY_CAUSE, terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { errorHandler } from "../middleware/index.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent pause resume tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** An adapter from an external plugin: its type is in no built-in list. */
const EXTERNAL_ADAPTER_TYPE = "external_session_test";

function externalAdapter(capabilities: Partial<ServerAdapterModule> = {}): ServerAdapterModule {
  return {
    type: EXTERNAL_ADAPTER_TYPE,
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({
      adapterType: EXTERNAL_ADAPTER_TYPE,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }),
    // The plugin persists its provider session and resumes it on the next run.
    sessionCodec: {
      deserialize: (raw) => (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null),
      serialize: (params) => params,
      getDisplayId: (params) => (typeof params?.sessionId === "string" ? params.sessionId : null),
    },
    ...capabilities,
  };
}

describeEmbeddedPostgres("agent pause keeps its task resumable", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-resume-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
    for (const child of children) if (!exited(child)) child.kill("SIGKILL");
    children.clear();
    runningProcesses.clear();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  /** A task whose legacy run is working in a live provider process. */
  async function seedWorkingRun(input: { adapterType?: string; ownedProcess?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const adapterType = input.adapterType ?? "claude_local";
    const prefix = `PR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Pause Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "running",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Write the report",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const child = input.ownedProcess === false
      ? null
      : spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (child) children.add(child);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      runtimeMode: "legacy",
      executionStage: "dispatching",
      startedAt: new Date(Date.now() - 45_000),
      processPid: child?.pid ?? 4_000_001,
      processStartedAt: new Date(Date.now() - 40_000),
      lastOutputAt: new Date(),
      lastOutputSeq: 12,
      contextSnapshot: { issueId },
      nextEventSeq: 10,
    });
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 1, eventType: "lifecycle", stream: "system", level: "info", message: "run started" },
      {
        companyId, runId, agentId, seq: 2, eventType: "adapter.invoke", stream: "system", level: "info",
        message: "adapter invocation", payload: { adapterType },
      },
    ]);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    if (child) runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    return { companyId, agentId, issueId, runId, child };
  }

  /** What the agent pause route does: mark the agent paused, then stop its runs. */
  async function pauseAgent(agentId: string) {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await heartbeatService(db, { runtimeEnv: {} }).cancelActiveForAgent(agentId);
  }

  async function resumeAgent(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    // Admission attributes the continuation to the company's responsible user.
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({
      id: responsibleUserId, name: "Operator", email: `${responsibleUserId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, agent!.companyId));
    // Occupy the agent's only slot so the continuation queues without
    // launching a provider in the test process.
    await db.update(agents).set({
      status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, agentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: agent!.companyId, agentId, invocationSource: "manual",
      status: "running", startedAt: new Date(),
    });
  }

  async function legacyHold(issueId: string) {
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
      ));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function continuationFor(actionId: string) {
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${actionId}`));
    if (wakes.length === 0) return null;
    expect(wakes).toHaveLength(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakes[0]!.runId!));
    return { wake: wakes[0]!, run: run! };
  }

  it("continues the task once the agent is resumed after a pause stopped its run", async () => {
    const { companyId, agentId, issueId, runId, child } = await seedWorkingRun();

    await pauseAgent(agentId);

    // The pause stopped the provider process and recorded the verified stop.
    expect(exited(child!)).toBe(true);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
    expect(stopped!.resultJson).toMatchObject({
      providerStop: { initiator: "agent_pause", processTerminated: true },
    });
    expect((await legacyHold(issueId)).status).toBe("active");

    // The automatic disposition authorizes the continuation instead of
    // settling the task without replay; the task is not blocked.
    await settleUnrecoverableExecutions(db, new Date());
    const hold = await legacyHold(issueId);
    expect(hold).toMatchObject({
      status: "resolved",
      outcome: "restored",
      evidence: {
        continuationDelivery: "pending",
        executionReconciliation: {
          runId,
          providerStopped: true,
          actionOutcome: "mixed",
          actorId: "execution-recovery",
        },
      },
    });
    expect(hold.evidence).not.toHaveProperty("automaticRecovery");
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const [settledTask] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(settledTask!.status).toBe("in_progress");
    const [settledActivity] = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.execution_recovery_settled"),
    ));
    expect(settledActivity!.details).toMatchObject({
      outcome: "restored",
      replay: "authorized_on_resume",
      policy: AGENT_PAUSE_RESUME_POLICY,
    });

    // While the agent stays paused nothing wakes it, and stranded-work
    // recovery does not hand the waiting task to the board.
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(await continuationFor(hold.id)).toBeNull();
    await heartbeat.reconcileStrandedAssignedIssues();
    const [pausedTask] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(pausedTask!.status).toBe("in_progress");
    expect(await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.status, "active"),
    ))).toHaveLength(0);

    // Resuming the agent delivers one continuation of the stopped run.
    await resumeAgent(agentId);
    await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
    const continuation = await continuationFor(hold.id);
    expect(continuation?.wake).toMatchObject({ agentId, status: "queued" });
    expect(continuation?.run).toMatchObject({
      agentId,
      status: "queued",
      retryOfRunId: runId,
      contextSnapshot: expect.objectContaining({ issueId, previousRunId: runId, source: "execution.reconciled" }),
    });
    expect((await legacyHold(issueId)).evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: continuation!.run.id,
    });
  });

  it("keeps the hold of a paused run whose process this server does not own", async () => {
    // For example a process that survived a restart: the pause cannot verify
    // that it stopped, so the run keeps the regular no-replay disposition.
    const { companyId, agentId, issueId } = await seedWorkingRun({ ownedProcess: false });
    await pauseAgent(agentId);
    await settleUnrecoverableExecutions(db, new Date());
    const hold = await legacyHold(issueId);
    expect(hold).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
    expect(hold.evidence).not.toHaveProperty("executionReconciliation");
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });
  });

  it("keeps the hold when the pause could not verify that the process stopped", async () => {
    const { companyId, issueId, runId, child } = await seedWorkingRun();
    runningProcesses.delete(runId);
    child!.kill("SIGKILL");
    // The pause recorded its stop request, but termination never confirmed it.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await terminalizeLegacyExecution({
      db,
      run: run!,
      status: "cancelled",
      patch: {
        finishedAt: new Date(),
        error: "Cancelled due to agent pause",
        errorCode: "agent_paused",
        resultJson: { providerStop: { initiator: "agent_pause", requestedAt: new Date().toISOString() } },
      },
    });

    // The disposition waits briefly for the pause to verify the stop...
    await settleUnrecoverableExecutions(db, new Date());
    expect((await legacyHold(issueId)).status).toBe("active");

    // ...then settles the run without replay, as before.
    await settleUnrecoverableExecutions(db, new Date(Date.now() + AGENT_PAUSE_STOP_SETTLE_GRACE_MS + 60_000));
    const hold = await legacyHold(issueId);
    expect(hold).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
    expect(hold.evidence).not.toHaveProperty("executionReconciliation");
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });
  });

  it.each([
    [
      "a run that crashed",
      { status: "failed", errorCode: "adapter_failed", error: "Adapter exited unexpectedly" },
    ],
    [
      "a run that timed out",
      { status: "timed_out", errorCode: "timeout", error: "Timed out" },
    ],
  ] as const)("still requires reconciliation for %s", async (_label, outcome) => {
    const { companyId, issueId, runId, child } = await seedWorkingRun();
    runningProcesses.delete(runId);
    child!.kill("SIGKILL");
    // The run ended on its own; nothing verified how its provider stopped.
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await terminalizeLegacyExecution({
      db,
      run: run!,
      status: outcome.status,
      patch: { finishedAt: new Date(), error: outcome.error, errorCode: outcome.errorCode },
    });
    await settleUnrecoverableExecutions(db, new Date());
    const hold = await legacyHold(issueId);
    expect(hold).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });
    expect(hold.evidence).not.toHaveProperty("executionReconciliation");
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(await continuationFor(hold.id)).toBeNull();
  });

  it("keeps the hold of a paused run whose adapter replays a command instead of taking a turn", async () => {
    const { companyId, agentId, issueId } = await seedWorkingRun({ adapterType: "process" });
    await pauseAgent(agentId);
    await settleUnrecoverableExecutions(db, new Date());
    const hold = await legacyHold(issueId);
    expect(hold).toMatchObject({ status: "resolved", evidence: { automaticRecovery: { replay: "blocked" } } });
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });
  });

  // An adapter plugin cannot be added to the server's built-in list of
  // conversation adapters; it declares the capability on its module instead.
  describe("an adapter from an external plugin", () => {
    it("continues the task after a pause when the adapter declares conversation continuation", async () => {
      registerServerAdapter(externalAdapter({ supportsConversationContinuation: true }));
      const { companyId, agentId, issueId, runId, child } = await seedWorkingRun({ adapterType: EXTERNAL_ADAPTER_TYPE });

      await pauseAgent(agentId);
      expect(exited(child!)).toBe(true);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(stopped!.resultJson).toMatchObject({
        providerStop: { initiator: "agent_pause", processTerminated: true },
      });

      await settleUnrecoverableExecutions(db, new Date());
      const hold = await legacyHold(issueId);
      expect(hold).toMatchObject({
        status: "resolved",
        outcome: "restored",
        evidence: {
          continuationDelivery: "pending",
          executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed" },
        },
      });
      expect(hold.evidence).not.toHaveProperty("automaticRecovery");
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();

      await resumeAgent(agentId);
      await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
      const continuation = await continuationFor(hold.id);
      expect(continuation?.run).toMatchObject({
        agentId,
        status: "queued",
        retryOfRunId: runId,
        contextSnapshot: expect.objectContaining({ issueId, previousRunId: runId, source: "execution.reconciled" }),
      });
    });

    it.each([
      ["leaves the capability unset", {}],
      ["declares that it does not continue a conversation", { supportsConversationContinuation: false }],
    ] as const)("keeps the hold of a paused run when the adapter %s", async (_label, capabilities) => {
      registerServerAdapter(externalAdapter(capabilities));
      const { companyId, agentId, issueId, child } = await seedWorkingRun({ adapterType: EXTERNAL_ADAPTER_TYPE });

      await pauseAgent(agentId);
      expect(exited(child!)).toBe(true);

      await settleUnrecoverableExecutions(db, new Date());
      const hold = await legacyHold(issueId);
      expect(hold).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
      expect(hold.evidence).not.toHaveProperty("executionReconciliation");
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });
      await resumeAgent(agentId);
      await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
      expect(await continuationFor(hold.id)).toBeNull();
    });

    it("continues the task after an instance restart stops its run when the adapter declares the capability", async () => {
      registerServerAdapter(externalAdapter({ supportsConversationContinuation: true }));
      const { companyId, issueId, runId } = await seedWorkingRun({ adapterType: EXTERNAL_ADAPTER_TYPE });
      const responsibleUserId = randomUUID();
      await db.insert(authUsers).values({
        id: responsibleUserId, name: "Operator", email: `${responsibleUserId}@example.test`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId })
        .where(eq(companies.id, companyId));

      const drained = await heartbeatService(db, { runtimeEnv: {} }).drainRunningRunsForShutdown("SIGTERM");
      expect(drained.interruptedRunIds).toEqual([runId]);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(stopped!.resultJson).toMatchObject({ conversationContinuation: "continue_conversation_v1" });

      await settleUnrecoverableExecutions(db, new Date());
      expect(await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
      ))).toHaveLength(0);
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    });
  });

  // The agent pause is not the only operator action that stops a run's
  // provider process. An instance restart and a board Stop record their
  // verified stop differently (an interrupted run, an acknowledged
  // cancellation), and conversation continuation already accepts both. These
  // cases pin that every such stop leaves the task resumable, and that a stop
  // nobody verified keeps the conservative hold.
  describe("other operator stops of a conversation turn", () => {
    function boardApp(companyId: string, userId: string) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as any).actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false };
        next();
      });
      server.use("/api", issueTreeControlRoutes(db));
      server.use(errorHandler);
      return server;
    }

    /** "Resume work" on the task: pause it, then release the pause and wake its agent. */
    async function resumeWork(companyId: string, issueId: string, userId: string) {
      const { hold } = await issueTreeControlService(db).createHold(companyId, issueId, {
        mode: "pause",
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
        actor: { actorType: "user", actorId: userId, userId },
      });
      return request(boardApp(companyId, userId))
        .post(`/api/issues/${issueId}/tree-holds/${hold.id}/release`)
        .send({ metadata: { wakeAgents: true } });
    }

    it("continues the task after an instance restart stops its run", async () => {
      const { companyId, issueId, runId, child } = await seedWorkingRun();
      // The retry run is attributed to the company's responsible user.
      const responsibleUserId = randomUUID();
      await db.insert(authUsers).values({
        id: responsibleUserId, name: "Operator", email: `${responsibleUserId}@example.test`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId })
        .where(eq(companies.id, companyId));

      // A graceful restart (or a drain before one) stops the owned process
      // before it records the interruption.
      const drained = await heartbeatService(db, { runtimeEnv: {} }).drainRunningRunsForShutdown("SIGTERM");
      expect(drained.interruptedRunIds).toEqual([runId]);
      expect(exited(child!)).toBe(true);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(stopped).toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted" });
      expect(stopped!.resultJson).toHaveProperty("conversationContinuation");

      // No no-replay disposition: the next turn continues from the recorded work.
      await settleUnrecoverableExecutions(db, new Date());
      expect(await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
      ))).toHaveLength(0);
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
      expect(drained.retryRunIds).toHaveLength(1);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, drained.retryRunIds[0]!));
      expect(retry).toMatchObject({ retryOfRunId: runId, contextSnapshot: expect.objectContaining({ issueId }) });
    });

    it("resumes the task after a board Stop that verified its process stopped", async () => {
      const { companyId, agentId, issueId, runId, child } = await seedWorkingRun();
      const userId = randomUUID();
      await heartbeatService(db, { runtimeEnv: {} }).cancelRun(runId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: userId },
      });
      expect(exited(child!)).toBe(true);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(stopped).toMatchObject({
        status: "cancelled",
        resultJson: { cancelledByActorType: "user", executionCancellation: { state: "acknowledged" } },
      });

      // The Stop is the operator's decision: nothing wakes the task by itself,
      // and nothing blocks it once the operator resumes it.
      await settleUnrecoverableExecutions(db, new Date());
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
      await resumeAgent(agentId);
      const response = await resumeWork(companyId, issueId, userId);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "released" });
      expect(response.body.wakeFailures).toBeUndefined();
      expect(response.body.reconciledIssueIds).toBeUndefined();
      expect(await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "issue_tree_resumed"),
      ))).toHaveLength(1);
    });

    it("keeps the hold of a board Stop that could not verify its process stopped", async () => {
      // The server does not own the process, so the Stop cannot confirm it
      // ended; the task keeps the no-replay disposition until reconciled.
      const { companyId, issueId, runId } = await seedWorkingRun({ ownedProcess: false });
      const userId = randomUUID();
      await heartbeatService(db, { runtimeEnv: {} }).cancelRun(runId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: userId },
      });
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(stopped!.status).toBe("cancelled");
      expect(stopped!.resultJson).not.toHaveProperty("executionCancellation");
      await settleUnrecoverableExecutions(db, new Date());
      const hold = await legacyHold(issueId);
      expect(hold).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { automaticRecovery: { replay: "blocked" } } });
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });

      // Moved back to work, "Resume work" offers the board reconciliation
      // instead of failing.
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      const response = await resumeWork(companyId, issueId, userId);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: RESUME_RECONCILIATION_REQUIRED_CODE });
    });
  });

  describe("resuming held work from the task", () => {
    function app(companyId: string, userId: string) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as any).actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false };
        next();
      });
      server.use("/api", issueTreeControlRoutes(db));
      server.use(errorHandler);
      return server;
    }

    /** A task held by a settled no-replay disposition, then paused and moved back to work by the board. */
    async function seedHeldTask() {
      const seeded = await seedWorkingRun({ adapterType: "process" });
      await pauseAgent(seeded.agentId);
      await settleUnrecoverableExecutions(db, new Date());
      const hold = await legacyHold(seeded.issueId);
      expect(hold.evidence).toMatchObject({ automaticRecovery: { replay: "blocked" } });
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, seeded.agentId));
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, seeded.issueId));
      const userId = randomUUID();
      const { hold: pauseHold } = await issueTreeControlService(db).createHold(seeded.companyId, seeded.issueId, {
        mode: "pause",
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
        actor: { actorType: "user", actorId: userId, userId },
      });
      return { ...seeded, hold, pauseHoldId: pauseHold.id, userId };
    }

    it("offers the reconciliation instead of failing, and keeps the task paused until confirmed", async () => {
      const { companyId, issueId, hold, pauseHoldId, userId, runId } = await seedHeldTask();
      const response = await request(app(companyId, userId))
        .post(`/api/issues/${issueId}/tree-holds/${pauseHoldId}/release`)
        .send({ metadata: { wakeAgents: true } });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: RESUME_RECONCILIATION_REQUIRED_CODE,
        details: {
          confirmation: RESUME_RECONCILIATION_CONFIRMATION,
          tasks: [{ issueId, recoveryActionId: hold.id, runId }],
        },
      });
      const [pauseHold] = await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, pauseHoldId));
      expect(pauseHold!.status).toBe("active");
      expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id });
    });

    it("reconciles the hold for a board operator who confirms, and continues the task", async () => {
      const { companyId, agentId, issueId, hold, pauseHoldId, userId, runId } = await seedHeldTask();
      const response = await request(app(companyId, userId))
        .post(`/api/issues/${issueId}/tree-holds/${pauseHoldId}/release`)
        .send({ metadata: { wakeAgents: true, reconcileExecutionHolds: true } });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "released", reconciledIssueIds: [issueId] });
      expect(response.body.wakeFailures).toBeUndefined();

      const [reconciled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
      expect(reconciled).toMatchObject({
        status: "resolved",
        outcome: "restored",
        evidence: {
          continuationDelivery: "pending",
          executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed", actorId: userId },
        },
      });
      expect(reconciled!.evidence).not.toHaveProperty("automaticRecovery");
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
      const [resolvedActivity] = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.recovery_action_resolved"),
      ));
      expect(resolvedActivity).toMatchObject({ actorType: "user", actorId: userId });

      // The reconciled continuation, not a second resume wake, starts the task.
      await resumeAgent(agentId);
      await deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
      const continuation = await continuationFor(hold.id);
      expect(continuation?.run).toMatchObject({ status: "queued", retryOfRunId: runId });
      expect(await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "issue_tree_resumed"),
      ))).toHaveLength(0);
    });

    it("refuses to reconcile while the stopped run's provider is still running", async () => {
      const { companyId, issueId, hold, pauseHoldId, userId, runId } = await seedHeldTask();
      // Another live process now owns the pid the run recorded.
      const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.add(survivor);
      await db.update(heartbeatRuns).set({ processPid: survivor.pid! }).where(eq(heartbeatRuns.id, runId));
      const response = await request(app(companyId, userId))
        .post(`/api/issues/${issueId}/tree-holds/${pauseHoldId}/release`)
        .send({ metadata: { wakeAgents: true, reconcileExecutionHolds: true } });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("still running");
      const [unchanged] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
      expect(unchanged!.evidence).not.toHaveProperty("executionReconciliation");
      const [pauseHold] = await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, pauseHoldId));
      expect(pauseHold!.status).toBe("active");
    });
  });
});
