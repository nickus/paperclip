import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { cleanupSandboxRunScratch, prepareSandboxRunScratch } from "./sandbox-run-scratch.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
  cleanupDirs.clear();
});

// A runner that executes the sandbox commands on this machine, in a temp
// directory standing in for the sandbox working directory.
function localRunner() {
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async (input) => {
    const startedAt = new Date().toISOString();
    const result = spawnSync(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      encoding: "utf-8",
      timeout: input.timeoutMs,
    });
    return {
      exitCode: result.status,
      signal: result.signal,
      timedOut: false,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      pid: null,
      startedAt,
    };
  });
  return { execute } satisfies CommandManagedRuntimeRunner;
}

async function sandboxTarget(runner?: CommandManagedRuntimeRunner): Promise<AdapterSandboxExecutionTarget> {
  const remoteCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-scratch-"));
  cleanupDirs.add(remoteCwd);
  return { kind: "remote", transport: "sandbox", remoteCwd, runner };
}

describe("sandbox run scratch", () => {
  it("creates a private scratch directory for the run inside the sandbox", async () => {
    const runner = localRunner();
    const target = await sandboxTarget(runner);

    const scratch = await prepareSandboxRunScratch({ target, runId: "run-1" });

    expect(scratch.dir).toBe(path.posix.join(target.remoteCwd, ".paperclip-runtime/runs/run-1/scratch"));
    const stat = await fs.stat(scratch.dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    // The command ran through the sandbox runner, in the sandbox working directory.
    expect(runner.execute).toHaveBeenCalledTimes(1);
    expect(runner.execute.mock.calls[0]?.[0]).toMatchObject({
      command: "sh",
      cwd: target.remoteCwd,
      bypassSession: true,
    });
  });

  it("replaces a link left at the scratch path instead of following it", async () => {
    const target = await sandboxTarget(localRunner());
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-outside-"));
    cleanupDirs.add(outside);
    const runDir = path.join(target.remoteCwd, ".paperclip-runtime/runs/run-1");
    await fs.mkdir(runDir, { recursive: true });
    await fs.symlink(outside, path.join(runDir, "scratch"));

    const scratch = await prepareSandboxRunScratch({ target, runId: "run-1" });

    expect((await fs.lstat(scratch.dir)).isDirectory()).toBe(true);
    expect((await fs.lstat(outside)).isDirectory()).toBe(true);
  });

  it("rejects a run id that would leave the runs directory", async () => {
    const runner = localRunner();
    const target = await sandboxTarget(runner);

    await expect(prepareSandboxRunScratch({ target, runId: "../escape" })).rejects.toThrow();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("fails when the sandbox cannot create the directory or has no runner", async () => {
    const failing = localRunner();
    failing.execute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "mkdir: Permission denied",
      pid: null,
      startedAt: new Date().toISOString(),
    });

    await expect(
      prepareSandboxRunScratch({ target: await sandboxTarget(failing), runId: "run-1" }),
    ).rejects.toThrow(/exit code 1 \(mkdir: Permission denied\)/);
    await expect(
      prepareSandboxRunScratch({ target: await sandboxTarget(undefined), runId: "run-1" }),
    ).rejects.toThrow(/no command runner/);
  });

  it("removes the scratch directory and the emptied run directory", async () => {
    const target = await sandboxTarget(localRunner());
    const scratch = await prepareSandboxRunScratch({ target, runId: "run-1" });
    await fs.writeFile(path.join(scratch.dir, "c.md"), "comment");
    const other = await prepareSandboxRunScratch({ target, runId: "run-2" });

    await expect(cleanupSandboxRunScratch({ scratch })).resolves.toEqual({ removed: true, dir: scratch.dir });

    await expect(fs.stat(path.dirname(scratch.dir))).rejects.toThrow();
    // Another run's directory stays.
    expect((await fs.stat(other.dir)).isDirectory()).toBe(true);
  });

  it("removes only the exact scratch directory of the run", async () => {
    const runner = localRunner();
    const target = await sandboxTarget(runner);
    const scratch = await prepareSandboxRunScratch({ target, runId: "run-1" });
    runner.execute.mockClear();

    await expect(
      cleanupSandboxRunScratch({ scratch: { ...scratch, dir: target.remoteCwd } }),
    ).resolves.toEqual({ removed: false, dir: target.remoteCwd });
    expect(runner.execute).not.toHaveBeenCalled();
    expect((await fs.stat(scratch.dir)).isDirectory()).toBe(true);
  });
});
