import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "opencode/gpt-5-nano\nopenai/gpt-4.1\n",
        stderr: "",
        pid: 122,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "session_123" }),
        JSON.stringify({ type: "text", sessionID: "session_123", part: { text: "hello" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session_123",
          part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    };
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: opencode"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "/home/agent",
    stderr: "",
    exitCode: 0,
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string; remoteDir: string }): Promise<void> => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

describe("opencode remote execution", () => {
  const cleanupDirs: string[] = [];
  const originalOpenCodeAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;

  beforeEach(async () => {
    const configHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    cleanupDirs.push(configHome);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    syncDirectoryToSsh.mockImplementation(async () => undefined);
    vi.unstubAllEnvs();
    if (originalOpenCodeAllowAllModels === undefined) {
      delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    } else {
      process.env.OPENCODE_ALLOW_ALL_MODELS = originalOpenCodeAllowAllModels;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each([false, true])("prepares the workspace, syncs OpenCode skills, and restores workspace changes for remote SSH execution (managed=%s)", async (managed) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Builder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "opencode",
        model: "opencode/gpt-5-nano",
        ...(managed ? {
          managedAiConnection: { provider: "openrouter", method: "api_key" },
        } : {}),
        env: {
          XDG_CONFIG_HOME: path.join(rootDir, "config"),
          ...(managed ? { HOME: "/var/folders/qa-managed", XDG_DATA_HOME: "/var/folders/qa-managed/data" } : {}),
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session_123",
      cwd: managedRemoteWorkspace,
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: managedRemoteWorkspace,
      },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(2);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/opencode/xdgConfig`,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/opencode/skills`,
      followSymlinks: true,
    }));
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".claude/skills"),
      expect.anything(),
    );
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    const modelProbeCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("models")) as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(modelProbeCall?.[2]).toEqual(["models"]);
    // The model probe runs after the runtime workspace is prepared (so XDG
    // points at the managed subdirectory) but the SSH session targets the
    // original target remoteCwd — the per-run subdirectory is layered
    // underneath via XDG/runtime config rather than by switching the cwd.
    expect(modelProbeCall?.[3].env.XDG_CONFIG_HOME).toBe(
      `${managedRemoteWorkspace}/.paperclip-runtime/opencode/xdgConfig`,
    );
    expect(modelProbeCall?.[3].remoteExecution?.remoteCwd).toBe("/remote/workspace");
    const call = runCall as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    if (managed) {
      const home = `${managedRemoteWorkspace}/.paperclip-runtime/opencode/managed-auth/run-1`;
      expect(call?.[3].env.HOME).toBe(home);
      expect(call?.[3].env.XDG_DATA_HOME).toBe(`${home}/data`);
      expect(modelProbeCall?.[3].env.XDG_DATA_HOME).toBe(`${home}/data`);
      expect(runSshCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(`${home}/.claude/skills`),
        expect.anything(),
      );
    }
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.XDG_CONFIG_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/opencode/xdgConfig`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("fails before the remote run when the configured model is unavailable on the SSH target", async () => {
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "openai/gpt-4.1\n",
      stderr: "",
      pid: 456,
      startedAt: new Date().toISOString(),
    }));

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-model-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await expect(() =>
      execute({
        runId: "run-ssh-model-missing",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Builder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "opencode",
          model: "opencode/gpt-5-nano",
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
        onLog: async () => {},
      }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect((runChildProcess.mock.calls[0]?.[2] as string[] | undefined) ?? []).toEqual(["models"]);
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
  });

  it("resumes saved OpenCode sessions for remote SSH execution only when the identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Builder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "opencode",
        model: "opencode/gpt-5-nano",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    const call = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[]]
      | undefined;
    expect(call?.[2]).toContain("--session");
    expect(call?.[2]).toContain("session-123");
  });

  it("resumes the session of an earlier run of the same task from the stable SSH workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-stable-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const key = "0123456789abcdef0123456789abcdef";
    const stableWorkspace = `/remote/workspace/.paperclip-runtime/workspaces/${key}/workspace`;
    const target = (leaseId: string): AdapterSshExecutionTarget => ({
      kind: "remote",
      transport: "ssh",
      environmentId: "env-1",
      leaseId,
      remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/remote/workspace",
        remoteCwd: "/remote/workspace",
        privateKey: "PRIVATE KEY",
        knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
      workspaceReuseKey: key,
    });
    const logs: string[] = [];
    const base = {
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Builder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      config: { command: "opencode", model: "opencode/gpt-5-nano" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
        logs.push(chunk);
      },
    };

    const first = await execute({
      ...base,
      runId: "run-1",
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-1" },
      executionTarget: target("lease-1"),
    });
    expect(first.sessionParams).toEqual({
      sessionId: "session_123",
      cwd: stableWorkspace,
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: stableWorkspace,
      },
    });
    // The host stores the session through the codec, as a JSON column.
    const saved = sessionCodec.deserialize(JSON.parse(JSON.stringify(sessionCodec.serialize(first.sessionParams ?? null))));
    runChildProcess.mockClear();
    syncDirectoryToSsh.mockClear();

    await execute({
      ...base,
      runId: "run-2",
      runtime: { sessionId: "session_123", sessionParams: saved, sessionDisplayId: "session_123", taskKey: "task-1" },
      executionTarget: target("lease-2"),
    });

    const call = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[], { remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toContain("--session");
    expect(call?.[2]).toContain("session_123");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(stableWorkspace);
    expect(logs.join("")).not.toContain("will not be resumed");
    // Runtime files of run 2 stay private to run 2.
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/remote/workspace/.paperclip-runtime/runs/run-2/opencode/skills",
    }));
  });

  it("ships the run's managed MCP servers to the SSH target and resumes only with the same set", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-mcp-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const key = "0123456789abcdef0123456789abcdef";
    const gatewayToken = "remote-gateway-secret";
    const assigned = {
      name: "paperclip-assigned",
      url: "https://paperclip.example.test/mcp/gateways/gw_1",
      token: gatewayToken,
      connectionId: "assignment:0123456789abcdef",
    };
    const shipped: Array<{ mode: number; contents: Record<string, unknown> }> = [];
    // Restored by the afterEach hook; the asset only exists until the run ends.
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string; remoteDir: string }) => {
      if (!input.remoteDir.endsWith("/xdgConfig")) return;
      const configPath = path.join(input.localDir, "opencode", "opencode.json");
      shipped.push({
        mode: (await stat(configPath)).mode & 0o777,
        contents: JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>,
      });
    });
    const target: AdapterSshExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/remote/workspace",
        remoteCwd: "/remote/workspace",
        privateKey: "PRIVATE KEY",
        knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
      workspaceReuseKey: key,
    };
    const logs: string[] = [];
    const run = (runId: string, servers: Array<typeof assigned>, sessionParams: Record<string, unknown> | null) =>
      execute({
        runId,
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Builder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: (sessionParams?.sessionId as string | undefined) ?? null,
          sessionParams,
          sessionDisplayId: null,
          taskKey: "task-1",
        },
        // Permission prompts stay on: the managed servers still need the runtime config.
        config: { command: "opencode", model: "opencode/gpt-5-nano", dangerouslySkipPermissions: false },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        executionTarget: target,
        runtimeMcp: { getServers: () => servers.map((server) => ({ ...server })) },
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
      });

    const first = await run("run-1", [assigned], null);

    expect(shipped).toHaveLength(1);
    expect(shipped[0]?.mode).toBe(0o600);
    expect(shipped[0]?.contents.mcp).toEqual({
      "paperclip-assigned": {
        type: "remote",
        url: assigned.url,
        headers: { Authorization: `Bearer ${gatewayToken}` },
        oauth: false,
        enabled: true,
        timeout: 330_000,
      },
    });
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(runCall?.[3].env.XDG_CONFIG_HOME).toBe("/remote/workspace/.paperclip-runtime/runs/run-1/opencode/xdgConfig");
    expect(JSON.stringify(runCall?.[2])).not.toContain(gatewayToken);
    expect(JSON.stringify(runCall?.[3].env)).not.toContain(gatewayToken);
    expect(logs.join("")).not.toContain(gatewayToken);

    // The host stores the session through the codec, as a JSON column.
    const saved = sessionCodec.deserialize(JSON.parse(JSON.stringify(sessionCodec.serialize(first.sessionParams ?? null))));
    expect(saved).toMatchObject({ sessionId: "session_123", mcpServerIdentity: expect.any(String) });

    runChildProcess.mockClear();
    await run("run-2", [assigned], saved);
    const resumed = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run"));
    expect(resumed?.[2]).toContain("--session");

    runChildProcess.mockClear();
    await run("run-3", [{ ...assigned, url: "https://paperclip.example.test/mcp/gateways/gw_2" }], saved);
    const fresh = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run"));
    expect(fresh?.[2]).not.toContain("--session");
    expect(logs.join("")).toContain("was saved with a different runtime MCP server set");
  });
});
