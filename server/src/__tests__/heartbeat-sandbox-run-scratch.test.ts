import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environments,
  heartbeatRuns,
  issues,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// What the adapter saw during a run. The fake sandbox below runs its commands
// in a host temp directory, so sandbox paths can be checked from here.
interface ObservedRun {
  runId: string;
  remoteCwd: unknown;
  env: Record<string, unknown>;
  scratch: Record<string, unknown> | null;
  scratchDirMode: number | null;
}

const observed = vi.hoisted(() => [] as ObservedRun[]);

// Each run records its task's disposition (here: moves it to review), as an
// agent does through the API, so a wake settles without disposition repair.
const recordDisposition = vi.hoisted(() => ({
  current: null as null | ((issueId: unknown) => Promise<void>),
}));

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: {
    runId: string;
    executionTarget?: Record<string, unknown> | null;
    config: Record<string, unknown>;
    context: Record<string, unknown>;
  }) => {
    const env = (ctx.config.env ?? {}) as Record<string, unknown>;
    const scratchDir = typeof env.PAPERCLIP_RUN_SCRATCH_DIR === "string" ? env.PAPERCLIP_RUN_SCRATCH_DIR : null;
    const scratchStat = scratchDir ? await stat(scratchDir).catch(() => null) : null;
    // An agent leaves files behind in its scratch directory.
    if (scratchStat?.isDirectory()) await writeFile(path.join(scratchDir!, "c.md"), "comment body\n");
    observed.push({
      runId: ctx.runId,
      remoteCwd: ctx.executionTarget?.remoteCwd,
      env,
      scratch: (ctx.context.paperclipScratch as Record<string, unknown> | undefined) ?? null,
      scratchDirMode: scratchStat?.isDirectory() ? scratchStat.mode & 0o777 : null,
    });
    await recordDisposition.current?.(ctx.context.issueId);
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
    `Skipping embedded Postgres sandbox run scratch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PROVIDER = "kubernetes";

/**
 * A sandbox provider worker whose sandbox is a host temp directory. It records
 * which paths existed in the sandbox when each lease was handed back.
 */
function hostDirectoryProviderWorker(pluginId: string, sandboxRoot: string) {
  const sandboxCwd = path.join(sandboxRoot, "workspace");
  const sandboxHome = path.join(sandboxRoot, "home");
  const runsDirAtRelease: string[][] = [];
  let created = 0;
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, any>) => {
    switch (method) {
      case "environmentAcquireLease":
        created += 1;
        return {
          providerLeaseId: `pc-sandbox-${created}`,
          metadata: { backend: "sandbox-cr", remoteCwd: sandboxCwd },
        };
      case "environmentResumeLease":
        return {
          providerLeaseId: params.providerLeaseId,
          metadata: { backend: "sandbox-cr", remoteCwd: sandboxCwd, resumedLease: true },
        };
      case "environmentRealizeWorkspace":
        return { cwd: sandboxCwd, metadata: { provider: PROVIDER, remoteCwd: sandboxCwd } };
      case "environmentExecute": {
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
      case "environmentDestroyLease": {
        const runsDir = path.join(sandboxCwd, ".paperclip-runtime", "runs");
        const listing = spawnSync("find", [runsDir, "-mindepth", "1"], { encoding: "utf-8" });
        runsDirAtRelease.push((listing.stdout ?? "").split("\n").filter(Boolean));
        return {
          providerLeaseId: params.providerLeaseId,
          state: method === "environmentReleaseLease" ? "stopped" : "destroyed",
        };
      }
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
      ],
    })),
  } as unknown as PluginWorkerManager;
  return { call, sandboxCwd, runsDirAtRelease, workerManager };
}

describeEmbeddedPostgres("heartbeat sandbox run scratch", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-sandbox-run-scratch");
    stopDb = () => started.cleanup();
    db = createDb(started.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    recordDisposition.current = async (issueId) => {
      if (typeof issueId !== "string") return;
      await db.update(issues).set({ status: "in_review", updatedAt: new Date() }).where(eq(issues.id, issueId));
    };
  }, 20_000);

  afterEach(async () => {
    observed.length = 0;
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

  async function seed(configEnv: Record<string, string> = {}) {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `acme.sandbox-provider.${pluginId}`,
      packageName: "@acme/sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: `acme.sandbox-provider.${pluginId}`,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Sandbox Provider",
        description: "Test provider whose sandbox is a host directory",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: PROVIDER,
            kind: "sandbox_provider",
            displayName: "Kubernetes",
            configSchema: { type: "object", properties: { backend: { type: "string" } } },
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
      name: `Sandbox ${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: PROVIDER, backend: "sandbox-cr" },
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
      adapterConfig: Object.keys(configEnv).length > 0 ? { env: configEnv } : {},
      runtimeConfig: {},
      defaultEnvironmentId: environmentId,
      permissions: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Write the plan",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      createdAt: now,
      updatedAt: now,
    });

    const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-scratch-pod-"));
    tempRoots.push(sandboxRoot);
    await mkdir(path.join(sandboxRoot, "workspace"), { recursive: true });
    await mkdir(path.join(sandboxRoot, "home"), { recursive: true });
    const worker = hostDirectoryProviderWorker(pluginId, sandboxRoot);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker.workerManager });

    async function agentRuns() {
      return await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, error: heartbeatRuns.error })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
    }

    function countCalls(...methods: string[]) {
      return worker.call.mock.calls.filter(([, called]) => methods.includes(called)).length;
    }

    /** Wake the agent once and wait until every run it led to has finished and handed its sandbox back. */
    async function wakeAndSettle() {
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { issueId },
      });
      expect(run).not.toBeNull();
      let settledCount = -1;
      for (;;) {
        await vi.waitFor(async () => {
          const runs = await agentRuns();
          expect(runs.length).toBeGreaterThan(0);
          expect(runs.filter((entry) => ["queued", "scheduled_retry", "running"].includes(entry.status))).toEqual([]);
          expect(countCalls("environmentReleaseLease", "environmentDestroyLease")).toBeGreaterThanOrEqual(
            countCalls("environmentAcquireLease", "environmentResumeLease"),
          );
        }, { timeout: 15_000, interval: 50 });
        const count = (await agentRuns()).length;
        if (count === settledCount) break;
        settledCount = count;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await heartbeat.drainActiveRunExecutions();
      return await agentRuns();
    }

    return { worker, wakeAndSettle };
  }

  it("gives the run a private scratch directory inside the sandbox and removes it before the lease is released", async () => {
    const { worker, wakeAndSettle } = await seed();

    const runs = await wakeAndSettle();

    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.map((entry) => [entry.status, entry.error])).toEqual(runs.map(() => ["succeeded", null]));
    expect(observed.map((seen) => seen.runId).sort()).toEqual(runs.map((entry) => entry.id).sort());
    for (const seen of observed) {
      const expectedDir = path.posix.join(worker.sandboxCwd, ".paperclip-runtime", "runs", seen.runId, "scratch");
      expect(seen.remoteCwd).toBe(worker.sandboxCwd);
      expect(seen.env).toMatchObject({
        PAPERCLIP_RUN_SCRATCH_DIR: expectedDir,
        PAPERCLIP_TASK_SCRATCH_DIR: expectedDir,
        PAPERCLIP_SCRATCH_DIR: expectedDir,
        PAPERCLIP_TMPDIR: expectedDir,
        TMPDIR: expectedDir,
        TEMP: expectedDir,
        TMP: expectedDir,
      });
      expect(seen.scratch).toMatchObject({ type: "heartbeat_run", location: "remote", dir: expectedDir });
      // The directory existed, private to the run, while the adapter ran.
      expect(seen.scratchDirMode).toBe(0o700);
      await expect(stat(expectedDir)).rejects.toThrow();
    }
    // Runs of one agent do not overlap here, so each run's directory, with what
    // the agent left in it, was gone whenever a lease was handed back.
    expect(worker.runsDirAtRelease.length).toBeGreaterThanOrEqual(runs.length);
    for (const listing of worker.runsDirAtRelease) expect(listing).toEqual([]);
  }, 60_000);

  it("keeps temp directories the agent configuration sets itself", async () => {
    const { worker, wakeAndSettle } = await seed({ TMPDIR: "/var/tmp/agent" });

    await wakeAndSettle();

    expect(observed.length).toBeGreaterThanOrEqual(1);
    for (const seen of observed) {
      expect(seen.env.TMPDIR).toBe("/var/tmp/agent");
      expect(seen.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(
        path.posix.join(worker.sandboxCwd, ".paperclip-runtime", "runs", seen.runId, "scratch"),
      );
      expect(seen.scratch?.tempKeysApplied).toEqual(["TEMP", "TMP"]);
    }
  }, 60_000);
});
