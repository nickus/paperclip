import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "Continue your Paperclip conversation");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
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
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "paperclip");
      expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes an OpenRouter key and complete model to OpenCode without logging the key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-openrouter",
        part: { text: "done" },
      }),
    }));
    const logs: string[] = [];
    const metadata: unknown[] = [];

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
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
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.model).toBe(model);
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode runtime MCP servers", () => {
  const gatewayToken = "gateway-bearer-secret";
  const runtimeMcpServer = {
    name: "paperclip-assigned",
    url: "https://paperclip.example.test/mcp/gateways/gw_1",
    token: gatewayToken,
    connectionId: "assignment:0123456789abcdef",
  };
  const runtimeMcpIdentity = JSON.stringify([
    { name: runtimeMcpServer.name, url: runtimeMcpServer.url, connectionId: runtimeMcpServer.connectionId },
  ]);
  let root: string;
  let workspace: string;
  let commandPath: string;
  let seenConfig: { path: string; mode: number; contents: Record<string, unknown> } | null;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-runtime-mcp-"));
    workspace = path.join(root, "workspace");
    commandPath = path.join(root, "opencode");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(root, "xdg", "opencode"), { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
    seenConfig = null;
    runProcessMock.mockReset();
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      // The runtime config only exists while OpenCode runs; capture it here.
      const configHome = (options as { env: Record<string, string> }).env.XDG_CONFIG_HOME;
      const configPath = path.join(configHome, "opencode", "opencode.json");
      const stat = await fs.stat(configPath).catch(() => null);
      if (stat) {
        seenConfig = {
          path: configPath,
          mode: stat.mode & 0o777,
          contents: JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>,
        };
      }
      return probeResult({
        stdout: JSON.stringify({ type: "text", sessionID: "session-new", part: { text: "done" } }),
      });
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function runWith(input: {
    servers?: Array<typeof runtimeMcpServer>;
    sessionParams?: Record<string, unknown> | null;
    config?: Record<string, unknown>;
    logs?: string[];
    metadata?: unknown[];
  }) {
    return execute({
      runId: "run-runtime-mcp",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: {
        sessionId: null,
        sessionParams: input.sessionParams ?? null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: commandPath,
        cwd: workspace,
        model: "openai/gpt-5",
        env: { HOME: path.join(root, "home"), OPENCODE_ALLOW_ALL_MODELS: "1" },
        promptTemplate: "Run the task.",
        ...input.config,
      },
      context: {},
      ...(input.servers
        ? { runtimeMcp: { getServers: () => input.servers!.map((server) => ({ ...server })) } }
        : {}),
      onLog: async (_stream, chunk) => {
        input.logs?.push(chunk);
      },
      onMeta: async (meta) => {
        input.metadata?.push(meta);
      },
    });
  }

  it("adds the run's Paperclip-managed MCP servers to OpenCode as remote MCP servers", async () => {
    const logs: string[] = [];
    const metadata: unknown[] = [];
    const result = await runWith({ servers: [runtimeMcpServer], logs, metadata });

    expect(result.exitCode).toBe(0);
    expect(seenConfig?.contents.mcp).toEqual({
      "paperclip-assigned": {
        type: "remote",
        url: runtimeMcpServer.url,
        headers: { Authorization: `Bearer ${gatewayToken}` },
        oauth: false,
        enabled: true,
        timeout: 330_000,
      },
    });
    // Owner-only, and gone once the run ends.
    expect(seenConfig?.mode).toBe(0o600);
    await expect(fs.access(seenConfig!.path)).rejects.toThrow();
    // The token lives only in that file: never in argv, env, logs or run metadata.
    const executionCall = runProcessMock.mock.calls.at(-1)!;
    expect(JSON.stringify(executionCall[3])).not.toContain(gatewayToken);
    expect(JSON.stringify((executionCall[4] as { env: Record<string, string> }).env)).not.toContain(gatewayToken);
    expect(JSON.stringify({ logs, metadata, result })).not.toContain(gatewayToken);
    expect(JSON.stringify(metadata)).toContain("Paperclip-managed MCP server");
    expect(result.sessionParams).toMatchObject({
      sessionId: "session-new",
      mcpServerIdentity: runtimeMcpIdentity,
    });
  });

  it("adds the managed MCP servers when OpenCode keeps its own permission prompts", async () => {
    await fs.writeFile(
      path.join(root, "xdg", "opencode", "opencode.json"),
      JSON.stringify({ permission: { bash: "ask" } }),
    );
    const result = await runWith({ servers: [runtimeMcpServer], config: { dangerouslySkipPermissions: false } });

    expect(result.exitCode).toBe(0);
    expect(seenConfig?.contents.permission).toEqual({ bash: "ask" });
    expect(Object.keys(seenConfig?.contents.mcp as Record<string, unknown>)).toEqual(["paperclip-assigned"]);
  });

  it("does not resume a session saved with a different MCP server set", async () => {
    const logs: string[] = [];
    const result = await runWith({
      servers: [runtimeMcpServer],
      sessionParams: {
        sessionId: "session-old",
        cwd: workspace,
        mcpServerIdentity: JSON.stringify([{ name: "other", url: "https://other.example.test/mcp", connectionId: "c2" }]),
      },
      logs,
    });

    expect(runProcessMock.mock.calls.at(-1)![3]).not.toContain("--session");
    expect(logs.join("")).toContain("was saved with a different runtime MCP server set");
    expect(result.sessionId).toBe("session-new");
  });

  it("does not resume a session saved before the run had managed MCP servers", async () => {
    await runWith({ servers: [runtimeMcpServer], sessionParams: { sessionId: "session-old", cwd: workspace } });
    expect(runProcessMock.mock.calls.at(-1)![3]).not.toContain("--session");
  });

  it("does not keep a skipped session when OpenCode reports no session id", async () => {
    runProcessMock.mockImplementation(async () => probeResult({ stdout: "" }));
    const result = await runWith({
      servers: [runtimeMcpServer],
      sessionParams: { sessionId: "session-old", cwd: workspace },
    });
    expect(result.sessionId).toBeNull();
    expect(result.sessionParams).toBeNull();
  });

  it("resumes a session saved with the same MCP server set", async () => {
    await runWith({
      servers: [runtimeMcpServer],
      sessionParams: { sessionId: "session-old", cwd: workspace, mcpServerIdentity: runtimeMcpIdentity },
    });
    const args = runProcessMock.mock.calls.at(-1)![3] as string[];
    expect(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2)).toEqual(["--session", "session-old"]);
  });

  it("leaves runs without managed MCP servers as they were", async () => {
    await fs.writeFile(
      path.join(root, "xdg", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { local: { type: "local", command: ["local-mcp"] } } }),
    );
    const result = await runWith({ sessionParams: { sessionId: "session-old", cwd: workspace } });

    expect(seenConfig?.contents.mcp).toEqual({ local: { type: "local", command: ["local-mcp"] } });
    const args = runProcessMock.mock.calls.at(-1)![3] as string[];
    expect(args).toContain("--session");
    expect(result.sessionParams).not.toHaveProperty("mcpServerIdentity");
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});
