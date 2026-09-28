import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeCluster, type FakeCluster } from "./_fake-cluster.js";

// Pod-readiness deadline (podReadyTimeoutSec) on reusable sandboxes: every
// readiness wait a kept sandbox goes through — the first command of a new
// reusable sandbox, the resume liveness check of a kept one, and the first
// command after a worker restart — is bounded by
// min(run budget, podReadyTimeoutSec ?? 600s), and a timeout leaves the
// sandbox's reuse state (busy mark, recorded pod UID, the CR itself) alone.

const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

// Namespace/RBAC/quota provisioning is covered by tenant-orchestrator tests.
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: vi.fn(async () => ({ exitCode: 0, stdout: "paperclip-process-reset: ok stopped=0\n", stderr: "" })),
  };
});

import plugin from "../../src/plugin.js";
import { execInPod } from "../../src/pod-exec.js";
import { resetKubeConnectionCache } from "../../src/kube-client-cache.js";
import { resetIdleReaper } from "../../src/idle-reaper.js";
import { REUSE_ANNOTATIONS } from "../../src/reuse.js";

type Plugin = typeof plugin;
type Lease = { providerLeaseId: string | null; metadata?: Record<string, unknown> };

const REUSE_CONFIG = {
  inCluster: true,
  backend: "sandbox-cr",
  adapterType: "opencode_local",
  reuseLease: true,
};

// A generous run budget with a much shorter readiness cap, so a stuck pod
// must be caught by the cap and not by the run budget.
const DEADLINE_CONFIG = { ...REUSE_CONFIG, podActivityDeadlineSec: 3600, podReadyTimeoutSec: 20 };

const SCOPE = {
  companyId: "company-1",
  environmentId: "env-1",
  executionWorkspaceId: "workspace-1",
  agentId: "agent-1",
};

const EVENTS = {
  items: [
    {
      reason: "FailedScheduling",
      message: "0/3 nodes are available: 3 Insufficient memory.",
      lastTimestamp: "2026-01-01T00:00:01.000Z",
    },
  ],
};

let cluster: FakeCluster;
let listNamespacedEvent: ReturnType<typeof vi.fn>;
// Set by a test that simulates a worker restart, so afterEach can stop the
// fresh module graph's reaper too.
let restartedResetIdleReaper: (() => void) | null = null;

beforeEach(() => {
  cluster = createFakeCluster();
  listNamespacedEvent = vi.fn(async () => EVENTS);
  (cluster.clients.core as Record<string, unknown>).listNamespacedEvent = listNamespacedEvent;
  h.clients = cluster.clients;
  resetKubeConnectionCache();
  resetIdleReaper();
  vi.mocked(execInPod).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetIdleReaper();
  restartedResetIdleReaper?.();
  restartedResetIdleReaper = null;
  vi.restoreAllMocks();
});

function acquire(p: Plugin = plugin, config: Record<string, unknown> = DEADLINE_CONFIG) {
  return p.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    issueId: "issue-1",
    config,
    runId: "run-1",
    agentId: SCOPE.agentId,
    executionWorkspaceId: SCOPE.executionWorkspaceId,
  } as Parameters<NonNullable<Plugin["definition"]["onEnvironmentAcquireLease"]>>[0]);
}

function release(lease: Lease, p: Plugin = plugin, config: Record<string, unknown> = DEADLINE_CONFIG) {
  return p.definition.onEnvironmentReleaseLease!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    config,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
  });
}

function resume(lease: Lease, p: Plugin = plugin, config: Record<string, unknown> = DEADLINE_CONFIG) {
  return p.definition.onEnvironmentResumeLease!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    config,
    providerLeaseId: lease.providerLeaseId!,
    // The host hands back the provider metadata plus its reuse scope.
    leaseMetadata: {
      ...lease.metadata,
      reusableSandboxLease: {
        version: 1,
        companyId: SCOPE.companyId,
        environmentId: SCOPE.environmentId,
        executionWorkspaceId: SCOPE.executionWorkspaceId,
        agentId: SCOPE.agentId,
        adapterType: "opencode_local",
        provider: "kubernetes",
      },
    },
  });
}

function execute(lease: Lease, p: Plugin = plugin, config: Record<string, unknown> = DEADLINE_CONFIG) {
  return p.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    config,
    lease: { providerLeaseId: lease.providerLeaseId, metadata: lease.metadata },
    command: "sh",
    args: ["-c", "echo hi"],
    // Longer than podReadyTimeoutSec, so only the readiness cap can end the wait.
    timeoutMs: 120_000,
  });
}

/** The Sandbox controller reports the sandbox not Ready and its pod not Ready. */
function makeNotReady(name: string): void {
  cluster.sandboxes.get(name)!.status = {
    podName: name,
    conditions: [{ type: "Ready", status: "False", reason: "PodNotReady" }],
  };
  const pod = cluster.pods.get(name)!;
  pod.status.conditions = [{ type: "Ready", status: "False", lastTransitionTime: new Date().toISOString() }];
  pod.status.containerStatuses = [{ name: "agent", ready: false, state: { running: {} } }];
}

function makeReady(name: string): void {
  cluster.sandboxes.get(name)!.status = { podName: name, conditions: [{ type: "Ready", status: "True" }] };
  const pod = cluster.pods.get(name)!;
  pod.status.conditions = [{ type: "Ready", status: "True" }];
  pod.status.containerStatuses = [{ name: "agent", ready: true, state: { running: {} } }];
}

function annotations(name: string): Record<string, string> {
  return cluster.sandboxes.get(name)!.metadata.annotations as Record<string, string>;
}

describe("pod-readiness deadline on a new reusable sandbox", () => {
  it("bounds the first command's readiness wait and keeps the sandbox and its busy mark", async () => {
    const lease = await acquire();
    const name = lease.providerLeaseId!;
    makeNotReady(name);

    vi.useFakeTimers();
    const pending = execute(lease);
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.stderr).toContain("did not become Ready within 20000ms");
    expect(result.stderr).toContain("FailedScheduling");
    expect(result.metadata).toMatchObject({ transient: true, podReadyTimeoutMs: 20_000, sandboxName: name });
    expect(listNamespacedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ fieldSelector: `involvedObject.name=${name}` }),
    );
    // Nothing ran in the pod, no pod was recorded for the sandbox, and the
    // sandbox is still this run's.
    expect(execInPod).not.toHaveBeenCalled();
    expect(cluster.sandboxes.has(name)).toBe(true);
    expect(annotations(name)[REUSE_ANNOTATIONS.leaseState]).toBe("busy");
    expect(annotations(name)[REUSE_ANNOTATIONS.podUid]).toBeUndefined();
    vi.useRealTimers();

    // Once the pod comes up the same lease works as before: the command runs
    // and the sandbox records its pod for the release check.
    makeReady(name);
    await expect(execute(lease)).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(annotations(name)[REUSE_ANNOTATIONS.podUid]).toBe(cluster.pods.get(name)!.metadata.uid);
    await expect(release(lease)).resolves.toEqual({ providerLeaseId: name, state: "stopped" });
    expect(annotations(name)[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
  });

  it("bounds the first file sync's readiness wait and names the pod's events in the error", async () => {
    const lease = await acquire();
    const name = lease.providerLeaseId!;
    makeNotReady(name);

    vi.useFakeTimers();
    const caught = plugin.definition.onEnvironmentSyncIn!({
      driverKey: "kubernetes",
      companyId: SCOPE.companyId,
      environmentId: SCOPE.environmentId,
      config: DEADLINE_CONFIG,
      lease: { providerLeaseId: name, metadata: lease.metadata },
      operations: [],
    }).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    await vi.advanceTimersByTimeAsync(25_000);
    const err = await caught;

    expect(err?.message).toContain("within 20000ms");
    expect(err?.message).toContain("FailedScheduling");
    expect(cluster.sandboxes.has(name)).toBe(true);
    expect(annotations(name)[REUSE_ANNOTATIONS.leaseState]).toBe("busy");
    expect(annotations(name)[REUSE_ANNOTATIONS.podUid]).toBeUndefined();
  });
});

describe("pod-readiness deadline on a reused sandbox", () => {
  async function releasedLease(config: Record<string, unknown> = DEADLINE_CONFIG): Promise<Lease> {
    const lease = await acquire(plugin, config);
    await execute(lease, plugin, config);
    await release(lease, plugin, config);
    return lease;
  }

  it("does not treat a changed podReadyTimeoutSec as a different sandbox spec", async () => {
    const lease = await releasedLease(REUSE_CONFIG);
    await expect(resume(lease, plugin, DEADLINE_CONFIG)).resolves.toMatchObject({
      providerLeaseId: lease.providerLeaseId,
      metadata: { resumedLease: true },
    });
  });

  it("bounds the resume readiness check to podReadyTimeoutSec when it is below the resume wait", async () => {
    const lease = await releasedLease({ ...DEADLINE_CONFIG, podReadyTimeoutSec: 5 });
    const name = lease.providerLeaseId!;
    makeNotReady(name);

    vi.useFakeTimers();
    const caught = resume(lease, plugin, { ...DEADLINE_CONFIG, podReadyTimeoutSec: 5 }).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    await vi.advanceTimersByTimeAsync(7_000);
    const err = await caught;

    // A briefly not-Ready pod is a temporary failure: the host retries and the
    // sandbox stays kept and idle.
    expect(err?.message).toMatch(/timed out after 5000ms/);
    expect(cluster.sandboxes.has(name)).toBe(true);
    expect(annotations(name)[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
  });

  it("keeps the resume readiness check at its own short wait under the default cap", async () => {
    const lease = await releasedLease(REUSE_CONFIG);
    makeNotReady(lease.providerLeaseId!);

    vi.useFakeTimers();
    let settled: Error | null | undefined;
    void resume(lease, plugin, REUSE_CONFIG).then(
      () => { settled = null; },
      (err: unknown) => { settled = err instanceof Error ? err : new Error(String(err)); },
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled?.message).toMatch(/timed out after 30000ms/);
  });

  it("bounds the readiness wait of a resumed sandbox's first command after a worker restart", async () => {
    const lease = await releasedLease();
    const name = lease.providerLeaseId!;
    const resumed = await resume(lease);
    expect(resumed.providerLeaseId).toBe(name);
    const podUid = annotations(name)[REUSE_ANNOTATIONS.podUid];
    expect(podUid).toBe(cluster.pods.get(name)!.metadata.uid);

    // A restarted worker has not seen this pod Ready, so its first command
    // waits for readiness again.
    vi.resetModules();
    const restarted = (await import("../../src/plugin.js")).default;
    const freshReaper = await import("../../src/idle-reaper.js");
    restartedResetIdleReaper = () => freshReaper.resetIdleReaper();
    makeNotReady(name);

    vi.useFakeTimers();
    const pending = execute(resumed, restarted);
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;

    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.stderr).toContain("did not become Ready within 20000ms");
    expect(result.stderr).toContain("FailedScheduling");
    expect(result.metadata).toMatchObject({ transient: true, podReadyTimeoutMs: 20_000 });
    // The kept sandbox keeps its identity and stays with this run.
    expect(cluster.sandboxes.has(name)).toBe(true);
    expect(annotations(name)[REUSE_ANNOTATIONS.leaseState]).toBe("busy");
    expect(annotations(name)[REUSE_ANNOTATIONS.podUid]).toBe(podUid);
    vi.useRealTimers();

    makeReady(name);
    await expect(execute(resumed, restarted)).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(annotations(name)[REUSE_ANNOTATIONS.podUid]).toBe(podUid);
  });
});
