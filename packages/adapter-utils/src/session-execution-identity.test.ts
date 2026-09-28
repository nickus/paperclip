import { describe, expect, it } from "vitest";
import {
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  overrideAdapterExecutionTargetRemoteCwd,
  parseAdapterExecutionTarget,
  type AdapterSandboxExecutionTarget,
  type AdapterSshExecutionTarget,
} from "./execution-target.js";
import {
  serializeRemoteSessionExecutionIdentity,
  serializeSandboxSessionExecutionIdentity,
  serializeSessionExecutionIdentity,
} from "./session-execution-identity.js";

function sandboxTarget(overrides: Partial<AdapterSandboxExecutionTarget> = {}): AdapterSandboxExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    environmentId: "env-1",
    leaseId: "lease-1",
    remoteCwd: "/workspace",
    sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "pc-1" },
    ...overrides,
  };
}

describe("serializeSessionExecutionIdentity", () => {
  it("keeps only identity fields", () => {
    expect(
      serializeSessionExecutionIdentity({
        transport: "sandbox",
        providerKey: "kubernetes",
        environmentId: "env-1",
        leaseId: "lease-1",
        providerLeaseId: "pc-1",
        remoteCwd: "/workspace",
        runner: { execute: () => undefined },
        privateKey: "secret",
      }),
    ).toEqual({
      transport: "sandbox",
      providerKey: "kubernetes",
      environmentId: "env-1",
      leaseId: "lease-1",
      providerLeaseId: "pc-1",
      remoteCwd: "/workspace",
    });
  });

  it("never turns malformed state into an empty, local-compatible identity", () => {
    expect(serializeSessionExecutionIdentity(undefined)).toBeNull();
    expect(serializeSessionExecutionIdentity("sandbox")).toEqual({ transport: "invalid" });
    expect(serializeSessionExecutionIdentity({ unrelated: true })).toEqual({ transport: "invalid" });
  });

  it("is kept by session codecs for sandbox identities only", () => {
    expect(serializeSandboxSessionExecutionIdentity({ transport: "sandbox", leaseId: "lease-1" })).toEqual({
      transport: "sandbox",
      leaseId: "lease-1",
    });
    expect(
      serializeSandboxSessionExecutionIdentity({ transport: "ssh", host: "ssh.example.test", port: 22 }),
    ).toBeNull();
    expect(serializeSandboxSessionExecutionIdentity("sandbox")).toBeNull();
    expect(serializeSandboxSessionExecutionIdentity(null)).toBeNull();
  });

  it("is kept by remote session codecs for SSH identities too, without key material", () => {
    expect(
      serializeRemoteSessionExecutionIdentity({
        transport: "ssh",
        host: "ssh.example.test",
        port: 22,
        username: "agent",
        remoteCwd: "/home/agent/work/.paperclip-runtime/workspaces/k/workspace",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        spec: { privateKey: "PRIVATE KEY" },
      }),
    ).toEqual({
      transport: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "agent",
      remoteCwd: "/home/agent/work/.paperclip-runtime/workspaces/k/workspace",
    });
    expect(serializeRemoteSessionExecutionIdentity({ transport: "sandbox", leaseId: "lease-1" })).toEqual({
      transport: "sandbox",
      leaseId: "lease-1",
    });
    expect(serializeRemoteSessionExecutionIdentity({ transport: "local" })).toBeNull();
    expect(serializeRemoteSessionExecutionIdentity({ transport: "invalid" })).toBeNull();
    expect(serializeRemoteSessionExecutionIdentity("ssh")).toBeNull();
    expect(serializeRemoteSessionExecutionIdentity(null)).toBeNull();
  });
});

describe("ssh session identity across runs", () => {
  const KEY = "0123456789abcdef0123456789abcdef";
  const stableCwd = `/home/agent/work/.paperclip-runtime/workspaces/${KEY}/workspace`;

  function sshTarget(overrides: Partial<AdapterSshExecutionTarget> = {}): AdapterSshExecutionTarget {
    return {
      kind: "remote",
      transport: "ssh",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/home/agent/work",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "agent",
        remoteWorkspacePath: "/home/agent/work",
        remoteCwd: "/home/agent/work",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      ...overrides,
    };
  }

  it("resumes a session saved in the stable workspace from a new lease", () => {
    // Run 1 runs in the stable workspace and saves its identity through a codec.
    const saved = serializeRemoteSessionExecutionIdentity(
      JSON.parse(
        JSON.stringify(
          adapterExecutionTargetSessionIdentity(
            overrideAdapterExecutionTargetRemoteCwd(sshTarget({ workspaceReuseKey: KEY }), stableCwd),
          ),
        ),
      ),
    );
    expect(saved).toEqual({
      transport: "ssh",
      host: "127.0.0.1",
      port: 22,
      username: "agent",
      remoteCwd: stableCwd,
    });
    // Run 2 gets a new lease row and stages the same stable workspace.
    const next = overrideAdapterExecutionTargetRemoteCwd(
      sshTarget({ leaseId: "lease-2", workspaceReuseKey: KEY }),
      stableCwd,
    );
    expect(adapterExecutionTargetSessionMatches(saved, next)).toBe(true);
  });

  it("does not resume from a per-run directory, another host or a legacy identity-less session", () => {
    const saved = adapterExecutionTargetSessionIdentity(
      overrideAdapterExecutionTargetRemoteCwd(sshTarget(), stableCwd),
    );
    const perRun = overrideAdapterExecutionTargetRemoteCwd(
      sshTarget(),
      "/home/agent/work/.paperclip-runtime/runs/run-2/workspace",
    );
    expect(adapterExecutionTargetSessionMatches(saved, perRun)).toBe(false);
    const otherHost = overrideAdapterExecutionTargetRemoteCwd(
      sshTarget({ spec: { ...sshTarget().spec, host: "10.0.0.2" } }),
      stableCwd,
    );
    expect(adapterExecutionTargetSessionMatches(saved, otherHost)).toBe(false);
    // Sessions saved before SSH identities were kept start one fresh session.
    expect(
      adapterExecutionTargetSessionMatches({}, overrideAdapterExecutionTargetRemoteCwd(sshTarget(), stableCwd)),
    ).toBe(false);
  });

  it("carries only a well-formed workspace reuse key through a parse", () => {
    const serialized = JSON.parse(JSON.stringify(sshTarget({ workspaceReuseKey: KEY })));
    expect(parseAdapterExecutionTarget(serialized)).toMatchObject({ transport: "ssh", workspaceReuseKey: KEY });
    const tampered = parseAdapterExecutionTarget({ ...serialized, workspaceReuseKey: "../../etc" });
    expect(tampered).not.toHaveProperty("workspaceReuseKey");
    expect(parseAdapterExecutionTarget({ ...serialized, workspaceReuseKey: undefined })).not.toHaveProperty(
      "workspaceReuseKey",
    );
  });
});

describe("sandbox session identity across runs", () => {
  it("records the provider lease id of the sandbox", () => {
    expect(adapterExecutionTargetSessionIdentity(sandboxTarget())).toEqual({
      transport: "sandbox",
      providerKey: "kubernetes",
      environmentId: "env-1",
      leaseId: "lease-1",
      providerLeaseId: "pc-1",
      remoteCwd: "/workspace",
    });
  });

  it("resumes a session saved in the same reusable sandbox from a new lease row", () => {
    // Run 1 saves its session identity; the host persists it through a codec.
    const saved = serializeSandboxSessionExecutionIdentity(
      JSON.parse(JSON.stringify(adapterExecutionTargetSessionIdentity(sandboxTarget()))),
    );
    // Run 2 gets a new lease row that resumed the same provider sandbox.
    const next = sandboxTarget({
      leaseId: "lease-2",
      sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "pc-1" },
    });
    expect(adapterExecutionTargetSessionMatches(saved, next)).toBe(true);
  });

  it("does not resume in a different sandbox or working directory", () => {
    const saved = adapterExecutionTargetSessionIdentity(sandboxTarget());
    expect(
      adapterExecutionTargetSessionMatches(
        saved,
        sandboxTarget({
          leaseId: "lease-2",
          sandboxLeaseAcquisition: { outcome: "replacement", providerLeaseId: "pc-2", reason: "not_found" },
        }),
      ),
    ).toBe(false);
    expect(
      adapterExecutionTargetSessionMatches(
        saved,
        sandboxTarget({ leaseId: "lease-2", remoteCwd: "/tmp", sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "pc-1" } }),
      ),
    ).toBe(false);
    // Without an execution identity the saved session is never resumed remotely.
    expect(adapterExecutionTargetSessionMatches({}, sandboxTarget())).toBe(false);
  });

  it("falls back to the lease id for identities saved without a provider lease id", () => {
    const legacy = {
      transport: "sandbox",
      providerKey: "kubernetes",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/workspace",
    };
    expect(adapterExecutionTargetSessionMatches(legacy, sandboxTarget())).toBe(true);
    expect(adapterExecutionTargetSessionMatches(legacy, sandboxTarget({ leaseId: "lease-2" }))).toBe(false);
  });
});
