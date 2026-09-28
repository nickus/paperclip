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

  it("tags a dropped fast-upload flush the same way (execTransportFailure + partial stderr)", async () => {
    // Drive the chunked-upload protocol (INIT, CHUNK, FINALIZE) on one lease so
    // the interceptor collapses it into a single flush exec, which then drops.
    h.execInPod.mockRejectedValue(
      new PodExecTransportError(
        "execInPod lost its exec connection before the command reported an exit status (keepalive_timeout: no frame, pong or send progress for 60000ms).",
        "keepalive_timeout",
        "",
        "base64: truncated input\n",
      ),
    );
    const base = executeParams();
    const run = (script: string) =>
      plugin.definition.onEnvironmentExecute!({ ...(base as object), command: "sh", args: ["-c", script] } as never);
    const target = "/workspace/f.bin";
    const b64 = `${target}.paperclip-upload.b64`;
    expect((await run(`mkdir -p '/workspace' && rm -f '${b64}' && : > '${b64}'`)).metadata)
      .toEqual(expect.objectContaining({ fastUpload: "ack" }));
    await run(`printf '%s' '${Buffer.from("hello").toString("base64")}' >> '${b64}'`);
    const result = await run(`base64 -d < '${b64}' > '${target}' && rm -f '${b64}'`);

    expect(h.execInPod).toHaveBeenCalledTimes(1); // the single flush exec
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.split("\n")[0]).toMatch(/^fast-upload flush failed: .*lost its exec connection/);
    expect(result.stderr).toContain("base64: truncated input");
    expect(result.metadata).toEqual(
      expect.objectContaining({ fastUpload: "flush", execTransportFailure: "keepalive_timeout" }),
    );
  });

  it("keeps timedOut=true and no transport tag for a non-transport flush error", async () => {
    h.execInPod.mockRejectedValue(new Error("Unexpected server response: 403"));
    const base = executeParams();
    const run = (script: string) =>
      plugin.definition.onEnvironmentExecute!({ ...(base as object), command: "sh", args: ["-c", script] } as never);
    const target = "/workspace/g.bin";
    const b64 = `${target}.paperclip-upload.b64`;
    await run(`mkdir -p '/workspace' && rm -f '${b64}' && : > '${b64}'`);
    await run(`printf '%s' '${Buffer.from("x").toString("base64")}' >> '${b64}'`);
    const result = await run(`base64 -d < '${b64}' > '${target}' && rm -f '${b64}'`);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toBe("fast-upload flush failed: Unexpected server response: 403");
    expect(result.metadata).not.toHaveProperty("execTransportFailure");
  });

  it("passes the run env to the pod over stdin, never on the exec command line", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const secret = "test-run-secret-7f3a";
    await plugin.definition.onEnvironmentExecute!({
      ...(executeParams() as object),
      env: { ANTHROPIC_API_KEY: secret, XDG_CONFIG_HOME: "/workspace/.config" },
      stdin: "prompt on stdin",
    } as never);

    expect(h.execInPod).toHaveBeenCalledTimes(1);
    const [, , , , command, stdin] = h.execInPod.mock.calls[0]!;
    const argv = (command as string[]).join("\0");
    expect(argv.split(secret).length - 1).toBe(0);
    expect(argv.split("/workspace/.config").length - 1).toBe(0);
    expect(argv).toContain("exec 'opencode' 'run' '--format' 'json'");
    const stdinText = Buffer.from(stdin as Buffer).toString("utf-8");
    expect(stdinText.split(secret).length - 1).toBe(1);
    expect(stdinText.endsWith("prompt on stdin")).toBe(true);
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
