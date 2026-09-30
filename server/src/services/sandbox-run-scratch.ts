import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { sshRunDir, sshRunScratchDir } from "@paperclipai/adapter-utils/ssh-workspace-layout";

/*
 * Sandbox lane: a private scratch directory per run inside the sandbox.
 *
 * It follows the SSH lane's run-directory layout,
 * `<remoteCwd>/.paperclip-runtime/runs/<runId>/scratch`. Workspace sync never
 * uploads over `.paperclip-runtime` and never copies it back to the host, so
 * the directory stays private to the sandbox. A sandbox that is kept between
 * runs keeps its filesystem, so the host removes the directory before it
 * releases the lease.
 */

const SANDBOX_SCRATCH_COMMAND_TIMEOUT_MS = 30_000;

export interface SandboxRunScratch {
  dir: string;
  runId: string;
  remoteCwd: string;
  target: AdapterSandboxExecutionTarget;
}

async function runSandboxScript(
  target: AdapterSandboxExecutionTarget,
  script: string,
  action: string,
): Promise<void> {
  const runner = target.runner;
  if (!runner) throw new Error(`Cannot ${action}: the sandbox target has no command runner`);
  const result = await runner.execute({
    command: "sh",
    args: ["-c", script],
    cwd: target.remoteCwd,
    timeoutMs: SANDBOX_SCRATCH_COMMAND_TIMEOUT_MS,
    // Housekeeping outside the agent's command stream: never queue behind a
    // long-lived command on the lease's persistent session.
    bypassSession: true,
  });
  if (result.timedOut || result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
    throw new Error(
      `Cannot ${action}: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}${detail ? ` (${detail})` : ""}`,
    );
  }
}

/**
 * Creates the private scratch directory of a run inside the sandbox (mode
 * 0700). It must exist before the adapter runs its first sandbox command,
 * because those commands get TMPDIR pointed at it.
 */
export async function prepareSandboxRunScratch(input: {
  target: AdapterSandboxExecutionTarget;
  runId: string;
}): Promise<SandboxRunScratch> {
  const remoteCwd = input.target.remoteCwd;
  if (!remoteCwd.startsWith("/")) {
    throw new Error("Cannot create the run scratch directory in the sandbox: the working directory is not absolute");
  }
  const runDir = sshRunDir(remoteCwd, input.runId);
  const dir = sshRunScratchDir(remoteCwd, input.runId);
  const script = [
    "set -e",
    "umask 077",
    `mkdir -p ${shellQuote(runDir)}`,
    // Never follow a link left at the scratch path.
    `if [ -L ${shellQuote(dir)} ]; then rm -f -- ${shellQuote(dir)}; fi`,
    `mkdir -p ${shellQuote(dir)}`,
    `chmod 700 ${shellQuote(dir)}`,
  ].join("\n");
  await runSandboxScript(input.target, script, "create the run scratch directory in the sandbox");
  return { dir, runId: input.runId, remoteCwd, target: input.target };
}

/**
 * Removes a run's scratch directory from the sandbox, and its run directory
 * when that is left empty. Only paths derived from the run's working directory
 * and id are removed. Call it while the run still holds the sandbox lease.
 */
export async function cleanupSandboxRunScratch(input: {
  scratch: SandboxRunScratch;
}): Promise<{ removed: boolean; dir: string }> {
  const expected = sshRunScratchDir(input.scratch.remoteCwd, input.scratch.runId);
  if (expected !== input.scratch.dir) return { removed: false, dir: input.scratch.dir };
  const dir = shellQuote(expected);
  const runDir = shellQuote(sshRunDir(input.scratch.remoteCwd, input.scratch.runId));
  await runSandboxScript(
    input.scratch.target,
    [
      `if [ -L ${dir} ]; then rm -f -- ${dir}; elif [ -d ${dir} ]; then rm -rf -- ${dir}; fi`,
      // rmdir only removes an empty directory.
      `rmdir -- ${runDir} 2>/dev/null || true`,
    ].join("\n"),
    "remove the run scratch directory from the sandbox",
  );
  return { removed: true, dir: expected };
}
