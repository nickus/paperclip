import { describe, expect, it } from "vitest";
import {
  adapterExecutionTargetPaperclipApiBridgePolicy,
  parseAdapterExecutionTarget,
} from "./execution-target.js";

describe("Paperclip API bridge policy on execution targets", () => {
  const sshTarget = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: "/srv/work",
    spec: {
      host: "ssh.example.test",
      port: 22,
      username: "runner",
      remoteWorkspacePath: "/srv/work",
      remoteCwd: "/srv/work",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  };
  const sandboxTarget = { kind: "remote", transport: "sandbox", providerKey: "fake-plugin", remoteCwd: "/workspace" };

  it("keeps the policy and company through a plain-object round trip", () => {
    for (const policy of ["agent", "agent-with-instruction-writes"] as const) {
      for (const target of [sshTarget, sandboxTarget]) {
        const parsed = parseAdapterExecutionTarget({
          ...target,
          paperclipApiBridgePolicy: policy,
          paperclipApiBridgeCompanyId: "company-1",
        });
        expect(parsed).toMatchObject({ paperclipApiBridgePolicy: policy, paperclipApiBridgeCompanyId: "company-1" });
        expect(adapterExecutionTargetPaperclipApiBridgePolicy(parsed)).toBe(policy);
      }
    }
  });

  it("fails closed to the restricted policy for any other value", () => {
    for (const value of [
      undefined,
      null,
      "restricted",
      "AGENT",
      "open",
      1,
      "Agent-With-Instruction-Writes",
      " agent-with-instruction-writes",
    ]) {
      for (const target of [sshTarget, sandboxTarget]) {
        const parsed = parseAdapterExecutionTarget({ ...target, paperclipApiBridgePolicy: value });
        expect(parsed).not.toBeNull();
        expect(adapterExecutionTargetPaperclipApiBridgePolicy(parsed)).toBe("restricted");
      }
    }
    expect(adapterExecutionTargetPaperclipApiBridgePolicy({ kind: "local" })).toBe("restricted");
    expect(adapterExecutionTargetPaperclipApiBridgePolicy(null)).toBe("restricted");
  });
});
