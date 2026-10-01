/**
 * Automatic in-process retry for a transient plugin activation failure.
 *
 * Before this, a plugin whose worker failed to answer `initialize` in time
 * (or whose process exited/crashed mid-initialize) was marked `error` and
 * stayed there until an operator called POST /api/plugins/:id/enable or the
 * server rebooted — even though the next attempt, a few seconds later, often
 * succeeds on its own. `activatePlugin` now schedules a backing-off retry
 * (5s, 15s, 60s, then every 5 minutes) for exactly that class of failure, and
 * leaves a deterministic failure (bad manifest, missing entry point) alone.
 *
 * These tests intercept `setTimeout`/`clearTimeout` themselves (a tiny,
 * explicitly-driven fake) instead of `vi.useFakeTimers()`. The retried
 * activation re-reads the plugin's manifest from real disk, and advancing a
 * faked clock does not reliably flush that real filesystem I/O; firing a
 * captured callback directly lets it run on the real event loop while still
 * giving the test full control over *when* each backoff step fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Captured before any test mocks `setTimeout` (see installTimerHarness
// below), so tests can still yield to the real event loop on demand.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import {
  cancelPluginActivationRetry,
  isPluginActivationRetryPending,
  isPluginActivationRetryPendingForKey,
  isTransientPluginActivationFailure,
  pluginLoader,
} from "../services/plugin-loader.js";
import type { PluginRuntimeServices } from "../services/plugin-loader.js";

const PLUGIN_ID = "plugin-retry-1";
const PLUGIN_KEY = "example.retry-plugin";

const TRANSIENT_TIMEOUT_MESSAGE = `Worker initialize failed for "${PLUGIN_ID}": RPC call "initialize" timed out after 15000ms`;
const TRANSIENT_EXIT_MESSAGE = `Worker initialize failed for "${PLUGIN_ID}": Worker process exited (code=null, signal=SIGKILL)`;
const NON_TRANSIENT_OK_FALSE_MESSAGE = `Worker initialize failed for "${PLUGIN_ID}": Worker initialize returned ok=false`;

describe("isTransientPluginActivationFailure", () => {
  it("matches an initialize-timeout failure", () => {
    expect(isTransientPluginActivationFailure(TRANSIENT_TIMEOUT_MESSAGE)).toBe(true);
  });

  it("matches a worker-exited-during-initialize failure", () => {
    expect(isTransientPluginActivationFailure(TRANSIENT_EXIT_MESSAGE)).toBe(true);
  });

  it("does not match a deterministic initialize failure", () => {
    expect(isTransientPluginActivationFailure(NON_TRANSIENT_OK_FALSE_MESSAGE)).toBe(false);
  });

  it("does not match a missing-entrypoint failure", () => {
    expect(
      isTransientPluginActivationFailure(
        `Worker entrypoint not found for plugin "${PLUGIN_KEY}". Checked: /a/dist/worker.js, /b/dist/worker.js`,
      ),
    ).toBe(false);
  });
});

/**
 * A minimal, explicitly-driven replacement for `vi.useFakeTimers()`: it
 * intercepts `setTimeout`/`clearTimeout` so the test decides exactly when a
 * scheduled callback runs, but the callback itself still executes on the
 * real event loop (so real `fs` I/O inside it resolves normally).
 */
function installTimerHarness() {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  let nextHandle = 1;
  const pending = new Map<number, { delayMs: number; fn: () => void }>();

  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((fn: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
      const handle = nextHandle++;
      pending.set(handle, { delayMs: delayMs ?? 0, fn: () => fn(...args) });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

  const clearTimeoutSpy = vi
    .spyOn(globalThis, "clearTimeout")
    .mockImplementation(((handle?: unknown) => {
      pending.delete(handle as number);
    }) as typeof clearTimeout);

  return {
    restore() {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    },
    pendingCount() {
      return pending.size;
    },
    /**
     * Fire the single pending timer (asserting its delay, when given), then
     * give the real event loop a short window to settle whatever real async
     * work the callback kicked off.
     */
    async fireNext(expectedDelayMs?: number) {
      const entries = [...pending.entries()];
      expect(entries.length).toBe(1);
      const [handle, entry] = entries[0]!;
      if (expectedDelayMs !== undefined) {
        expect(entry.delayMs).toBe(expectedDelayMs);
      }
      pending.delete(handle);
      entry.fn();
      await new Promise((resolve) => realSetTimeout(resolve, 25));
    },
  };
}

describe("pluginLoader activation retry after a transient failure", () => {
  let root: string;
  let packageRoot: string;
  let row: Record<string, unknown>;
  let runtimeServices: PluginRuntimeServices;
  let timers: ReturnType<typeof installTimerHarness>;

  function buildManifest() {
    return {
      id: PLUGIN_KEY,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Retry Plugin",
      description: "Fixture",
      author: "Test",
      categories: ["automation"],
      capabilities: ["issues.read"],
      entrypoints: { worker: "dist/worker.js" },
    };
  }

  function createRow(overrides: Record<string, unknown> = {}) {
    return {
      id: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      packageName: "@example/retry-plugin",
      packagePath: packageRoot,
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      status: "ready",
      lastError: null,
      installOrder: 1,
      manifestJson: buildManifest(),
      ...overrides,
    };
  }

  function createLoader() {
    return pluginLoader(
      {} as unknown as Db,
      { localPluginDir: "/nonexistent/local-plugins", enableLocalFilesystem: false, enableNpmDiscovery: false },
      runtimeServices,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    timers = installTimerHarness();

    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "plugin-activation-retry-")));
    packageRoot = path.join(root, "pkg");
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/retry-plugin",
        version: "1.0.0",
        type: "module",
        paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" },
      }),
    );
    writeFileSync(
      path.join(packageRoot, "dist/manifest.js"),
      `export default ${JSON.stringify(buildManifest())};`,
    );
    // Content is irrelevant — startWorker is mocked below and the file is
    // never actually spawned; only its existence is checked.
    writeFileSync(path.join(packageRoot, "dist/worker.js"), "// unused in this test\n");

    row = createRow();
    mockRegistry.getById.mockImplementation(async (id: string) =>
      id === row.id ? { ...row } : null,
    );
    mockRegistry.updateStatus.mockImplementation(
      async (id: string, patch: { status: string; lastError?: string | null }) => {
        if (id !== row.id) return null;
        row = { ...row, status: patch.status, lastError: patch.lastError ?? null };
        return { ...row };
      },
    );

    runtimeServices = {
      lifecycleManager: {
        markError: vi.fn(async (id: string, error: string) => {
          if (id === row.id) row = { ...row, status: "error", lastError: error };
          return { ...row };
        }),
      },
      workerManager: {
        startWorker: vi.fn(async () => {}),
        isRunning: vi.fn(() => false),
        stopWorker: vi.fn(async () => {}),
        getWorker: vi.fn(() => undefined),
      },
      eventBus: {
        forPlugin: vi.fn(() => ({})),
        subscriptionCount: vi.fn(() => 0),
        clearPlugin: vi.fn(),
      },
      jobScheduler: {
        registerPlugin: vi.fn(async () => {}),
        unregisterPlugin: vi.fn(async () => {}),
      },
      jobStore: {
        syncJobDeclarations: vi.fn(async () => {}),
      },
      toolDispatcher: {
        registerPluginTools: vi.fn(),
        unregisterPluginTools: vi.fn(),
      },
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: { hostVersion: "0.0.0-test" },
    } as unknown as PluginRuntimeServices;
  });

  afterEach(() => {
    cancelPluginActivationRetry(PLUGIN_ID);
    timers.restore();
    rmSync(root, { recursive: true, force: true });
  });

  it("schedules a retry after an initialize-timeout failure and succeeds on the next attempt", async () => {
    const loader = createLoader();
    (runtimeServices.workerManager.startWorker as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error(TRANSIENT_TIMEOUT_MESSAGE))
      .mockResolvedValueOnce(undefined);

    const result = await loader.loadSingle(PLUGIN_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 15000ms");
    expect(runtimeServices.lifecycleManager.markError).toHaveBeenCalledTimes(1);
    expect(isPluginActivationRetryPending(PLUGIN_ID)).toBe(true);
    expect(isPluginActivationRetryPendingForKey(PLUGIN_KEY)).toBe(true);
    expect(timers.pendingCount()).toBe(1);

    // First backoff step: 5s.
    await timers.fireNext(5_000);

    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(2);
    expect(row.status).toBe("ready");
    expect(isPluginActivationRetryPending(PLUGIN_ID)).toBe(false);
    expect(isPluginActivationRetryPendingForKey(PLUGIN_KEY)).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  it("does not schedule a retry for a deterministic (non-transient) activation failure", async () => {
    // Point packagePath at a directory with no package.json, so activation
    // fails resolving the package root — long before startWorker is ever
    // reached — exactly like a missing entry point or invalid manifest.
    row = createRow({ packagePath: path.join(root, "does-not-exist") });

    const loader = createLoader();
    const result = await loader.loadSingle(PLUGIN_ID);

    expect(result.success).toBe(false);
    expect(runtimeServices.lifecycleManager.markError).toHaveBeenCalledTimes(1);
    expect(runtimeServices.workerManager.startWorker).not.toHaveBeenCalled();
    expect(isPluginActivationRetryPending(PLUGIN_ID)).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  it("cancels a pending retry when the plugin is unloaded (disable/unload/upgrade)", async () => {
    const loader = createLoader();
    (runtimeServices.workerManager.startWorker as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(TRANSIENT_TIMEOUT_MESSAGE),
    );

    await loader.loadSingle(PLUGIN_ID);
    expect(isPluginActivationRetryPending(PLUGIN_ID)).toBe(true);
    expect(timers.pendingCount()).toBe(1);

    await loader.unloadSingle(PLUGIN_ID, PLUGIN_KEY);

    expect(isPluginActivationRetryPending(PLUGIN_ID)).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  it("escalates backoff across consecutive transient failures: 5s, 15s, 60s, then every 5 minutes", async () => {
    const loader = createLoader();
    (runtimeServices.workerManager.startWorker as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(TRANSIENT_TIMEOUT_MESSAGE),
    );

    await loader.loadSingle(PLUGIN_ID);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(1);

    await timers.fireNext(5_000);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(2);

    await timers.fireNext(15_000);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(3);

    await timers.fireNext(60_000);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(4);

    // Steady state: every 5 minutes thereafter.
    await timers.fireNext(5 * 60 * 1000);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(5);
    await timers.fireNext(5 * 60 * 1000);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(6);
  });

  it("coalesces a manual activation attempt with an in-flight automatic retry for the same plugin", async () => {
    // Reproduces a race between the automatic backoff retry and an
    // operator-triggered manual re-activation (POST /api/plugins/:id/enable)
    // landing for the same plugin at nearly the same moment. Against a real
    // PluginWorkerManager, a second, independent activatePlugin() call that
    // reaches workerManager.startWorker() while the first is still starting
    // throws `Worker already registered for plugin "<id>" (status: ...)`.
    // That message does not match isTransientPluginActivationFailure, so the
    // loser's catch handler calls lifecycleManager.markError(), which tears
    // the *winner's* just-started worker back down (markError ->
    // deactivatePluginRuntime -> unloadSingle -> teardownPluginRuntime stops
    // any running worker for this pluginId) and leaves the plugin stuck in
    // `error` with no further retry scheduled — turning a successful
    // activation into a self-inflicted outage. activatePlugin must coalesce
    // concurrent attempts for the same plugin instead of racing two of them.
    const loader = createLoader();
    let releaseRetryStart: (() => void) | undefined;
    const retryStartGate = new Promise<void>((resolve) => {
      releaseRetryStart = resolve;
    });

    (runtimeServices.workerManager.startWorker as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error(TRANSIENT_TIMEOUT_MESSAGE))
      // The scheduled retry's own call: held open so a concurrent manual
      // activation attempt can be made while it is still in flight.
      .mockImplementationOnce(() => retryStartGate)
      // A second, independent activation attempt would reach this third
      // call — which must never happen once attempts are coalesced.
      .mockImplementationOnce(() => {
        throw new Error(
          "startWorker must not be called a third time — the manual call should have coalesced onto the in-flight retry",
        );
      });

    const initial = await loader.loadSingle(PLUGIN_ID);
    expect(initial.success).toBe(false);
    expect(timers.pendingCount()).toBe(1);

    // Fire the 5s backoff step. Its activatePlugin() call reaches
    // workerManager.startWorker() and blocks there — the retry is now "in
    // flight".
    await timers.fireNext(5_000);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(2);

    // An operator's manual retry races in while the automatic retry is
    // still in flight.
    const manualResultPromise = loader.loadSingle(PLUGIN_ID);

    // Give the manual call's own async chain (getById, cancel, activatePlugin's
    // pre-startWorker steps) room to run before releasing the gate.
    await new Promise((resolve) => realSetTimeout(resolve, 25));
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(2);

    releaseRetryStart!();
    const manualResult = await manualResultPromise;

    expect(manualResult.success).toBe(true);
    expect(runtimeServices.workerManager.startWorker).toHaveBeenCalledTimes(2);
    expect(row.status).toBe("ready");
  });
});
