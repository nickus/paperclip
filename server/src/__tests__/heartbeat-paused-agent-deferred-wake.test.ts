import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres paused-agent deferred-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A release keeps a paused agent's deferred wake queued instead of failing
// it, and stamps it with the run whose release reached it. Once the issue's
// execution lock is free nothing else drains that queue, so the scheduler
// sweep must run that release again after the agent resumes.
describeEmbeddedPostgres("heartbeat deferred wakes held for a paused agent", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-paused-agent-deferred-wake-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterEach(async () => {
    stopTaskDrain();
    await db.execute(
      sql.raw(`
        TRUNCATE TABLE
          "issues",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `),
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedHeldWake(options: { markerIssue?: "same" | "other" } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date(),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Paused while a follow-up was deferred",
        status: "in_progress",
        assigneeAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Unrelated issue",
        status: "in_progress",
        assigneeAgentId: agentId,
      },
    ]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      contextSnapshot: {
        issueId: options.markerIssue === "other" ? otherIssueId : issueId,
      },
    });
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: {
        issueId,
        heldForPausedAgent: { runId, heldAt: new Date().toISOString() },
      },
      // Held a while ago, so the sweep's retry interval has passed.
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });
    return { companyId, agentId, issueId, runId, wakeId };
  }

  async function readWake(wakeId: string) {
    const [row] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    return row!;
  }

  async function resume(agentId: string) {
    await db
      .update(agents)
      .set({ status: "idle", pauseReason: null, pausedAt: null })
      .where(eq(agents.id, agentId));
  }

  it("leaves the wake deferred while its agent is paused", async () => {
    const { wakeId } = await seedHeldWake();

    const result = await heartbeat.releaseDeferredWakesHeldForPausedAgents();

    expect(result).toEqual({ checked: 0, released: 0 });
    expect((await readWake(wakeId)).status).toBe("deferred_issue_execution");
  });

  it("promotes the wake to a queued run once its agent resumes", async () => {
    const { agentId, wakeId, runId } = await seedHeldWake();
    await resume(agentId);
    // Hold dispatch, so the promoted run stays queued for inspection.
    startTaskDrain();

    const result = await heartbeat.releaseDeferredWakesHeldForPausedAgents();

    expect(result).toEqual({ checked: 1, released: 1 });
    const wake = await readWake(wakeId);
    expect(wake.status).not.toBe("deferred_issue_execution");
    expect(wake.runId).not.toBeNull();
    const [promoted] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake.runId!));
    expect(promoted).toMatchObject({
      agentId,
      status: "queued",
      wakeupRequestId: wakeId,
    });
    expect(promoted!.id).not.toBe(runId);
  });

  it("ignores a marker that names a run on a different issue", async () => {
    const { agentId, wakeId } = await seedHeldWake({ markerIssue: "other" });
    await resume(agentId);
    startTaskDrain();

    const result = await heartbeat.releaseDeferredWakesHeldForPausedAgents();

    expect(result).toEqual({ checked: 1, released: 0 });
    const wake = await readWake(wakeId);
    expect(wake.status).toBe("deferred_issue_execution");
    expect(wake.runId).toBeNull();
  });

  it("promotes a wake held by a failed native run's release exactly once, without recording that run's recovery again", async () => {
    const { companyId, agentId, issueId, wakeId } = await seedHeldWake();
    // The wake was held by the release of another agent's native run that
    // failed; that run's agent owns the task now. Its release reached the
    // drain, so any terminal recovery it needed was already settled then.
    const ownerId = randomUUID();
    await db.insert(agents).values({
      id: ownerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const nativeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nativeRunId,
      companyId,
      agentId: ownerId,
      invocationSource: "on_demand",
      status: "failed",
      runtimeMode: "native",
      nativeIssueId: issueId,
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ assigneeAgentId: ownerId }).where(eq(issues.id, issueId));
    await db
      .update(agentWakeupRequests)
      .set({
        reason: "issue_comment_mentioned",
        payload: { issueId, heldForPausedAgent: { runId: nativeRunId, heldAt: new Date().toISOString() } },
      })
      .where(eq(agentWakeupRequests.id, wakeId));
    await resume(agentId);
    startTaskDrain();

    const first = await heartbeat.releaseDeferredWakesHeldForPausedAgents();
    const second = await heartbeat.releaseDeferredWakesHeldForPausedAgents();

    expect(first).toEqual({ checked: 1, released: 1 });
    expect(second).toEqual({ checked: 0, released: 0 });
    const wake = await readWake(wakeId);
    expect(wake.status).not.toBe("deferred_issue_execution");
    const promoted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(promoted.filter((run) => run.wakeupRequestId === wakeId)).toHaveLength(1);
    expect(promoted.find((run) => run.wakeupRequestId === wakeId)).toMatchObject({ status: "queued" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("in_progress");
    expect(
      await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)),
    ).toEqual([]);
  });

  it("strips the marker from a wake caller's payload", async () => {
    const { agentId, wakeId, runId } = await seedHeldWake();
    await resume(agentId);
    startTaskDrain();

    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_check",
      payload: { note: "check in", heldForPausedAgent: { runId } },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    const created = (
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
    ).filter((row) => row.id !== wakeId);
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ note: "check in" });
    expect(created[0]!.payload).not.toHaveProperty("heldForPausedAgent");
  });
});
