import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { createSandboxRunLogTailFactory, type SandboxRunLogSink } from "./sandbox-run-log-stream.js";

// The tail loop's wire protocol (see buildTickScript/parseTickOutput in the
// module under test): three markers delimiting a base64 stdout section and a
// base64 stderr section. Tests fake the runner directly, so they speak this
// protocol rather than exercising a real shell/tail pipeline.
const MARKER_STDOUT = "__PAPERCLIP_RUN_LOG_STDOUT__";
const MARKER_STDERR = "__PAPERCLIP_RUN_LOG_STDERR__";
const MARKER_END = "__PAPERCLIP_RUN_LOG_END__";

function tickStdout(newStdoutBytes: string, newStderrBytes = ""): string {
  return [
    MARKER_STDOUT,
    Buffer.from(newStdoutBytes, "utf8").toString("base64"),
    MARKER_STDERR,
    Buffer.from(newStderrBytes, "utf8").toString("base64"),
    MARKER_END,
  ].join("\n");
}

type ExecuteCall = Parameters<CommandManagedRuntimeRunner["execute"]>[0];

/** A fake runner whose `execute` (the tail's "tick") follows a fixed script. */
function scriptedRunner(
  script: Array<() => { exitCode?: number | null; timedOut?: boolean; stdout?: string }>,
): { runner: CommandManagedRuntimeRunner; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = [];
  const runner: CommandManagedRuntimeRunner = {
    execute: vi.fn(async (input: ExecuteCall) => {
      calls.push(input);
      const step = script[Math.min(calls.length - 1, script.length - 1)]!;
      const outcome = step();
      return {
        exitCode: outcome.exitCode ?? 0,
        timedOut: outcome.timedOut ?? false,
        stdout: outcome.stdout ?? tickStdout(""),
        stderr: "",
        signal: null,
        pid: null,
        startedAt: null,
      };
    }),
  };
  return { runner, calls };
}

/** Always-failing runner, for tests that only care that retries never stop. */
function alwaysFailingRunner(): { runner: CommandManagedRuntimeRunner; calls: ExecuteCall[] } {
  return scriptedRunner([() => ({ exitCode: 1 })]);
}

function recordingSink(): { sink: SandboxRunLogSink; calls: Array<{ stream: string; chunk: string }> } {
  const calls: Array<{ stream: string; chunk: string }> = [];
  const sink: SandboxRunLogSink = async (stream, chunk) => {
    calls.push({ stream, chunk });
  };
  return { sink, calls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 2): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("createSandboxRunLogTailFactory tail loop", () => {
  it("never gives up on failures: it keeps retrying well past the old give-up threshold", async () => {
    const { runner, calls } = alwaysFailingRunner();
    const factory = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/work",
      logsDir: "/logs",
      shellCommand: "bash",
      pollIntervalMs: 1,
      maxBackoffMs: 2,
      maxConsecutiveFailures: 3,
    });
    const handle = factory.create();
    const { sink } = recordingSink();
    handle.start(sink);

    // The old behavior broke the loop for good at `maxConsecutiveFailures`.
    // Wait for well past that many failed ticks and confirm it is still
    // going (health stays degraded, the loop promise never settles).
    await waitFor(() => calls.length > 20);
    expect(handle.health().degraded).toBe(true);

    await handle.abort();
  });

  it("resumes from the same offsets on recovery, delivers the backlog once, and logs one recovery line", async () => {
    // A real tail only returns the backlog once (the bytes from the last
    // known offset onward); later ticks see nothing new. Model that with a
    // one-shot flag rather than a fixed script length, since the loop keeps
    // retrying (and re-running this same step) after the test's `waitFor`
    // has already observed the delivery.
    let delivered = false;
    const { runner } = scriptedRunner([
      () => ({ exitCode: 1 }),
      () => ({ exitCode: 1 }),
      () => ({ exitCode: 1 }),
      () => ({ exitCode: 1 }),
      () => ({ exitCode: 1 }),
      () => {
        if (delivered) return { exitCode: 0, stdout: tickStdout("") };
        delivered = true;
        // The sandbox kept producing output the whole time; this tick's
        // delta is everything the file grew by since the last successful tick.
        return { exitCode: 0, stdout: tickStdout("the backlog that piled up while reads were failing\n") };
      },
    ]);
    const factory = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/work",
      logsDir: "/logs",
      shellCommand: "bash",
      pollIntervalMs: 1,
      maxBackoffMs: 2,
      maxConsecutiveFailures: 3,
    });
    const handle = factory.create();
    const { sink, calls } = recordingSink();
    handle.start(sink);

    await waitFor(() =>
      calls.some((call) => call.chunk.includes("the backlog that piled up")),
    );
    await handle.abort();

    const stdoutChunks = calls.filter((call) => call.stream === "stdout");
    // Delivered exactly once, not duplicated by the retries that preceded it.
    expect(stdoutChunks).toHaveLength(1);
    expect(stdoutChunks[0]!.chunk).toBe("the backlog that piled up while reads were failing\n");

    const statusLines = calls.filter((call) => call.stream === "stderr").map((call) => call.chunk);
    // One "just became degraded" line, then one "still degraded" line per
    // failure past the threshold (5 failures, threshold 3 -> 2 of those).
    expect(statusLines.filter((line) => line.includes("streaming degraded ("))).toHaveLength(1);
    expect(statusLines.filter((line) => line.includes("still degraded"))).toHaveLength(2);
    expect(statusLines.filter((line) => line.includes("recovered"))).toHaveLength(1);
    expect(statusLines.find((line) => line.includes("recovered"))).toContain(
      "recovered after 5 failed ticks",
    );

    expect(handle.health()).toMatchObject({ degraded: false, degradedSinceMs: null });
    expect(handle.health().lastSuccessfulTickAtMs).not.toBeNull();
  });

  it("stops asserting activity once the degraded heartbeat budget is exhausted, but keeps retrying", async () => {
    const { runner, calls: runnerCalls } = alwaysFailingRunner();
    // A monotonically increasing fake clock, independent of wall-clock sleep
    // delays: every `now()` call (there is exactly one per failed-tick
    // health check after the initial threshold) advances it by one unit, so
    // the budget boundary is exact regardless of real timing.
    let clock = 0;
    const now = () => ++clock;
    const factory = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/work",
      logsDir: "/logs",
      shellCommand: "bash",
      pollIntervalMs: 1,
      maxBackoffMs: 1,
      maxConsecutiveFailures: 1,
      degradedHeartbeatBudgetMs: 3,
      now,
    });
    const handle = factory.create();
    const { sink, calls } = recordingSink();
    handle.start(sink);

    // 1 "degraded" line (on the triggering failure) + up to 3 "still
    // degraded" lines (elapsed 1, 2, 3 against the budget of 3) = 4 total,
    // then no more even though the runner keeps being called.
    await waitFor(() => runnerCalls.length > 15);
    await handle.abort();

    const degradedLines = calls.filter(
      (call) => call.stream === "stderr" && call.chunk.includes("degraded"),
    );
    expect(degradedLines.length).toBe(4);
    // The loop itself never stopped retrying.
    expect(runnerCalls.length).toBeGreaterThan(15);
    expect(handle.health().degraded).toBe(true);
  });

  it("exposes health transitions: healthy -> degraded -> healthy", async () => {
    const { runner } = scriptedRunner([
      () => ({ exitCode: 0, stdout: tickStdout("ok\n") }),
      () => ({ exitCode: 1 }),
      () => ({ exitCode: 1 }),
      () => ({ exitCode: 0, stdout: tickStdout("ok again\n") }),
    ]);
    const factory = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/work",
      logsDir: "/logs",
      shellCommand: "bash",
      pollIntervalMs: 1,
      maxBackoffMs: 2,
      maxConsecutiveFailures: 2,
    });
    const handle = factory.create();
    const { sink, calls } = recordingSink();

    expect(handle.health()).toEqual({ degraded: false, degradedSinceMs: null, lastSuccessfulTickAtMs: null });
    handle.start(sink);

    await waitFor(() => calls.some((call) => call.chunk.includes("ok again")));
    await handle.abort();

    expect(handle.health().degraded).toBe(false);
    expect(handle.health().degradedSinceMs).toBeNull();
    expect(handle.health().lastSuccessfulTickAtMs).not.toBeNull();
  });

  it("finish() still reports a still-degraded stream when the run ends before recovery", async () => {
    const { runner } = alwaysFailingRunner();
    const factory = createSandboxRunLogTailFactory({
      runner,
      remoteCwd: "/work",
      logsDir: "/logs",
      shellCommand: "bash",
      pollIntervalMs: 1,
      maxBackoffMs: 1,
      maxConsecutiveFailures: 1,
    });
    const handle = factory.create();
    const { sink, calls } = recordingSink();
    handle.start(sink);

    await waitFor(() => handle.health().degraded === true);
    await handle.finish({ stdout: "", stderr: "" });

    expect(
      calls.some((call) => call.chunk.includes("was still degraded when the run completed")),
    ).toBe(true);
  });
});
