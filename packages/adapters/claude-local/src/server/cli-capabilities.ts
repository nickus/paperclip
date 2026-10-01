import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import path from "node:path";

// One `--help` probe per command/target; every flag check reads the same
// result. Holds null when the probe timed out or could not run.
const helpProbeCache = new Map<string, Promise<ClaudeHelpProbe | null>>();

interface ClaudeHelpProbe {
  output: string;
  exitCode: number | null;
}

export interface ClaudeCommandProbeInput {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}

export const CLAUDE_FABLE_5_1_MIN_CLI_VERSION = "2.1.251";

export function claudeCommandLooksLike(command: string, expected = "claude"): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function cacheKeyForTarget(command: string, target: AdapterExecutionTarget | null | undefined): string {
  if (!target) return `local::${command}`;
  if (target.kind === "local") {
    return `local:${target.environmentId ?? ""}:${target.leaseId ?? ""}:${command}`;
  }
  if (target.transport === "sandbox") {
    return [
      "sandbox",
      target.providerKey ?? "",
      target.environmentId ?? "",
      command,
    ].join(":");
  }
  return [
    "ssh",
    target.environmentId ?? "",
    target.leaseId ?? "",
    target.spec.host,
    target.spec.port ?? "",
    target.spec.username ?? "",
    command,
  ].join(":");
}

export function minimumClaudeCliVersionForModel(model: string): string | null {
  const modelId = model.trim().replace(/\[1m\]$/, "").replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "");
  if (modelId === "claude-opus-5-5") return "2.1.280";
  return modelId === "claude-fable-5-1"
    ? CLAUDE_FABLE_5_1_MIN_CLI_VERSION
    : null;
}

export function parseClaudeCliVersion(output: string): string | null {
  return output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0] ?? null;
}

export function claudeCliVersionAtLeast(version: string, minimum: string): boolean {
  const parsedVersion = version.split(".").map(Number);
  const parsedMinimum = minimum.split(".").map(Number);
  if (
    parsedVersion.length !== 3 ||
    parsedMinimum.length !== 3 ||
    parsedVersion.some((part) => !Number.isInteger(part) || part < 0) ||
    parsedMinimum.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    return false;
  }

  for (let index = 0; index < parsedMinimum.length; index += 1) {
    if (parsedVersion[index] !== parsedMinimum[index]) {
      return parsedVersion[index] > parsedMinimum[index];
    }
  }
  return true;
}

async function probeClaudeCommandVersion(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  const version = await runAdapterExecutionTargetProcess(
    input.runId,
    input.target,
    input.command,
    ["--version"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: Math.max(1, Math.min(input.timeoutSec, 20)),
      graceSec: Math.max(1, Math.min(input.graceSec, 5)),
      onLog: async () => {},
    },
  );

  if (version.timedOut || version.exitCode !== 0) return null;
  return parseClaudeCliVersion(`${version.stdout}\n${version.stderr}`);
}

export async function readClaudeCommandVersion(input: {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}): Promise<string | null> {
  // Do not cache this probe: an operator may upgrade Claude Code while the
  // Paperclip server is running, and the next Test/run should recover without
  // requiring a server restart.
  return probeClaudeCommandVersion(input).catch(() => null);
}

async function probeClaudeCommandHelp(input: ClaudeCommandProbeInput): Promise<ClaudeHelpProbe | null> {
  const help = await runAdapterExecutionTargetProcess(
    input.runId,
    input.target,
    input.command,
    ["--help"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: Math.max(1, Math.min(input.timeoutSec, 20)),
      graceSec: Math.max(1, Math.min(input.graceSec, 5)),
      onLog: async () => {},
    },
  );

  if (help.timedOut) return null;
  return { output: `${help.stdout}\n${help.stderr}`, exitCode: help.exitCode };
}

async function claudeCommandAdvertisesFlag(
  input: ClaudeCommandProbeInput,
  flag: string,
): Promise<boolean | null> {
  // A wrapper script or other binary may not forward --help, so its output
  // proves nothing either way.
  if (!claudeCommandLooksLike(input.command, "claude")) return null;

  const key = cacheKeyForTarget(input.command, input.target);
  let probe = helpProbeCache.get(key);
  if (!probe) {
    // A thrown probe (e.g. sandbox connection error, ENOENT spawning the binary)
    // must degrade to the conservative fallback rather than killing the run, so we
    // resolve to null and drop the cache entry to retry on the next lease.
    probe = probeClaudeCommandHelp(input).catch(() => {
      helpProbeCache.delete(key);
      return null;
    });
    helpProbeCache.set(key, probe);
  }

  const help = await probe;
  if (!help) return null;
  if (help.output.includes(flag)) return true;
  // Only a clean exit proves the flag is absent; a failing --help is unknown.
  if ((help.exitCode ?? 0) === 0) return false;
  return null;
}

/** true/false when `--help` settles it; null when it is unknown. */
export async function claudeCommandSupportsEffortFlag(input: ClaudeCommandProbeInput): Promise<boolean | null> {
  return claudeCommandAdvertisesFlag(input, "--effort");
}

/**
 * Whether the CLI accepts `--system-prompt-snapshot`, which lets a resumed
 * conversation run on a newly rendered system prompt instead of the one it
 * recorded on its first request. true/false when `--help` settles it; null
 * when it is unknown.
 */
export async function claudeCommandSupportsSystemPromptSnapshotFlag(
  input: ClaudeCommandProbeInput,
): Promise<boolean | null> {
  return claudeCommandAdvertisesFlag(input, "--system-prompt-snapshot");
}

export function resetClaudeCliCapabilitiesCacheForTests() {
  helpProbeCache.clear();
}
