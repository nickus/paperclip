import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  adapterExecutionTargetReusesSandbox,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { sessionCodec as claudeSessionCodec } from "@paperclipai/adapter-claude-local/server";
import { sessionCodec as opencodeSessionCodec } from "@paperclipai/adapter-opencode-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.ts";
import { remoteExecutionHasStopped } from "../services/remote-execution-termination.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reusable sandbox session tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PROVIDER = "kubernetes";
const ENVIRONMENT_CONFIG = {
  provider: PROVIDER,
  inCluster: true,
  backend: "sandbox-cr",
  reuseLease: true,
  runnerIdleTimeoutMs: 86_400_000,
};

/**
 * A plugin worker that behaves like a provider keeping one long-lived sandbox
 * per lease: release stops the run and keeps the sandbox ("stopped"), resume
 * hands back the same provider lease id and working directory, destroy removes
 * it. `sandboxes` is the provider-side truth.
 */
function reusableProviderWorker() {
  const sandboxes = new Map<string, "busy" | "idle">();
  let created = 0;
  const leaseMetadata = (id: string) => ({
    namespace: "paperclip-test",
    jobName: id,
    podName: id,
    backend: "sandbox-cr",
    remoteCwd: "/workspace",
  });
  const releaseReceipt = vi.fn((id: string): { providerLeaseId: string; state: "stopped" | "destroyed" } => ({
    providerLeaseId: id,
    state: "stopped",
  }));
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, any>) => {
    switch (method) {
      case "environmentAcquireLease": {
        created += 1;
        const id = `pc-sandbox-${created}`;
        sandboxes.set(id, "busy");
        return { providerLeaseId: id, metadata: leaseMetadata(id) };
      }
      case "environmentResumeLease": {
        if (!sandboxes.has(params.providerLeaseId)) {
          return { providerLeaseId: null, metadata: { expired: true, reason: "not_found" } };
        }
        sandboxes.set(params.providerLeaseId, "busy");
        return {
          providerLeaseId: params.providerLeaseId,
          metadata: { ...leaseMetadata(params.providerLeaseId), resumedLease: true },
        };
      }
      case "environmentReleaseLease": {
        const receipt = releaseReceipt(params.providerLeaseId);
        if (receipt.state === "destroyed") sandboxes.delete(params.providerLeaseId);
        else sandboxes.set(params.providerLeaseId, "idle");
        return receipt;
      }
      case "environmentDestroyLease":
        sandboxes.delete(params.providerLeaseId);
        return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      default:
        throw new Error(`Unexpected plugin method: ${method}`);
    }
  });
  return { sandboxes, call, releaseReceipt };
}

describeEmbeddedPostgres("reusable sandbox leases carry the harness session to the next run", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("reusable-sandbox-session");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active", createdAt: now, updatedAt: now });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "Reusable Kubernetes",
      driver: "sandbox",
      status: "active",
      config: ENVIRONMENT_CONFIG,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.kubernetes-sandbox-provider",
      packageName: "@acme/kubernetes-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.kubernetes-sandbox-provider",
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
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Project",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "Task workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: now,
      updatedAt: now,
    });
    const environment = (await environmentService(db).getById(environmentId))!;
    const worker = reusableProviderWorker();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: worker.call,
      getWorker: vi.fn(() => ({
        supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
      })),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    async function startRun() {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        agentId,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "isolated_workspace" },
        adapterType: "opencode_local",
      });
      const target = await resolveEnvironmentExecutionTarget({
        db,
        companyId,
        adapterType: "opencode_local",
        environment,
        leaseId: acquired.lease.id,
        leaseMetadata: acquired.lease.metadata,
        lease: acquired.lease,
      });
      return { runId, lease: acquired.lease, target: target as AdapterExecutionTarget };
    }

    return { companyId, runtime, worker, startRun };
  }

  /**
   * What the adapter saves at the end of a run (session id + execution
   * identity) after the heartbeat persisted it through the adapter's session
   * codec, as read back on the next run.
   */
  function persistedSession(
    codec: typeof opencodeSessionCodec,
    sessionId: string,
    target: AdapterExecutionTarget,
  ) {
    const saved = codec.serialize({
      sessionId,
      cwd: target.kind === "remote" ? target.remoteCwd : "",
      remoteExecution: adapterExecutionTargetSessionIdentity(target),
    });
    return codec.deserialize(JSON.parse(JSON.stringify(saved)))!;
  }

  it("resumes the same sandbox, working directory and harness session on a follow-up run", async () => {
    const { companyId, runtime, worker, startRun } = await seed();

    const first = await startRun();
    expect(first.target).toMatchObject({ transport: "sandbox", remoteCwd: "/workspace" });
    const opencodeSession = persistedSession(opencodeSessionCodec, "ses_task_1", first.target);
    const claudeSession = persistedSession(
      claudeSessionCodec,
      "11111111-1111-4111-8111-111111111111",
      first.target,
    );
    await runtime.releaseRunLeases(first.runId, "released");

    // The provider kept the sandbox and certified the stop.
    expect(worker.sandboxes.get(first.lease.providerLeaseId!)).toBe("idle");
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({ status: "released" });
    expect(await remoteExecutionHasStopped(db, companyId, first.runId)).toBe(true);

    const second = await startRun();

    // A new lease row for the new run, on the same provider sandbox.
    expect(second.lease.id).not.toBe(first.lease.id);
    expect(second.lease.providerLeaseId).toBe(first.lease.providerLeaseId);
    expect(second.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(second.target).toMatchObject({ remoteCwd: "/workspace", leaseId: second.lease.id });
    expect(worker.call.mock.calls.filter(([, method]) => method === "environmentAcquireLease")).toHaveLength(1);

    // The saved session passes the adapters' session-match gate on the resumed sandbox.
    expect(opencodeSession.remoteExecution).toMatchObject({
      transport: "sandbox",
      leaseId: first.lease.id,
      providerLeaseId: first.lease.providerLeaseId,
      remoteCwd: "/workspace",
    });
    expect(adapterExecutionTargetSessionMatches(opencodeSession.remoteExecution, second.target)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(claudeSession.remoteExecution, second.target)).toBe(true);
    // Adapters treat the sandbox as kept between runs (build directories and
    // per-account harness homes carry over).
    expect(adapterExecutionTargetReusesSandbox(second.target)).toBe(true);
  });

  it("tells the provider which lease policy it records and how each run ended", async () => {
    const { runtime, worker, startRun } = await seed();
    const first = await startRun();
    await runtime.releaseRunLeases(first.runId, "failed");
    const second = await startRun();
    await runtime.releaseRunLeases(second.runId, "released");

    const acquire = worker.call.mock.calls.find(([, method]) => method === "environmentAcquireLease");
    expect(acquire?.[2]).toMatchObject({ leasePolicy: "reuse_by_environment" });
    const releases = worker.call.mock.calls
      .filter(([, method]) => method === "environmentReleaseLease")
      .map(([, , params]) => params.runStatus);
    expect(releases).toEqual(["failed", "released"]);
  });

  it("starts a fresh session when the sandbox had to be replaced", async () => {
    const { runtime, worker, startRun } = await seed();
    const first = await startRun();
    const session = persistedSession(opencodeSessionCodec, "ses_task_1", first.target);
    await runtime.releaseRunLeases(first.runId, "released");
    worker.sandboxes.delete(first.lease.providerLeaseId!); // e.g. reaped after its idle TTL

    const second = await startRun();

    expect(second.lease.providerLeaseId).not.toBe(first.lease.providerLeaseId);
    expect(second.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "replacement" });
    expect(adapterExecutionTargetSessionMatches(session.remoteExecution, second.target)).toBe(false);
  });

  it("keeps a stopped sandbox resumable after a failed run", async () => {
    const { companyId, runtime, startRun } = await seed();
    const first = await startRun();
    await runtime.releaseRunLeases(first.runId, "failed");

    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "released",
      failureReason: "adapter_or_run_failure",
      cleanupStatus: "success",
    });
    expect(await remoteExecutionHasStopped(db, companyId, first.runId)).toBe(true);

    const second = await startRun();
    expect(second.lease.providerLeaseId).toBe(first.lease.providerLeaseId);
    expect(second.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
  });

  it("records a failed run as failed when the provider destroyed the sandbox", async () => {
    const { runtime, worker, startRun } = await seed();
    const first = await startRun();
    worker.releaseReceipt.mockImplementationOnce((id) => ({ providerLeaseId: id, state: "destroyed" }));

    await runtime.releaseRunLeases(first.runId, "failed");

    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "failed",
      failureReason: "adapter_or_run_failure",
    });
  });

  it("destroys the sandbox of a cancelled run", async () => {
    const { runtime, worker, startRun } = await seed();
    const first = await startRun();

    await runtime.releaseRunLeases(first.runId, "expired");

    expect(worker.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
    expect(
      worker.call.mock.calls.filter(
        ([, method, params]) =>
          method === "environmentDestroyLease" && params.providerLeaseId === first.lease.providerLeaseId,
      ),
    ).toHaveLength(1);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({ status: "expired" });
  });
});
