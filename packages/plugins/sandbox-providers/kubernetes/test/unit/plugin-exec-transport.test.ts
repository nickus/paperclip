import { describe, it, expect, vi, beforeEach } from "vitest";

// onEnvironmentExecute must turn a dropped exec connection into a prompt,
// clearly-labelled failure (not a "timed out after 3600s"), keep partial
// output, and forward the keepalive settings from the provider config.

const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  execInPod: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  h.execInPod = vi.fn();
  return { ...actual, execInPod: (...args: unknown[]) => h.execInPod(...args) };
});

import plugin from "../../src/plugin.js";
import { PodExecTransportError } from "../../src/pod-exec.js";

let leaseSeq = 0;

function executeParams(config: Record<string, unknown> = {}) {
  // Fresh lease id per test so the worker's "already Ready" cache never leaks.
  leaseSeq += 1;
  return {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { inCluster: true, backend: "sandbox-cr", ...config },
    lease: {
      providerLeaseId: `pc-exec-${leaseSeq}`,
      metadata: { namespace: "paperclip-acme", podName: "pc-pod", backend: "sandbox-cr" },
    },
    command: "opencode",
    args: ["run", "--format", "json"],
    timeoutMs: 3_600_000,
  } as never;
}

beforeEach(() => {
  h.clients = {
    custom: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { uid: "uid-1" },
        status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-pod" },
      }),
    },
  };
  h.execInPod.mockReset();
});

describe("onEnvironmentExecute exec transport failures", () => {
  it("reports a dropped connection as a failure (not a timeout) with partial output", async () => {
    h.execInPod.mockRejectedValue(
      new PodExecTransportError(
        "execInPod lost its exec connection before the command reported an exit status (connection_closed: WebSocket closed (code=1006)).",
        "connection_closed",
        '{"sessionID":"ses_1"}\n',
        "opencode warn\n",
      ),
    );
    const result = await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('{"sessionID":"ses_1"}\n');
    // Our diagnosis is the first line so it becomes the run's error message.
    expect(result.stderr.split("\n")[0]).toMatch(/lost its exec connection/);
    expect(result.stderr).toContain("opencode warn");
    expect(result.metadata).toEqual(expect.objectContaining({ execTransportFailure: "connection_closed" }));
  });

  it("keeps timedOut=true for a genuine watchdog timeout", async () => {
    h.execInPod.mockRejectedValue(
      new PodExecTransportError("execInPod timed out after 3600000ms", "timeout", "", ""),
    );
    const result = await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(result.timedOut).toBe(true);
    expect(result.metadata).toEqual(expect.objectContaining({ execTransportFailure: "timeout" }));
  });

  it("forwards keepalive settings from the provider config (defaults 15s / 60s)", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await plugin.definition.onEnvironmentExecute!(executeParams());
    expect(h.execInPod.mock.calls[0]?.[9]).toEqual({ keepaliveIntervalMs: 15_000, timeoutMs: 60_000 });

    await plugin.definition.onEnvironmentExecute!(
      executeParams({ execKeepaliveIntervalSec: 0, execLivenessTimeoutSec: 300 }),
    );
    expect(h.execInPod.mock.calls[1]?.[9]).toEqual({ keepaliveIntervalMs: 0, timeoutMs: 300_000 });
  });

  it("validateConfig normalizes the keepalive defaults", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true },
    });
    expect(result.normalizedConfig).toEqual(
      expect.objectContaining({ execKeepaliveIntervalSec: 15, execLivenessTimeoutSec: 60 }),
    );
  });
});
