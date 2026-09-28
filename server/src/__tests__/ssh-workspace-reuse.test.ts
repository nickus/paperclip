import { describe, expect, it, vi } from "vitest";
import type {
  AdapterExecutionTarget,
  AdapterSshExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  claimSshWorkspaceReuseKey,
  cleanupSshRunScratch,
  deriveSshWorkspaceReuseKey,
  omitRemoteRunScratchEnv,
  prepareSshRunScratch,
  resolveSshWorkspaceReuse,
  sshWorkspaceReuseKeyHolder,
} from "../services/ssh-workspace-reuse.ts";
import { buildRunScratchEnvForDir } from "../services/run-scratch.ts";
import { isRemoteSessionWorkspaceCwd } from "../services/session-workspace-cwd.ts";

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

describe("ssh workspace reuse key", () => {
  it("is stable for one agent, task and host workspace, and differs otherwise", () => {
    const base = { agentId: "agent-1", taskKey: "issue-1", hostCwd: "/srv/workspaces/project" };
    const key = deriveSshWorkspaceReuseKey(base);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveSshWorkspaceReuseKey({ ...base })).toBe(key);
    expect(deriveSshWorkspaceReuseKey({ ...base, hostCwd: "/srv/workspaces/project/" })).toBe(key);
    expect(deriveSshWorkspaceReuseKey({ ...base, hostCwd: "/srv/workspaces/other/../project" })).toBe(key);
    expect(deriveSshWorkspaceReuseKey({ ...base, taskKey: "issue-2" })).not.toBe(key);
    expect(deriveSshWorkspaceReuseKey({ ...base, agentId: "agent-2" })).not.toBe(key);
    expect(deriveSshWorkspaceReuseKey({ ...base, hostCwd: "/srv/workspaces/other" })).not.toBe(key);
    // Field boundaries are part of the hash input.
    expect(deriveSshWorkspaceReuseKey({ agentId: "a", taskKey: "bc", hostCwd: "/x" })).not.toBe(
      deriveSshWorkspaceReuseKey({ agentId: "ab", taskKey: "c", hostCwd: "/x" }),
    );
  });

  it("marks only SSH targets of runs with a task and a host workspace", () => {
    const sandbox = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/workspace",
    } as AdapterExecutionTarget;
    const cases: Array<Parameters<typeof resolveSshWorkspaceReuse>[0]> = [
      { target: { kind: "local" }, agentId: "a", taskKey: "t", hostCwd: "/w", runId: "run-local" },
      { target: sandbox, agentId: "a", taskKey: "t", hostCwd: "/w", runId: "run-sandbox" },
      { target: null, agentId: "a", taskKey: "t", hostCwd: "/w", runId: "run-none" },
      { target: sshTarget(), agentId: "a", taskKey: null, hostCwd: "/w", runId: "run-no-task" },
      { target: sshTarget(), agentId: "a", taskKey: "t", hostCwd: "", runId: "run-no-cwd" },
      { target: sshTarget(), agentId: "a", taskKey: "t", hostCwd: "/w", runId: "../bad" },
    ];
    for (const input of cases) {
      const result = resolveSshWorkspaceReuse(input);
      expect(result.claim).toBeNull();
      expect(result.warning).toBeNull();
      expect(result.target).toBe(input.target ?? null);
      expect(result.target ?? {}).not.toHaveProperty("workspaceReuseKey");
    }
  });

  it("hands a key to one run at a time and frees it on release", () => {
    const input = { agentId: "agent-claim", taskKey: "task-claim", hostCwd: "/srv/w" };
    const first = resolveSshWorkspaceReuse({ ...input, target: sshTarget(), runId: "run-1" });
    const key = deriveSshWorkspaceReuseKey(input);
    expect(first.target).toMatchObject({ transport: "ssh", workspaceReuseKey: key });
    expect(first.claim?.key).toBe(key);
    expect(sshWorkspaceReuseKeyHolder(key)).toBe("run-1");

    // A concurrent run of the same agent and task falls back to its own directory.
    const second = resolveSshWorkspaceReuse({ ...input, target: sshTarget(), runId: "run-2" });
    expect(second.claim).toBeNull();
    expect(second.target).not.toHaveProperty("workspaceReuseKey");
    expect(second.warning).toContain("run-1");

    // The same run may claim again (a re-entered execution).
    expect(claimSshWorkspaceReuseKey({ key, runId: "run-1" }).claimed).toBe(true);

    first.claim!.release();
    expect(sshWorkspaceReuseKeyHolder(key)).toBeNull();
    const third = resolveSshWorkspaceReuse({ ...input, target: sshTarget(), runId: "run-3" });
    expect(third.target).toMatchObject({ workspaceReuseKey: key });
    // A second release of an old claim never frees a key another run holds.
    first.claim!.release();
    expect(sshWorkspaceReuseKeyHolder(key)).toBe("run-3");
    third.claim!.release();
    expect(sshWorkspaceReuseKeyHolder(key)).toBeNull();
  });

  it("frees the key when the run fails", async () => {
    const input = { agentId: "agent-throw", taskKey: "task-throw", hostCwd: "/srv/w" };
    const key = deriveSshWorkspaceReuseKey(input);
    const runWithClaim = async (runId: string, work: () => Promise<void>) => {
      const resolution = resolveSshWorkspaceReuse({ ...input, target: sshTarget(), runId });
      try {
        await work();
      } finally {
        resolution.claim?.release();
      }
    };
    await expect(
      runWithClaim("run-fail", async () => {
        expect(sshWorkspaceReuseKeyHolder(key)).toBe("run-fail");
        throw new Error("adapter failed");
      }),
    ).rejects.toThrow("adapter failed");
    expect(sshWorkspaceReuseKeyHolder(key)).toBeNull();
  });
});

describe("remote run scratch", () => {
  it("creates a private scratch directory under the run directory", async () => {
    const runCommand = vi.fn(async () => undefined);
    const target = sshTarget();
    const scratch = await prepareSshRunScratch({ target, runId: "run-1", runCommand });
    expect(scratch.dir).toBe("/home/agent/work/.paperclip-runtime/runs/run-1/scratch");
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [spec, script] = runCommand.mock.calls[0] as unknown as [unknown, string];
    expect(spec).toBe(target.spec);
    expect(script).toContain("umask 077");
    expect(script).toContain("mkdir -p '/home/agent/work/.paperclip-runtime/runs/run-1/scratch'");
    expect(script).toContain("chmod 700 '/home/agent/work/.paperclip-runtime/runs/run-1/scratch'");
    await expect(prepareSshRunScratch({ target, runId: "../escape", runCommand })).rejects.toThrow();
  });

  it("removes only the exact scratch directory of the run", async () => {
    const runCommand = vi.fn(async () => undefined);
    const scratch = await prepareSshRunScratch({ target: sshTarget(), runId: "run-1", runCommand });
    runCommand.mockClear();

    await expect(cleanupSshRunScratch({ scratch, runCommand })).resolves.toEqual({
      removed: true,
      dir: scratch.dir,
    });
    const [, script] = runCommand.mock.calls[0] as unknown as [unknown, string];
    expect(script).toContain("rm -rf -- '/home/agent/work/.paperclip-runtime/runs/run-1/scratch'");

    runCommand.mockClear();
    await expect(
      cleanupSshRunScratch({ scratch: { ...scratch, dir: "/home/agent" }, runCommand }),
    ).resolves.toEqual({ removed: false, dir: "/home/agent" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("points the scratch and temp env at the directory unless temp keys are configured", () => {
    expect(buildRunScratchEnvForDir({ TMPDIR: "/custom" }, "/remote/scratch")).toEqual({
      env: {
        PAPERCLIP_RUN_SCRATCH_DIR: "/remote/scratch",
        PAPERCLIP_TASK_SCRATCH_DIR: "/remote/scratch",
        PAPERCLIP_SCRATCH_DIR: "/remote/scratch",
        PAPERCLIP_TMPDIR: "/remote/scratch",
        TEMP: "/remote/scratch",
        TMP: "/remote/scratch",
      },
      tempKeysApplied: ["TEMP", "TMP"],
    });
  });

  it("keeps remote scratch paths away from processes that run on this host", () => {
    const env = {
      PAPERCLIP_SCRATCH_DIR: "/remote/scratch",
      TMPDIR: "/remote/scratch",
      TMP: "/custom",
      OTHER: "value",
    };
    expect(omitRemoteRunScratchEnv(env, { dir: "/remote/scratch" })).toEqual({ TMP: "/custom", OTHER: "value" });
    expect(omitRemoteRunScratchEnv(env, null)).toBe(env);
  });
});

describe("remote session workspace cwd", () => {
  it("recognizes a saved cwd that is the remote working directory", () => {
    const remoteCwd = "/home/agent/work/.paperclip-runtime/workspaces/k/workspace";
    expect(
      isRemoteSessionWorkspaceCwd({
        sessionId: "s",
        cwd: remoteCwd,
        remoteExecution: { transport: "ssh", host: "h", port: 22, username: "u", remoteCwd },
      }),
    ).toBe(true);
    expect(
      isRemoteSessionWorkspaceCwd({
        cwd: "/workspace",
        remoteExecution: { transport: "sandbox", remoteCwd: "/workspace" },
      }),
    ).toBe(true);
    // A remote session that saved the host cwd (as Claude does) keeps it.
    expect(
      isRemoteSessionWorkspaceCwd({
        cwd: "/srv/host/workspace",
        remoteExecution: { transport: "ssh", remoteCwd },
      }),
    ).toBe(false);
    expect(isRemoteSessionWorkspaceCwd({ cwd: remoteCwd })).toBe(false);
    expect(isRemoteSessionWorkspaceCwd({ cwd: remoteCwd, remoteExecution: { transport: "local", remoteCwd } }))
      .toBe(false);
    expect(isRemoteSessionWorkspaceCwd(null)).toBe(false);
  });
});
