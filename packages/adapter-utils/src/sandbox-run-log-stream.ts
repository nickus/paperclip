import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import { shellQuote } from "./ssh.js";

// Sandbox providers execute commands through batch RPCs, so agent CLI output
// normally only reaches the host when the process exits. This module streams
// that output during the run instead: `wrapCommand` tees the CLI's
// stdout/stderr into log files under the bridge runtime directory inside the
// sandbox, and a host-side poll loop tails those files (byte offsets +
// base64 transport, mirroring the callback-bridge queue client) and emits
// incremental `onLog` chunks through the existing run-log pipeline.

const SANDBOX_EXEC_CHANNEL_ENV = "PAPERCLIP_SANDBOX_EXEC_CHANNEL";
const SANDBOX_EXEC_CHANNEL_BRIDGE = "bridge";

const DEFAULT_TAIL_POLL_INTERVAL_MS = 250;
const DEFAULT_TAIL_MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TAIL_TICK_TIMEOUT_MS = 15_000;
const DEFAULT_TAIL_MAX_CONSECUTIVE_FAILURES = 3;
// Once a run is degraded, back off exponentially from the ordinary poll
// cadence instead of hammering an overloaded host, but never wait longer than
// this between retries: the loop must keep trying, not give up.
const DEFAULT_TAIL_MAX_BACKOFF_MS = 60_000;
// Every retry while degraded logs a short "still trying" line so the run's
// idle watchdog (which only sees activity through this same log channel)
// keeps extending its deadline instead of reading the silence as the run
// having stopped. That is only safe for so long: past this budget (measured
// from when the stream first degraded) the loop stops asserting activity,
// so a host that never recovers still lets the idle timeout do its job
// instead of being kept alive forever by our own retries.
const DEFAULT_TAIL_DEGRADED_HEARTBEAT_BUDGET_MS = 30 * 60 * 1000;

const TAIL_MARKER_STDOUT = "__PAPERCLIP_RUN_LOG_STDOUT__";
const TAIL_MARKER_STDERR = "__PAPERCLIP_RUN_LOG_STDERR__";
const TAIL_MARKER_END = "__PAPERCLIP_RUN_LOG_END__";

export type SandboxRunLogSink = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

export interface SandboxRunLogStreamHealth {
  /** Whether the tail loop is currently past its failure threshold. */
  degraded: boolean;
  /** When the current degraded spell began, or null while healthy. */
  degradedSinceMs: number | null;
  /** Latest tick that read the log files successfully, or null before the first one. */
  lastSuccessfulTickAtMs: number | null;
}

export interface SandboxRunLogTailHandle {
  /**
   * Wrap the agent CLI invocation in a shell script that tees stdout/stderr
   * into tailable log files while preserving the original streams (the
   * provider result must keep the full stdout for adapter parsing) and the
   * original exit code.
   */
  wrapCommand(command: string, args: string[]): { command: string; args: string[] };
  /** Start the host-side poll loop that tails the log files via the runner. */
  start(onLog: SandboxRunLogSink): void;
  /** Current tail-loop health (see `SandboxRunLogStreamHealth`). */
  health(): SandboxRunLogStreamHealth;
  /**
   * Stop the poll loop and emit any bytes of the final batched output that
   * were not already streamed. Emitting the suffix past the streamed byte
   * offset both dedupes the final batch and guarantees full coverage when
   * the tail loop degraded mid-run.
   */
  finish(finalBatch: { stdout: string; stderr: string }): Promise<void>;
  /** Stop the poll loop without emitting anything further (error path). */
  abort(): Promise<void>;
}

export interface SandboxRunLogTailFactory {
  create(): SandboxRunLogTailHandle;
}

export interface SandboxRunLogTailFactoryOptions {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  /** Remote directory the log files live in (bridge queue `logs/` dir). */
  logsDir: string;
  shellCommand?: "bash" | "sh" | null;
  pollIntervalMs?: number | null;
  maxChunkBytesPerTick?: number | null;
  tickTimeoutMs?: number | null;
  maxConsecutiveFailures?: number | null;
  /** Cap on the exponential backoff between retries once degraded. */
  maxBackoffMs?: number | null;
  /** How long a degraded stream may keep extending the idle deadline before it stops asserting activity. */
  degradedHeartbeatBudgetMs?: number | null;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

function normalizePositiveInt(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

interface TailStreamState {
  stream: "stdout" | "stderr";
  logFile: string;
  offset: number;
  decoder: StringDecoder;
}

function decodeBase64Section(lines: string[]): Buffer {
  const joined = lines.join("").replace(/\s+/g, "");
  if (joined.length === 0) return Buffer.alloc(0);
  return Buffer.from(joined, "base64");
}

export function createSandboxRunLogTailFactory(
  options: SandboxRunLogTailFactoryOptions,
): SandboxRunLogTailFactory {
  const shellCommand = preferredShellForSandbox(options.shellCommand);
  const pollIntervalMs = normalizePositiveInt(options.pollIntervalMs, DEFAULT_TAIL_POLL_INTERVAL_MS);
  const maxChunkBytes = normalizePositiveInt(options.maxChunkBytesPerTick, DEFAULT_TAIL_MAX_CHUNK_BYTES);
  const tickTimeoutMs = normalizePositiveInt(options.tickTimeoutMs, DEFAULT_TAIL_TICK_TIMEOUT_MS);
  const maxConsecutiveFailures = normalizePositiveInt(
    options.maxConsecutiveFailures,
    DEFAULT_TAIL_MAX_CONSECUTIVE_FAILURES,
  );
  const maxBackoffMs = normalizePositiveInt(options.maxBackoffMs, DEFAULT_TAIL_MAX_BACKOFF_MS);
  const degradedHeartbeatBudgetMs = normalizePositiveInt(
    options.degradedHeartbeatBudgetMs,
    DEFAULT_TAIL_DEGRADED_HEARTBEAT_BUDGET_MS,
  );
  const now = options.now ?? Date.now;

  let sequence = 0;

  function createHandle(): SandboxRunLogTailHandle {
    sequence += 1;
    const baseName = `run-${sequence}`;
    const stdoutLog = path.posix.join(options.logsDir, `${baseName}-stdout.log`);
    const stderrLog = path.posix.join(options.logsDir, `${baseName}-stderr.log`);
    const statusFile = path.posix.join(options.logsDir, `${baseName}-status`);

    const streams: [TailStreamState, TailStreamState] = [
      { stream: "stdout", logFile: stdoutLog, offset: 0, decoder: new StringDecoder("utf8") },
      { stream: "stderr", logFile: stderrLog, offset: 0, decoder: new StringDecoder("utf8") },
    ];

    let sink: SandboxRunLogSink | null = null;
    let stopped = false;
    let degraded = false;
    let degradedSinceMs: number | null = null;
    let lastSuccessfulTickAtMs: number | null = null;
    let loopPromise: Promise<void> | null = null;
    let wakeSleep: (() => void) | null = null;

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wakeSleep = null;
          resolve();
        }, ms);
        wakeSleep = () => {
          clearTimeout(timer);
          wakeSleep = null;
          resolve();
        };
      });
    }

    function buildTickScript(): string {
      const lines: string[] = [`printf '%s\\n' ${shellQuote(TAIL_MARKER_STDOUT)}`];
      for (const state of streams) {
        if (state.stream === "stderr") {
          lines.push(`printf '%s\\n' ${shellQuote(TAIL_MARKER_STDERR)}`);
        }
        lines.push(
          `if [ -f ${shellQuote(state.logFile)} ]; then tail -c +${state.offset + 1} ${shellQuote(state.logFile)} | head -c ${maxChunkBytes} | base64; fi`,
        );
      }
      lines.push(`printf '%s\\n' ${shellQuote(TAIL_MARKER_END)}`);
      return lines.join("\n");
    }

    function parseTickOutput(stdout: string): { stdout: Buffer; stderr: Buffer } | null {
      const lines = stdout.split(/\r?\n/);
      const stdoutIndex = lines.indexOf(TAIL_MARKER_STDOUT);
      const stderrIndex = lines.indexOf(TAIL_MARKER_STDERR);
      const endIndex = lines.indexOf(TAIL_MARKER_END);
      if (stdoutIndex < 0 || stderrIndex < stdoutIndex || endIndex < stderrIndex) {
        return null;
      }
      return {
        stdout: decodeBase64Section(lines.slice(stdoutIndex + 1, stderrIndex)),
        stderr: decodeBase64Section(lines.slice(stderrIndex + 1, endIndex)),
      };
    }

    /**
     * Log a status line through the run's own log sink, best-effort: the
     * tail loop's job is reading the sandbox, not writing the run log, so a
     * sink failure (e.g. the run already finished persisting its log) must
     * not stop the loop from retrying.
     */
    async function emitStatusLine(stream: "stdout" | "stderr", line: string): Promise<void> {
      if (!sink) return;
      try {
        await sink(stream, line);
      } catch {
        // See above: the next tick still gets a chance regardless.
      }
    }

    async function emitBytes(state: TailStreamState, bytes: Buffer): Promise<void> {
      if (bytes.length === 0) return;
      state.offset += bytes.length;
      const text = state.decoder.write(bytes);
      if (text.length > 0 && sink) {
        await sink(state.stream, text);
      }
    }

    async function tick(): Promise<void> {
      const result = await options.runner.execute({
        command: shellCommand,
        args: shellCommandArgs(buildTickScript()),
        cwd: options.remoteCwd,
        env: { [SANDBOX_EXEC_CHANNEL_ENV]: SANDBOX_EXEC_CHANNEL_BRIDGE },
        timeoutMs: tickTimeoutMs,
      });
      if (result.timedOut || (result.exitCode ?? 1) !== 0) {
        throw new Error(
          `Run log tail tick failed (exit ${result.exitCode ?? "null"}${result.timedOut ? ", timed out" : ""}).`,
        );
      }
      const sections = parseTickOutput(result.stdout);
      if (!sections) {
        throw new Error("Run log tail tick returned unparseable output.");
      }
      await emitBytes(streams[0], sections.stdout);
      await emitBytes(streams[1], sections.stderr);
    }

    async function loop(): Promise<void> {
      let consecutiveFailures = 0;
      while (!stopped) {
        // Ordinary cadence while healthy; exponential backoff (capped) once
        // degraded, so an overloaded host is not hammered with retries.
        const delayMs = degraded
          ? Math.min(
              maxBackoffMs,
              pollIntervalMs * 2 ** (consecutiveFailures - maxConsecutiveFailures + 1),
            )
          : pollIntervalMs;
        await sleep(delayMs);
        if (stopped) break;
        try {
          await tick();
          lastSuccessfulTickAtMs = now();
          if (degraded) {
            const failedTicks = consecutiveFailures;
            degraded = false;
            degradedSinceMs = null;
            // The offsets were never reset on failure, so this tick resumed
            // exactly where the last successful one left off: nothing
            // skipped, nothing duplicated.
            await emitStatusLine(
              "stderr",
              `[paperclip] Run log streaming recovered after ${failedTicks} failed tick${failedTicks === 1 ? "" : "s"}; resuming from the last delivered offset.\n`,
            );
          }
          consecutiveFailures = 0;
        } catch {
          consecutiveFailures += 1;
          if (consecutiveFailures === maxConsecutiveFailures) {
            degraded = true;
            degradedSinceMs = now();
            await emitStatusLine(
              "stderr",
              "[paperclip] Run log streaming degraded (the host could not read the sandbox's log files); " +
                "retrying with backoff. The run keeps working and no output already produced is lost.\n",
            );
          } else if (degraded && now() - degradedSinceMs! <= degradedHeartbeatBudgetMs) {
            // Still retrying: say so on the same channel the idle watchdog
            // reads, so it extends its deadline instead of reading this
            // silence as the run having gone quiet. Past the budget above,
            // this stops firing and the ordinary idle timeout (if the run
            // is truly stuck) is left to do its job.
            await emitStatusLine(
              "stderr",
              `[paperclip] Run log streaming still degraded (${consecutiveFailures} failed ticks so far); still retrying.\n`,
            );
          }
          // Never give up while the run is active: loop back around and
          // try again, instead of breaking out for good.
        }
      }
    }

    async function stopLoop(): Promise<void> {
      stopped = true;
      wakeSleep?.();
      if (loopPromise) {
        await loopPromise.catch(() => undefined);
        loopPromise = null;
      }
    }

    return {
      wrapCommand(command, args) {
        const quotedInvocation = [command, ...args].map(shellQuote).join(" ");
        // Tee stdout/stderr into tailable log files while keeping both
        // streams flowing to the provider result. fd 3 carries the real
        // stdout out of the inner group so stderr can ride the inner pipe
        // into its own tee. The exit status survives the pipeline through
        // the status file.
        const script = [
          `out_log=${shellQuote(stdoutLog)}`,
          `err_log=${shellQuote(stderrLog)}`,
          `status_file=${shellQuote(statusFile)}`,
          `mkdir -p ${shellQuote(options.logsDir)}`,
          `: > "$out_log"`,
          `: > "$err_log"`,
          `rm -f "$status_file"`,
          `{`,
          `  { ${quotedInvocation} 3>&-; printf '%s' "$?" > "$status_file"; } 2>&1 1>&3 | tee -a "$err_log" >&2`,
          `} 3>&1 | tee -a "$out_log"`,
          `if [ -s "$status_file" ]; then exit "$(cat "$status_file")"; fi`,
          `exit 1`,
        ].join("\n");
        return { command: shellCommand, args: shellCommandArgs(script) };
      },
      start(onLog) {
        if (loopPromise || stopped) return;
        sink = onLog;
        loopPromise = loop();
      },
      health() {
        return { degraded, degradedSinceMs, lastSuccessfulTickAtMs };
      },
      async finish(finalBatch) {
        await stopLoop();
        if (!sink) return;
        for (const state of streams) {
          const finalBytes = Buffer.from(
            state.stream === "stdout" ? finalBatch.stdout : finalBatch.stderr,
            "utf8",
          );
          if (finalBytes.length > state.offset) {
            const text = state.decoder.write(finalBytes.subarray(state.offset));
            if (text.length > 0) {
              await sink(state.stream, text);
            }
          }
          const rest = state.decoder.end();
          if (rest.length > 0) {
            await sink(state.stream, rest);
          }
        }
        if (degraded) {
          // The loop never gave up, but the stream was still degraded when
          // the run ended; the lines above fill in whatever the last
          // successful tick had not yet caught up on.
          await sink(
            "stderr",
            "[paperclip] Run log streaming was still degraded when the run completed; remaining output was delivered at completion.\n",
          );
        }
      },
      async abort() {
        await stopLoop();
      },
    };
  }

  return { create: createHandle };
}
