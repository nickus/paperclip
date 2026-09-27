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

import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { heartbeatService, STALE_TERMINAL_RUN_LEASE_GRACE_MS } from "../services/heartbeat.ts";

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
