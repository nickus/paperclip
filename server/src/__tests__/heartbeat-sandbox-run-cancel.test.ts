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
  environments,
  heartbeatRuns,
  issues,
  plugins,
} from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { sandboxExecutionStops } from "../services/adapter-execution-control.ts";
import { RUN_IDLE_TIMEOUT_ERROR_CODE } from "../services/run-activity-timeouts.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// The adapter under test. Each test decides how the agent command behaves; any
// later run (for example a retry) finishes at once.
const agentTurn = vi.hoisted(() => ({
  current: null as null | ((ctx: unknown) => Promise<unknown>),
}));

// Each finished run records its task's disposition, as an agent does through
// the API, so a run settles without a disposition-repair follow-up.
const recordDisposition = vi.hoisted(() => ({
  current: null as null | ((issueId: unknown) => Promise<void>),
}));

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: { context: Record<string, unknown> }) => {
    const turn = agentTurn.current;
    agentTurn.current = null;
    if (turn) return turn(ctx);
    await recordDisposition.current?.(ctx.context.issueId);
    return { exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test-model" };
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
    `Skipping embedded Postgres sandbox run cancel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PROVIDER = "kubernetes";
// The agent CLI inside the sandbox: it runs until something stops it.
const AGENT_COMMAND = "agent-cli";
// What an adapter with its own cancellation protocol sends to end a turn.
const AGENT_CANCEL_COMMAND = "agent-cli-cancel";

type CommandResult = { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };

/**
 * A sandbox provider worker whose sandbox is a host temp directory. The agent
 * command never returns on its own; stopping the lease ends it, as a
 * provider ends every process in a stopped sandbox.
 */
function sandboxProviderWorker(pluginId: string, sandboxRoot: string) {
  const sandboxCwd = path.join(sandboxRoot, "workspace");
  const sandboxHome = path.join(sandboxRoot, "home");
  const liveAgentCommands = new Set<(result: CommandResult) => void>();
  let agentCommandsStarted = 0;
  let created = 0;
  const endAgentCommands = (stderr: string) => {
    for (const end of liveAgentCommands) {
      end({ exitCode: 143, signal: null, timedOut: false, stdout: "", stderr });
    }
    liveAgentCommands.clear();
  };
  const call = vi.fn(async (_pluginId: string, method: string, params: Record<string, any>) => {
    switch (method) {
      case "environmentAcquireLease":
        created += 1;
        return {
          // Unique per provider, so no lease of another test shares the id.
          providerLeaseId: `pc-sandbox-${pluginId.slice(0, 8)}-${created}`,
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
        if (params.command === AGENT_COMMAND) {
          agentCommandsStarted += 1;
          return await new Promise<CommandResult>((resolve) => liveAgentCommands.add(resolve));
        }
        if (params.command === AGENT_CANCEL_COMMAND) {
          endAgentCommands("cancelled by the agent protocol\n");
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        }
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
      case "environmentStopLease":
        endAgentCommands("Terminated\n");
        return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      case "environmentReleaseLease":
      case "environmentDestroyLease":
        endAgentCommands("Terminated\n");
        return {
          providerLeaseId: params.providerLeaseId,
          state: method === "environmentReleaseLease" ? "stopped" : "destroyed",
        };
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
        "environmentStopLease",
        "environmentDestroyLease",
        "environmentRealizeWorkspace",
        "environmentExecute",
      ],
    })),
  } as unknown as PluginWorkerManager;
  return {
    call,
    workerManager,
    agentCommandsStarted: () => agentCommandsStarted,
    agentCommandsLive: () => liveAgentCommands.size,
    stopCalls: () =>
      call.mock.calls.filter(([, method]) => method === "environmentStopLease").map(([, , params]) => params),
  };
}

function runnerOf(ctx: AdapterExecutionContext): CommandManagedRuntimeRunner {
  const runner = (ctx.executionTarget as { runner?: CommandManagedRuntimeRunner } | null)?.runner;
  if (!runner) throw new Error("expected a sandbox runner");
  return runner;
}

// An adapter that does not know about cancellation, like a direct CLI adapter
// or an external adapter plugin: it runs the agent in the sandbox and waits.
async function plainSandboxTurn(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const result = await runnerOf(ctx).execute({ command: AGENT_COMMAND });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: false,
    errorMessage: result.exitCode === 0 ? null : "agent exited unexpectedly",
    provider: "test",
    model: "test-model",
  };
}

describeEmbeddedPostgres("heartbeat sandbox run cancellation", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-sandbox-run-cancel");
    stopDb = () => started.cleanup();
    db = createDb(started.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    recordDisposition.current = async (issueId) => {
      if (typeof issueId !== "string") return;
      await db.update(issues).set({ status: "in_review", updatedAt: new Date() }).where(eq(issues.id, issueId));
    };
  }, 20_000);

  afterEach(async () => {
    agentTurn.current = null;
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

  async function seed(adapterConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      adapterConfig,
      runtimeConfig: {},
      defaultEnvironmentId: environmentId,
      permissions: {},
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

    const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-cancel-pod-"));
    tempRoots.push(sandboxRoot);
    await mkdir(path.join(sandboxRoot, "workspace"), { recursive: true });
    await mkdir(path.join(sandboxRoot, "home"), { recursive: true });
    const worker = sandboxProviderWorker(pluginId, sandboxRoot);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: worker.workerManager });

    async function startRun() {
      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { issueId },
      });
      expect(run).not.toBeNull();
      await vi.waitFor(() => expect(worker.agentCommandsStarted()).toBe(1), { timeout: 30_000, interval: 50 });
      return run!;
    }

    async function settle() {
      await vi.waitFor(async () => {
        const rows = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, agentId));
        expect(rows.filter((row) => ["queued", "scheduled_retry", "running"].includes(row.status))).toEqual([]);
      }, { timeout: 30_000, interval: 50 });
      await heartbeat.drainActiveRunExecutions();
    }

    return { heartbeat, worker, agentId, companyId, startRun, settle };
  }

  it("stops the agent inside the sandbox when an adapter that never opts in is cancelled", async () => {
    const { heartbeat, worker, startRun, settle } = await seed();
    agentTurn.current = (ctx) => plainSandboxTurn(ctx as AdapterExecutionContext);
    const run = await startRun();

    const cancelled = await heartbeat.cancelRun(run.id, "Stopped by the board");

    // Stop returned only after the provider confirmed the sandbox stopped.
    expect(worker.stopCalls()).toEqual([
      expect.objectContaining({ cancelActiveWork: true, resourceDisposition: "stop_and_retain" }),
    ]);
    expect(worker.agentCommandsLive()).toBe(0);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    await settle();
    expect(await heartbeat.getRun(run.id)).toMatchObject({
      status: "cancelled",
      error: "Stopped by the board",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(worker.stopCalls()).toHaveLength(1);
  }, 90_000);

  it("leaves the stop to an adapter that handles its own cancellation", async () => {
    const { heartbeat, worker, startRun, settle } = await seed();
    let signalAborted = false;
    agentTurn.current = async (input) => {
      const ctx = input as AdapterExecutionContext;
      await ctx.onCancellationReady?.();
      const runner = runnerOf(ctx);
      const turn = runner.execute({ command: AGENT_COMMAND });
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      signalAborted = true;
      // End the turn through the agent's own protocol, not by stopping the sandbox.
      await runner.execute({ command: AGENT_CANCEL_COMMAND });
      await turn;
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "cancelled",
        errorMessage: "Turn cancelled",
        resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
      } satisfies AdapterExecutionResult;
    };
    const run = await startRun();

    const cancelled = await heartbeat.cancelRun(run.id);

    expect(signalAborted).toBe(true);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    await settle();
    // The host never stopped the sandbox behind the adapter's back.
    expect(worker.stopCalls()).toEqual([]);
  }, 90_000);

  it("stops the sandbox once when an opted-in adapter asks for the stop itself", async () => {
    const { heartbeat, worker, startRun, settle } = await seed();
    agentTurn.current = async (input) => {
      const ctx = input as AdapterExecutionContext;
      await ctx.onCancellationReady?.();
      const turn = runnerOf(ctx).execute({ command: AGENT_COMMAND });
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await ctx.stopRemoteStartup?.();
      await turn;
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "cancelled",
        errorMessage: "Turn cancelled",
        resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
      } satisfies AdapterExecutionResult;
    };
    const run = await startRun();

    await expect(heartbeat.cancelRun(run.id)).resolves.toMatchObject({ status: "cancelled" });
    await settle();
    expect(worker.stopCalls()).toHaveLength(1);
  }, 90_000);

  it("enforces the inactivity timeout on a sandbox run", async () => {
    const { heartbeat, worker, startRun } = await seed({ idleTimeoutSec: 1 });
    agentTurn.current = (ctx) => plainSandboxTurn(ctx as AdapterExecutionContext);
    const run = await startRun();

    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(run.id))?.status).toBe("timed_out");
    }, { timeout: 30_000, interval: 100 });
    // A timed-out run may schedule a delayed retry; only this run must settle.
    await heartbeat.drainActiveRunExecutions();

    expect(worker.stopCalls()).toEqual([
      expect.objectContaining({ cancelActiveWork: true, resourceDisposition: "stop_and_retain" }),
    ]);
    expect(worker.agentCommandsLive()).toBe(0);
    expect(await heartbeat.getRun(run.id)).toMatchObject({
      status: "timed_out",
      errorCode: RUN_IDLE_TIMEOUT_ERROR_CODE,
    });
  }, 90_000);

  describe("Stop without an adapter execution control", () => {
    async function seedRunningRun() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date();
      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        runtimeMode: "legacy",
        runtimeModeResolvedAt: now,
        startedAt: now,
        contextSnapshot: {},
      });
      return { runId };
    }

    it("stops the sandbox of a run that is still preparing before recording the cancellation", async () => {
      const { runId } = await seedRunningRun();
      const heartbeat = heartbeatService(db);
      const events: string[] = [];
      const stop = vi.fn(async (_reason: Error) => {
        const current = await heartbeat.getRun(runId);
        events.push(`stop while ${current?.status}`);
      });
      sandboxExecutionStops.set(runId, stop);
      try {
        const cancelled = await heartbeat.cancelRun(runId, "Stopped by the board");
        expect(stop).toHaveBeenCalledOnce();
        expect(stop.mock.calls[0]![0]).toEqual(new Error("Stopped by the board"));
        expect(events).toEqual(["stop while running"]);
        expect(cancelled).toMatchObject({
          status: "cancelled",
          resultJson: { executionCancellation: { state: "acknowledged" } },
        });
      } finally {
        sandboxExecutionStops.delete(runId);
      }
    });

    it("does not record a cancellation the sandbox could not confirm", async () => {
      const { runId } = await seedRunningRun();
      const heartbeat = heartbeatService(db);
      sandboxExecutionStops.set(runId, async () => {
        throw new Error("Could not verify remote startup stopped");
      });
      try {
        await expect(heartbeat.cancelRun(runId)).rejects.toThrow("Could not verify remote startup stopped");
        expect(await heartbeat.getRun(runId)).toMatchObject({ status: "running" });
      } finally {
        sandboxExecutionStops.delete(runId);
      }
    });
  });
});
