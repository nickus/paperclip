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

describe("execute — model-endpoint preflight", () => {
  let configHome: string;
  let commandPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  const GATEWAY_PROVIDERS = JSON.stringify({
    acme_gateway: { options: { baseURL: "http://gateway.example/v1", apiKey: "secret" } },
  });

  function baseCtx(overrides: Record<string, unknown> = {}) {
    return {
      runId: "preflight-run",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: configHome,
        model: "acme_gateway/some-model",
        env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
      },
      context: {},
      onLog: async () => {},
      ...overrides,
    } as never;
  }

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-preflight-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("PAPERCLIP_OPENCODE_PROVIDERS", GATEWAY_PROVIDERS);
    vi.stubEnv("PAPERCLIP_MODEL_ENDPOINT_PREFLIGHT", "");
    commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(
      probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "s-1", part: { text: "ok" } }) }),
    );
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it("unreachable: a network failure fails without spawning opencode", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await execute(baseCtx());

    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway.example/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.errorCode).toBe("model_endpoint_unreachable");
    expect(result.errorMessage).toMatch(/unreachable/i);
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("unreachable: a 5xx response fails without spawning opencode", async () => {
    fetchMock.mockResolvedValue({ status: 503 });

    const result = await execute(baseCtx());

    expect(result.errorCode).toBe("model_endpoint_unreachable");
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("reachable: a 2xx response spawns opencode as usual", async () => {
    fetchMock.mockResolvedValue({ status: 200 });

    const result = await execute(baseCtx());

    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("reachable: a 4xx response (e.g. auth) fails open and still spawns opencode", async () => {
    fetchMock.mockResolvedValue({ status: 401 });

    const result = await execute(baseCtx());

    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("no baseURL: an unresolvable provider skips the probe entirely and spawns opencode", async () => {
    vi.stubEnv("PAPERCLIP_OPENCODE_PROVIDERS", "");

    const result = await execute(baseCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("kill switch: PAPERCLIP_MODEL_ENDPOINT_PREFLIGHT=0 skips the probe even with a known, unreachable baseURL", async () => {
    vi.stubEnv("PAPERCLIP_MODEL_ENDPOINT_PREFLIGHT", "0");
    fetchMock.mockRejectedValue(new Error("should never be called"));

    const result = await execute(baseCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("unreachable: sets bootstrap execution-recovery evidence so the server can safely retry", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await execute(baseCtx());

    expect(result.errorCode).toBe("model_endpoint_unreachable");
    expect(result.resultJson).toMatchObject({
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
  });

  it("unresolved {env:VAR} placeholder: fails open instead of failing closed on a URL fetch cannot parse", async () => {
    // expandEnvPlaceholders (runtime-config.ts) deliberately leaves a
    // placeholder intact when the server-side env lacks the variable, for
    // OpenCode itself to resolve at spawn time. Passing that straight to
    // fetch() throws "Failed to parse URL", which must not fail the run.
    vi.stubEnv(
      "PAPERCLIP_OPENCODE_PROVIDERS",
      JSON.stringify({ acme_gateway: { options: { baseURL: "{env:GATEWAY_BASE_URL}" } } }),
    );

    const result = await execute(baseCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("credentialed baseURL: fails open and never sends or logs the credentials", async () => {
    // fetch() itself refuses to construct a request to a URL with userinfo
    // ("Request cannot be constructed from a URL that includes credentials"),
    // and the baseURL must never reach a log line or error message unredacted.
    const loggedLines: string[] = [];
    vi.stubEnv(
      "PAPERCLIP_OPENCODE_PROVIDERS",
      JSON.stringify({ acme_gateway: { options: { baseURL: "http://user:hunter2@gateway.example/v1" } } }),
    );

    const result = await execute(
      baseCtx({ onLog: async (_stream: string, chunk: string) => { loggedLines.push(chunk); } }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(loggedLines.join("")).not.toContain("hunter2");
  });

  it("non-http(s) baseURL: fails open instead of probing a protocol fetch cannot GET", async () => {
    vi.stubEnv(
      "PAPERCLIP_OPENCODE_PROVIDERS",
      JSON.stringify({ acme_gateway: { options: { baseURL: "ftp://gateway.example/v1" } } }),
    );

    const result = await execute(baseCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errorCode ?? null).toBeNull();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it("unreachable: logs and reports only the origin+pathname, never a query string", async () => {
    vi.stubEnv(
      "PAPERCLIP_OPENCODE_PROVIDERS",
      JSON.stringify({ acme_gateway: { options: { baseURL: "http://gateway.example/v1?token=abc123" } } }),
    );
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const loggedLines: string[] = [];

    const result = await execute(
      baseCtx({ onLog: async (_stream: string, chunk: string) => { loggedLines.push(chunk); } }),
    );

    expect(result.errorCode).toBe("model_endpoint_unreachable");
    expect(result.errorMessage).not.toContain("token=abc123");
    expect(loggedLines.join("")).not.toContain("token=abc123");
  });
});
