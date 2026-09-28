import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { logger } from "../middleware/logger.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import {
  heartbeatService,
  STALE_TERMINAL_RUN_LEASE_GRACE_MS,
  type HeartbeatEnvironmentRuntime,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale lease release tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression coverage: a sandboxed run cancelled (agent pause)
// while its pod was still starting kept an "active" environment lease forever
// once its executor was gone, so the task's comment wakes waited indefinitely
// for a sandbox-stop receipt.
describeEmbeddedPostgres("heartbeat environment lease release for stopped runs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lease-release-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecutionControls.clear();
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Seed a company, agent, run, and one "active" local environment lease bound
  // to the run. No executor is registered, as after a server restart.
  async function seedRunWithActiveLease(input: {
    runStatus: "running" | "cancelled" | "failed";
    runtimeMode?: "legacy" | "native";
    finishedAt?: Date | null;
    leaseUpdatedAt?: Date;
    controllerBootId?: string;
    controllerLeaseExpiresAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const leaseId = randomUUID();
    const leaseUpdatedAt = input.leaseUpdatedAt ?? new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Architect",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: leaseUpdatedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {},
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
      controllerBootId: input.controllerBootId ?? null,
      controllerLeaseExpiresAt: input.controllerLeaseExpiresAt ?? null,
      startedAt: leaseUpdatedAt,
      finishedAt: input.finishedAt ?? null,
      updatedAt: input.finishedAt ?? leaseUpdatedAt,
    });
    // The instance keeps a single local environment (unique per driver).
    const [existingLocal] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.driver, "local"));
    const environmentId = existingLocal?.id ?? randomUUID();
    if (!existingLocal) {
      await db.insert(environments).values({
        id: environmentId,
        name: "Local test environment",
        driver: "local",
        status: "active",
        config: {},
        metadata: null,
      });
    }
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId,
      heartbeatRunId: runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      providerLeaseId: null,
      acquiredAt: leaseUpdatedAt,
      lastUsedAt: leaseUpdatedAt,
      metadata: { driver: "local" },
      createdAt: leaseUpdatedAt,
      updatedAt: leaseUpdatedAt,
    });
    return { companyId, agentId, runId, leaseId };
  }

  // A provider-backed runtime whose release blocks on a gate, like a plugin
  // teardown RPC waiting for the sandbox to go. `entered` resolves once a
  // release has started; `open()` lets every release finish as "expired".
  function gatedReleaseRuntime() {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasedRunIds: string[] = [];
    const releaseRunLeases = vi.fn(async (runId: string) => {
      releasedRunIds.push(runId);
      entered();
      await gate;
      await db
        .update(environmentLeases)
        .set({ status: "expired", releasedAt: new Date(), updatedAt: new Date() })
        .where(eq(environmentLeases.heartbeatRunId, runId));
      return [];
    });
    return {
      runtime: { releaseRunLeases } as unknown as HeartbeatEnvironmentRuntime,
      releasedRunIds,
      firstEntered,
      open: () => open(),
    };
  }

  // Resolves to "blocked" when the promise is still pending after a short wait.
  function settledOrBlocked<T>(promise: Promise<T>) {
    return Promise.race([
      promise,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]);
  }

  async function leaseRow(leaseId: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]!);
  }

  it("releases the lease of an executor-less run cancelled by an agent pause", async () => {
    const { agentId, runId, leaseId } = await seedRunWithActiveLease({ runStatus: "running" });

    await heartbeatService(db).cancelActiveForAgent(agentId);

    const run = await heartbeatService(db).getRun(runId);
    expect(run?.status).toBe("cancelled");
    const lease = await leaseRow(leaseId);
    // A cancelled run's lease is released as "expired" (leaseReleaseStatusForRunStatus).
    expect(lease.status).toBe("expired");
    expect(lease.releasedAt).not.toBeNull();
  });

  it("releases the lease of an executor-less run stopped through cancelRun", async () => {
    const { runId, leaseId } = await seedRunWithActiveLease({ runStatus: "running" });

    const cancelled = await heartbeatService(db).cancelRun(runId);

    expect(cancelled?.status).toBe("cancelled");
    const lease = await leaseRow(leaseId);
    expect(lease.status).toBe("expired");
    expect(lease.releasedAt).not.toBeNull();
  });

  it("leaves the release to a live executor in another server process", async () => {
    const { agentId, runId, leaseId } = await seedRunWithActiveLease({
      runStatus: "running",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60 * 1000),
    });

    await heartbeatService(db).cancelActiveForAgent(agentId);

    expect((await heartbeatService(db).getRun(runId))?.status).toBe("cancelled");
    expect((await leaseRow(leaseId)).status).toBe("active");
  });

  it("reconciles a stale active lease left behind by a terminal run", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { runId, leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });

    const result = await heartbeatService(db).reconcileStaleTerminalRunLeases();

    expect(result).toEqual({ reconciled: 1, runIds: [runId] });
    const lease = await leaseRow(leaseId);
    expect(lease.status).toBe("expired");
    expect(lease.releasedAt).not.toBeNull();
  });

  it("reconciles stale terminal-run leases on the periodic reaper tick", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { leaseId } = await seedRunWithActiveLease({
      runStatus: "failed",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });

    const lease = await leaseRow(leaseId);
    expect(lease.status).toBe("failed");
    expect(lease.releasedAt).not.toBeNull();
  });

  // The reaper also runs a generic orphaned-active-lease sweep that moves such
  // a lease to pending_cleanup and destroys its sandbox. For a legacy run's
  // lease that is stale for both, the release path above goes first (a
  // reusable sandbox is released through the provider instead of destroyed).
  function recordingReleaseRuntime() {
    const releaseRunLeases = vi.fn(async (runId: string) => {
      await db
        .update(environmentLeases)
        .set({ status: "expired", releasedAt: new Date(), updatedAt: new Date() })
        .where(eq(environmentLeases.heartbeatRunId, runId));
      return [];
    });
    return { releaseRunLeases } as unknown as HeartbeatEnvironmentRuntime & {
      releaseRunLeases: typeof releaseRunLeases;
    };
  }

  it("releases a legacy run's stranded lease before the orphaned-lease sweep on the periodic tick", async () => {
    const reaperThresholdMs = 5 * 60 * 1000;
    // Stale for the reaper tick, but younger than the standalone grace.
    const staleForTick = new Date(Date.now() - reaperThresholdMs - 60 * 1000);
    expect(Date.now() - staleForTick.getTime()).toBeLessThan(STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { runId, leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: staleForTick,
      leaseUpdatedAt: staleForTick,
    });
    const runtime = recordingReleaseRuntime();

    await heartbeatService(db, { environmentRuntime: runtime }).reapOrphanedRuns({
      staleThresholdMs: reaperThresholdMs,
    });

    expect(runtime.releaseRunLeases.mock.calls.map((call) => call[0])).toEqual([runId]);
    const lease = await leaseRow(leaseId);
    expect(lease.status).toBe("expired");
    expect(lease.failureReason).not.toBe("orphaned_active_lease_recovered");
  });

  it("releases a legacy run's stranded lease before the orphaned-lease sweep on the startup reap", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { runId, leaseId } = await seedRunWithActiveLease({
      runStatus: "failed",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });
    const runtime = recordingReleaseRuntime();

    // The startup reap has no staleness threshold, so the sweep would take
    // every stranded lease at once; one past the grace is released instead.
    await heartbeatService(db, { environmentRuntime: runtime }).reapOrphanedRuns();

    expect(runtime.releaseRunLeases.mock.calls.map((call) => call[0])).toEqual([runId]);
    const lease = await leaseRow(leaseId);
    expect(lease.status).toBe("expired");
    expect(lease.failureReason).not.toBe("orphaned_active_lease_recovered");
  });

  it("leaves a terminal run's lease alone within the grace period", async () => {
    const recent = new Date(Date.now() - 60 * 1000);
    const { leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: recent,
      leaseUpdatedAt: recent,
    });

    const result = await heartbeatService(db).reconcileStaleTerminalRunLeases();

    expect(result.reconciled).toBe(0);
    expect((await leaseRow(leaseId)).status).toBe("active");
  });

  it("never touches the lease of a live run", async () => {
    const { leaseId } = await seedRunWithActiveLease({ runStatus: "running" });

    const result = await heartbeatService(db).reconcileStaleTerminalRunLeases({ graceMs: 0 });

    expect(result.reconciled).toBe(0);
    expect((await leaseRow(leaseId)).status).toBe("active");
  });

  it("never touches a lease whose executor is still settling in this process", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { runId, leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });
    adapterExecutionControls.set(runId, createAdapterExecutionControl());

    const result = await heartbeatService(db).reconcileStaleTerminalRunLeases();

    expect(result.reconciled).toBe(0);
    expect((await leaseRow(leaseId)).status).toBe("active");
  });

  it("releases a stale lease once when two server processes reconcile it at the same time", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { runId, leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });
    const provider = gatedReleaseRuntime();
    // Two service instances stand in for two server processes sharing the DB.
    const processA = heartbeatService(db, { environmentRuntime: provider.runtime });
    const processB = heartbeatService(db, { environmentRuntime: provider.runtime });

    const first = processA.reconcileStaleTerminalRunLeases();
    await provider.firstEntered;
    // A is inside the slow provider teardown; B's tick must not start another.
    const second = await settledOrBlocked(processB.reconcileStaleTerminalRunLeases());
    provider.open();

    expect(second).toEqual({ reconciled: 0, runIds: [] });
    expect(await first).toEqual({ reconciled: 1, runIds: [runId] });
    expect(provider.releasedRunIds).toEqual([runId]);
    expect((await leaseRow(leaseId)).status).toBe("expired");
  });

  it("skips an overlapping reconciliation in the same process instead of stacking teardowns", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const a = await seedRunWithActiveLease({ runStatus: "cancelled", finishedAt: longAgo, leaseUpdatedAt: longAgo });
    const b = await seedRunWithActiveLease({ runStatus: "failed", finishedAt: longAgo, leaseUpdatedAt: longAgo });
    const provider = gatedReleaseRuntime();
    const heartbeat = heartbeatService(db, { environmentRuntime: provider.runtime });

    const slowTick = heartbeat.reconcileStaleTerminalRunLeases();
    await provider.firstEntered;
    // The next reaper tick returns at once rather than waiting on the teardown.
    const nextTick = await settledOrBlocked(heartbeat.reconcileStaleTerminalRunLeases());
    expect(nextTick).toEqual({ reconciled: 0, runIds: [] });
    expect(provider.releasedRunIds).toHaveLength(1);
    provider.open();

    const result = await slowTick;
    expect(result.reconciled).toBe(2);
    expect([...result.runIds].sort()).toEqual([a.runId, b.runId].sort());
    expect(provider.releasedRunIds).toHaveLength(2);
  });

  it("retries a lease the release left active only after another grace period", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });
    // A release that cannot act (e.g. the lease's environment row is gone)
    // leaves the lease "active".
    const releaseRunLeases = vi.fn(async () => []);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: { releaseRunLeases } as unknown as HeartbeatEnvironmentRuntime,
    });

    await heartbeat.reconcileStaleTerminalRunLeases();
    const nextTick = await heartbeat.reconcileStaleTerminalRunLeases();

    // The claim pushed the lease behind the grace, so the next tick neither
    // repeats the teardown nor keeps the lease at the head of every page.
    expect(nextTick.reconciled).toBe(0);
    expect(releaseRunLeases).toHaveBeenCalledTimes(1);
    const lease = await leaseRow(leaseId);
    expect(lease.status).toBe("active");
    expect(lease.updatedAt.getTime()).toBeGreaterThan(longAgo.getTime());
  });

  it("logs a constant error kind and never the exception when a release fails", async () => {
    const sentinel = "Bearer sk-SENTINEL-d4e5f6";
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { runId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });
    const realUpdate = db.update.bind(db);
    const updateSpy = vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
      if (table === environmentLeases) {
        const failure = new Error(`lease claim failed: ${sentinel}`);
        (failure as { code?: string }).code = `ECLAIM ${sentinel}`;
        throw failure;
      }
      return realUpdate(table as Parameters<typeof realUpdate>[0]);
    }) as typeof db.update);
    vi.mocked(logger.warn).mockClear();

    try {
      const result = await heartbeatService(db).reconcileStaleTerminalRunLeases();
      expect(result.reconciled).toBe(0);
    } finally {
      updateSpy.mockRestore();
    }

    const call = vi
      .mocked(logger.warn)
      .mock.calls.find((entry) => entry[1] === "failed to reconcile stale environment lease for terminal run");
    expect(call).toBeDefined();
    const record = call![0] as Record<string, unknown>;
    expect(JSON.stringify(record)).not.toContain(sentinel);
    expect(record).not.toHaveProperty("err");
    expect(record).toEqual({ errorKind: "stale_terminal_run_lease_release_failed", runId });
  });

  it("leaves native runs to their finalization coordinator", async () => {
    const longAgo = new Date(Date.now() - 2 * STALE_TERMINAL_RUN_LEASE_GRACE_MS);
    const { leaseId } = await seedRunWithActiveLease({
      runStatus: "cancelled",
      runtimeMode: "native",
      finishedAt: longAgo,
      leaseUpdatedAt: longAgo,
    });

    const result = await heartbeatService(db).reconcileStaleTerminalRunLeases();

    expect(result.reconciled).toBe(0);
    expect((await leaseRow(leaseId)).status).toBe("active");
  });
});
