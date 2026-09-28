import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PassThrough } from "node:stream";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster — same pattern as
// plugin-lease-lifecycle.test.ts.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

// Mock the k8s Exec websocket client so a "pod became Ready" test can reach a
// real exec call without a cluster — same pattern as pod-exec.test.ts.
type StatusCb = (status: { status: string }) => void;
let scriptedExec: (stdout: PassThrough, stderr: PassThrough, statusCb: StatusCb) => void =
  (_stdout, _stderr, statusCb) => statusCb({ status: "Success" });

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      _command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      _stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      setImmediate(() => scriptedExec(stdout, stderr, statusCb));
      return { close() {} };
    }
  }
  return { Exec };
});

const plugin = (await import("../../src/plugin.js")).default;

// A generous podActivityDeadlineSec (the overall run budget) with a much
// smaller podReadyTimeoutSec, so a stuck pod must be caught by the new bound
// and not by the run budget itself.
const CONFIG = {
  inCluster: true,
  backend: "sandbox-cr" as const,
  podActivityDeadlineSec: 3600,
  podReadyTimeoutSec: 30,
};

function pendingSandboxCr(): Record<string, unknown> {
  return { metadata: { uid: "uid-1" }, status: { phase: "Pending", conditions: [] } };
}

function readySandboxCr(podName: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: { conditions: [{ type: "Ready", status: "True" }], podName },
  };
}

beforeEach(() => {
  h.clients = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onEnvironmentExecute pod-readiness deadline (sandbox-cr backend)", () => {
  it("bounds the readiness wait to podReadyTimeoutSec and reports a transient timeout with recent pod events when the pod never becomes Ready", async () => {
    vi.useFakeTimers();
    const getNamespacedCustomObject = vi.fn().mockResolvedValue(pendingSandboxCr());
    const listNamespacedEvent = vi.fn().mockResolvedValue({
      items: [
        {
          reason: "FailedScheduling",
          message: "0/3 nodes are available: 3 Insufficient cpu.",
          lastTimestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          reason: "ImagePullBackOff",
          message: 'Back-off pulling image "ghcr.io/acme/agent:latest"',
          lastTimestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    });
    h.clients = {
      custom: { getNamespacedCustomObject },
      core: { listNamespacedEvent },
    };

    const resultPromise = plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease: {
        providerLeaseId: "pc-abc",
        metadata: { namespace: "paperclip-acme", backend: "sandbox-cr" },
      },
      command: "true",
      args: [],
      env: {},
    });

    // Drive the 2s-interval readiness poll well past the bounded 30s deadline
    // (podReadyTimeoutSec) but nowhere near the 3600s run budget.
    await vi.advanceTimersByTimeAsync(40_000);

    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // Bounded by podReadyTimeoutSec (30s) — not by podActivityDeadlineSec (3600s).
    expect(result.stderr).toContain("30000ms");
    expect(result.stderr).toContain("FailedScheduling");
    expect(result.stderr).toContain("ImagePullBackOff");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        transient: true,
        podReadyTimeoutMs: 30_000,
        backend: "sandbox-cr",
      }),
    );
    expect((result.metadata as { podEvents?: unknown[] }).podEvents).toHaveLength(2);
    expect(listNamespacedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme" }),
    );
  });

  it("leaves the exec path unchanged when the pod becomes Ready before the deadline", async () => {
    const getNamespacedCustomObject = vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod"));
    const listNamespacedEvent = vi.fn();
    h.clients = {
      custom: { getNamespacedCustomObject },
      core: { listNamespacedEvent },
    };
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("hi", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };

    const result = await plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease: {
        providerLeaseId: "pc-abc",
        metadata: { namespace: "paperclip-acme", backend: "sandbox-cr" },
      },
      command: "true",
      args: [],
      env: {},
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    // The readiness-timeout branch never ran: no transient marker, no event lookup.
    expect(result.metadata).not.toHaveProperty("transient");
    expect(result.metadata).not.toHaveProperty("podReadyTimeoutMs");
    expect(listNamespacedEvent).not.toHaveBeenCalled();
  });
});

describe("file sync pod-readiness deadline (sandbox-cr backend, sync path)", () => {
  it("bounds the readiness wait to podReadyTimeoutSec and enriches the thrown error with recent pod events", async () => {
    vi.useFakeTimers();
    const getNamespacedCustomObject = vi.fn().mockResolvedValue(pendingSandboxCr());
    const listNamespacedEvent = vi.fn().mockResolvedValue({
      items: [
        {
          reason: "FailedScheduling",
          message: "0/3 nodes are available: 3 Insufficient cpu.",
          lastTimestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    h.clients = {
      custom: { getNamespacedCustomObject },
      core: { listNamespacedEvent },
    };

    const resultPromise = plugin.definition.onEnvironmentSyncIn!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease: {
        providerLeaseId: "pc-sync-timeout",
        metadata: { namespace: "paperclip-acme", backend: "sandbox-cr", remoteCwd: "/workspace" },
      },
      operations: [],
    });
    // Attach the rejection handler before advancing fake timers so the
    // rejection is observed as soon as it happens, not left unhandled.
    const caught = resultPromise.then(
      () => null,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );

    // Drive the 2s-interval readiness poll well past the bounded 30s deadline
    // (podReadyTimeoutSec) but nowhere near the 3600s run budget — same bound
    // as the onEnvironmentExecute path above, exercised here via the sync
    // hooks' separate resolveSyncPodExec entry point.
    await vi.advanceTimersByTimeAsync(40_000);
    const err = await caught;
    // Bounded at podReadyTimeoutSec (30s), and — the point of this test —
    // the thrown error is enriched with the pod's recent events, same as the
    // structured onEnvironmentExecute timeout result above: the readiness
    // wait itself, and its diagnostics, do not depend on which caller path
    // triggered it.
    expect(err?.message).toContain("30000ms");
    expect(err?.message).toContain("FailedScheduling");
    expect(listNamespacedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme" }),
    );
  });
});

describe("onEnvironmentExecute pod-readiness deadline (job backend)", () => {
  const JOB_CONFIG = {
    inCluster: true,
    backend: "job" as const,
    podActivityDeadlineSec: 3600,
    podReadyTimeoutSec: 30,
  };

  it("bounds the pod-scheduling wait to podReadyTimeoutSec — not the Job's whole completion — and reports a transient timeout with recent pod events when the pod never starts running", async () => {
    vi.useFakeTimers();
    // The pod never appears at all (stuck scheduling): getJobStatus reports
    // Pending throughout, and no pod exists yet for this Job.
    const readNamespacedJobStatus = vi.fn().mockResolvedValue({ status: {} });
    const listNamespacedPod = vi.fn().mockResolvedValue({ items: [] });
    const listNamespacedEvent = vi.fn().mockResolvedValue({
      items: [
        {
          reason: "FailedScheduling",
          message: "0/3 nodes are available: 3 Insufficient cpu.",
          lastTimestamp: "2026-01-01T00:00:01.000Z",
        },
      ],
    });
    h.clients = {
      batch: { readNamespacedJobStatus },
      core: { listNamespacedPod, listNamespacedEvent, readNamespacedPodLog: vi.fn() },
    };

    const resultPromise = plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: JOB_CONFIG,
      lease: {
        providerLeaseId: "job-pending",
        metadata: { namespace: "paperclip-acme", backend: "job" },
      },
      command: "true",
      args: [],
      env: {},
    });

    // Drive the 2s-interval poll well past the bounded 30s deadline but
    // nowhere near the 3600s run budget.
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("did not start running");
    expect(result.stderr).toContain("30000ms");
    expect(result.stderr).toContain("FailedScheduling");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        transient: true,
        timeoutStage: "pod_not_ready",
        podReadyTimeoutMs: 30_000,
        backend: "job",
      }),
    );
    expect((h.clients.core as { readNamespacedPodLog: ReturnType<typeof vi.fn> }).readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it("does not cap a Job's completion wait at podReadyTimeoutSec once its pod is running (regression: a Job needing longer than podReadyTimeoutSec to finish must still succeed)", async () => {
    vi.useFakeTimers();
    let jobStartMs: number | null = null;
    const ELEVEN_MINUTES_MS = 11 * 60_000;
    const readNamespacedJobStatus = vi.fn().mockImplementation(async () => {
      if (jobStartMs === null) jobStartMs = Date.now();
      const elapsed = Date.now() - jobStartMs;
      if (elapsed >= ELEVEN_MINUTES_MS) {
        return { status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] } };
      }
      return { status: { active: 1 } };
    });
    // The pod is Running from the very first check — scheduling itself was
    // fast; it is the JOB's OWN WORK that takes 11 minutes, well past the
    // 30s podReadyTimeoutSec.
    const listNamespacedPod = vi.fn().mockResolvedValue({
      items: [{ metadata: { name: "job-slow-xyz" }, status: { phase: "Running" } }],
    });
    const readNamespacedPodLog = vi.fn().mockResolvedValue("done\n");
    const listNamespacedEvent = vi.fn().mockResolvedValue({ items: [] });
    h.clients = {
      batch: { readNamespacedJobStatus },
      core: { listNamespacedPod, listNamespacedEvent, readNamespacedPodLog },
    };

    const resultPromise = plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: JOB_CONFIG,
      lease: {
        providerLeaseId: "job-slow",
        metadata: { namespace: "paperclip-acme", backend: "job" },
      },
      command: "true",
      args: [],
      env: {},
    });

    await vi.advanceTimersByTimeAsync(ELEVEN_MINUTES_MS + 60_000);
    const result = await resultPromise;

    // Before the two-phase fix, the Job's WHOLE completion wait was bounded
    // by podReadyTimeoutSec (30s), so this same scenario timed out at 30s
    // with exitCode: null. With the fix, only the (here: instant) pod-start
    // wait is bounded by it; completion gets the full remaining run budget.
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done\n");
    expect(result.metadata).not.toHaveProperty("transient");
  });
});
