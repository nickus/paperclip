import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, type TestContext } from "vitest";
import {
  buildSshSpawnTarget,
  buildSshEnvLabFixtureConfig,
  createSshCommandManagedRuntimeRunner,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  readSshEnvLabFixtureStatus,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareAdapterExecutionTargetRuntime, type AdapterSshExecutionTarget } from "./execution-target.js";
import { runChildProcess } from "./server-utils.js";

const SSH_FIXTURE_TEST_TIMEOUT_MS = 30_000;
let sshEnvLabUnsupportedReason: string | null = null;

// One entry per fixture root directory, registered at creation time so
// teardown survives a setup call that throws before the fixture starts, an
// assertion failure, or an early return on skip. `state` stays null until
// the fixture actually starts; a caller that stops the fixture itself still
// leaves the entry in the stack, so the drain below must be idempotent
// (stopSshEnvLabFixture is).
interface FixtureTeardownEntry {
  rootDir: string;
  state: SshEnvLabFixtureState | null;
}

const fixtureTeardowns: FixtureTeardownEntry[] = [];

// Creates the fixture root directory and registers its teardown entry in
// the same step, so a setup call that throws between here and the fixture
// start (mkdir, writeFile, git init) still leaves the root directory queued
// for removal.
async function createFixtureRootDir(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
  fixtureTeardowns.push({ rootDir, state: null });
  return rootDir;
}

async function drainFixtureTeardowns(): Promise<void> {
  while (fixtureTeardowns.length > 0) {
    const entry = fixtureTeardowns.pop();
    if (!entry) continue;
    if (entry.state) {
      try {
        await stopSshEnvLabFixture(entry.state);
      } catch (error) {
        // stopSshEnvLabFixture throws only when the listener survives
        // SIGKILL, and it deliberately keeps the root directory so a later
        // stop call can still find and signal it through the state file.
        // Report the failure but keep the root directory; do not remove it,
        // and do not rethrow, so a throw here cannot strand the entries
        // still left on the stack.
        console.error(
          `SSH env-lab fixture teardown failed for pid ${entry.state.pid} on port ${entry.state.port}:`,
          error,
        );
        continue;
      }
    }
    await rm(entry.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Finds the pid of a running sshd process by its config file path, the same
// way isSshEnvLabFixtureProcess identifies a fixture internally. Used by the
// readiness-failure regression test, which needs the pid of a fixture that
// startSshEnvLabFixture never returns because it throws before returning it.
async function findSshdPidByConfigPath(sshdConfigPath: string): Promise<number | null> {
  const stdout = await new Promise<string>((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], (error, out) => resolve(error ? "" : out));
  });
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex === -1) continue;
    const pid = Number.parseInt(trimmed.slice(0, spaceIndex), 10);
    const args = trimmed.slice(spaceIndex + 1);
    if (Number.isFinite(pid) && args.includes(sshdConfigPath)) {
      return pid;
    }
  }
  return null;
}

// Without a test context an unsupported environment makes the helper return
// null and the caller returns early, so the test counts as passed. Tests whose
// assertions are the only proof of a guarantee (the secret scans below) pass
// their context instead and are then reported as skipped.
async function startSshEnvLabFixtureOrSkip(
  statePath: string,
  label: string,
  test: Pick<TestContext, "skip">,
): Promise<SshEnvLabFixtureState>;
async function startSshEnvLabFixtureOrSkip(
  statePath: string,
  label: string,
): Promise<SshEnvLabFixtureState | null>;
async function startSshEnvLabFixtureOrSkip(
  statePath: string,
  label: string,
  test?: Pick<TestContext, "skip">,
): Promise<SshEnvLabFixtureState | null> {
  // The teardown entry for this root directory must already exist: callers
  // create it with createFixtureRootDir() before they derive statePath, so
  // this only attaches the state to that entry instead of pushing a new
  // one (a root directory must never get two entries).
  const rootDir = path.dirname(statePath);
  const entry = fixtureTeardowns.find((candidate) => candidate.rootDir === rootDir);
  if (!entry) {
    throw new Error(
      `No fixture teardown entry for ${rootDir}. Call createFixtureRootDir() before starting a fixture.`,
    );
  }

  const skip = (reason: string): null => {
    console.warn(`Skipping ${label}: ${reason}`);
    if (test) test.skip(reason);
    return null;
  };

  if (sshEnvLabUnsupportedReason) {
    return skip(sshEnvLabUnsupportedReason);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
    return skip(sshEnvLabUnsupportedReason);
  }

  let state: SshEnvLabFixtureState;
  try {
    state = await startSshEnvLabFixture({ statePath });
  } catch (error) {
    sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
    return skip(sshEnvLabUnsupportedReason);
  }
  entry.state = state;
  return state;
}

interface ParsedProgressLine {
  raw: string;
  percent: number | null;
  doneMb: number | null;
  totalMb: number | null;
}

// How many live processes have `needle` in their argument vector. Only the
// count is reported: a process command line may hold secrets.
async function countProcessesWithArgument(needle: string): Promise<number> {
  const bytes = Buffer.from(needle);
  let count = 0;
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await readFile(`/proc/${entry}/cmdline`)).includes(bytes)) count += 1;
    } catch {
      // The process exited or is not readable.
    }
  }
  return count;
}

async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Env values that stress the stdin handoff: quotes, a newline, a value that
// looks like the prologue's line-count header, shell syntax that must stay
// inert, and non-ASCII.
const TRICKY_ENV = {
  QUOTED: "a'b\"c",
  MULTILINE: "line one\nline two\n",
  LOOKS_LIKE_HEADER: "3\n",
  INERT: "$(echo pwned) `echo pwned` ; exit 9",
  UNICODE: "grüße ✓",
};
const PRINT_TRICKY_ENV =
  'for v in "$RUN_TOKEN" "$QUOTED" "$MULTILINE" "$LOOKS_LIKE_HEADER" "$INERT" "$UNICODE"; do printf "[%s]" "$v"; done; printf "|"';

function expectedTrickyOutput(token: string): string {
  return [token, ...Object.values(TRICKY_ENV)].map((value) => `[${value}]`).join("") + "|";
}

function parseProgressLine(line: string): ParsedProgressLine {
  const trimmed = line.trimEnd();
  const percentMatch = trimmed.match(/:\s*(\d+)%\s*\(([\d.]+)\/([\d.]+) MB\)$/);
  if (percentMatch) {
    return {
      raw: trimmed,
      percent: Number.parseInt(percentMatch[1]!, 10),
      doneMb: Number.parseFloat(percentMatch[2]!),
      totalMb: Number.parseFloat(percentMatch[3]!),
    };
  }
  const mbMatch = trimmed.match(/:\s*([\d.]+) MB$/);
  if (mbMatch) {
    return { raw: trimmed, percent: null, doneMb: Number.parseFloat(mbMatch[1]!), totalMb: null };
  }
  return { raw: trimmed, percent: null, doneMb: null, totalMb: null };
}

describe("ssh env-lab fixture", () => {
  afterEach(drainFixtureTeardowns);
  // Backstop: if a throw inside afterEach ever leaves an entry on the stack,
  // this drains it too instead of stranding a listener until the process exits.
  afterAll(drainFixtureTeardowns);

  it("starts an isolated sshd fixture and executes commands through it", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const quotedWorkspace = JSON.stringify(started.workspaceDir);
    const result = await runSshCommand(
      config,
      `cd ${quotedWorkspace} && pwd`,
    );

    expect(result.stdout.trim()).toBe(started.workspaceDir);
    const status = await readSshEnvLabFixtureStatus(statePath);
    expect(status.running).toBe(true);

    await stopSshEnvLabFixture(started);

    const stopped = await readSshEnvLabFixtureStatus(statePath);
    expect(stopped.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("resolves a relative statePath to the same absolute state across start, status, and stop", async () => {
    const rootDir = await createFixtureRootDir();
    const absoluteStatePath = path.join(rootDir, "state.json");
    // A path relative to the test process's own working directory. This is
    // the shape a caller outside this file's own resolveEnvLabSshStatePath
    // helper can pass; startSshEnvLabFixture must resolve it up front so the
    // persisted state and every derived path stay absolute.
    const relativeStatePath = path.relative(process.cwd(), absoluteStatePath);

    if (sshEnvLabUnsupportedReason) {
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }

    const entry = fixtureTeardowns.find((candidate) => candidate.rootDir === rootDir);
    if (!entry) {
      throw new Error(`No fixture teardown entry for ${rootDir}.`);
    }

    let state: SshEnvLabFixtureState;
    try {
      state = await startSshEnvLabFixture({ statePath: relativeStatePath });
    } catch (error) {
      sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    entry.state = state;

    expect(state.statePath).toBe(absoluteStatePath);
    expect(state.rootDir).toBe(rootDir);

    const running = await readSshEnvLabFixtureStatus(relativeStatePath);
    expect(running.running).toBe(true);
    expect(running.state?.statePath).toBe(absoluteStatePath);

    const stopped = await stopSshEnvLabFixture(relativeStatePath);
    expect(stopped).toBe(true);
    entry.state = null;

    const afterStop = await readSshEnvLabFixtureStatus(relativeStatePath);
    expect(afterStop.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("forwards stdin to remote SSH commands", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH stdin forwarding test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remotePath = path.posix.join(started.workspaceDir, "stdin-forwarded.txt");

    await runSshCommand(
      config,
      `cat > ${JSON.stringify(remotePath)}`,
      {
        stdin: "hello over ssh stdin\n",
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(remotePath)}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    expect(result.stdout).toBe("hello over ssh stdin\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not treat an unrelated reused pid as the running fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    await stopSshEnvLabFixture(started);
    await mkdir(path.dirname(statePath), { recursive: true });

    await writeFile(
      statePath,
      JSON.stringify({ ...started, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const staleStatus = await readSshEnvLabFixtureStatus(statePath);
    expect(staleStatus.running).toBe(false);

    const restarted = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture restart test");
    if (!restarted) return;
    expect(restarted.pid).not.toBe(process.pid);

    await stopSshEnvLabFixture(restarted);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects a forged state file and cannot signal an unrelated local process", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    // A process this test does not own. A forged state must never be able
    // to target it for SIGTERM or SIGKILL.
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    const bystanderPid = bystander.pid;
    if (!bystanderPid) {
      throw new Error("Failed to spawn the bystander process for this regression test.");
    }

    try {
      const baseState = {
        kind: "ssh_openbsd" as const,
        bindHost: "127.0.0.1",
        host: "127.0.0.1",
        port: 0,
        username: os.userInfo().username,
        rootDir,
        workspaceDir: path.join(rootDir, "workspace"),
        statePath,
        createdAt: new Date().toISOString(),
        clientPrivateKeyPath: path.join(rootDir, "client_key"),
        clientPublicKeyPath: path.join(rootDir, "client_key.pub"),
        hostPrivateKeyPath: path.join(rootDir, "host_key"),
        hostPublicKeyPath: path.join(rootDir, "host_key.pub"),
        authorizedKeysPath: path.join(rootDir, "authorized_keys"),
        knownHostsPath: path.join(rootDir, "known_hosts"),
        sshdConfigPath: path.join(rootDir, "sshd_config"),
        sshdLogPath: path.join(rootDir, "sshd.log"),
      };

      const forgedVariants = [
        // An empty sshdConfigPath used to defeat the identity check: an
        // empty string is a substring of every command line.
        { ...baseState, pid: bystanderPid, sshdConfigPath: "" },
        // A sshdConfigPath outside the fixture root.
        { ...baseState, pid: bystanderPid, sshdConfigPath: "/etc/ssh/sshd_config" },
        // A non-positive pid.
        { ...baseState, pid: 0 },
        { ...baseState, pid: -1 },
      ];

      for (const forged of forgedVariants) {
        await writeFile(statePath, JSON.stringify(forged, null, 2), { mode: 0o600 });

        const status = await readSshEnvLabFixtureStatus(statePath);
        expect(status.running).toBe(false);
        expect(status.state).toBeNull();

        const stopped = await stopSshEnvLabFixture(statePath);
        expect(stopped).toBe(false);
      }

      // No forged state ever reached the identity check or a signal call,
      // so the bystander process is still alive.
      expect(() => process.kill(bystanderPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(bystanderPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("stops the fixture listener and frees its loopback port", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH teardown regression test");
    if (!started) return;
    const { pid, port, bindHost } = started;

    await stopSshEnvLabFixture(started);

    let pidStillRunning = true;
    try {
      process.kill(pid, 0);
    } catch {
      pidStillRunning = false;
    }
    expect(pidStillRunning).toBe(false);

    // Bind the exact port to prove it is free; a stopped process is not
    // proof the OS released the socket.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, bindHost, () => {
        probe.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("leaves no live listener and no root directory when the fixture fails readiness", async () => {
    if (sshEnvLabUnsupportedReason) {
      console.warn(`Skipping SSH readiness-failure cleanup test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping SSH readiness-failure cleanup test: ${sshEnvLabUnsupportedReason}`);
      return;
    }

    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const sshdConfigPath = path.join(rootDir, "sshd_config");

    // sshd binds through bindHost (127.0.0.1) and stays alive; the readiness
    // check targets an unreachable RFC 5737 TEST-NET-3 address instead, so it
    // fails on every attempt without ever reaching a real host. Poll for the
    // resulting sshd process concurrently, since startSshEnvLabFixture never
    // returns a state on this path (it throws before writing one).
    let capturedPid: number | null = null;
    const pollDeadline = Date.now() + 5_000;
    const pollForPid = (async () => {
      while (capturedPid === null && Date.now() < pollDeadline) {
        capturedPid = await findSshdPidByConfigPath(sshdConfigPath);
        if (capturedPid === null) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();

    await expect(
      startSshEnvLabFixture({
        statePath,
        host: "203.0.113.1",
        readinessTimeoutMs: 1_000,
      }),
    ).rejects.toThrow();

    await pollForPid;
    expect(capturedPid).not.toBeNull();

    let pidStillRunning = true;
    try {
      process.kill(capturedPid!, 0);
    } catch {
      pidStillRunning = false;
    }
    expect(pidStillRunning).toBe(false);

    await expect(stat(rootDir)).rejects.toThrow();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("builds a remote script that sources login profiles but no nvm", async () => {
    const target = await buildSshSpawnTarget({
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
      command: "node",
      args: ["--version"],
      env: { FOO: "bar" },
    });

    // The remote script rides the last ssh argument. The SSH target is an
    // operator-configured host that can expose `node` only through a login
    // profile, so the wrapper sources the profiles. It no longer sources
    // `nvm.sh`; a profile that adds nvm still runs.
    const remoteScript = String(target.args.at(-1) ?? "");
    expect(remoteScript).not.toContain("nvm.sh");
    expect(remoteScript).not.toContain("NVM_DIR");
    // Source /etc/profile so a host that exposes the PATH through
    // /etc/profile.d scripts still resolves node and the agent CLI.
    expect(remoteScript).toContain("/etc/profile");
    expect(remoteScript).toContain(".profile");
    expect(remoteScript).toContain(".bash_profile");
    expect(remoteScript).toContain(".zprofile");
    // Fall back to .bashrc when no .bash_profile exists, so a host that adds
    // nvm in .bashrc still resolves node under a non-login SSH command.
    expect(remoteScript).toContain(".bashrc");
    // The last ssh argument wraps the script as `sh -c '...'`, so the inner
    // quotes are escaped. Assert the command still runs: cd, env, and the argv.
    expect(remoteScript).toContain("cd ");
    expect(remoteScript).toContain("/srv/paperclip/workspace");
    expect(remoteScript).toContain('eval "$__pc_env"');
    expect(remoteScript).toContain("exec ");
    expect(remoteScript).toContain("node");
    expect(remoteScript).toContain("--version");
    // The env value itself travels over stdin, not in the ssh arguments.
    expect(target.args.join("\0")).not.toContain("bar");
    expect(target.stdinPrefix).toBe("1\nexport FOO='bar'\n");
    await target.cleanup();
  });

  it("keeps env values out of the ssh arguments and hands them over on stdin", async () => {
    const token = `tok-${randomUUID()}`;
    const target = await buildSshSpawnTarget({
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
      command: "agent",
      args: ["run"],
      env: { RUN_TOKEN: token, ...TRICKY_ENV },
    });
    const argv = target.args.join("\0");
    for (const value of [token, ...Object.values(TRICKY_ENV)]) {
      expect(argv.split(value).length - 1).toBe(0);
    }
    expect(target.stdinPrefix?.split(token).length).toBe(2);
    // The remote login shell parses the script first; keep it on one line.
    expect(String(target.args.at(-1))).not.toContain("\n");
    const withoutEnv = await buildSshSpawnTarget({
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
      command: "agent",
      args: ["run"],
      env: {},
    });
    expect(withoutEnv.stdinPrefix).toBeUndefined();
    expect(String(withoutEnv.args.at(-1))).not.toContain("__pc_env");
    await target.cleanup();
    await withoutEnv.cleanup();
  });

  it("runs remote commands with env from stdin and never exposes a value in a process command line", async (ctx) => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env over stdin test", ctx);
    const config = await buildSshEnvLabFixtureConfig(started);
    const token = `tok-${randomUUID()}`;
    const marker = path.posix.join(started.workspaceDir, `running-${randomUUID()}`);

    // The remote command signals that it is running, then waits so the process
    // table can be inspected while the local ssh client and the remote shells
    // are alive; then it prints the env it got and the stdin it was sent.
    const pending = runSshCommand(
      config,
      `: > ${JSON.stringify(marker)}; sleep 1; ${PRINT_TRICKY_ENV}; cat`,
      {
        env: { RUN_TOKEN: token, ...TRICKY_ENV },
        stdin: "caller stdin\nsecond line\n",
        timeoutMs: 30_000,
      },
    );
    await waitForFile(marker);
    if (existsSync("/proc/self/cmdline")) {
      // The scan does see these processes (the marker path is in their argv)...
      expect(await countProcessesWithArgument(marker)).toBeGreaterThan(0);
      // ...but no argument vector holds the secret.
      expect(await countProcessesWithArgument(token)).toBe(0);
    }
    const result = await pending;
    expect(result.stdout).toBe(`${expectedTrickyOutput(token)}caller stdin\nsecond line\n`);

    // Without caller stdin, a command that reads stdin gets EOF right after
    // the env handoff instead of waiting on an open pipe.
    const noStdin = await runSshCommand(config, 'cat; printf "done:%s" "$RUN_TOKEN"', {
      env: { RUN_TOKEN: token },
      timeoutMs: 30_000,
    });
    expect(noStdin.stdout).toBe(`done:${token}`);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("spawns remote agent processes with env from stdin, ahead of the caller's stdin", async (ctx) => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH spawn env over stdin test", ctx);
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir };
    const token = `tok-${randomUUID()}`;
    const marker = path.posix.join(started.workspaceDir, `running-${randomUUID()}`);

    const pending = runChildProcess(
      `run-${randomUUID()}`,
      "sh",
      ["-c", `: > ${JSON.stringify(marker)}; sleep 1; ${PRINT_TRICKY_ENV}; cat`],
      {
        cwd: rootDir,
        env: { RUN_TOKEN: token, ...TRICKY_ENV },
        stdin: "prompt on stdin\n",
        timeoutSec: 30,
        graceSec: 1,
        onLog: async () => {},
        remoteExecution: spec,
      },
    );
    await waitForFile(marker);
    if (existsSync("/proc/self/cmdline")) {
      expect(await countProcessesWithArgument(marker)).toBeGreaterThan(0);
      expect(await countProcessesWithArgument(token)).toBe(0);
    }
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${expectedTrickyOutput(token)}prompt on stdin\n`);

    // No caller stdin: the command still gets its env and an immediate EOF.
    const noStdin = await runChildProcess(
      `run-${randomUUID()}`,
      "sh",
      ["-c", 'cat; printf "done:%s" "$RUN_TOKEN"'],
      {
        cwd: rootDir,
        env: { RUN_TOKEN: token },
        timeoutSec: 30,
        graceSec: 1,
        onLog: async () => {},
        remoteExecution: spec,
      },
    );
    expect(noStdin.exitCode).toBe(0);
    expect(noStdin.stdout).toBe(`done:${token}`);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("hands an oversized JSON payload variable to the remote process as a file in the run scratch dir", async (ctx) => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH oversized env payload test", ctx);
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir };
    const scratchDir = path.posix.join(started.workspaceDir, ".paperclip-runtime", "runs", "run-1", "scratch");
    await mkdir(scratchDir, { recursive: true, mode: 0o700 });
    // Far above the 128 KiB a single env string may have; as an env var of the
    // local ssh process or of the remote command this fails with E2BIG.
    const payload = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ workspaceId: `w${index}`, notes: "x".repeat(2_000) })));
    const result = await runChildProcess(
      `run-${randomUUID()}`,
      "sh",
      [
        "-c",
        'if [ -n "${PAPERCLIP_WORKSPACES_JSON+x}" ]; then echo inline; exit 3; fi; ' +
          'printf "%s\n" "$PAPERCLIP_WORKSPACES_FILE"; wc -c < "$PAPERCLIP_WORKSPACES_FILE"; cat',
      ],
      {
        cwd: rootDir,
        env: { PAPERCLIP_WORKSPACES_JSON: payload, PAPERCLIP_RUN_SCRATCH_DIR: scratchDir },
        stdin: "prompt on stdin\n",
        timeoutSec: 30,
        graceSec: 1,
        onLog: async () => {},
        remoteExecution: spec,
      },
    );
    expect(result.exitCode).toBe(0);
    const [filePath, byteCount, stdinEcho] = result.stdout.trim().split("\n").map((line) => line.trim());
    expect(filePath!.startsWith(`${scratchDir}/paperclip-env-`)).toBe(true);
    expect(Number(byteCount)).toBe(Buffer.byteLength(payload));
    expect(stdinEcho).toBe("prompt on stdin");
    // Removed once the remote command exited.
    expect(existsSync(filePath!)).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("gives commands run through the SSH command runner their env over stdin", async (ctx) => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH command runner env test", ctx);
    const config = await buildSshEnvLabFixtureConfig(started);
    const runner = createSshCommandManagedRuntimeRunner({
      spec: { ...config, remoteCwd: started.workspaceDir },
    });
    const token = `tok-${randomUUID()}`;
    const marker = path.posix.join(started.workspaceDir, `running-${randomUUID()}`);

    const pending = runner.execute({
      command: "sh",
      args: ["-c", `: > ${JSON.stringify(marker)}; sleep 1; pwd; ${PRINT_TRICKY_ENV}; cat`],
      env: { RUN_TOKEN: token, ...TRICKY_ENV },
      stdin: "runner stdin\n",
      timeoutMs: 30_000,
    });
    await waitForFile(marker);
    if (existsSync("/proc/self/cmdline")) {
      expect(await countProcessesWithArgument(marker)).toBeGreaterThan(0);
      expect(await countProcessesWithArgument(token)).toBe(0);
    }
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${started.workspaceDir}\n${expectedTrickyOutput(token)}runner stdin\n`);

    // A plain (non-shell) command gets the same env.
    const printed = await runner.execute({
      command: "printenv",
      args: ["RUN_TOKEN"],
      env: { RUN_TOKEN: token },
      timeoutMs: 30_000,
    });
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toBe(`${token}\n`);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
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
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("syncs a local directory into the remote fixture workspace", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "message.txt"), "hello from paperclip\n", "utf8");
    await writeFile(path.join(localDir, "._message.txt"), "should never sync\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(path.posix.join(remoteDir, "message.txt"))} && if [ -e ${JSON.stringify(path.posix.join(remoteDir, "._message.txt"))} ]; then echo appledouble-present; fi`,
    );

    expect(result.stdout).toContain("hello from paperclip");
    expect(result.stdout).not.toContain("appledouble-present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports throttled upload progress with a clamped percent and terminal 100% line", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    // Multiple files large enough that tar emits several pipe chunks, so the
    // byte counter crosses several step boundaries before the stream closes.
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH upload progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-progress");

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryToSsh({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir,
      remoteDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Syncing workspace to ssh");
    }
    // Monotonically increasing byte counts.
    const doneSeries = lines.map((line) => line.doneMb ?? 0);
    for (let index = 1; index < doneSeries.length; index += 1) {
      expect(doneSeries[index]!).toBeGreaterThanOrEqual(doneSeries[index - 1]!);
    }
    // Percent clamped to <= 99% on every line emitted before the stream closed.
    for (const line of lines.slice(0, -1)) {
      if (line.percent != null) expect(line.percent).toBeLessThanOrEqual(99);
    }
    // Terminal completion line is 100% with matching done/total.
    const last = lines.at(-1)!;
    expect(last.percent).toBe(100);
    expect(last.doneMb).toBe(last.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports restore progress with a terminal completion line", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");
    const restoreDir = path.join(rootDir, "restore-target");

    await mkdir(localDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH restore progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const remoteDir = path.posix.join(started.workspaceDir, "restore-source");

    await syncDirectoryToSsh({ spec, localDir, remoteDir });

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryFromSsh({
      spec,
      remoteDir,
      localDir: restoreDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Restoring workspace from ssh");
    }
    // Terminal completion line: either an exact 100% (probe succeeded) or a
    // final MB-received line (probe unavailable). Either is a valid terminal.
    const last = lines.at(-1)!;
    expect(last.percent === 100 || (last.percent === null && last.doneMb !== null)).toBe(true);
    // The restored files round-tripped through the byte-counting transport.
    await expect(readFile(path.join(restoreDir, "blob-0.bin"))).resolves.toEqual(
      Buffer.alloc(256 * 1024, 1),
    );
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports exact git-history import percentage from the known bundle size", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.bin"), Buffer.alloc(256 * 1024, 7));
    await git(localRepo, ["add", "tracked.bin"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH git import progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const lines: ParsedProgressLine[] = [];
    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
    });

    const importLines = lines.filter((line) => line.raw.includes("Importing git history to ssh"));
    expect(importLines.length).toBeGreaterThan(0);
    // Known bundle size -> exact percentage with no "workspace" label.
    for (const line of importLines) {
      expect(line.raw).not.toContain("workspace");
      expect(line.percent).not.toBeNull();
    }
    const lastImport = importLines.at(-1)!;
    expect(lastImport.percent).toBe(100);
    expect(lastImport.doneMb).toBe(lastImport.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("can dereference local symlinks while syncing to the remote fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(sourceDir, "auth.json"), "{\"token\":\"secret\"}\n", "utf8");
    await symlink(path.join(sourceDir, "auth.json"), path.join(localDir, "auth.json"));

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH symlink sync test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-follow-links");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
      followSymlinks: true,
    });

    const result = await runSshCommand(
      config,
      `if [ -L ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))} ]; then echo symlink; else echo regular; fi && cat ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))}`,
    );

    expect(result.stdout).toContain("regular");
    expect(result.stdout).toContain("{\"token\":\"secret\"}");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips a git workspace through the SSH fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(localRepo, "._tracked.txt"), "should stay local only\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    const originalHead = await git(localRepo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH workspace round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const remoteStatus = await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git status --short`,
    );
    expect(remoteStatus.stdout).toContain("M tracked.txt");
    expect(remoteStatus.stdout).toContain("?? untracked.txt");
    expect(remoteStatus.stdout).not.toContain("._tracked.txt");

    await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && git add tracked.txt untracked.txt && git commit -m "remote update" >/dev/null && printf "remote dirty\\n" > tracked.txt && printf "remote extra\\n" > remote-only.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const restoredHead = await git(localRepo, ["rev-parse", "HEAD"]);
    expect(restoredHead).not.toBe(originalHead);
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    expect(await git(localRepo, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(localRepo, ["status", "--short"])).not.toContain("._tracked.txt");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves both concurrent SSH restores in a shared git workspace", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    expect(preparedA.workspaceRemoteDir).not.toBe(preparedB.workspaceRemoteDir);

    await runSshCommand(
      config,
      `printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "run-a.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "run-b.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves nested per-run files across sequential SSH restores with stale baselines", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "sequential nested SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/claude_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/codex_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await preparedA.restoreWorkspace();
    await preparedB.restoreWorkspace();

    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/claude_local.md"), "utf8")).resolves
      .toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/codex_local.md"), "utf8")).resolves
      .toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips remote git commits through the managed runtime restore path", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "managed-runtime SSH git round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "committed\\n" > tracked.txt && git add tracked.txt && git commit -m "remote update" >/dev/null && printf "dirty remote\\n" > tracked.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    await expect(readFile(path.join(localRepo, "tracked.txt"), "utf8")).resolves.toBe("dirty remote\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("propagates remote commits to the local worktree with no git remote configured (no-remote-git contract)", async () => {
    // Locks in the architectural contract documented in
    // packages/adapter-utils/README.md and packages/adapters/AUTHORING.md:
    // the local execution-workspace cwd is the only persistence boundary
    // across runs. No adapter may depend on a git remote for cross-run state.
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    // Assert there is no git remote configured before we begin, and verify
    // that no point in the round-trip introduces one. `git remote` returns an
    // empty string when no remotes exist (and exit code 0).
    expect(await git(localRepo, ["remote"])).toBe("");

    const started = await startSshEnvLabFixtureOrSkip(
      statePath,
      "no-remote-git contract test",
    );
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-no-remote",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    // Remote commit lands a deliverable that must show up locally via
    // sync-back alone — no `git push`, no fetch from any origin.
    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "deliverable\\n" > tracked.txt && git add tracked.txt && git commit -m "remote-only commit" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe(
      "remote-only commit",
    );
    expect(await readFile(path.join(localRepo, "tracked.txt"), "utf8")).toBe(
      "deliverable\n",
    );
    // Final assertion: still no git remote — restore did not silently add one.
    expect(await git(localRepo, ["remote"])).toBe("");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("merges concurrent remote commits through the managed runtime restore path", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent managed-runtime SSH git merge test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedA.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run a\\n" > run-a.txt && git add run-a.txt && git commit -m "remote update a" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedB.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run b\\n" > run-b.txt && git add run-b.txt && git commit -m "remote update b" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toContain("Paperclip SSH sync merge");

    const recentSubjects = await git(localRepo, ["log", "--pretty=%s", "-3"]);
    expect(recentSubjects).toContain("remote update a");
    expect(recentSubjects).toContain("remote update b");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it.each(["git", "plain"] as const)(
    "stages a stable workspace per reuse key across prepare and restore cycles (%s)",
    async (kind) => {
      const KEY = "0123456789abcdef0123456789abcdef";
      const rootDir = await createFixtureRootDir();
      const statePath = path.join(rootDir, "state.json");
      const localRepo = path.join(rootDir, "local-workspace");
      const skillsDir = path.join(rootDir, "skills");
      await mkdir(localRepo, { recursive: true });
      await mkdir(skillsDir, { recursive: true });
      await writeFile(path.join(skillsDir, "SKILL.md"), "skill\n", "utf8");
      await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
      if (kind === "git") {
        await git(localRepo, ["init"]);
        await git(localRepo, ["checkout", "-b", "main"]);
        await git(localRepo, ["config", "user.name", "Paperclip Test"]);
        await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
        await git(localRepo, ["add", "tracked.txt"]);
        await git(localRepo, ["commit", "-m", "initial"]);
      }

      const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH stable workspace test");
      if (!started) return;
      const config = await buildSshEnvLabFixtureConfig(started);
      const target: AdapterSshExecutionTarget = {
        kind: "remote",
        transport: "ssh",
        remoteCwd: started.workspaceDir,
        spec: { ...config, remoteCwd: started.workspaceDir },
        workspaceReuseKey: KEY,
      };
      const runtimeDir = path.join(started.workspaceDir, ".paperclip-runtime");
      const stable = path.posix.join(runtimeDir, "workspaces", KEY, "workspace");
      const prepare = (runId: string) =>
        prepareAdapterExecutionTargetRuntime({
          runId,
          target,
          adapterKey: "test-adapter",
          workspaceLocalDir: localRepo,
          assets: [{ key: "skills", localDir: skillsDir }],
        });

      const first = await prepare("run-1");
      expect(first.workspaceRemoteDir).toBe(stable);
      expect(first.runtimeRootDir).toBe(path.posix.join(runtimeDir, "runs", "run-1", "test-adapter"));
      expect(await readFile(path.join(stable, "tracked.txt"), "utf8")).toBe("base\n");
      expect(await readFile(path.join(runtimeDir, "runs", "run-1", "test-adapter", "skills", "SKILL.md"), "utf8"))
        .toBe("skill\n");
      await runSshCommand(
        config,
        `printf "from run 1\\n" > ${JSON.stringify(path.posix.join(stable, "agent-notes.md"))}`,
        { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
      );
      await first.restoreWorkspace();
      expect(await readFile(path.join(localRepo, "agent-notes.md"), "utf8")).toBe("from run 1\n");

      const second = await prepare("run-2");
      // Same working directory as run 1, so a CLI session saved there resolves.
      expect(second.workspaceRemoteDir).toBe(stable);
      expect(second.runtimeRootDir).toBe(path.posix.join(runtimeDir, "runs", "run-2", "test-adapter"));
      // The file written in run 1 came back through the host copy.
      expect(await readFile(path.join(stable, "agent-notes.md"), "utf8")).toBe("from run 1\n");
      // Run 1's remote copy was moved aside, and the sync of run 2 left run 1's runtime files alone.
      expect(await readFile(path.join(runtimeDir, "runs", "run-1", "workspace", "agent-notes.md"), "utf8"))
        .toBe("from run 1\n");
      expect(await readFile(path.join(runtimeDir, "runs", "run-1", "test-adapter", "skills", "SKILL.md"), "utf8"))
        .toBe("skill\n");
      expect(await readFile(path.join(runtimeDir, "workspaces", KEY, ".last-run"), "utf8")).toBe("run-2\n");

      await runSshCommand(
        config,
        `printf "from run 2\\n" >> ${JSON.stringify(path.posix.join(stable, "agent-notes.md"))}`,
        { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
      );
      await second.restoreWorkspace();
      expect(await readFile(path.join(localRepo, "agent-notes.md"), "utf8")).toBe("from run 1\nfrom run 2\n");
    },
    SSH_FIXTURE_TEST_TIMEOUT_MS,
  );
});
