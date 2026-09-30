import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Failure breaker test run.",
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

// Lets a test hold every wake at the breaker check until all of them have read
// the breaker, so concurrent wakes race on recording the notice.
const breakerCheckBarrier = vi.hoisted(() => ({ parties: 0, arrived: [] as Array<() => void> }));

vi.mock("../services/agent-failure-breaker.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-failure-breaker.ts")>(
    "../services/agent-failure-breaker.ts",
  );
  return {
    ...actual,
    readAgentFailureBreaker: vi.fn(async (...args: Parameters<typeof actual.readAgentFailureBreaker>) => {
      const trip = await actual.readAgentFailureBreaker(...args);
      if (breakerCheckBarrier.parties > 0) {
        await new Promise<void>((resolve) => {
          breakerCheckBarrier.arrived.push(resolve);
          if (breakerCheckBarrier.arrived.length >= breakerCheckBarrier.parties) {
            for (const release of breakerCheckBarrier.arrived.splice(0)) release();
          }
          // Never hang the suite if fewer wakes reach the check than expected.
          setTimeout(resolve, 5_000).unref();
        });
      }
      return trip;
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent failure breaker tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat agent failure breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-failure-breaker-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    breakerCheckBarrier.parties = 0;
    breakerCheckBarrier.arrived.splice(0);
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentConfigRevisions);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFailingAgent(input: { failures: number; error?: string; status?: "error" | "idle" }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: input.status ?? "error",
      errorReason: input.error ?? "Secret is not active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const failedRunIds: string[] = [];
    for (let index = 0; index < input.failures; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(Date.now() - (input.failures - index) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "failed",
        errorCode: "setup_failed",
        error: input.error ?? "Secret is not active",
        responsibleUserId: "responsible-user",
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        contextSnapshot: { wakeReason: "issue_comment_mentioned" },
      });
      failedRunIds.push(runId);
    }
    return { companyId, agentId, failedRunIds };
  }

  function automaticWake(agentId: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "failure_breaker_test",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function breakerSkips(agentId: string) {
    return db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "agent.failure_breaker_open")));
  }

  async function breakerNotices(agentId: string) {
    return db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.automatic_wakes_paused")));
  }

  it("holds automatic wakes after three identical failures and records one notice", async () => {
    const { agentId, failedRunIds } = await seedFailingAgent({ failures: 3 });

    expect(await automaticWake(agentId)).toBeNull();
    expect(await automaticWake(agentId)).toBeNull();

    const skips = await breakerSkips(agentId);
    expect(skips).toHaveLength(2);
    expect(skips[0]).toMatchObject({ status: "skipped" });
    expect(skips[0]?.error).toContain("Automatic wakes are paused");

    const notices = await breakerNotices(agentId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.details).toMatchObject({
      errorCode: "setup_failed",
      consecutiveFailures: 3,
      failedRunIds: [...failedRunIds].reverse(),
    });

    const [agent] = await db.select({ status: agents.status, errorReason: agents.errorReason }).from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe("error");
    expect(agent?.errorReason).toContain("(setup_failed: Secret is not active)");

    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(3);
  });

  it("records one notice when automatic wakes for the agent arrive concurrently", async () => {
    const { agentId } = await seedFailingAgent({ failures: 3 });
    breakerCheckBarrier.parties = 6;

    const results = await Promise.all(Array.from({ length: 6 }, () => automaticWake(agentId)));

    expect(results.every((run) => run === null)).toBe(true);
    expect(await breakerSkips(agentId)).toHaveLength(6);
    expect(await breakerNotices(agentId)).toHaveLength(1);
  });

  it("records a new notice when another run of the streak fails", async () => {
    const { companyId, agentId } = await seedFailingAgent({ failures: 3 });
    expect(await automaticWake(agentId)).toBeNull();
    expect(await breakerNotices(agentId)).toHaveLength(1);

    // A run a person started fails the same way; finishing it rewrites the
    // agent's error reason with the run's error.
    const createdAt = new Date();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      errorCode: "setup_failed",
      error: "Secret is not active",
      responsibleUserId: "responsible-user",
      createdAt,
      startedAt: createdAt,
      finishedAt: createdAt,
    });
    await db.update(agents).set({ errorReason: "Secret is not active" }).where(eq(agents.id, agentId));

    expect(await automaticWake(agentId)).toBeNull();
    expect(await automaticWake(agentId)).toBeNull();
    expect(await breakerNotices(agentId)).toHaveLength(2);
  });

  it("still runs a wake a person requests", async () => {
    const { agentId } = await seedFailingAgent({ failures: 3 });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });

    expect(run).not.toBeNull();
    expect(await breakerSkips(agentId)).toHaveLength(0);
  });

  it("admits automatic wakes again after a configuration change", async () => {
    const { companyId, agentId } = await seedFailingAgent({ failures: 3 });
    await db.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      source: "patch",
      changedKeys: ["adapterConfig"],
      beforeConfig: {},
      afterConfig: {},
    });

    expect(await automaticWake(agentId)).not.toBeNull();
    expect(await breakerSkips(agentId)).toHaveLength(0);
  });

  it("admits automatic wakes once the agent's error is cleared", async () => {
    const { agentId } = await seedFailingAgent({ failures: 3, status: "idle" });

    expect(await automaticWake(agentId)).not.toBeNull();
    expect(await breakerSkips(agentId)).toHaveLength(0);
  });

  it("keeps waking below the threshold", async () => {
    const { agentId } = await seedFailingAgent({ failures: 2 });

    expect(await automaticWake(agentId)).not.toBeNull();
    expect(await breakerSkips(agentId)).toHaveLength(0);
  });
});
