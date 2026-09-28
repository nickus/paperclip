import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterExecutionTarget,
  AdapterSshExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { runSshCommand, shellQuote, type SshRemoteExecutionSpec } from "@paperclipai/adapter-utils/ssh";
import {
  isSshRunIdPathSegment,
  sshRunDir,
  sshRunScratchDir,
} from "@paperclipai/adapter-utils/ssh-workspace-layout";

/*
 * SSH lane: stable workspace per (agent, task, host workspace) and a per-run
 * scratch directory on the remote host.
 *
 * Agent CLIs key their session stores by working directory. When every run
 * staged its workspace in a new directory, a saved session never matched the
 * next run and every wake started from scratch. The host now hands each run
 * of the same agent and task the same workspace reuse key, so the adapter
 * stages the workspace at the same remote path (see
 * @paperclipai/adapter-utils/ssh-workspace-layout).
 */

const WORKSPACE_REUSE_KEY_DOMAIN = "paperclip-ssh-ws-v1";

/**
 * Key of the stable remote workspace for one agent, task and host workspace.
 * It follows how task sessions are keyed (agent + task), plus the host
 * workspace so that moving a task to another workspace starts a fresh
 * session, as it does locally.
 */
export function deriveSshWorkspaceReuseKey(input: {
  agentId: string;
  taskKey: string;
  hostCwd: string;
}): string {
  return createHash("sha256")
    .update([WORKSPACE_REUSE_KEY_DOMAIN, input.agentId, input.taskKey, path.resolve(input.hostCwd)].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

export interface SshWorkspaceReuseClaim {
  key: string;
  runId: string;
  release(): void;
}

// Key -> run id that stages its workspace under that key. A key is handed to
// one run at a time: two runs staging the same directory would overwrite each
// other's workspace and restore the other run's files.
const claimedWorkspaceReuseKeys = new Map<string, string>();

export function claimSshWorkspaceReuseKey(input: {
  key: string;
  runId: string;
}): { claimed: true; claim: SshWorkspaceReuseClaim } | { claimed: false; heldByRunId: string } {
  const holder = claimedWorkspaceReuseKeys.get(input.key);
  if (holder !== undefined && holder !== input.runId) {
    return { claimed: false, heldByRunId: holder };
  }
  claimedWorkspaceReuseKeys.set(input.key, input.runId);
  let released = false;
  return {
    claimed: true,
    claim: {
      key: input.key,
      runId: input.runId,
      release() {
        if (released) return;
        released = true;
        if (claimedWorkspaceReuseKeys.get(input.key) === input.runId) {
          claimedWorkspaceReuseKeys.delete(input.key);
        }
      },
    },
  };
}

/** Run holding `key`, if any. For tests and diagnostics. */
export function sshWorkspaceReuseKeyHolder(key: string): string | null {
  return claimedWorkspaceReuseKeys.get(key) ?? null;
}

export interface SshWorkspaceReuseResolution {
  target: AdapterExecutionTarget | null;
  claim: SshWorkspaceReuseClaim | null;
  warning: string | null;
}

/**
 * Marks an SSH execution target with the workspace reuse key of this agent and
 * task, when no other run holds it. Local and sandbox targets, runs without a
 * task key and runs without a host workspace are returned unchanged. The
 * caller must release the returned claim when the run ends.
 */
export function resolveSshWorkspaceReuse(input: {
  target: AdapterExecutionTarget | null | undefined;
  agentId: string;
  taskKey: string | null | undefined;
  hostCwd: string | null | undefined;
  runId: string;
}): SshWorkspaceReuseResolution {
  const target = input.target ?? null;
  const taskKey = input.taskKey?.trim();
  const hostCwd = input.hostCwd?.trim();
  if (
    !target ||
    target.kind !== "remote" ||
    target.transport !== "ssh" ||
    !taskKey ||
    !hostCwd ||
    !isSshRunIdPathSegment(input.runId)
  ) {
    return { target, claim: null, warning: null };
  }
  const key = deriveSshWorkspaceReuseKey({ agentId: input.agentId, taskKey, hostCwd });
  const result = claimSshWorkspaceReuseKey({ key, runId: input.runId });
  if (!result.claimed) {
    return {
      target,
      claim: null,
      warning:
        `Run ${result.heldByRunId} is using the stable SSH workspace of this task. ` +
        "This run uses its own workspace directory and starts a fresh agent session.",
    };
  }
  const marked: AdapterSshExecutionTarget = { ...target, workspaceReuseKey: result.claim.key };
  return { target: marked, claim: result.claim, warning: null };
}

export type SshCommandRunner = (
  spec: SshRemoteExecutionSpec,
  command: string,
  options: { timeoutMs?: number; maxBuffer?: number },
) => Promise<unknown>;

const defaultSshCommandRunner: SshCommandRunner = (spec, command, options) =>
  runSshCommand(spec, command, options);

export interface SshRunScratch {
  dir: string;
  runId: string;
  spec: SshRemoteExecutionSpec;
  remoteCwd: string;
}

/**
 * Creates the private scratch directory of a run on the SSH host,
 * `<remoteCwd>/.paperclip-runtime/runs/<runId>/scratch` (mode 0700). It must
 * exist before the adapter runs its first remote command, because those
 * commands already get TMPDIR pointed at it.
 */
export async function prepareSshRunScratch(input: {
  target: AdapterSshExecutionTarget;
  runId: string;
  runCommand?: SshCommandRunner;
}): Promise<SshRunScratch> {
  const remoteCwd = input.target.remoteCwd;
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
  await (input.runCommand ?? defaultSshCommandRunner)(input.target.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 16 * 1024,
  });
  return { dir, runId: input.runId, spec: input.target.spec, remoteCwd };
}

/**
 * Removes a run's scratch directory from the SSH host. Only the exact path
 * derived from the run's working directory and id is removed; the host's
 * run-directory GC is the backstop when this fails.
 */
export async function cleanupSshRunScratch(input: {
  scratch: SshRunScratch;
  runCommand?: SshCommandRunner;
}): Promise<{ removed: boolean; dir: string }> {
  const expected = sshRunScratchDir(input.scratch.remoteCwd, input.scratch.runId);
  if (expected !== input.scratch.dir) return { removed: false, dir: input.scratch.dir };
  const dir = shellQuote(expected);
  await (input.runCommand ?? defaultSshCommandRunner)(
    input.scratch.spec,
    `if [ -L ${dir} ]; then rm -f -- ${dir}; elif [ -d ${dir} ]; then rm -rf -- ${dir}; fi`,
    { timeoutMs: 30_000, maxBuffer: 16 * 1024 },
  );
  return { removed: true, dir: expected };
}

/**
 * Drops the entries that the remote run scratch env added (`scratchEnv`, as
 * returned by buildRunScratchEnvForDir) from `env`, for processes that run on
 * this host. Only those keys are dropped, and only while they still hold the
 * value the scratch env gave them: a temp key the agent config sets itself, or
 * any other key that happens to hold the same path, is kept.
 */
export function omitRemoteRunScratchEnv(
  env: Record<string, string>,
  scratchEnv: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  if (!scratchEnv) return env;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => !(Object.hasOwn(scratchEnv, key) && scratchEnv[key] === value),
    ),
  );
}
