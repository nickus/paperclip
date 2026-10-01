import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeCluster, notFound, type FakeCluster } from "./_fake-cluster.js";

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
    execInPod: vi.fn(async () => ({ exitCode: 0, stdout: "paperclip-process-reset: ok stopped=2\n", stderr: "" })),
  };
});

import plugin from "../../src/plugin.js";
import manifest from "../../src/manifest.js";
import { execInPod } from "../../src/pod-exec.js";
import { resetKubeConnectionCache } from "../../src/kube-client-cache.js";
import { idleReaperState, resetIdleReaper, sweepAllRegisteredNamespaces } from "../../src/idle-reaper.js";
import { PROCESS_RESET_SCRIPT } from "../../src/process-reset.js";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";
import { REUSE_ANNOTATIONS, REUSE_BUSY_REFRESH_MS, computeReuseKey } from "../../src/reuse.js";

const REUSE_CONFIG = {
  inCluster: true,
  backend: "sandbox-cr",
  adapterType: "opencode_local",
  reuseLease: true,
};

const SCOPE = {
  companyId: "company-1",
  environmentId: "env-1",
  executionWorkspaceId: "workspace-1",
  agentId: "agent-1",
};

let cluster: FakeCluster;

beforeEach(() => {
  cluster = createFakeCluster();
  h.clients = cluster.clients;
  resetKubeConnectionCache();
  resetIdleReaper();
  vi.mocked(execInPod).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  resetIdleReaper();
  vi.restoreAllMocks();
});

function acquire(config: Record<string, unknown> = REUSE_CONFIG, overrides: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    issueId: "issue-1",
    config,
    runId: "run-1",
    agentId: SCOPE.agentId,
    executionWorkspaceId: SCOPE.executionWorkspaceId,
    ...overrides,
  } as Parameters<NonNullable<typeof plugin.definition.onEnvironmentAcquireLease>>[0]);
}

function release(
  lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
  config: Record<string, unknown> = REUSE_CONFIG,
  overrides: Record<string, unknown> = {},
) {
  return plugin.definition.onEnvironmentReleaseLease!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    config,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
    ...overrides,
  });
}

/**
 * The lease metadata the host stores and hands back on resume: the provider's
 * metadata plus the host's reuse scope (see the server's reusable lease scope).
 */
function hostLeaseMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...metadata,
    reusableSandboxLease: {
      version: 1,
      companyId: SCOPE.companyId,
      environmentId: SCOPE.environmentId,
      executionWorkspaceId: SCOPE.executionWorkspaceId,
      agentId: SCOPE.agentId,
      adapterType: "opencode_local",
      provider: "kubernetes",
    },
  };
}

function resume(
  lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
  config: Record<string, unknown> = REUSE_CONFIG,
) {
  return plugin.definition.onEnvironmentResumeLease!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    config,
    providerLeaseId: lease.providerLeaseId!,
    leaseMetadata: hostLeaseMetadata(lease.metadata),
  });
}

function execute(
  lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
  script: string,
  config: Record<string, unknown> = REUSE_CONFIG,
) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: SCOPE.companyId,
    environmentId: SCOPE.environmentId,
    config,
    lease: { providerLeaseId: lease.providerLeaseId, metadata: lease.metadata },
    command: "sh",
    args: ["-c", script],
    timeoutMs: 60_000,
  });
}

function transient(): Error {
  return Object.assign(new Error("HTTP-Code: 503 Message: service unavailable"), { code: 503 });
}

function createdSandbox() {
  const call = cluster.clients.custom.createNamespacedCustomObject.mock.calls.find(
    ([req]) => req.plural === "sandboxes",
  );
  return call![0].body as Record<string, any>;
}

describe("reusable lease config", () => {
  it("declares reusable leases and keeps reuseLease through validation", async () => {
    expect(manifest.environmentDrivers?.[0]).toMatchObject({ supportsReusableLeases: true });
    const schema = manifest.environmentDrivers?.[0]?.configSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("reuseLease");

    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { ...REUSE_CONFIG, runnerIdleTimeoutMs: 86_400_000, reuseMaxSandboxes: 8 },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({
      reuseLease: true,
      runnerIdleTimeoutMs: 86_400_000,
      reuseMaxSandboxes: 8,
    });
  });

  it("rejects reuseLease on the job backend", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { ...REUSE_CONFIG, backend: "job" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/reuseLease requires backend "sandbox-cr"/);
  });

  it("warns when the cap does not fit the default tenant quota", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { ...REUSE_CONFIG, egressMode: "cilium", reuseMaxSandboxes: 12 },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining("reuseMaxSandboxes=12 is more than the 10 reusable sandboxes")]);
  });
});

describe("acquire with reuseLease", () => {
  it("creates a busy, labelled, low-request sandbox and stamps the lease", async () => {
    const lease = await acquire();
    const cr = createdSandbox();
    const key = computeReuseKey({ ...SCOPE, runAdapterType: "opencode_local" });

    expect(cr.metadata.labels).toMatchObject({
      "paperclip.io/run-id": "run-1",
      "paperclip.io/agent-id": "agent-1",
      "paperclip.io/reuse": "true",
      "paperclip.io/reuse-key": key.slice(0, 40),
      "paperclip.io/execution-workspace-id": "workspace-1",
      "paperclip.io/issue-id": "issue-1",
    });
    expect(cr.metadata.annotations).toMatchObject({
      [REUSE_ANNOTATIONS.specVersion]: "1",
      [REUSE_ANNOTATIONS.reuseKey]: key,
      [REUSE_ANNOTATIONS.leaseState]: "busy",
      [REUSE_ANNOTATIONS.idleTtlSeconds]: "86400",
      [REUSE_ANNOTATIONS.staleBusySeconds]: "3600",
    });
    expect(cr.metadata.annotations[REUSE_ANNOTATIONS.specHash]).toMatch(/^[0-9a-f]{64}$/);
    expect(cr.spec.podTemplate.spec.containers[0].resources).toEqual({
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "2", memory: "4Gi" },
    });
    expect(lease.providerLeaseId).toBe(cr.metadata.name);
    expect(lease.metadata).toMatchObject({
      remoteCwd: "/workspace",
      kubernetesReuse: {
        version: 1,
        key,
        specHash: cr.metadata.annotations[REUSE_ANNOTATIONS.specHash],
        runAdapterType: "opencode_local",
        idleTtlSec: 86_400,
        podUid: null,
      },
    });
    // No top-level key that also exists in the provider config (the host
    // compares config keys against lease metadata to pick a reusable lease).
    expect(lease.metadata).not.toHaveProperty("adapterType");
  });

  it("takes its idle TTL from the host's runnerIdleTimeoutMs", async () => {
    const lease = await acquire({ ...REUSE_CONFIG, runnerIdleTimeoutMs: 7_200_000 });
    expect(createdSandbox().metadata.annotations[REUSE_ANNOTATIONS.idleTtlSeconds]).toBe("7200");
    expect((lease.metadata?.kubernetesReuse as { idleTtlSec: number }).idleTtlSec).toBe(7200);
  });

  it("stays ephemeral without an execution workspace or with a caller deadline", async () => {
    const noWorkspace = await acquire(REUSE_CONFIG, { executionWorkspaceId: null });
    expect(noWorkspace.metadata).not.toHaveProperty("kubernetesReuse");
    const bounded = await acquire(REUSE_CONFIG, { requestedExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(bounded.metadata).not.toHaveProperty("kubernetesReuse");
  });

  it("keeps no sandbox for a lease the host records as ephemeral", async () => {
    const ephemeral = await acquire(REUSE_CONFIG, { leasePolicy: "ephemeral" });
    expect(ephemeral.metadata).not.toHaveProperty("kubernetesReuse");
    expect(createdSandbox().metadata.labels).not.toHaveProperty("paperclip.io/reuse");

    const reusable = await acquire(REUSE_CONFIG, { leasePolicy: "reuse_by_environment" });
    expect(reusable.metadata).toHaveProperty("kubernetesReuse");
  });

  it("leaves the manifest and lease metadata unchanged when reuseLease is off", async () => {
    const config = { inCluster: true, backend: "sandbox-cr", adapterType: "opencode_local" };
    const lease = await acquire(config);
    const cr = createdSandbox();
    const name = cr.metadata.name as string;

    // Exactly what the provider built before reusable leases existed.
    const expected = buildSandboxCrManifest({
      namespace: "paperclip-company-1",
      sandboxName: name,
      adapterType: "opencode_local",
      image: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
      envSecretName: `${name}-env`,
      serviceAccountName: "paperclip-tenant-sa",
      labels: {
        "paperclip.io/run-id": "run-1",
        "paperclip.io/agent-id": "run-1",
        "paperclip.io/company-id": "company-1",
        "paperclip.io/adapter": "opencode_local",
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
      },
      resources: {},
      runtimeClassName: undefined,
      imagePullSecrets: [],
    });
    const { uid: _uid, resourceVersion: _rv, creationTimestamp: _ts, ...createdMetadata } = cr.metadata;
    expect(JSON.stringify({ ...cr, metadata: createdMetadata, status: undefined })).toBe(
      JSON.stringify({ ...expected, status: undefined }),
    );
    expect(Object.keys(lease.metadata ?? {}).sort()).toEqual([
      "backend",
      "jobName",
      "namespace",
      "nativeFileSyncUnsupported",
      "phase",
      "podName",
      "scopedNetworkEgress",
      "scopedNetworkPolicyName",
      "secretName",
    ]);
  });
});

describe("acquire for an adapter named only in the environment's adapter registry", () => {
  // An environment serves mixed harnesses: its registry lists an external
  // adapter next to the environment's default one, and each run names its
  // agent's adapter.
  const REGISTRY_CONFIG = {
    inCluster: true,
    backend: "sandbox-cr",
    adapterType: "opencode_local",
    adapters: [
      { adapterType: "opencode_local", runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1" },
      {
        adapterType: "external_local",
        runtimeImage: "registry.example.test/agent-runtime-external:v1",
        envKeys: [],
        allowFqdns: [],
        probeCommand: ["external-runner", "-h"],
      },
    ],
  };

  it("validates a config whose registry lists an external adapter", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: REGISTRY_CONFIG,
    } as Parameters<NonNullable<typeof plugin.definition.onEnvironmentValidateConfig>>[0]);
    expect(result.ok).toBe(true);
  });

  it("runs the run's adapter on its registry entry's runtime image", async () => {
    await acquire(REGISTRY_CONFIG, { adapterType: "external_local" });
    const cr = createdSandbox();
    expect(cr.spec.podTemplate.spec.containers[0].image).toBe("registry.example.test/agent-runtime-external:v1");
    expect(cr.metadata.labels["paperclip.io/adapter"]).toBe("external_local");
  });

  it("keeps the environment's default adapter image for a run that names no adapter", async () => {
    await acquire(REGISTRY_CONFIG);
    const cr = createdSandbox();
    expect(cr.spec.podTemplate.spec.containers[0].image).toBe("ghcr.io/paperclipai/agent-runtime-opencode:v1");
    expect(cr.metadata.labels["paperclip.io/adapter"]).toBe("opencode_local");
  });

  it("keys a kept sandbox to the run's adapter", async () => {
    const lease = await acquire({ ...REGISTRY_CONFIG, reuseLease: true }, { adapterType: "external_local" });
    expect(lease.metadata).toMatchObject({
      kubernetesReuse: {
        key: computeReuseKey({ ...SCOPE, runAdapterType: "external_local" }),
        runAdapterType: "external_local",
      },
    });
  });

  it("fails the lease for an adapter the registry does not list", async () => {
    await expect(acquire(REGISTRY_CONFIG, { adapterType: "unlisted_local" })).rejects.toThrow(
      'Adapter "unlisted_local" is not in the configured adapter registry',
    );
  });
});

describe("release with reuseLease", () => {
  it("stops the run's processes, marks the sandbox idle and keeps it", async () => {
    const lease = await acquire();
    const name = lease.providerLeaseId!;

    const receipt = await release(lease);

    expect(receipt).toEqual({ providerLeaseId: name, state: "stopped" });
    expect(execInPod).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execInPod).mock.calls[0]?.slice(2, 5)).toEqual([
      name,
      "agent",
      ["/bin/sh", "-c", PROCESS_RESET_SCRIPT, "paperclip-process-reset"],
    ]);
    const cr = cluster.sandboxes.get(name)!;
    expect(cr.metadata.annotations).toMatchObject({
      [REUSE_ANNOTATIONS.leaseState]: "idle",
      [REUSE_ANNOTATIONS.podUid]: cluster.pods.get(name)!.metadata.uid,
    });
    expect(cr.metadata.annotations[REUSE_ANNOTATIONS.lastUsedAt]).toBeTruthy();
    expect(cluster.pods.has(name)).toBe(true);
    expect(cluster.secrets.has(`${name}-env`)).toBe(true);
    expect(cluster.clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("tears the sandbox down when the processes cannot be verified stopped", async () => {
    const lease = await acquire();
    vi.mocked(execInPod).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "paperclip-process-reset: failed remaining= 42" });

    await expect(release(lease)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    expect(cluster.sandboxes.has(lease.providerLeaseId!)).toBe(false);
  });

  it("keeps the sandbox on an explicit cancellation once the processes are verified stopped", async () => {
    const lease = await acquire();
    await expect(release(lease, REUSE_CONFIG, { cancelActiveWork: true })).resolves.toEqual({
      providerLeaseId: lease.providerLeaseId,
      state: "stopped",
    });
    // The verified stop is the proof a cancellation needs; the task keeps its sandbox.
    expect(execInPod).toHaveBeenCalledTimes(1);
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
  });

  it("tears the sandbox down on a cancellation whose processes cannot be verified stopped", async () => {
    const lease = await acquire();
    vi.mocked(execInPod).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "paperclip-process-reset: failed remaining= 7" });
    await expect(release(lease, REUSE_CONFIG, { cancelActiveWork: true })).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
  });

  it("refuses commands for a released sandbox until a run resumes it", async () => {
    const lease = await acquire();
    await release(lease, REUSE_CONFIG, { cancelActiveWork: true });
    vi.mocked(execInPod).mockClear();

    // A command from the cancelled startup that arrives after the release.
    const late = await execute(lease, "echo late");
    expect(late).toMatchObject({ exitCode: null, timedOut: false, metadata: { leaseReleased: true } });
    expect(late.stderr).toMatch(/was released/);
    expect(execInPod).not.toHaveBeenCalled();

    const resumed = await resume(lease);
    await expect(execute(resumed, "echo next-run")).resolves.toMatchObject({ exitCode: 0 });
    expect(execInPod).toHaveBeenCalledTimes(1);
  });

  it("retries a temporary API error instead of giving the sandbox up", async () => {
    const lease = await acquire();
    cluster.clients.custom.getNamespacedCustomObject.mockRejectedValueOnce(transient());
    cluster.clients.core.readNamespacedPod.mockRejectedValueOnce(transient());

    await expect(release(lease)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
  });

  it("keeps a verified-stopped sandbox when only the idle mark keeps failing", async () => {
    const lease = await acquire();
    cluster.clients.custom.patchNamespacedCustomObject.mockRejectedValue(transient());
    try {
      await expect(release(lease)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    } finally {
      cluster.clients.custom.patchNamespacedCustomObject.mockReset();
    }
    // Still marked busy: the reaper's stale-busy rule covers it.
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("busy");
    expect(cluster.clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  }, 15_000);

  it("removes the sandbox after too many failed runs in a row, and resets the count after a good one", async () => {
    const lease = await acquire();
    await expect(release(lease, REUSE_CONFIG, { runStatus: "failed" })).resolves.toMatchObject({ state: "stopped" });
    const annotations = () => cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations;
    expect(annotations()[REUSE_ANNOTATIONS.consecutiveFailures]).toBe("1");

    let current = await resume(lease);
    await expect(release(current, REUSE_CONFIG, { runStatus: "released" })).resolves.toMatchObject({ state: "stopped" });
    expect(annotations()[REUSE_ANNOTATIONS.consecutiveFailures]).toBe("0");

    current = await resume(current);
    await release(current, REUSE_CONFIG, { runStatus: "failed" });
    current = await resume(current);
    await release(current, REUSE_CONFIG, { runStatus: "failed" });
    expect(annotations()[REUSE_ANNOTATIONS.consecutiveFailures]).toBe("2");
    current = await resume(current);
    await expect(release(current, REUSE_CONFIG, { runStatus: "failed" })).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
  });

  it("leaves the failure count alone for a cancelled or interrupted run", async () => {
    const lease = await acquire();
    const annotations = () => cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations;
    await release(lease, REUSE_CONFIG, { runStatus: "failed" });
    let current = await resume(lease);
    await release(current, REUSE_CONFIG, { runStatus: "failed" });
    expect(annotations()[REUSE_ANNOTATIONS.consecutiveFailures]).toBe("2");

    // Neither says anything about the sandbox: no third failure, no reset.
    for (const runStatus of ["interrupted", "expired", "interrupted"]) {
      current = await resume(current);
      await expect(release(current, REUSE_CONFIG, { runStatus, cancelActiveWork: true })).resolves.toMatchObject({
        state: "stopped",
      });
      expect(annotations()[REUSE_ANNOTATIONS.consecutiveFailures]).toBe("2");
    }
    current = await resume(current);
    await expect(release(current, REUSE_CONFIG, { runStatus: "failed" })).resolves.toMatchObject({ state: "destroyed" });
  });

  it("tears the sandbox down when its pod was replaced during the run that created it", async () => {
    const lease = await acquire();
    // The run's first command records the pod it started on.
    await expect(execute(lease, "echo first")).resolves.toMatchObject({ exitCode: 0 });
    const first = cluster.pods.get(lease.providerLeaseId!)!.metadata.uid;
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.podUid]).toBe(first);

    cluster.replacePod(lease.providerLeaseId!);
    await expect(release(lease)).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
  });

  it("keeps only the most recently released sandbox of a task", async () => {
    // Two runs of the same task that each created a sandbox.
    const older = await acquire();
    const newer = await acquire(REUSE_CONFIG, { runId: "run-2" });
    await release(older);
    await release(newer);

    expect(cluster.sandboxes.has(older.providerLeaseId!)).toBe(false);
    expect(cluster.sandboxes.has(newer.providerLeaseId!)).toBe(true);
  });

  it("never removes a busy sandbox of the same task", async () => {
    const running = await acquire();
    const other = await acquire(REUSE_CONFIG, { runId: "run-2" });
    await release(other);
    expect(cluster.sandboxes.has(running.providerLeaseId!)).toBe(true);
  });

  it("keeps a run's commands from looking abandoned while they run", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const lease = await acquire();
      const name = lease.providerLeaseId!;
      const busySince = () => cluster.sandboxes.get(name)!.metadata.annotations[REUSE_ANNOTATIONS.busySince];
      const before = busySince();
      let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
      vi.mocked(execInPod).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

      const running = execute(lease, "long-running-agent");
      await vi.waitFor(() => expect(execInPod).toHaveBeenCalled());
      vi.advanceTimersByTime(REUSE_BUSY_REFRESH_MS + 1);
      await vi.waitFor(() => expect(busySince()).not.toBe(before));
      finish({ exitCode: 0, stdout: "", stderr: "" });
      await expect(running).resolves.toMatchObject({ exitCode: 0 });

      // A refresh after the release never marks the idle sandbox busy again.
      await release(lease);
      const patches = cluster.clients.custom.patchNamespacedCustomObject.mock.calls.length;
      vi.advanceTimersByTime(REUSE_BUSY_REFRESH_MS * 3);
      expect(cluster.clients.custom.patchNamespacedCustomObject.mock.calls.length).toBe(patches);
      expect(cluster.sandboxes.get(name)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears the sandbox down once reuse is turned off for the environment", async () => {
    const lease = await acquire();
    await expect(release(lease, { ...REUSE_CONFIG, reuseLease: false })).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
  });

  it("tears the sandbox down when its pod was replaced during the run", async () => {
    const lease = await acquire();
    await release(lease);
    const resumed = await resume(lease);
    cluster.replacePod(lease.providerLeaseId!);

    await expect(release(resumed)).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
  });
});

describe("stop and keep", () => {
  function stop(
    lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
    config: Record<string, unknown> = REUSE_CONFIG,
  ) {
    return plugin.definition.onEnvironmentStopLease!({
      driverKey: "kubernetes",
      companyId: SCOPE.companyId,
      environmentId: SCOPE.environmentId,
      config,
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
      cancelActiveWork: true,
      resourceDisposition: "stop_and_retain",
    });
  }

  it("stops the processes, keeps the sandbox idle and keeps its failure count", async () => {
    const lease = await acquire();
    await release(lease, REUSE_CONFIG, { runStatus: "failed" });
    const resumed = await resume(lease);
    vi.mocked(execInPod).mockClear();

    await expect(stop(resumed)).resolves.toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });

    expect(vi.mocked(execInPod).mock.calls.map((call) => call[4])).toEqual([
      ["/bin/sh", "-c", PROCESS_RESET_SCRIPT, "paperclip-process-reset"],
    ]);
    const annotations = cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations;
    expect(annotations[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
    expect(annotations[REUSE_ANNOTATIONS.consecutiveFailures]).toBe("1");
    expect(cluster.pods.has(lease.providerLeaseId!)).toBe(true);
    expect(cluster.clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    // The next run of the task resumes the kept sandbox.
    await expect(resume(resumed)).resolves.toMatchObject({ providerLeaseId: lease.providerLeaseId });
  });

  it("keeps the sandbox when reuse was turned off, for the idle reaper to remove", async () => {
    const lease = await acquire();
    await expect(stop(lease, { ...REUSE_CONFIG, reuseLease: false })).resolves.toMatchObject({ state: "stopped" });
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
    expect(cluster.clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("takes a release that asks to stop and retain the same way", async () => {
    const lease = await acquire();
    await expect(
      release(lease, { ...REUSE_CONFIG, reuseLease: false }, { resourceDisposition: "stop_and_retain" }),
    ).resolves.toMatchObject({ state: "stopped" });
    expect(cluster.sandboxes.has(lease.providerLeaseId!)).toBe(true);
  });

  it("throws instead of removing the sandbox when the stop cannot be verified", async () => {
    const lease = await acquire();
    vi.mocked(execInPod).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "paperclip-process-reset: failed remaining= 42" });

    await expect(stop(lease)).rejects.toThrow(/Could not verify that the processes .* stopped .*the sandbox was kept/);
    expect(cluster.sandboxes.has(lease.providerLeaseId!)).toBe(true);
    expect(cluster.pods.has(lease.providerLeaseId!)).toBe(true);
    expect(cluster.clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(cluster.clients.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("refuses commands after the stop until a run resumes the sandbox", async () => {
    const lease = await acquire();
    await stop(lease);
    await expect(execute(lease, "echo late")).resolves.toMatchObject({ exitCode: null, metadata: { leaseReleased: true } });
    const resumed = await resume(lease);
    await expect(execute(resumed, "echo next-run")).resolves.toMatchObject({ exitCode: 0 });
  });

  it("reports a sandbox or pod that is gone as destroyed and deletes nothing", async () => {
    const withoutSandbox = await acquire();
    cluster.sandboxes.delete(withoutSandbox.providerLeaseId!);
    await expect(stop(withoutSandbox)).resolves.toEqual({
      providerLeaseId: withoutSandbox.providerLeaseId,
      state: "destroyed",
    });

    const withoutPod = await acquire(REUSE_CONFIG, { executionWorkspaceId: "workspace-2" });
    cluster.pods.delete(withoutPod.providerLeaseId!);
    await expect(stop(withoutPod)).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.has(withoutPod.providerLeaseId!)).toBe(true);

    const replaced = await acquire(REUSE_CONFIG, { executionWorkspaceId: "workspace-3" });
    await execute(replaced, "echo first");
    cluster.replacePod(replaced.providerLeaseId!);
    vi.mocked(execInPod).mockClear();
    await expect(stop(replaced)).resolves.toMatchObject({ state: "destroyed" });
    expect(execInPod).not.toHaveBeenCalled();

    expect(cluster.clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("asks for a retry while the sandbox is being deleted", async () => {
    const lease = await acquire();
    cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.deletionTimestamp = new Date().toISOString();
    await expect(stop(lease)).rejects.toThrow(/is being deleted/);
  });

  it("stops and keeps a sandbox that is not kept between runs", async () => {
    const config = { ...REUSE_CONFIG, reuseLease: false };
    const lease = await acquire(config);
    expect(lease.metadata?.kubernetesReuse).toBeUndefined();

    await expect(stop(lease, config)).resolves.toMatchObject({ state: "stopped" });
    expect(execInPod).toHaveBeenCalledTimes(1);
    expect(cluster.sandboxes.has(lease.providerLeaseId!)).toBe(true);
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations ?? {}).not.toHaveProperty(
      REUSE_ANNOTATIONS.leaseState,
    );
    // An exact resume of the stopped sandbox accepts commands again.
    const resumed = await resume(lease, config);
    await expect(execute(resumed, "echo resumed", config)).resolves.toMatchObject({ exitCode: 0 });
  });

  it("refuses to stop a job, which cannot be kept", async () => {
    await expect(
      stop({ providerLeaseId: "pc-job", metadata: { backend: "job", namespace: "paperclip-tenant" } }),
    ).rejects.toThrow(/cannot be stopped without removing it/);
  });
});

describe("destroy with reuseLease", () => {
  it("removes the sandbox, its secret and its task-scoped egress policy", async () => {
    const lease = await acquire(REUSE_CONFIG, {
      executionWorkspaceSettings: { networkEgress: { allowCidrs: ["203.0.113.0/24"] } },
    });
    const policy = lease.metadata?.scopedNetworkPolicyName as string;
    expect(cluster.networkPolicies.has(policy)).toBe(true);

    const receipt = await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: SCOPE.companyId,
      environmentId: SCOPE.environmentId,
      config: REUSE_CONFIG,
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    });

    expect(receipt).toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
    expect(cluster.secrets.size).toBe(0);
    expect(cluster.networkPolicies.has(policy)).toBe(false);
    // Idempotent: a second destroy (e.g. a pending_cleanup retry) treats 404 as done.
    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: SCOPE.companyId,
        environmentId: SCOPE.environmentId,
        config: REUSE_CONFIG,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      }),
    ).resolves.toMatchObject({ state: "destroyed" });
  });
});

describe("teardown of a reusable sandbox", () => {
  it("does not fail a completed teardown when its egress policy delete fails", async () => {
    const lease = await acquire(REUSE_CONFIG, {
      executionWorkspaceSettings: { networkEgress: { allowCidrs: ["203.0.113.0/24"] } },
    });
    cluster.clients.networking.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(
      Object.assign(new Error("HTTP-Code: 500 Message: internal error"), { code: 500 }),
    );
    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: SCOPE.companyId,
        environmentId: SCOPE.environmentId,
        config: REUSE_CONFIG,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      }),
    ).resolves.toMatchObject({ state: "destroyed" });
    expect(cluster.sandboxes.size).toBe(0);
  });
});

describe("resume with reuseLease", () => {
  async function releasedLease() {
    const lease = await acquire();
    await release(lease);
    return lease;
  }

  it("resumes the same sandbox with the same working directory on the next run", async () => {
    const lease = await releasedLease();
    const name = lease.providerLeaseId!;

    const resumed = await resume(lease);

    expect(resumed.providerLeaseId).toBe(name);
    expect(resumed.metadata).toMatchObject({
      podName: name,
      phase: "Running",
      remoteCwd: "/workspace",
      resumedLease: true,
      kubernetesReuse: {
        key: (lease.metadata?.kubernetesReuse as { key: string }).key,
        podUid: cluster.pods.get(name)!.metadata.uid,
      },
    });
    expect(cluster.sandboxes.get(name)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("busy");
    // Resume never touches processes.
    expect(execInPod).toHaveBeenCalledTimes(1);

    // And the cycle repeats: release again, resume again, same sandbox.
    await expect(release(resumed)).resolves.toMatchObject({ state: "stopped" });
    await expect(resume(resumed)).resolves.toMatchObject({ providerLeaseId: name });
  });

  it("reports a deleted sandbox as expired (not found)", async () => {
    const lease = await releasedLease();
    cluster.sandboxes.delete(lease.providerLeaseId!);
    await expect(resume(lease)).resolves.toEqual({
      providerLeaseId: null,
      metadata: expect.objectContaining({ expired: true, reason: "not_found" }),
    });
  });

  it("reports a sandbox that is being deleted or failed as expired", async () => {
    const deleting = await releasedLease();
    cluster.sandboxes.get(deleting.providerLeaseId!)!.metadata.deletionTimestamp = new Date().toISOString();
    await expect(resume(deleting)).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "deleting" } });

    const failed = await releasedLease();
    cluster.sandboxes.get(failed.providerLeaseId!)!.status.conditions = [{ type: "Failed", status: "True" }];
    await expect(resume(failed)).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "failed" } });
  });

  it("never reuses a sandbox built from a different spec", async () => {
    const lease = await releasedLease();
    await expect(
      resume(lease, { ...REUSE_CONFIG, reuseResources: { limits: { memory: "6Gi" } } }),
    ).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "spec_changed" } });
    await expect(
      resume(lease, { ...REUSE_CONFIG, imageRegistry: "https://registry.example" }),
    ).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "spec_changed" } });
  });

  it("reports a replaced pod as expired so the next run starts a fresh session", async () => {
    const lease = await releasedLease();
    cluster.replacePod(lease.providerLeaseId!);
    await expect(resume(lease)).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "pod_replaced" } });
  });

  it("reports a reuse key mismatch as an identity mismatch", async () => {
    const lease = await releasedLease();
    cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.reuseKey] = "other";
    await expect(resume(lease)).resolves.toMatchObject({
      providerLeaseId: null,
      metadata: { reason: "identity_mismatch", workspaceSentinel: { result: "mismatch" } },
    });

    // The host scope must describe the same task as the stamp.
    const other = await releasedLease();
    await expect(
      plugin.definition.onEnvironmentResumeLease!({
        driverKey: "kubernetes",
        companyId: SCOPE.companyId,
        environmentId: SCOPE.environmentId,
        config: REUSE_CONFIG,
        providerLeaseId: other.providerLeaseId!,
        leaseMetadata: {
          ...hostLeaseMetadata(other.metadata),
          reusableSandboxLease: { executionWorkspaceId: "workspace-2", agentId: SCOPE.agentId },
        },
      }),
    ).resolves.toMatchObject({ providerLeaseId: null, metadata: { workspaceSentinel: { result: "mismatch" } } });
  });

  it("reports a stuck container as expired", async () => {
    const lease = await releasedLease();
    const pod = cluster.pods.get(lease.providerLeaseId!)!;
    pod.status.conditions = [{ type: "Ready", status: "False" }];
    pod.status.containerStatuses = [{ name: "agent", state: { waiting: { reason: "ImagePullBackOff" } } }];
    await expect(resume(lease)).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "pod_unhealthy" } });
  });

  it("throws on a temporary API error and keeps the sandbox", async () => {
    const lease = await releasedLease();
    cluster.clients.custom.getNamespacedCustomObject.mockRejectedValueOnce(
      Object.assign(new Error("HTTP-Code: 503 Message: service unavailable"), { code: 503 }),
    );
    // The host's resume retry treats messages mentioning a network failure as transient.
    await expect(resume(lease)).rejects.toThrow(/\bnetwork\b/);
    expect(cluster.sandboxes.has(lease.providerLeaseId!)).toBe(true);
    expect(cluster.sandboxes.get(lease.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.leaseState]).toBe("idle");
  });

  it("reports the sandbox expired when the reaper removed it during the resume", async () => {
    const lease = await releasedLease();
    cluster.clients.custom.patchNamespacedCustomObject.mockRejectedValueOnce(notFound());
    await expect(resume(lease)).resolves.toMatchObject({ providerLeaseId: null, metadata: { reason: "not_found" } });
  });

  it("keeps an upload in flight when another resume of the same lease happens", async () => {
    const lease = await releasedLease();
    const resumed = await resume(lease);
    const target = "/workspace/.paperclip-runtime/opencode/file.bin";
    await expect(
      execute(resumed, `mkdir -p '/workspace/.paperclip-runtime/opencode' && rm -f '${target}.paperclip-upload.b64' && : > '${target}.paperclip-upload.b64'`),
    ).resolves.toMatchObject({ metadata: { fastUpload: "ack" } });
    await expect(
      execute(resumed, `printf '%s' 'aGVsbG8=' >> '${target}.paperclip-upload.b64'`),
    ).resolves.toMatchObject({ metadata: { fastUpload: "ack" } });

    // A second acquisition resumes the same lease (it loses the host's lease handoff).
    await resume(lease);

    await expect(
      execute(resumed, `base64 -d < '${target}.paperclip-upload.b64' > '${target}' && rm -f '${target}.paperclip-upload.b64'`),
    ).resolves.toMatchObject({ metadata: { fastUpload: "flush", uploadedBytes: 5 } });
  });

  it("reports the lease expired when reuse was turned off", async () => {
    const lease = await releasedLease();
    await expect(resume(lease, { ...REUSE_CONFIG, reuseLease: false })).resolves.toMatchObject({
      providerLeaseId: null,
      metadata: { reason: "reuse_disabled" },
    });
  });
});

describe("idle expiry across restarts", () => {
  it("finds kept sandboxes in other namespaces from any call, even with reuse turned off", async () => {
    const lease = await acquire(REUSE_CONFIG);
    await release(lease);
    const name = lease.providerLeaseId!;
    cluster.sandboxes.get(name)!.metadata.annotations[REUSE_ANNOTATIONS.lastUsedAt] =
      new Date(Date.now() - 25 * 3_600_000).toISOString();

    // A worker restart forgets every registration; reuse was also turned off.
    resetIdleReaper();
    const reuseOff = { inCluster: true, backend: "sandbox-cr", adapterType: "opencode_local", companySlug: "other" };
    await acquire(reuseOff, { companyId: "company-2" });
    await vi.waitFor(() =>
      expect(idleReaperState().namespaces).toEqual([{ namespace: "paperclip-company-1", maxSandboxes: null }]),
    );

    await sweepAllRegisteredNamespaces();
    expect(cluster.sandboxes.has(name)).toBe(false);
    // Nothing reusable left there: the namespace is no longer swept.
    await sweepAllRegisteredNamespaces();
    expect(idleReaperState().registrations).toBe(0);
  });
});

describe("cap on reusable sandboxes", () => {
  it("holds the cap when several tasks acquire at once", async () => {
    const config = { ...REUSE_CONFIG, reuseMaxSandboxes: 8 };
    for (let i = 0; i < 8; i += 1) {
      const lease = await acquire(config, { executionWorkspaceId: `workspace-idle-${i}`, runId: `run-idle-${i}` });
      await release(lease, config);
    }
    expect(cluster.sandboxes.size).toBe(8);

    await Promise.all(
      [0, 1, 2].map((i) => acquire(config, { executionWorkspaceId: `workspace-new-${i}`, runId: `run-new-${i}` })),
    );

    expect(cluster.sandboxes.size).toBe(8);
  });

  it("evicts the least recently used idle sandbox before creating one at the cap", async () => {
    const config = { ...REUSE_CONFIG, reuseMaxSandboxes: 2 };
    const first = await acquire(config, { executionWorkspaceId: "workspace-a" });
    await release(first, config);
    resetIdleReaper(); // drop the RPC sweep throttle between acquires
    const second = await acquire(config, { executionWorkspaceId: "workspace-b" });
    await release(second, config);
    cluster.sandboxes.get(first.providerLeaseId!)!.metadata.annotations[REUSE_ANNOTATIONS.lastUsedAt] =
      new Date(Date.now() - 60_000).toISOString();
    resetIdleReaper();

    const third = await acquire(config, { executionWorkspaceId: "workspace-c" });

    expect(cluster.sandboxes.has(first.providerLeaseId!)).toBe(false);
    expect(cluster.sandboxes.has(second.providerLeaseId!)).toBe(true);
    expect(cluster.sandboxes.has(third.providerLeaseId!)).toBe(true);
  });
});
