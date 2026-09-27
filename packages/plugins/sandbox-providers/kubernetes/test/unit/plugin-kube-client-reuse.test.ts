import { describe, it, expect, vi, beforeEach } from "vitest";

// Count kubeconfig parses / client builds across plugin RPCs. Before the
// connection cache, every onEnvironmentExecute parsed the kubeconfig and built
// five API clients (N execs → N parses); now it is 1 per config per TTL.
const h = vi.hoisted(() => ({
  creates: 0,
  makes: 0,
  clients: {} as Record<string, unknown>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => {
    h.creates += 1;
    return { fake: h.creates };
  }),
  makeKubeClients: vi.fn(() => {
    h.makes += 1;
    return h.clients;
  }),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
  };
});

import plugin from "../../src/plugin.js";
import { resetKubeConnectionCache } from "../../src/kube-client-cache.js";
import { execInPod } from "../../src/pod-exec.js";

const KUBECONFIG = "apiVersion: v1\nkind: Config\n# fake\n";

function executeParams(overrides: Record<string, unknown> = {}) {
  return {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { kubeconfig: KUBECONFIG, backend: "sandbox-cr" },
    lease: {
      providerLeaseId: "pc-reuse",
      metadata: {
        namespace: "paperclip-acme",
        podName: "pc-reuse-pod",
        backend: "sandbox-cr",
      },
    },
    command: "sh",
    args: ["-c", "echo hi"],
    timeoutMs: 10_000,
    ...overrides,
  } as Parameters<NonNullable<typeof plugin.definition.onEnvironmentExecute>>[0];
}

beforeEach(() => {
  h.creates = 0;
  h.makes = 0;
  h.clients = {
    custom: {
      // Sandbox CR reports Ready on the first (and only) readiness check.
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { uid: "uid-1" },
        status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-reuse-pod" },
      }),
    },
  };
  resetKubeConnectionCache();
});

describe("kube client reuse across RPCs", () => {
  it("parses the kubeconfig once for 50 execute calls", async () => {
    for (let i = 0; i < 50; i += 1) {
      const result = await plugin.definition.onEnvironmentExecute!(executeParams());
      expect(result.exitCode).toBe(0);
    }
    // Before the fix: 50 parses + 50 client builds. After: 1 + 1.
    expect(h.creates).toBe(1);
    expect(h.makes).toBe(1);
  });

  it("rebuilds the client after the API server rejects the credential (401)", async () => {
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.creates).toBe(1);

    // A lease with no recorded podName forces a findPod call; make it 401.
    const unauthorized = Object.assign(new Error("HTTP-Code: 401 Unauthorized"), { code: 401 });
    // Mutate the CACHED clients in place (the plugin holds on to that object).
    (h.clients.custom as Record<string, unknown>).getNamespacedCustomObject =
      vi.fn().mockRejectedValue(unauthorized);
    await expect(
      plugin.definition.onEnvironmentExecute!(
        executeParams({
          lease: {
            providerLeaseId: "pc-reuse-2",
            metadata: { namespace: "paperclip-acme", backend: "sandbox-cr" },
          },
        }),
      ),
    ).rejects.toThrow(/401/);

    // The failing call used the cached client; the eviction forces a rebuild.
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.creates).toBe(2);
  });

  it("does not evict on non-auth failures", async () => {
    await plugin.definition.onEnvironmentExecute!(executeParams());
    (h.clients.custom as Record<string, unknown>).getNamespacedCustomObject =
      vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(
      plugin.definition.onEnvironmentExecute!(
        executeParams({
          lease: {
            providerLeaseId: "pc-reuse-3",
            metadata: { namespace: "paperclip-acme", backend: "sandbox-cr" },
          },
        }),
      ),
    ).rejects.toThrow(/socket hang up/);
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.creates).toBe(1);
  });

  it("rebuilds the client after the exec WebSocket upgrade is rejected (ws ErrorEvent)", async () => {
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.creates).toBe(1);
    // client-node rejects exec with ws's ErrorEvent, not an Error instance; the
    // plugin reports it as a timed-out result, so eviction happens in the catch.
    vi.mocked(execInPod).mockRejectedValueOnce({
      type: "error",
      message: "Unexpected server response: 401",
      error: new Error("Unexpected server response: 401"),
    });
    const rejected = await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(rejected.timedOut).toBe(true);
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.creates).toBe(2);
  });

  it("keeps the client when an exec watchdog message merely contains 403/forbidden", async () => {
    await plugin.definition.onEnvironmentExecute!(executeParams());
    vi.mocked(execInPod).mockRejectedValueOnce(new Error(
      "execInPod timed out after 5000ms (pod=pc-reuse-403, container=agent, cmd0=forbidden). The WebSocket likely dropped before the command produced a status frame.",
    ));
    const timedOut = await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(timedOut.timedOut).toBe(true);
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.creates).toBe(1);
  });
});
