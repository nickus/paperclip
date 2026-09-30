import { describe, expect, it, vi } from "vitest";
import { createHeartbeatStartupRecoveryGate } from "../heartbeat-startup-recovery-gate.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("heartbeat startup recovery gate", () => {
  it("lets ticks proceed when no recovery is held", async () => {
    const isSchedulingSuppressed = vi.fn(async () => false);
    const gate = createHeartbeatStartupRecoveryGate({ isSchedulingSuppressed, onError: vi.fn() });

    expect(await gate.beforeTick()).toBe("proceed");
    expect(isSchedulingSuppressed).not.toHaveBeenCalled();
  });

  it("keeps the recovery held while the drain lasts, then runs it once in place of a tick", async () => {
    let suppressed = true;
    const recovery = vi.fn(async () => {});
    const gate = createHeartbeatStartupRecoveryGate({
      isSchedulingSuppressed: async () => suppressed,
      onError: vi.fn(),
    });
    gate.hold(recovery);

    expect(await gate.beforeTick()).toBe("proceed");
    expect(await gate.beforeTick()).toBe("proceed");
    expect(recovery).not.toHaveBeenCalled();

    suppressed = false;
    expect(await gate.beforeTick()).toBe("skip");
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(await gate.beforeTick()).toBe("proceed");
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping ticks while the recovery runs", async () => {
    const running = deferred();
    const recovery = vi.fn(() => running.promise);
    const gate = createHeartbeatStartupRecoveryGate({
      isSchedulingSuppressed: async () => false,
      onError: vi.fn(),
    });
    gate.hold(recovery);

    const first = gate.beforeTick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await gate.beforeTick()).toBe("skip");
    running.resolve();
    expect(await first).toBe("skip");
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(await gate.beforeTick()).toBe("proceed");
  });

  it("reports a failed recovery and tries it again on the next tick", async () => {
    const onError = vi.fn();
    const failure = new Error("native recovery failed closed");
    const recovery = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const gate = createHeartbeatStartupRecoveryGate({
      isSchedulingSuppressed: async () => false,
      onError,
    });
    gate.hold(recovery);

    expect(await gate.beforeTick()).toBe("skip");
    expect(onError).toHaveBeenCalledWith(failure);
    expect(await gate.beforeTick()).toBe("skip");
    expect(recovery).toHaveBeenCalledTimes(2);
    expect(await gate.beforeTick()).toBe("proceed");
    expect(recovery).toHaveBeenCalledTimes(2);
  });
});
