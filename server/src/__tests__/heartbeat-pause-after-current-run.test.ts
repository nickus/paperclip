import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
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
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { agentService } from "../services/agents.ts";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";

const TRANSIENT_FAILURE_TEST_ADAPTER = "pause_after_run_transient_failure_test";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pause-after-current-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Pausing an agent "after the current run" only skips the cancellation the
// pause route otherwise performs. These tests pin the scheduler behavior that
// relies on: a paused agent's live run finishes normally and leaves the agent
// paused, and its queued runs stay queued until the agent is resumed.
describeEmbeddedPostgres("heartbeat pause after the current run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let markerDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pause-after-current-run-");
    db = createDb(tempDb.connectionString);
    markerDir = mkdtempSync(path.join(tmpdir(), "pause-after-run-"));
  }, 60_000);

  afterEach(async () => {
    stopTaskDrain();
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter(TRANSIENT_FAILURE_TEST_ADAPTER);
    await tempDb?.cleanup();
    if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  });

  async function seed(startedMarker: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pause Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        // Signal that the process started, then work for a moment.
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(startedMarker)}, "started"); setTimeout(() => process.exit(0), 1500);`,
        ],
      },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work in flight when the agent is paused",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function insertQueuedRun(input: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run's process to start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function runStatus(runId: string) {
    const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row?.status;
  }

  it("lets the live run finish, keeps the agent paused, and holds its queued run until resume", async () => {
    const startedMarker = path.join(markerDir, `${randomUUID()}.started`);
    const fixture = await seed(startedMarker);
    const heartbeat = heartbeatService(db);
    const liveRunId = await insertQueuedRun(fixture);

    await heartbeat.resumeQueuedRuns();
    await waitFor(() => existsSync(startedMarker));
    expect(await runStatus(liveRunId)).toBe("running");

    // The pause route with afterCurrentRun pauses the agent and cancels nothing.
    await agentService(db).pause(fixture.agentId);
    const queuedRunId = await insertQueuedRun(fixture);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(liveRunId)).toBe("succeeded");
    const [agentAfterRun] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, fixture.agentId));
    expect(agentAfterRun?.status).toBe("paused");
    // The scheduler neither starts nor cancels a paused agent's queued run.
    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(queuedRunId)).toBe("queued");

    await agentService(db).resume(fixture.agentId);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queuedRunId)).toBe("succeeded");
  }, 60_000);

  it("keeps the transient-failure retry of the last run until the agent is resumed", async () => {
    let started = false;
    let finishRun!: () => void;
    const runMayFinish = new Promise<void>((resolve) => { finishRun = resolve; });
    registerServerAdapter({
      type: TRANSIENT_FAILURE_TEST_ADAPTER,
      execute: async () => {
        started = true;
        await runMayFinish;
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "upstream overloaded",
          errorCode: "claude_transient_upstream",
          errorFamily: "transient_upstream",
          resultJson: {
            executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
            errorFamily: "transient_upstream",
          },
        };
      },
      testEnvironment: async () => ({
        adapterType: TRANSIENT_FAILURE_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    const fixture = await seed(path.join(markerDir, `${randomUUID()}.unused`));
    await db.update(agents).set({ adapterType: TRANSIENT_FAILURE_TEST_ADAPTER, adapterConfig: {} }).where(eq(agents.id, fixture.agentId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.issueId));
    const heartbeat = heartbeatService(db);
    const liveRunId = await insertQueuedRun(fixture);

    await heartbeat.resumeQueuedRuns();
    await waitFor(() => started);
    // Pause after the current run: nothing is cancelled, and the run then
    // fails with a transient provider error.
    await agentService(db).pause(fixture.agentId);
    finishRun();
    await heartbeat.drainActiveRunExecutions();
    // Keep the promoted retry queued for inspection.
    startTaskDrain();

    expect(await runStatus(liveRunId)).toBe("failed");
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, liveRunId));
    expect(retry).toMatchObject({ agentId: fixture.agentId, status: "scheduled_retry", scheduledRetryReason: "transient_failure" });
    const [issueAfterRun] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issueAfterRun).toMatchObject({ status: "in_progress", executionRunId: retry!.id });

    // While the agent stays paused, the due retry is neither promoted nor
    // cancelled, and recovery does not escalate the task that waits for it.
    const afterDue = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(await heartbeat.promoteDueScheduledRetries(afterDue)).toEqual({ promoted: 0, runIds: [] });
    expect(await runStatus(retry!.id)).toBe("scheduled_retry");
    expect((await heartbeat.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    const [issueWhilePaused] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issueWhilePaused!.status).toBe("in_progress");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId))).toEqual([]);

    await agentService(db).resume(fixture.agentId);
    expect(await heartbeat.promoteDueScheduledRetries(afterDue)).toEqual({ promoted: 1, runIds: [retry!.id] });
    expect(await runStatus(retry!.id)).toBe("queued");
  }, 60_000);
});
