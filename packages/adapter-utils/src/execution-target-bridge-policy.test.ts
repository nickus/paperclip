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
    for (const target of [sshTarget, sandboxTarget]) {
      const parsed = parseAdapterExecutionTarget({
        ...target,
        paperclipApiBridgePolicy: "agent",
        paperclipApiBridgeCompanyId: "company-1",
      });
      expect(parsed).toMatchObject({ paperclipApiBridgePolicy: "agent", paperclipApiBridgeCompanyId: "company-1" });
      expect(adapterExecutionTargetPaperclipApiBridgePolicy(parsed)).toBe("agent");
    }
  });

  it("keeps the steward policy through a plain-object round trip", () => {
    for (const target of [sshTarget, sandboxTarget]) {
      const parsed = parseAdapterExecutionTarget({
        ...target,
        paperclipApiBridgePolicy: "steward",
        paperclipApiBridgeCompanyId: "company-1",
      });
      expect(parsed).toMatchObject({ paperclipApiBridgePolicy: "steward", paperclipApiBridgeCompanyId: "company-1" });
      expect(adapterExecutionTargetPaperclipApiBridgePolicy(parsed)).toBe("steward");
    }
  });

  it("fails closed to the restricted policy for any other value", () => {
    for (const value of [undefined, null, "restricted", "AGENT", "STEWARD", " steward", "open", 1]) {
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
