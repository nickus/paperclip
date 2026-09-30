import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as serverUtils from "./server-utils.js";
import {
  adapterExecutionTargetReusesSandbox,
  cleanupGitHubOperationLaunchers,
  prepareGitHubOperationLaunchers,
  adapterExecutionTargetUsesManagedHome,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  writeAdapterExecutionTargetTextFile,
} from "./execution-target.js";

describe("runAdapterExecutionTargetShellCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("quotes remote shell commands with the shared SSH quoting helper", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await runAdapterExecutionTargetShellCommand(
      "run-1",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      `printf '%s\\n' "$HOME" && echo "it's ok"`,
      {
        cwd: "/tmp/local",
        env: {},
      },
    );

    // runSshCommand owns profile sourcing and the outer shell wrapper —
    // the caller passes the raw command string. Wrapping it here would
    // double-nest the login shell and re-source profiles after the explicit
    // env override, silently undoing identity-var preservation.
    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "ssh.example.test",
        username: "ssh-user",
      }),
      `printf '%s\\n' "$HOME" && echo "it's ok"`,
      expect.any(Object),
    );
  });

  it("sanitizes inherited host env before SSH shell execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await runAdapterExecutionTargetShellCommand(
      "run-1b",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "env",
      {
        cwd: "/tmp/local",
        env: {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          SAFE_VALUE: "visible",
        },
      },
    );

    expect(runSshCommandSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({
        env: {
          SAFE_VALUE: "visible",
        },
      }),
    );
  });

  it("returns a timedOut result when the SSH shell command times out", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
      stdout: "partial stdout",
      stderr: "partial stderr",
      signal: "SIGTERM",
    }));
    const onLog = vi.fn(async () => {});

    const result = await runAdapterExecutionTargetShellCommand(
      "run-2",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "sleep 10",
      {
        cwd: "/tmp/local",
        env: {},
        onLog,
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
    expect(onLog).toHaveBeenCalledWith("stdout", "partial stdout");
    expect(onLog).toHaveBeenCalledWith("stderr", "partial stderr");
  });

  it("returns the SSH process exit code for non-zero remote command failures", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(Object.assign(new Error("non-zero exit"), {
      code: 17,
      stdout: "partial stdout",
      stderr: "partial stderr",
      signal: null,
    }));
    const onLog = vi.fn(async () => {});

    const result = await runAdapterExecutionTargetShellCommand(
      "run-3",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "false",
      {
        cwd: "/tmp/local",
        env: {},
        onLog,
      },
    );

    expect(result).toMatchObject({
      exitCode: 17,
      signal: null,
      timedOut: false,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
    expect(onLog).toHaveBeenCalledWith("stdout", "partial stdout");
    expect(onLog).toHaveBeenCalledWith("stderr", "partial stderr");
  });

  it("keeps managed homes disabled for both local and SSH targets", () => {
    expect(adapterExecutionTargetUsesManagedHome(null)).toBe(false);
    expect(adapterExecutionTargetUsesManagedHome({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip/workspace",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/workspace",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    })).toBe(false);
  });
});

describe("runAdapterExecutionTargetProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sanitizes inherited host env before SSH process execution", async () => {
    vi.stubEnv("PATH", "/host/bin:/usr/bin");
    vi.stubEnv("HOME", "/Users/local");

    const runChildProcessSpy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    await runAdapterExecutionTargetProcess(
      "run-ssh-process",
      {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      "agent-cli",
      ["--json"],
      {
        cwd: "/tmp/local",
        env: {
          PATH: "/host/bin:/usr/bin",
          HOME: "/Users/local",
          SAFE_VALUE: "visible",
        },
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
      },
    );

    expect(runChildProcessSpy).toHaveBeenCalledWith(
      "run-ssh-process",
      "agent-cli",
      ["--json"],
      expect.objectContaining({
        env: {
          SAFE_VALUE: "visible",
        },
      }),
    );
  });
});

describe("ensureAdapterExecutionTargetRuntimeCommandInstalled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs install commands for sandbox targets", async () => {
    const runner = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      })),
    };

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-install",
      target: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "e2b",
        remoteCwd: "/remote/workspace",
        runner,
      },
      installCommand: "npm install -g @google/gemini-cli",
      cwd: "/local/workspace",
      env: { PATH: "/usr/bin" },
      timeoutSec: 30,
    });

    expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh",
      args: ["-c", "npm install -g @google/gemini-cli"],
      cwd: "/remote/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 30_000,
    }));
  });

  it("skips install commands for SSH targets", async () => {
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
    });

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-skip",
      target: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/srv/paperclip/workspace",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
      installCommand: "npm install -g @google/gemini-cli",
      cwd: "/tmp/local",
      env: {},
    });

    expect(runSshCommandSpy).not.toHaveBeenCalled();
  });
});

describe("resolveAdapterExecutionTargetCwd", () => {
  const sshTarget = {
    kind: "remote" as const,
    transport: "ssh" as const,
    remoteCwd: "/srv/paperclip/workspace",
    spec: {
      host: "ssh.example.test",
      port: 22,
      username: "ssh-user",
      remoteCwd: "/srv/paperclip/workspace",
      remoteWorkspacePath: "/srv/paperclip/workspace",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  };

  it("falls back to the remote cwd when no adapter cwd is configured", () => {
    expect(resolveAdapterExecutionTargetCwd(sshTarget, "", "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
    expect(resolveAdapterExecutionTargetCwd(sshTarget, "   ", "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
    expect(resolveAdapterExecutionTargetCwd(sshTarget, null, "/Users/host/repo/server")).toBe(
      "/srv/paperclip/workspace",
    );
  });

  it("preserves an explicit adapter cwd when one is configured", () => {
    expect(
      resolveAdapterExecutionTargetCwd(
        sshTarget,
        "/srv/paperclip/custom-agent-dir",
        "/Users/host/repo/server",
      ),
    ).toBe("/srv/paperclip/custom-agent-dir");
  });

  it("keeps the local fallback cwd for local targets", () => {
    expect(resolveAdapterExecutionTargetCwd(null, "", "/Users/host/repo/server")).toBe(
      "/Users/host/repo/server",
    );
  });
});


describe("GitHub launcher lifecycle", () => {
  it("removes only the completed run's launchers and leaves concurrent runs usable", async () => {
    const first = { runId: randomUUID(), target: null };
    const second = { runId: randomUUID(), target: null };
    try {
      const a = await prepareGitHubOperationLaunchers({ ...first, cwd: "/tmp", env: {} });
      const b = await prepareGitHubOperationLaunchers({ ...second, cwd: "/tmp", env: {} });
      await cleanupGitHubOperationLaunchers(first);
      await expect(access(a.PAPERCLIP_GITHUB_LAUNCHER_DIR)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(`${b.PAPERCLIP_GITHUB_LAUNCHER_DIR}/git`, "utf8")).toContain("PAPERCLIP_GITHUB_BROKER_URL");
      await cleanupGitHubOperationLaunchers(first); // teardown replay is harmless
    } finally {
      await cleanupGitHubOperationLaunchers(first);
      await cleanupGitHubOperationLaunchers(second);
    }
  });

  it("bounds remote cleanup to one run and rejects traversal", async () => {
    const runner = { execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false,
      stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() })) };
    const target = { kind: "remote" as const, transport: "sandbox" as const,
      providerKey: "e2b", remoteCwd: "/remote/workspace", runner };
    await cleanupGitHubOperationLaunchers({ runId: "finished-run", target });
    expect(runner.execute).toHaveBeenCalledWith({ command: "sh",
      args: ["-c", "rm -rf -- '/remote/workspace/.paperclip-runtime/github/finished-run'"],
      cwd: "/remote/workspace", timeoutMs: 5_000 });
    await expect(cleanupGitHubOperationLaunchers({ runId: "../other", target })).rejects.toThrow("Invalid GitHub launcher run ID");
    expect(runner.execute).toHaveBeenCalledTimes(1);
  });
});

describe("adapterExecutionTargetReusesSandbox", () => {
  const sandbox = {
    kind: "remote" as const,
    transport: "sandbox" as const,
    remoteCwd: "/workspace",
  };
  const capabilities = (reusableLeases: boolean) => ({
    reusableLeases,
    nativeSyncIn: true,
    nativeSyncOut: true,
    persistentProcessSessions: false,
    independentControlCommands: false,
    incrementalSessionOutput: false,
    concurrentSyncOperations: false,
    duplexCommandStream: false,
    runnerWebSocketIngress: false,
  });

  it("follows the host's capability snapshot for this lease", () => {
    expect(adapterExecutionTargetReusesSandbox({ ...sandbox, effectiveCapabilities: capabilities(true) })).toBe(true);
    // An ephemeral lease in an environment with reuse on is not kept.
    expect(
      adapterExecutionTargetReusesSandbox({
        ...sandbox,
        reusableLeaseConfigured: true,
        effectiveCapabilities: capabilities(false),
      }),
    ).toBe(false);
  });

  it("falls back to the environment setting without a snapshot, and is false off sandboxes", () => {
    expect(adapterExecutionTargetReusesSandbox({ ...sandbox, reusableLeaseConfigured: true })).toBe(true);
    expect(adapterExecutionTargetReusesSandbox(sandbox)).toBe(false);
    expect(adapterExecutionTargetReusesSandbox({ kind: "local" })).toBe(false);
    expect(adapterExecutionTargetReusesSandbox(null)).toBe(false);
  });
});

describe("writeAdapterExecutionTargetTextFile", () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      await rm(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  // Runs a target shell script on this machine with the given stdin.
  function runScript(script: string, stdin: string) {
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = execFile("/bin/sh", ["-c", script], (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: error ? Number((error as { code?: number }).code ?? 1) : 0 });
      });
      child.stdin?.end(stdin);
    });
  }

  const contents = JSON.stringify({ mcpServers: { a: { headers: { Authorization: "Bearer secret-canary" } } } });
  const sshSpec = {
    host: "ssh.example.test",
    port: 22,
    username: "ssh-user",
    remoteCwd: "/srv/paperclip/workspace",
    remoteWorkspacePath: "/srv/paperclip/workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  };

  it("writes an owner-only file on a local target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-write-target-file-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "nested", "config.json");
    await writeAdapterExecutionTargetTextFile("run-1", { kind: "local" }, filePath, contents);
    expect(await readFile(filePath, "utf8")).toBe(contents);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("sends the contents over stdin on an SSH target, never on the command line", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-write-target-file-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "mcp", "config.json");
    const runSshCommandSpy = vi.spyOn(ssh, "runSshCommand").mockImplementation(async (_spec, script, options) => {
      const result = await runScript(script, options?.stdin ?? "");
      if (result.code !== 0) throw Object.assign(new Error("remote command failed"), result);
      return { stdout: result.stdout, stderr: result.stderr };
    });
    await writeAdapterExecutionTargetTextFile(
      "run-1",
      { kind: "remote", transport: "ssh", remoteCwd: sshSpec.remoteCwd, spec: sshSpec },
      filePath,
      contents,
    );
    expect(await readFile(filePath, "utf8")).toBe(contents);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(runSshCommandSpy).toHaveBeenCalledTimes(1);
    const [, script, options] = runSshCommandSpy.mock.calls[0]!;
    expect(script).not.toContain("secret-canary");
    expect(options?.env).toBeUndefined();
    expect(options?.stdin).toBe(contents);
  });

  it("reports a failed SSH write with the target's error output", async () => {
    vi.spyOn(ssh, "runSshCommand").mockRejectedValue(
      Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "mkdir: permission denied" }),
    );
    await expect(writeAdapterExecutionTargetTextFile(
      "run-1",
      { kind: "remote", transport: "ssh", remoteCwd: sshSpec.remoteCwd, spec: sshSpec },
      "/srv/paperclip/workspace/config.json",
      contents,
    )).rejects.toThrow('Could not write "/srv/paperclip/workspace/config.json" on the execution target: mkdir: permission denied');
  });

  it("sends the contents over stdin on a sandbox target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-write-target-file-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "mcp", "config.json");
    const calls: Array<{ args?: string[]; env?: Record<string, string>; stdin?: string; bypassSession?: boolean }> = [];
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        stdin?: string;
        bypassSession?: boolean;
      }) => {
        calls.push(input);
        const result = await runScript(input.args?.[1] ?? "", input.stdin ?? "");
        return {
          exitCode: result.code,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt: new Date().toISOString(),
        };
      },
    };
    await writeAdapterExecutionTargetTextFile(
      "run-1",
      { kind: "remote", transport: "sandbox", remoteCwd: dir, runner },
      filePath,
      contents,
    );
    expect(await readFile(filePath, "utf8")).toBe(contents);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(calls[0]?.args)).not.toContain("secret-canary");
    expect(calls[0]?.env).toBeUndefined();
    expect(calls[0]?.stdin).toBe(contents);
    expect(calls[0]?.bypassSession).toBe(true);
  });
});
