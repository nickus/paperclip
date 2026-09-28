import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
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
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// The adapter stands in for a remote-managed adapter: before it launches the
// agent it stages the workspace into the sandbox through the execution target's
// native sync, which every such adapter does (`prepareAdapterExecutionTargetRuntime`
// routes all staging through `syncIn`).
// Each run also records its task's disposition (here: moves it to review), as
// an agent does through the API. A run that leaves its task in progress without
// one gets disposition-repair runs, the later of them scheduled after a delay,
// which would keep a wake from ever settling.
const recordDisposition = vi.hoisted(() => ({
  current: null as null | ((issueId: unknown) => Promise<void>),
}));

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (input: { executionTarget?: any; context?: Record<string, unknown> }) => {
    const target = input.executionTarget;
    if (target?.kind === "remote" && typeof target.runner?.syncIn === "function") {
      await target.runner.syncIn([{ operationId: "sync-op-1", files: [] }]);
      await target.runner.syncOut([{ operationId: "sync-op-2", files: [] }]);
    }
    await recordDisposition.current?.(input.context?.issueId);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "opencode_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "opencode_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres sandbox workspace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PROVIDER = "kubernetes";

/**
 * A provider worker shaped like the Kubernetes sandbox provider:
 * - acquire pins `remoteCwd` on the lease only for a sandbox it keeps between
 *   runs (reuse on, a reuse scope of execution workspace + agent, and a host
 *   that records the lease as reusable); a per-run sandbox gets no `remoteCwd`
 *   at acquire;
 * - realize reports the workspace dir as `remoteCwd` in its result metadata;
 * - native sync requires `remoteCwd` on the lease metadata it is handed.
 */
function kubernetesLikeProviderWorker(pluginId: string, sandboxRoot: string) {
  const sandboxCwd = path.join(sandboxRoot, "workspace");
  const sandboxHome = path.join(sandboxRoot, "home");
  const sandboxes = new Map<string, "busy" | "idle">();
  const syncLeaseMetadata: Array<Record<string, unknown> | undefined> = [];
  let created = 0;
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, any>) => {
    switch (method) {
      case "environmentAcquireLease": {
        created += 1;
        const id = `pc-sandbox-${created}`;
        sandboxes.set(id, "busy");
        const hostAllowsReuse =
          typeof params.leasePolicy !== "string" || params.leasePolicy === "reuse_by_environment";
        const keepsSandbox =
          params.config?.reuseLease === true &&
          hostAllowsReuse &&
          typeof params.executionWorkspaceId === "string" &&
          params.executionWorkspaceId.length > 0 &&
          typeof params.agentId === "string" &&
          params.agentId.length > 0 &&
          !params.requestedExpiresAt;
        return {
          providerLeaseId: id,
          metadata: {
            backend: "sandbox-cr",
            nativeFileSyncUnsupported: false,
            ...(keepsSandbox ? { remoteCwd: sandboxCwd, kubernetesReuse: { key: id } } : {}),
          },
        };
      }
      case "environmentResumeLease": {
        if (!sandboxes.has(params.providerLeaseId)) {
          return { providerLeaseId: null, metadata: { expired: true, reason: "not_found" } };
        }
        sandboxes.set(params.providerLeaseId, "busy");
        return {
          providerLeaseId: params.providerLeaseId,
          metadata: {
            backend: "sandbox-cr",
            nativeFileSyncUnsupported: false,
            remoteCwd: sandboxCwd,
            kubernetesReuse: { key: params.providerLeaseId },
            resumedLease: true,
          },
        };
      }
      case "environmentRealizeWorkspace": {
        const cwd =
          typeof params.workspace?.remotePath === "string" && params.workspace.remotePath.trim().length > 0
            ? params.workspace.remotePath.trim()
            : sandboxCwd;
        return { cwd, metadata: { provider: PROVIDER, remoteCwd: cwd } };
      }
      case "environmentExecute": {
        // Run the commands the host issues before the (mocked) adapter in a host
        // temp dir standing in for the sandbox.
        const result = spawnSync(params.command, params.args ?? [], {
          cwd: params.cwd ?? sandboxCwd,
          env: { ...process.env, ...(params.env ?? {}), HOME: sandboxHome },
          input: params.stdin ?? undefined,
          encoding: "utf-8",
          timeout: params.timeoutMs ?? 30_000,
        });
        return {
          exitCode: result.status ?? 1,
          signal: result.signal ?? null,
          timedOut: false,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }
      case "environmentSyncIn":
      case "environmentSyncOut": {
        const metadata = params.lease?.metadata as Record<string, unknown> | undefined;
        syncLeaseMetadata.push(metadata);
        const remoteCwd = metadata?.remoteCwd;
        if (typeof remoteCwd !== "string" || remoteCwd.trim().length === 0) {
          throw new Error("Kubernetes file sync requires a workspace remote dir on the lease metadata.");
        }
        return {
          operations: (params.operations ?? []).map((operation: { operationId: string }) => ({
            operationId: operation.operationId,
            filesTransferred: 0,
            bytesTransferred: 0,
          })),
        };
      }
      case "environmentReleaseLease":
        sandboxes.set(params.providerLeaseId, "idle");
        return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      case "environmentDestroyLease":
        sandboxes.delete(params.providerLeaseId);
        return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      default:
        throw new Error(`Unexpected plugin method: ${method}`);
    }
  });
  const workerManager = {
    isRunning: vi.fn((id: string) => id === pluginId),
    call,
    getWorker: vi.fn(() => ({
      supportedMethods: [
        "environmentResumeLease",
        "environmentReleaseLease",
        "environmentDestroyLease",
        "environmentRealizeWorkspace",
        "environmentExecute",
        "environmentSyncIn",
        "environmentSyncOut",
      ],
    })),
  } as unknown as PluginWorkerManager;
  return { call, sandboxCwd, sandboxes, syncLeaseMetadata, workerManager };
}

describeEmbeddedPostgres("heartbeat sandbox runs without a project workspace", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-sandbox-projectless-workspace");
    stopDb = () => started.cleanup();
    db = createDb(started.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    recordDisposition.current = async (issueId) => {
      if (typeof issueId !== "string") return;
      await db.update(issues).set({ status: "in_review", updatedAt: new Date() }).where(eq(issues.id, issueId));
    };
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    recordDisposition.current = null;
    await db.$client.end();
    await stopDb?.();
  }, 30_000);

  async function seed(environmentConfig: Record<string, unknown>, options: { withProject: boolean }) {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const agentId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    let projectId: string | null = null;
    if (options.withProject) {
      projectId = randomUUID();
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-project-workspace-"));
      tempRoots.push(workspaceRoot);
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Sandbox project",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(projectWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        name: "Primary",
        cwd: workspaceRoot,
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      });
    }
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
        description: "Test provider with native file sync and reusable leases",
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
      companyId,
      name: `Kubernetes sandbox ${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: PROVIDER, inCluster: true, backend: "sandbox-cr", ...environmentConfig },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: environmentId,
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Write the plan",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      createdAt: now,
      updatedAt: now,
    });

    const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-pod-"));
    tempRoots.push(sandboxRoot);
    await mkdir(path.join(sandboxRoot, "workspace"), { recursive: true });
    await mkdir(path.join(sandboxRoot, "home"), { recursive: true });
    const worker = kubernetesLikeProviderWorker(pluginId, sandboxRoot);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker.workerManager });

    async function agentRuns() {
      return await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
    }

    function countCalls(method: string) {
      return worker.call.mock.calls.filter(([, called]) => called === method).length;
    }

    /**
     * Wake the agent once (on the issue, or with no issue at all) and wait until
     * every run it led to has finished and handed its sandbox back.
     */
    async function wakeAndSettle(target: { issue: boolean }) {
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: target.issue ? { issueId } : {},
      });
      expect(run).not.toBeNull();
      let settledCount = -1;
      for (;;) {
        await vi.waitFor(async () => {
          const runs = await agentRuns();
          expect(runs.length).toBeGreaterThan(0);
          expect(runs.filter((entry) => ["queued", "scheduled_retry", "running"].includes(entry.status))).toEqual([]);
          expect(countCalls("environmentReleaseLease") + countCalls("environmentDestroyLease")).toBeGreaterThanOrEqual(
            countCalls("environmentAcquireLease") + countCalls("environmentResumeLease"),
          );
        }, { timeout: 15_000, interval: 50 });
        const count = (await agentRuns()).length;
        if (count === settledCount) break;
        settledCount = count;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return await agentRuns();
    }

    async function leases() {
      return await db
        .select({
          leasePolicy: environmentLeases.leasePolicy,
          executionWorkspaceId: environmentLeases.executionWorkspaceId,
          metadata: environmentLeases.metadata,
        })
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environmentId));
    }

    function acquireCalls() {
      return worker.call.mock.calls
        .filter(([, method]) => method === "environmentAcquireLease")
        .map(([, , params]) => params as Record<string, unknown>);
    }

    return { issueId, wakeAndSettle, leases, acquireCalls, worker };
  }

  const cases = [
    { label: "an issue with no project, reuseLease on", issue: true, reuseLease: true },
    { label: "an issue with no project, reuseLease off", issue: true, reuseLease: false },
    { label: "no issue, reuseLease on", issue: false, reuseLease: true },
    { label: "no issue, reuseLease off", issue: false, reuseLease: false },
  ];

  it.each(cases)("stages the workspace through native sync for $label", async ({ issue, reuseLease }) => {
    const { wakeAndSettle, leases, acquireCalls, worker } = await seed({ reuseLease }, { withProject: false });

    const runs = await wakeAndSettle({ issue });

    // Such a run has no execution workspace, so there is no reuse scope and the
    // provider always gives it a per-run sandbox, which pins no remote dir at
    // acquire, whatever the reuse setting.
    expect(acquireCalls().length).toBeGreaterThanOrEqual(1);
    for (const params of acquireCalls()) {
      expect(params.executionWorkspaceId ?? null).toBeNull();
    }

    // Every run succeeds: the adapter staged its workspace into the sandbox.
    expect(runs.map((entry) => [entry.status, entry.error])).toEqual(runs.map(() => ["succeeded", null]));
    expect(adapterExecute).toHaveBeenCalled();
    // Native sync ran, and every call was handed the realized workspace dir on
    // the lease, so the provider had a root to confine the transfer to.
    expect(worker.syncLeaseMetadata.length).toBeGreaterThanOrEqual(2);
    for (const metadata of worker.syncLeaseMetadata) {
      expect(metadata?.remoteCwd).toBe(worker.sandboxCwd);
    }
    // The lease row records the realized workspace dir too.
    for (const lease of await leases()) {
      expect(lease.metadata?.remoteCwd).toBe(worker.sandboxCwd);
    }
  }, 60_000);

  it.each([
    { label: "reuseLease on", reuseLease: true },
    { label: "reuseLease off", reuseLease: false },
  ])("keeps native sync working for an issue in a project ($label)", async ({ reuseLease }) => {
    const { wakeAndSettle, worker } = await seed({ reuseLease }, { withProject: true });

    const runs = await wakeAndSettle({ issue: true });

    expect(runs.map((entry) => [entry.status, entry.error])).toEqual(runs.map(() => ["succeeded", null]));
    expect(worker.syncLeaseMetadata.length).toBeGreaterThanOrEqual(2);
    for (const metadata of worker.syncLeaseMetadata) {
      expect(metadata?.remoteCwd).toBe(worker.sandboxCwd);
    }
  }, 60_000);
});
