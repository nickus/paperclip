import { describe, expect, it } from "vitest";
import {
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import {
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
