import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function leaseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    jobName: "pc-abc",
    podName: "pc-abc-pod",
    secretName: "pc-abc-env",
    phase: "Pending",
    backend: "sandbox-cr",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(podName: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      podName,
    },
  };
}

beforeEach(() => {
  h.clients = {};
});

describe("onEnvironmentResumeLease", () => {
  it("is implemented (Daytona feature parity)", () => {
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("returns a valid lease handle for a live sandbox-cr lease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: {},
          status: { phase: "Running" },
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
        phase: "Running",
        backend: "sandbox-cr",
        resumedLease: true,
        // sandbox-cr has a pod-exec channel, so native file sync stays enabled.
        nativeFileSyncUnsupported: false,
      }),
    );
  });

  it("flags a resumed job-backend lease as native-sync-unsupported so the server keeps the base64 fallback", async () => {
    h.clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({ status: { active: 1 } }),
      },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod" }),
    });

    expect(lease.providerLeaseId).toBe("pc-job");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        backend: "job",
        // The job backend has no exec channel; its native sync hook rejects, so
        // the lease must fall back to the byte-identical base64 transport.
        nativeFileSyncUnsupported: true,
      }),
    );
  });

  it("returns providerLeaseId null (expired) when the Sandbox CR is gone, so the caller falls back to acquireLease", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn() },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
    expect(lease.metadata?.reason).toMatch(/no longer exists/);
  });

  it("returns providerLeaseId null when the backing pod is gone", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
  });
});

// Fake clients for the teardown handlers. Every delete succeeds and every
// read reports 404, i.e. the API server confirms the resources are gone.
function teardownClients(overrides: {
  deleteCr?: ReturnType<typeof vi.fn>;
  deletePod?: ReturnType<typeof vi.fn>;
  deleteSecret?: ReturnType<typeof vi.fn>;
  deleteJob?: ReturnType<typeof vi.fn>;
  readCr?: ReturnType<typeof vi.fn>;
  readPod?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    custom: {
      deleteNamespacedCustomObject: overrides.deleteCr ?? vi.fn().mockResolvedValue({}),
      getNamespacedCustomObject: overrides.readCr ?? vi.fn().mockRejectedValue(notFound()),
    },
    core: {
      deleteNamespacedPod: overrides.deletePod ?? vi.fn().mockResolvedValue({}),
      deleteNamespacedSecret: overrides.deleteSecret ?? vi.fn().mockResolvedValue({}),
      readNamespacedPod: overrides.readPod ?? vi.fn().mockRejectedValue(notFound()),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    },
    batch: {
      deleteNamespacedJob: overrides.deleteJob ?? vi.fn().mockResolvedValue({}),
      readNamespacedJobStatus: vi.fn().mockRejectedValue(notFound()),
    },
  };
}

function teardownParams(overrides: Record<string, unknown> = {}) {
  return {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: CONFIG,
    providerLeaseId: "pc-abc",
    leaseMetadata: leaseMetadata(),
    ...overrides,
  } as Parameters<NonNullable<typeof plugin.definition.onEnvironmentDestroyLease>>[0];
}

describe("onEnvironmentDestroyLease", () => {
  it("deletes the Sandbox CR, pod, and per-run Secret and returns a termination receipt", async () => {
    const clients = teardownClients();
    h.clients = clients;

    const receipt = await plugin.definition.onEnvironmentDestroyLease!(teardownParams());

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
    expect(clients.core.deleteNamespacedPod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
      gracePeriodSeconds: 5,
    });
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
    // The host only certifies a remote stop from this exact receipt shape.
    expect(receipt).toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("is idempotent: confirms the stop when every resource is already gone (404)", async () => {
    h.clients = teardownClients({
      deleteCr: vi.fn().mockRejectedValue(notFound()),
      deletePod: vi.fn().mockRejectedValue(notFound()),
      deleteSecret: vi.fn().mockRejectedValue(notFound()),
    });

    await expect(
      plugin.definition.onEnvironmentDestroyLease!(teardownParams()),
    ).resolves.toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("is a no-op when providerLeaseId is null", async () => {
    const clients = teardownClients();
    h.clients = clients;

    await plugin.definition.onEnvironmentDestroyLease!(
      teardownParams({ providerLeaseId: null, leaseMetadata: undefined }),
    );

    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("deletes the Job for job-backend leases", async () => {
    const clients = teardownClients();
    h.clients = clients;

    await plugin.definition.onEnvironmentDestroyLease!(teardownParams({
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod", secretName: "pc-job-env" }),
    }));

    expect(clients.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe("onEnvironmentReleaseLease", () => {
  it("tears down the workload, pod, and Secret and returns a termination receipt", async () => {
    // Before the fix, release only deleted the workload and returned void, so
    // the host never recorded a stop receipt and saved comments waited forever.
    const clients = teardownClients();
    h.clients = clients;

    const receipt = await plugin.definition.onEnvironmentReleaseLease!(teardownParams());

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc", propagationPolicy: "Foreground" }),
    );
    expect(clients.core.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc-pod" }),
    );
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
    expect(receipt).toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("confirms the stop of a lease cancelled while its pod was still starting (no podName recorded)", async () => {
    const readCr = vi.fn()
      // Pod lookup before deletion: the CR exists and names its pod.
      .mockResolvedValueOnce({ metadata: { uid: "uid-1" }, status: { podName: "pc-abc-pod" } })
      // Confirmation: the CR is gone.
      .mockRejectedValue(notFound());
    const clients = teardownClients({ readCr });
    h.clients = clients;

    const receipt = await plugin.definition.onEnvironmentReleaseLease!(
      teardownParams({ leaseMetadata: leaseMetadata({ podName: undefined }) }),
    );

    expect(clients.core.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pc-abc-pod" }),
    );
    expect(receipt).toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("throws instead of returning a receipt when the stop cannot be confirmed", async () => {
    vi.useFakeTimers();
    try {
      // The pod never disappears: the host must keep the lease for cleanup
      // retries rather than record a stop that did not happen.
      h.clients = teardownClients({
        readCr: vi.fn().mockRejectedValue(notFound()),
        readPod: vi.fn().mockResolvedValue({ metadata: { deletionTimestamp: "now" } }),
      });

      const pending = plugin.definition.onEnvironmentReleaseLease!(teardownParams());
      const assertion = expect(pending).rejects.toThrow(/still terminating/);
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
