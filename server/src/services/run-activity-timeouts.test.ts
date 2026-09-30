import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUN_IDLE_TIMEOUT_SEC,
  buildTimeCapContinuationInstruction,
  classifyTimeCapStop,
  createRunActivityWatchdog,
  isPlatformOnlyLogChunk,
  resolveRunIdleTimeoutPolicy,
  resolveTimeCapContinuationPolicy,
  type RunActivitySnapshot,
} from "./run-activity-timeouts.js";

describe("resolveRunIdleTimeoutPolicy", () => {
  it.each([
    { name: "unset", config: {}, expected: { idleTimeoutSec: DEFAULT_RUN_IDLE_TIMEOUT_SEC, source: "default" } },
    { name: "zero (form default)", config: { idleTimeoutSec: 0 }, expected: { idleTimeoutSec: DEFAULT_RUN_IDLE_TIMEOUT_SEC, source: "default" } },
    { name: "positive", config: { idleTimeoutSec: 600 }, expected: { idleTimeoutSec: 600, source: "configured" } },
    { name: "numeric string", config: { idleTimeoutSec: "300" }, expected: { idleTimeoutSec: 300, source: "configured" } },
    { name: "sub-second", config: { idleTimeoutSec: 0.2 }, expected: { idleTimeoutSec: 1, source: "configured" } },
    { name: "negative disables", config: { idleTimeoutSec: -1 }, expected: { idleTimeoutSec: 0, source: "disabled" } },
    { name: "garbage", config: { idleTimeoutSec: "soon" }, expected: { idleTimeoutSec: DEFAULT_RUN_IDLE_TIMEOUT_SEC, source: "default" } },
  ])("resolves $name", ({ config, expected }) => {
    expect(resolveRunIdleTimeoutPolicy("claude_local", config)).toEqual(expected);
  });

  it("leaves the idle timer off by default for command and webhook adapters", () => {
    for (const adapterType of ["process", "http"]) {
      expect(resolveRunIdleTimeoutPolicy(adapterType, {})).toEqual({ idleTimeoutSec: 0, source: "disabled" });
      expect(resolveRunIdleTimeoutPolicy(adapterType, { idleTimeoutSec: 60 })).toEqual({ idleTimeoutSec: 60, source: "configured" });
    }
  });
});

describe("resolveTimeCapContinuationPolicy", () => {
  it("is on by default with a small bound", () => {
    expect(resolveTimeCapContinuationPolicy({})).toEqual({ enabled: true, maxAttempts: 3, delayMs: 1000 });
  });

  it("reads and clamps runtimeConfig.heartbeat.timeCapContinuation", () => {
    expect(
      resolveTimeCapContinuationPolicy({
        heartbeat: { timeCapContinuation: { enabled: false, maxAttempts: 99, delayMs: -5 } },
      }),
    ).toEqual({ enabled: false, maxAttempts: 10, delayMs: 0 });
  });
});

describe("isPlatformOnlyLogChunk", () => {
  it("treats platform status lines and blank chunks as non-provider output", () => {
    expect(isPlatformOnlyLogChunk("[paperclip] Syncing workspace\n")).toBe(true);
    expect(isPlatformOnlyLogChunk("[paperclip] a\n  \n[paperclip] b\n")).toBe(true);
    expect(isPlatformOnlyLogChunk("[paperclip] a\r\n[paperclip] b\r\n")).toBe(true);
    expect(isPlatformOnlyLogChunk("\n")).toBe(true);
  });

  it("treats any other line as provider output", () => {
    expect(isPlatformOnlyLogChunk('{"type":"tool_call"}\n')).toBe(false);
    expect(isPlatformOnlyLogChunk("[paperclip] note\nediting src/app.ts\n")).toBe(false);
  });

  it("does not take copies of platform lines inside provider output for platform lines", () => {
    // Indented, as in a code block or a log dump.
    expect(isPlatformOnlyLogChunk("    [paperclip] Syncing workspace\n")).toBe(false);
    expect(isPlatformOnlyLogChunk("\t[paperclip] Syncing workspace\n")).toBe(false);
    // Quoted or embedded in structured output.
    expect(isPlatformOnlyLogChunk("> [paperclip] Syncing workspace\n")).toBe(false);
    expect(
      isPlatformOnlyLogChunk('{"type":"text","text":"[paperclip] Syncing workspace"}\n'),
    ).toBe(false);
    // Not the platform's line format.
    expect(isPlatformOnlyLogChunk("[paperclip]Syncing workspace\n")).toBe(false);
  });
});

describe("createRunActivityWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never stops a run that keeps producing output, well past an hour-long wall-clock limit", () => {
    const onIdle = vi.fn(() => true);
    const watchdog = createRunActivityWatchdog({ idleTimeoutMs: 900_000, onIdle });
    // A slow model: one tool call every four minutes for two hours.
    for (let elapsed = 0; elapsed < 2 * 60 * 60 * 1000; elapsed += 240_000) {
      vi.advanceTimersByTime(240_000);
      watchdog.recordActivity("provider");
    }
    expect(onIdle).not.toHaveBeenCalled();
    expect(watchdog.snapshot().idleFiredAt).toBeNull();
    watchdog.stop();
  });

  it("fires once after idleTimeoutMs without output", () => {
    const onIdle = vi.fn(() => true);
    const watchdog = createRunActivityWatchdog({ idleTimeoutMs: 900_000, onIdle });
    vi.advanceTimersByTime(300_000);
    watchdog.recordActivity("provider");
    vi.advanceTimersByTime(899_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    const snapshot = (onIdle.mock.calls as unknown as Array<[RunActivitySnapshot]>)[0]![0];
    expect(snapshot.idleFiredAt! - snapshot.lastActivityAt).toBe(900_000);
    vi.advanceTimersByTime(10 * 900_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(watchdog.snapshot().idleFiredAt).not.toBeNull();
  });

  it("keeps watching when the run could not be stopped yet", () => {
    let stoppable = false;
    const onIdle = vi.fn(() => stoppable);
    const watchdog = createRunActivityWatchdog({ idleTimeoutMs: 1_000, onIdle });
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(watchdog.snapshot().idleFiredAt).toBeNull();
    // The next check is a full window later, not a busy loop.
    vi.advanceTimersByTime(999);
    expect(onIdle).toHaveBeenCalledTimes(1);
    stoppable = true;
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(2);
    expect(watchdog.snapshot().idleFiredAt).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("counts platform progress as activity but not as provider output", () => {
    const onIdle = vi.fn(() => true);
    const watchdog = createRunActivityWatchdog({ idleTimeoutMs: 1_000, onIdle });
    vi.advanceTimersByTime(900);
    watchdog.recordActivity("platform");
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled();
    expect(watchdog.snapshot().lastProviderActivityAt).toBeNull();
    watchdog.stop();
  });

  it("does not fire after stop or when disabled", () => {
    const stoppedIdle = vi.fn(() => true);
    const stopped = createRunActivityWatchdog({ idleTimeoutMs: 1_000, onIdle: stoppedIdle });
    stopped.stop();
    const disabledIdle = vi.fn(() => true);
    createRunActivityWatchdog({ idleTimeoutMs: 0, onIdle: disabledIdle });
    vi.advanceTimersByTime(60_000);
    expect(stoppedIdle).not.toHaveBeenCalled();
    expect(disabledIdle).not.toHaveBeenCalled();
  });
});

describe("classifyTimeCapStop", () => {
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  const hour = 60 * 60 * 1000;

  it("classifies a cap hit with recent provider output as productive", () => {
    expect(
      classifyTimeCapStop({
        snapshot: { startedAt, lastActivityAt: startedAt + hour - 1_000, lastProviderActivityAt: startedAt + hour - 180_000, idleFiredAt: null },
        stoppedAt: startedAt + hour,
        windowSec: 900,
      }),
    ).toEqual({ productive: true, runDurationMs: hour, providerSilenceMs: 180_000 });
  });

  it("classifies a cap hit after a long provider silence as stalled, even with platform chatter", () => {
    expect(
      classifyTimeCapStop({
        snapshot: { startedAt, lastActivityAt: startedAt + hour - 1_000, lastProviderActivityAt: startedAt + hour - 1_200_000, idleFiredAt: null },
        stoppedAt: startedAt + hour,
        windowSec: 900,
      }).productive,
    ).toBe(false);
  });

  it("does not treat a cap shorter than the activity window as a safety-net hit", () => {
    expect(
      classifyTimeCapStop({
        snapshot: { startedAt, lastActivityAt: startedAt + 110_000, lastProviderActivityAt: startedAt + 110_000, idleFiredAt: null },
        stoppedAt: startedAt + 120_000,
        windowSec: 900,
      }).productive,
    ).toBe(false);
  });

  it("classifies a run that never produced output as stalled", () => {
    expect(
      classifyTimeCapStop({
        snapshot: { startedAt, lastActivityAt: startedAt, lastProviderActivityAt: null, idleFiredAt: null },
        stoppedAt: startedAt + hour,
        windowSec: 900,
      }),
    ).toEqual({ productive: false, runDurationMs: hour, providerSilenceMs: null });
  });
});

describe("buildTimeCapContinuationInstruction", () => {
  it("tells the next run when the cap was reached and to continue from the workspace", () => {
    const instruction = buildTimeCapContinuationInstruction("2026-01-01T01:00:00.000Z");
    expect(instruction).toContain("Your previous run reached the time cap at 2026-01-01T01:00:00.000Z");
    expect(instruction).toContain("continue from the workspace state");
  });
});
