import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reusable sandbox release retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PROVIDER = "kubernetes";
const ENVIRONMENT_CONFIG = {
  provider: PROVIDER,
  inCluster: true,
  backend: "sandbox-cr",
  reuseLease: true,
};
// The sweep's attempt counter and the attempt that owns a parked lease.
const ATTEMPTS_KEY = "pendingCleanupRetryAttempts";
const ATTEMPT_ID_KEY = "pendingCleanupAttemptId";
// Release attempts a parked reusable sandbox gets before the sweep destroys it.
const RELEASE_ATTEMPT_CAP = 3;

type ReleaseBehaviour = "stopped" | "destroyed" | "no_receipt" | "throw";

/**
 * A provider worker that keeps one sandbox per lease: release stops the run's
 * work and keeps the sandbox ("stopped"), resume hands it back, destroy removes
 * it. `sandboxes` is the provider-side truth. Release and destroy outcomes can
 * be scripted, and the worker can be taken down.
 */
function reusableProviderWorker(pluginId: string) {
  const sandboxes = new Map<string, "busy" | "idle">();
  let created = 0;
  const state = {
    running: true,
    releases: [] as ReleaseBehaviour[],
    destroyFails: 0,
    onRelease: null as null | ((params: Record<string, any>) => Promise<void>),
  };
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, any>) => {
    switch (method) {
      case "environmentAcquireLease": {
        created += 1;
        const id = `pc-sandbox-${pluginId.slice(0, 8)}-${created}`;
        sandboxes.set(id, "busy");
        return { providerLeaseId: id, metadata: { namespace: "paperclip-test", backend: "sandbox-cr", remoteCwd: "/workspace" } };
      }
      case "environmentResumeLease": {
        if (!sandboxes.has(params.providerLeaseId)) {
          return { providerLeaseId: null, metadata: { expired: true, reason: "not_found" } };
        }
        sandboxes.set(params.providerLeaseId, "busy");
        return {
          providerLeaseId: params.providerLeaseId,
          metadata: { namespace: "paperclip-test", backend: "sandbox-cr", remoteCwd: "/workspace", resumedLease: true },
        };
      }
      case "environmentReleaseLease": {
        await state.onRelease?.(params);
        const behaviour = state.releases.shift() ?? "stopped";
        if (behaviour === "throw") throw new Error("release timed out");
        if (behaviour === "no_receipt") return undefined;
        if (behaviour === "destroyed") {
          sandboxes.delete(params.providerLeaseId);
          return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        }
        sandboxes.set(params.providerLeaseId, "idle");
        return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      }
      case "environmentDestroyLease": {
        if (state.destroyFails > 0) {
          state.destroyFails -= 1;
          throw new Error("destroy failed");
        }
        sandboxes.delete(params.providerLeaseId);
        return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      }
      default:
        throw new Error(`Unexpected plugin method: ${method}`);
    }
  });
  const workerManager = {
    isRunning: vi.fn((id: string) => state.running && id === pluginId),
    call,
    getWorker: vi.fn(() => ({
      supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
    })),
  } as unknown as PluginWorkerManager;
  const calls = (method: string) =>
    call.mock.calls.filter(([, called]) => called === method).map(([, , params]) => params);
  return { sandboxes, state, call, calls, workerManager };
}

describeEmbeddedPostgres("reusable sandbox leases parked for a release", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("reusable-sandbox-release-retry");
    stopDb = () => started.cleanup();
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Drain background run work, then drop every row a test left behind: the
    // startup reap and the sweep act on all rows, not only the current test's.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies", "plugins", "environments" CASCADE`));
  });

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  }, 30_000);

  async function seed(options: { adapterType?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: options.adapterType ?? "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `acme.kubernetes-sandbox-provider.${pluginId}`,
      packageName: "@acme/kubernetes-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: `acme.kubernetes-sandbox-provider.${pluginId}`,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Kubernetes Sandbox Provider",
        description: "Test provider with reusable leases",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: PROVIDER,
            kind: "sandbox_provider",
            displayName: "Kubernetes",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                inCluster: { type: "boolean" },
                backend: { type: "string" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: now,
    } as any);
    await db.insert(environments).values({
      id: environmentId,
      name: `Reusable Kubernetes ${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: ENVIRONMENT_CONFIG,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build the feature",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      createdAt: now,
      updatedAt: now,
    });
    const worker = reusableProviderWorker(pluginId);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker.workerManager });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker.workerManager });

    async function insertRun(values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        contextSnapshot: { issueId },
        createdAt: new Date(),
        updatedAt: new Date(),
        ...values,
      });
      return runId;
    }

    /** A run that holds a reusable sandbox lease, as a run does while it works. */
    async function startRun(values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const runId = await insertRun(values);
      const environment = (await environmentService(db).getById(environmentId))!;
      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId,
        agentId,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
        adapterType: options.adapterType ?? "opencode_local",
      });
      expect(acquired.lease.leasePolicy).toBe("reuse_by_environment");
      return { runId, lease: acquired.lease };
    }

    /** A cancelled run whose release could not be confirmed: its lease is parked. */
    async function parkedLease(behaviour: ReleaseBehaviour = "throw") {
      const { runId, lease } = await startRun();
      worker.state.releases.push(behaviour);
      await runtime.releaseRunLeases(runId, "expired", undefined, undefined, true);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
      const parked = await leaseRow(lease.id);
      expect(parked).toMatchObject({
        status: "pending_cleanup",
        metadata: expect.objectContaining({ pendingCleanupIntent: "release" }),
      });
      return { runId, lease };
    }

    return { companyId, agentId, environmentId, issueId, pluginId, worker, runtime, heartbeat, insertRun, startRun, parkedLease };
  }

  async function leaseRow(leaseId: string) {
    return db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)).then((rows) => rows[0] ?? null);
  }

  /** Let the next sweep act at once instead of after the retry cooldown. */
  async function skipCooldown(leaseId: string) {
    await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} || '{"pendingCleanupRetryAfterMs":0}'::jsonb`,
      updatedAt: new Date(0),
    }).where(eq(environmentLeases.id, leaseId));
  }

  describe("the cleanup sweep", () => {
    it("retries the release and keeps the sandbox for the task's next run", async () => {
      const { worker, heartbeat, startRun, parkedLease } = await seed();
      const { runId, lease } = await parkedLease();

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(worker.calls("environmentReleaseLease").at(-1)).toMatchObject({
        providerLeaseId: lease.providerLeaseId,
        cancelActiveWork: true,
        runStatus: "expired",
      });
      expect(worker.calls("environmentDestroyLease")).toEqual([]);
      expect(worker.sandboxes.get(lease.providerLeaseId!)).toBe("idle");
      const released = await leaseRow(lease.id);
      expect(released).toMatchObject({
        status: "released",
        cleanupStatus: "success",
        failureReason: "pending_cleanup_release_retry",
        metadata: expect.objectContaining({
          remoteExecutionTermination: expect.objectContaining({ state: "stopped", leaseId: lease.id }),
        }),
      });
      expect(released?.metadata).not.toHaveProperty("pendingCleanupIntent");

      const next = await startRun();
      expect(next.lease.providerLeaseId).toBe(lease.providerLeaseId);
      expect(next.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed", previousRunId: runId });
    });

    it("defers the release while the plugin worker is down without using up an attempt", async () => {
      const { worker, heartbeat, parkedLease } = await seed();
      const { lease } = await parkedLease();
      const releasesBefore = worker.calls("environmentReleaseLease").length;
      worker.state.running = false;

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(worker.calls("environmentReleaseLease")).toHaveLength(releasesBefore);
      const deferred = await leaseRow(lease.id);
      expect(deferred).toMatchObject({ status: "pending_cleanup" });
      expect(deferred?.metadata?.[ATTEMPTS_KEY] ?? 0).toBe(0);

      worker.state.running = true;
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(await leaseRow(lease.id)).toMatchObject({ status: "released" });
      expect(worker.calls("environmentDestroyLease")).toEqual([]);
    });

    it("destroys the sandbox once the release has failed on every allowed attempt", async () => {
      const { worker, heartbeat, parkedLease } = await seed();
      const { lease } = await parkedLease();
      const releasesBefore = worker.calls("environmentReleaseLease").length;
      worker.state.releases.push("throw", "no_receipt", "throw", "stopped");

      for (let attempt = 1; attempt <= RELEASE_ATTEMPT_CAP; attempt += 1) {
        await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
        const row = await leaseRow(lease.id);
        expect(row).toMatchObject({
          status: "pending_cleanup",
          metadata: expect.objectContaining({ pendingCleanupIntent: "release", [ATTEMPTS_KEY]: attempt }),
        });
        await skipCooldown(lease.id);
      }
      expect(worker.calls("environmentDestroyLease")).toEqual([]);

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      // No fourth release: the sweep tears the sandbox down instead.
      expect(worker.calls("environmentReleaseLease")).toHaveLength(releasesBefore + RELEASE_ATTEMPT_CAP);
      expect(worker.calls("environmentDestroyLease")).toEqual([
        expect.objectContaining({ providerLeaseId: lease.providerLeaseId }),
      ]);
      expect(worker.sandboxes.has(lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("keeps destroying once it has fallen back to a destroy", async () => {
      const { worker, heartbeat, parkedLease } = await seed();
      const { lease } = await parkedLease();
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ [ATTEMPTS_KEY]: RELEASE_ATTEMPT_CAP })}::jsonb`,
      }).where(eq(environmentLeases.id, lease.id));
      worker.state.destroyFails = 1;

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(await leaseRow(lease.id)).toMatchObject({
        status: "pending_cleanup",
        metadata: expect.objectContaining({ pendingCleanupIntent: "destroy" }),
      });
      // Even with the counter back under the cap, a destroy is never turned
      // back into a release.
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ [ATTEMPTS_KEY]: 0 })}::jsonb`,
      }).where(eq(environmentLeases.id, lease.id));
      await skipCooldown(lease.id);
      const releasesBefore = worker.calls("environmentReleaseLease").length;

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(worker.calls("environmentReleaseLease")).toHaveLength(releasesBefore);
      expect(worker.calls("environmentDestroyLease")).toHaveLength(2);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "expired" });
    });

    it("ignores a release that completes after a newer cleanup attempt took the lease over", async () => {
      const { worker, heartbeat, parkedLease } = await seed();
      const { lease } = await parkedLease();
      const releaseStarted = Promise.withResolvers<void>();
      const finishRelease = Promise.withResolvers<void>();
      worker.state.onRelease = async () => {
        releaseStarted.resolve();
        await finishRelease.promise;
      };

      const sweeping = heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      await releaseStarted.promise;
      // The attempt outlived its claim and a newer attempt owns the lease now.
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ [ATTEMPT_ID_KEY]: "newer-attempt" })}::jsonb`,
      }).where(eq(environmentLeases.id, lease.id));
      finishRelease.resolve();
      await sweeping;

      const row = await leaseRow(lease.id);
      expect(row).toMatchObject({
        status: "pending_cleanup",
        metadata: expect.objectContaining({ [ATTEMPT_ID_KEY]: "newer-attempt", pendingCleanupIntent: "release" }),
      });
      expect(row?.metadata).not.toHaveProperty("remoteExecutionTermination");
    });

    it("destroys a parked reusable lease that carries no cleanup intent", async () => {
      const { worker, heartbeat, parkedLease } = await seed();
      const { lease } = await parkedLease();
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} - 'pendingCleanupIntent'`,
      }).where(eq(environmentLeases.id, lease.id));
      const releasesBefore = worker.calls("environmentReleaseLease").length;

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(worker.calls("environmentReleaseLease")).toHaveLength(releasesBefore);
      expect(worker.calls("environmentDestroyLease")).toHaveLength(1);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "expired", failureReason: "pending_cleanup_retry" });
    });

    it("never keeps a sandbox that was parked for a destroy", async () => {
      const { worker, runtime, heartbeat, startRun } = await seed();
      const { runId, lease } = await startRun();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
      const environment = (await environmentService(db).getById(lease.environmentId!))!;
      worker.state.destroyFails = 1;
      await runtime.destroyRunLease({ environment, lease, failureReason: "execution_workspace_closed" });
      expect(await leaseRow(lease.id)).toMatchObject({
        status: "pending_cleanup",
        metadata: expect.objectContaining({ pendingCleanupIntent: "destroy" }),
      });

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(worker.calls("environmentReleaseLease")).toEqual([]);
      expect(worker.calls("environmentDestroyLease")).toHaveLength(2);
      expect(worker.sandboxes.has(lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "expired" });
    });

    it.each([
      ["moved to another provider", { ...ENVIRONMENT_CONFIG, provider: "other-provider" }],
      ["stopped reusing sandboxes", { ...ENVIRONMENT_CONFIG, reuseLease: false }],
    ])("tears the sandbox down from the lease's recorded provider when the environment %s", async (_label, config) => {
      const { environmentId, worker, heartbeat, parkedLease } = await seed();
      const { lease } = await parkedLease();
      await db.update(environments).set({ config }).where(eq(environments.id, environmentId));
      const releasesBefore = worker.calls("environmentReleaseLease").length;

      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(worker.calls("environmentReleaseLease")).toHaveLength(releasesBefore);
      expect(worker.calls("environmentDestroyLease")).toEqual([
        expect.objectContaining({ driverKey: PROVIDER, providerLeaseId: lease.providerLeaseId }),
      ]);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });
  });

  describe("the startup reap", () => {
    it("releases the sandbox of a run that ended just before the restart instead of destroying it", async () => {
      const { worker, heartbeat, startRun } = await seed();
      const { runId, lease } = await startRun();
      // The run was cancelled a minute before the restart; its executor died
      // before it could release the lease.
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(Date.now() - 60_000) })
        .where(eq(heartbeatRuns.id, runId));

      await heartbeat.reapOrphanedRuns();

      expect(worker.calls("environmentDestroyLease")).toEqual([]);
      expect(worker.calls("environmentReleaseLease")).toEqual([
        expect.objectContaining({ providerLeaseId: lease.providerLeaseId, cancelActiveWork: true }),
      ]);
      expect(worker.sandboxes.get(lease.providerLeaseId!)).toBe("idle");
      const row = await leaseRow(lease.id);
      expect(row).toMatchObject({ status: "released", cleanupStatus: "success" });
      expect(row?.failureReason).not.toBe("orphaned_active_lease_recovered");
    });

    it("parks a lost run's sandbox while the plugin worker is down and keeps it once the worker is back", async () => {
      const { worker, heartbeat, startRun } = await seed({ adapterType: "claude_local" });
      // A run whose process this restart lost (its pid is gone).
      const { runId, lease } = await startRun({
        processPid: 999_999_999,
        runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      });
      worker.state.running = false;

      await heartbeat.reapOrphanedRuns();

      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "failed", errorCode: "process_lost" });
      const parked = await leaseRow(lease.id);
      expect(parked).toMatchObject({
        status: "pending_cleanup",
        metadata: expect.objectContaining({ pendingCleanupIntent: "release", pendingCleanupReleaseRunStatus: "failed" }),
      });
      expect(parked?.metadata?.[ATTEMPTS_KEY] ?? 0).toBe(0);
      expect(worker.calls("environmentReleaseLease")).toEqual([]);

      worker.state.running = true;
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(await leaseRow(lease.id)).toMatchObject({ status: "released" });
      expect(worker.calls("environmentDestroyLease")).toEqual([]);
      expect(worker.sandboxes.get(lease.providerLeaseId!)).toBe("idle");
      // A lost process is not a failure of the sandbox: the provider does not
      // count it toward giving the sandbox up.
      expect(worker.calls("environmentReleaseLease")).toEqual([
        expect.objectContaining({
          providerLeaseId: lease.providerLeaseId,
          runStatus: "interrupted",
          // The lost run never removed its scratch directory and launchers.
          runPrivatePaths: [
            `/workspace/.paperclip-runtime/runs/${runId}`,
            `/workspace/.paperclip-runtime/github/${runId}`,
          ],
        }),
      ]);
    });

    it("retries a lost run's parked release before it queues the run's retry", async () => {
      const { agentId, worker, heartbeat, startRun } = await seed({ adapterType: "claude_local" });
      const { runId, lease } = await startRun({
        processPid: 999_999_999,
        runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      });
      // The first release times out; the retry goes through.
      worker.state.releases.push("throw", "stopped");
      const runsAtEachRelease: number[] = [];
      worker.state.onRelease = async () => {
        runsAtEachRelease.push(
          (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).length,
        );
      };

      await heartbeat.reapOrphanedRuns();

      expect(await leaseRow(lease.id)).toMatchObject({ status: "released" });
      expect(worker.calls("environmentDestroyLease")).toEqual([]);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      const retry = runs.find((run) => run.id !== runId);
      expect(retry).toBeDefined();
      // Both releases ran while the lost run was the agent's only run.
      expect(runsAtEachRelease).toEqual([1, 1]);
      expect(worker.calls("environmentReleaseLease").map((params) => params.runStatus)).toEqual([
        "interrupted",
        "interrupted",
      ]);
    });
  });

  describe("closing a task", () => {
    it("leaves a released sandbox of the task as it is", async () => {
      const { companyId, issueId, worker, runtime, startRun } = await seed();
      const { runId, lease } = await startRun();
      await runtime.releaseRunLeases(runId, "released");
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
      const callsBefore = worker.call.mock.calls.length;

      await runtime.releaseIdleReusableSandboxLeases({ companyId, issueId });

      expect(worker.call.mock.calls).toHaveLength(callsBefore);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "released" });
      expect(worker.sandboxes.get(lease.providerLeaseId!)).toBe("idle");
    });

    it("stops a warm runner's sandbox and keeps it idle", async () => {
      const { companyId, issueId, worker, runtime, startRun } = await seed();
      const { runId, lease } = await startRun();
      await runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
      expect(await leaseRow(lease.id)).toMatchObject({ status: "retained" });

      await runtime.releaseIdleReusableSandboxLeases({ companyId, issueId });

      expect(worker.calls("environmentDestroyLease")).toEqual([]);
      expect(worker.calls("environmentReleaseLease")).toEqual([
        expect.objectContaining({ providerLeaseId: lease.providerLeaseId, cancelActiveWork: true }),
      ]);
      expect(await leaseRow(lease.id)).toMatchObject({ status: "released", cleanupStatus: "success" });
      expect(worker.sandboxes.get(lease.providerLeaseId!)).toBe("idle");
    });

    it("leaves the sandbox of a run that is still live alone", async () => {
      const { companyId, issueId, worker, runtime, startRun } = await seed();
      const live = await startRun();
      await runtime.releaseRunLeases(live.runId, "released", undefined, "keep_running");

      await runtime.releaseIdleReusableSandboxLeases({ companyId, issueId });

      expect(worker.calls("environmentReleaseLease")).toEqual([]);
      expect(worker.calls("environmentDestroyLease")).toEqual([]);
      expect(await leaseRow(live.lease.id)).toMatchObject({ status: "retained" });
    });
  });
});
