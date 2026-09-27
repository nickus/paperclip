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
import { resetIdleReaper } from "../../src/idle-reaper.js";
import { PROCESS_RESET_SCRIPT } from "../../src/process-reset.js";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";
import { REUSE_ANNOTATIONS, computeReuseKey } from "../../src/reuse.js";

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

  it("tears the sandbox down on an explicit cancellation", async () => {
    const lease = await acquire();
    await expect(release(lease, REUSE_CONFIG, { cancelActiveWork: true })).resolves.toMatchObject({ state: "destroyed" });
    expect(execInPod).not.toHaveBeenCalled();
    expect(cluster.sandboxes.size).toBe(0);
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

  it("reports the lease expired when reuse was turned off", async () => {
    const lease = await releasedLease();
    await expect(resume(lease, { ...REUSE_CONFIG, reuseLease: false })).resolves.toMatchObject({
      providerLeaseId: null,
      metadata: { reason: "reuse_disabled" },
    });
  });
});

describe("cap on reusable sandboxes", () => {
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
