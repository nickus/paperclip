import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environments,
  executionWorkspaces,
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

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  provider: "test",
  model: "test-model",
})));

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
    `Skipping embedded Postgres reusable sandbox workspace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PROVIDER = "kubernetes";

/**
 * A provider worker that keeps one sandbox per lease: release stops the run and
 * keeps the sandbox, resume hands the same sandbox back.
 */
function reusableProviderWorker(pluginId: string, sandboxRoot: string) {
  const sandboxCwd = path.join(sandboxRoot, "workspace");
  const sandboxHome = path.join(sandboxRoot, "home");
  const sandboxes = new Map<string, "busy" | "idle">();
  let created = 0;
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, any>) => {
    switch (method) {
      case "environmentAcquireLease": {
        created += 1;
        const id = `pc-sandbox-${created}`;
        sandboxes.set(id, "busy");
        return { providerLeaseId: id, metadata: { remoteCwd: sandboxCwd } };
      }
      case "environmentResumeLease": {
        if (!sandboxes.has(params.providerLeaseId)) {
          return { providerLeaseId: null, metadata: { expired: true, reason: "not_found" } };
        }
        sandboxes.set(params.providerLeaseId, "busy");
        return {
          providerLeaseId: params.providerLeaseId,
          metadata: { remoteCwd: sandboxCwd, resumedLease: true },
        };
      }
      case "environmentRealizeWorkspace":
        return { cwd: sandboxCwd, metadata: {} };
      case "environmentExecute": {
        // Run the sandbox commands the run issues before the (mocked) adapter
        // (Git context probe, launcher uploads) in a host temp dir standing in
        // for the sandbox.
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
      supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
    })),
  } as unknown as PluginWorkerManager;
  return { call, sandboxes, workerManager };
}

describeEmbeddedPostgres("heartbeat keeps a task on one execution workspace for reusable sandboxes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-reusable-sandbox-workspace");
    stopDb = () => started.cleanup();
    db = createDb(started.connectionString);
    // The default posture: the opt-in isolated worktree UI is off.
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await db.$client.end();
    await stopDb?.();
  }, 30_000);

  async function seed(environmentConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-reusable-sandbox-workspace-"));
    tempRoots.push(workspaceRoot);
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reusable sandbox project",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
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
    // A plain task: no project workspace policy and no per-task workspace
    // settings, so it runs in the shared project workspace.
    async function insertIssue(id: string, title: string) {
      await db.insert(issues).values({
        id,
        companyId,
        projectId,
        title,
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        createdAt: now,
        updatedAt: now,
      });
    }
    await insertIssue(issueId, "Implement the feature");

    /** Another task for the same agent, in the same project and environment. */
    async function addIssue(title: string) {
      const id = randomUUID();
      await insertIssue(id, title);
      return id;
    }
    const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-reusable-sandbox-pod-"));
    tempRoots.push(sandboxRoot);
    await mkdir(path.join(sandboxRoot, "workspace"), { recursive: true });
    await mkdir(path.join(sandboxRoot, "home"), { recursive: true });
    const worker = reusableProviderWorker(pluginId, sandboxRoot);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker.workerManager });

    async function agentRuns() {
      return await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
    }

    function countCalls(method: string) {
      return worker.call.mock.calls.filter(([, called]) => called === method).length;
    }

    /**
     * Wake the agent on the task and wait until every run it led to (the
     * heartbeat may queue its own follow-up runs) has finished and released its
     * sandbox lease, as between two real runs of a task.
     */
    async function wakeAndSettle(targetIssueId: string = issueId) {
      const before = (await agentRuns()).length;
      if (before > 0) {
        // A reply on the task since the last run, so the follow-up wake is new
        // input rather than a throttled rewake.
        await db.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: "responsible-user",
          action: "issue.comment_added",
          entityType: "issue",
          entityId: targetIssueId,
          createdAt: new Date(),
        });
      }
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { issueId: targetIssueId },
      });
      expect(run).not.toBeNull();
      let settledCount = -1;
      for (;;) {
        await vi.waitFor(async () => {
          const runs = await agentRuns();
          expect(runs.length).toBeGreaterThan(before);
          expect(runs.filter((entry) => ["queued", "scheduled_retry", "running"].includes(entry.status))).toEqual([]);
          expect(countCalls("environmentReleaseLease")).toBe(
            countCalls("environmentAcquireLease") + countCalls("environmentResumeLease"),
          );
        }, { timeout: 15_000, interval: 50 });
        const count = (await agentRuns()).length;
        if (count === settledCount) break;
        settledCount = count;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const runs = await agentRuns();
      expect(runs.map((entry) => entry.status)).toEqual(runs.map(() => "succeeded"));
      return runs.length;
    }

    async function readIssue(targetIssueId: string = issueId) {
      return await db
        .select({
          executionWorkspaceId: issues.executionWorkspaceId,
          executionWorkspacePreference: issues.executionWorkspacePreference,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.id, targetIssueId))
        .then((rows) => rows[0]!);
    }

    async function countExecutionWorkspaces() {
      return (await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
        .where(eq(executionWorkspaces.companyId, companyId))).length;
    }

    function leaseCalls() {
      return worker.call.mock.calls
        .filter(([, method]) => method === "environmentAcquireLease" || method === "environmentResumeLease")
        .map(([, method, params]) => ({ method, params: params as Record<string, unknown> }));
    }

    /** Every run of the agent in start order, with its task-session bookkeeping. */
    async function runSessions() {
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          createdAt: heartbeatRuns.createdAt,
          sessionIdBefore: heartbeatRuns.sessionIdBefore,
          sessionIdAfter: heartbeatRuns.sessionIdAfter,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => {
          const session = ((row.resultJson?.configFreshness as Record<string, unknown> | undefined)?.session ??
            null) as { reset?: unknown; changedCategories?: unknown } | null;
          return {
            sessionIdBefore: row.sessionIdBefore,
            sessionIdAfter: row.sessionIdAfter,
            reset: session?.reset ?? null,
            changedCategories: session?.changedCategories ?? null,
          };
        });
    }

    return { issueId, wakeAndSettle, readIssue, addIssue, countExecutionWorkspaces, leaseCalls, worker, runSessions };
  }

  it("pins the task to its execution workspace so later runs resume the same sandbox", async () => {
    const { wakeAndSettle, readIssue, countExecutionWorkspaces, leaseCalls, worker } = await seed({
      reuseLease: true,
      runnerIdleTimeoutMs: 86_400_000,
    });

    await wakeAndSettle();
    const afterFirst = await readIssue();
    expect(afterFirst.executionWorkspaceId).toEqual(expect.any(String));
    expect(afterFirst.executionWorkspacePreference).toBe("reuse_existing");
    expect(afterFirst.executionWorkspaceSettings).toMatchObject({ mode: "shared_workspace" });

    const runCount = await wakeAndSettle();
    expect(runCount).toBeGreaterThanOrEqual(2);
    const afterSecond = await readIssue();
    expect(afterSecond.executionWorkspaceId).toBe(afterFirst.executionWorkspaceId);
    expect(await countExecutionWorkspaces()).toBe(1);

    // One sandbox for the task: acquired once for its workspace, then resumed by
    // every later run.
    const calls = leaseCalls();
    const acquires = calls.filter((call) => call.method === "environmentAcquireLease");
    const resumes = calls.filter((call) => call.method === "environmentResumeLease");
    expect(acquires).toHaveLength(1);
    expect(acquires[0].params.executionWorkspaceId).toBe(afterFirst.executionWorkspaceId);
    expect(resumes).toHaveLength(runCount - 1);
    expect(resumes.map((call) => call.params.providerLeaseId)).toEqual(resumes.map(() => "pc-sandbox-1"));
    expect(worker.sandboxes.size).toBe(1);
  }, 60_000);

  it.each([
    ["with the isolated workspace setting off", false],
    ["with isolated workspaces enabled", true],
  ])("resumes the agent session on the first follow-up after the task is pinned to its workspace (%s)", async (_label, isolatedWorkspaces) => {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: isolatedWorkspaces });
    // The adapter keeps whatever session it is handed and starts a new one
    // only when it gets none, like a CLI agent resuming by session id.
    let sessionsStarted = 0;
    adapterExecute.mockImplementation((async (input: { runtime?: { sessionParams?: Record<string, unknown> | null } }) => {
      const resumed = input?.runtime?.sessionParams?.sessionId;
      const sessionId = typeof resumed === "string" ? resumed : `session-${++sessionsStarted}`;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "test",
        model: "test-model",
        sessionId,
        sessionParams: { sessionId },
        sessionDisplayId: sessionId,
      };
    }) as any);
    try {
      const { wakeAndSettle, readIssue, runSessions } = await seed({
        reuseLease: true,
        runnerIdleTimeoutMs: 86_400_000,
      });

      await wakeAndSettle();
      // The first run pinned the task to its workspace; that write-back is
      // bookkeeping, not a configuration change.
      expect((await readIssue()).executionWorkspacePreference).toBe("reuse_existing");
      await wakeAndSettle();
      await wakeAndSettle();

      const runs = await runSessions();
      expect(runs.length).toBeGreaterThanOrEqual(3);
      expect(runs[0].sessionIdBefore).toBeNull();
      expect(runs[0].sessionIdAfter).toBe("session-1");
      for (const run of runs.slice(1)) {
        expect(run).toEqual({
          sessionIdBefore: "session-1",
          sessionIdAfter: "session-1",
          reset: false,
          changedCategories: [],
        });
      }
      expect(sessionsStarted).toBe(1);
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      adapterExecute.mockReset();
      adapterExecute.mockImplementation(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "test",
        model: "test-model",
      }));
    }
  }, 90_000);

  it("gives each task its own execution workspace and sandbox and never resumes another task's sandbox", async () => {
    const { issueId, wakeAndSettle, readIssue, addIssue, countExecutionWorkspaces, leaseCalls, worker } = await seed({
      reuseLease: true,
      runnerIdleTimeoutMs: 86_400_000,
    });
    const otherIssueId = await addIssue("Fix the other bug");

    // Interleave the two tasks: each first run creates a sandbox, and each later
    // run must resume its own task's sandbox, not the most recently released one.
    await wakeAndSettle();
    const firstTask = await readIssue();
    const callsAfterWake1 = leaseCalls().length;
    await wakeAndSettle(otherIssueId);
    const otherTask = await readIssue(otherIssueId);
    const callsAfterWake2 = leaseCalls().length;
    await wakeAndSettle();
    const callsAfterWake3 = leaseCalls().length;
    await wakeAndSettle(otherIssueId);

    expect(firstTask.executionWorkspaceId).toEqual(expect.any(String));
    expect(otherTask.executionWorkspaceId).toEqual(expect.any(String));
    expect(otherTask.executionWorkspaceId).not.toBe(firstTask.executionWorkspaceId);
    expect((await readIssue()).executionWorkspaceId).toBe(firstTask.executionWorkspaceId);
    expect((await readIssue(otherIssueId)).executionWorkspaceId).toBe(otherTask.executionWorkspaceId);
    expect(await countExecutionWorkspaces()).toBe(2);

    // Lease calls name the task they are for (acquire also its workspace).
    const calls = leaseCalls().map((call) => [
      call.method,
      call.params.issueId,
      call.params.executionWorkspaceId ?? null,
      call.params.providerLeaseId ?? null,
    ]);
    const acquires = calls.filter(([method]) => method === "environmentAcquireLease");
    expect(acquires).toEqual([
      ["environmentAcquireLease", issueId, firstTask.executionWorkspaceId, null],
      ["environmentAcquireLease", otherIssueId, otherTask.executionWorkspaceId, null],
    ]);
    // Every later run resumes its own task's sandbox, never the other one.
    const sandboxOf = new Map<string, string>([
      [issueId, "pc-sandbox-1"],
      [otherIssueId, "pc-sandbox-2"],
    ]);
    const resumes = calls.filter(([method]) => method === "environmentResumeLease");
    expect(resumes.length).toBeGreaterThanOrEqual(2);
    for (const [, resumedIssueId, , providerLeaseId] of resumes) {
      expect(providerLeaseId).toBe(sandboxOf.get(resumedIssueId as string));
    }
    // Per wake: each wake only touches its own task, and each task's second
    // wake resumes (never acquires) that task's sandbox.
    for (const [, callIssueId] of calls.slice(0, callsAfterWake1)) expect(callIssueId).toBe(issueId);
    for (const [, callIssueId] of calls.slice(callsAfterWake1, callsAfterWake2)) expect(callIssueId).toBe(otherIssueId);
    const firstTaskAgain = calls.slice(callsAfterWake2, callsAfterWake3);
    expect(firstTaskAgain.length).toBeGreaterThanOrEqual(1);
    expect(firstTaskAgain).toEqual(firstTaskAgain.map(() => ["environmentResumeLease", issueId, null, "pc-sandbox-1"]));
    const otherTaskAgain = calls.slice(callsAfterWake3);
    expect(otherTaskAgain.length).toBeGreaterThanOrEqual(1);
    expect(otherTaskAgain).toEqual(otherTaskAgain.map(() => ["environmentResumeLease", otherIssueId, null, "pc-sandbox-2"]));
    expect(worker.sandboxes.size).toBe(2);
  }, 90_000);

  it("leaves the task unpinned and provisions a fresh workspace per run when leases are not reused", async () => {
    const { wakeAndSettle, readIssue, countExecutionWorkspaces, leaseCalls } = await seed({ reuseLease: false });

    await wakeAndSettle();
    const runCount = await wakeAndSettle();
    expect(runCount).toBeGreaterThanOrEqual(2);
    const issue = await readIssue();
    expect(issue.executionWorkspacePreference).toBeNull();
    expect(issue.executionWorkspaceId).toBeNull();
    expect(await countExecutionWorkspaces()).toBe(runCount);

    const calls = leaseCalls();
    expect(calls.map((call) => call.method)).toEqual(calls.map(() => "environmentAcquireLease"));
    expect(calls).toHaveLength(runCount);
    expect(new Set(calls.map((call) => call.params.executionWorkspaceId)).size).toBe(runCount);
  }, 60_000);
});
