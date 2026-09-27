import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { PassThrough } from "node:stream";

// Dead-exec-connection detection. The k8s client hands back a `ws` WebSocket
// and never tells us when it closes after setup, so pod-exec attaches its own
// close/error/pong listeners and pings. These tests drive a fake WebSocket
// (an EventEmitter with ping/terminate) through the scenarios that matter:
// dropped connection, half-open connection, quiet-but-alive command, normal
// close after the status frame.

type StatusCb = (status: {
  status: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  bufferedAmount = 0;
  pings = 0;
  // When true, every ping is answered with a pong (a live apiserver).
  autoPong = true;
  closed = false;
  terminated = false;
  // Like `ws`: a sent message is queued in the send buffer until "flushed".
  send(data: Buffer) {
    this.bufferedAmount += data.length;
  }
  ping() {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    this.pings += 1;
    if (this.autoPong) setImmediate(() => this.emit("pong"));
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
}

let fakeWs: FakeWs;
let scriptedExec: (
  stdout: PassThrough,
  stderr: PassThrough,
  statusCb: StatusCb,
  stdin: PassThrough | null,
) => void = () => undefined;

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      _command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      // Defer so the caller has wired its stream listeners and monitor first.
      setImmediate(() => scriptedExec(stdout, stderr, statusCb, stdin));
      return fakeWs;
    }
  }
  return { Exec };
});

const { execInPod, execInPodStreaming, PodExecTransportError } = await import("../../src/pod-exec.js");

const KC = {} as never;
const CMD = ["opencode", "run"];
const RUN_BUDGET_MS = 3_600_000; // a typical 1h run timeout

// Let setImmediate/nextTick work (real) run, while the fake clock stays put.
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// Capture a promise's settlement without an unhandled-rejection window.
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

beforeEach(() => {
  fakeWs = new FakeWs();
  // Fake only the clock-driven timers; setImmediate / nextTick stay real so
  // stream plumbing and the mock's deferred script still run.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("execInPod dead-connection detection", () => {
  it("fails fast when the WebSocket closes before a status frame (the 3600s hang)", async () => {
    scriptedExec = (stdout) => {
      stdout.write(Buffer.from('{"type":"session","sessionID":"ses_1"}\n'));
      // Connection dropped mid-run: close with no status frame.
      setImmediate(() => fakeWs.emit("close", 1006, Buffer.from("")));
    };
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();

    // Settled without advancing the clock at all — not after 3600s.
    expect(state.settled).toBe(true);
    const err = state.error as InstanceType<typeof PodExecTransportError>;
    expect(err).toBeInstanceOf(PodExecTransportError);
    expect(err.kind).toBe("connection_closed");
    expect(err.message).toMatch(/code=1006/);
    expect(err.message).toMatch(/not re-run and may still be running/);
    // Partial output survives so the caller can still parse e.g. the session id.
    expect(err.partialStdout).toContain("ses_1");
  });

  it("fails fast on a WebSocket error after setup", async () => {
    scriptedExec = () => {
      setImmediate(() => fakeWs.emit("error", new Error("read ECONNRESET")));
    };
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();
    const err = state.error as InstanceType<typeof PodExecTransportError>;
    expect(err).toBeInstanceOf(PodExecTransportError);
    expect(err.kind).toBe("connection_error");
    expect(err.message).toMatch(/ECONNRESET/);
    expect(fakeWs.terminated).toBe(true);
  });

  it("detects a half-open connection (no pongs, no frames) within the liveness window", async () => {
    fakeWs.autoPong = false; // peer vanished without a FIN: pings go nowhere
    scriptedExec = () => undefined;
    const state = track(
      execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS, undefined, undefined, {
        keepaliveIntervalMs: 15_000,
        timeoutMs: 60_000,
      }),
    );
    await flush();

    await vi.advanceTimersByTimeAsync(45_000);
    expect(state.settled).toBe(false); // not yet: still inside the window
    expect(fakeWs.pings).toBe(3);

    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    const err = state.error as InstanceType<typeof PodExecTransportError>;
    expect(err).toBeInstanceOf(PodExecTransportError);
    expect(err.kind).toBe("keepalive_timeout");
    expect(err.message).toMatch(/liveness timeout 60000ms/);
    // A dead peer gets a hard teardown, not a close handshake it cannot answer.
    expect(fakeWs.terminated).toBe(true);
  });

  it("uses the 15s/60s defaults when no liveness options are passed", async () => {
    fakeWs.autoPong = false;
    scriptedExec = () => undefined;
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("keepalive_timeout");
  });

  it("never kills a quiet but connected command (pongs keep it alive)", async () => {
    // Emits nothing for 30 minutes, then exits 0. The apiserver keeps answering
    // pings the whole time, which is exactly the "thinking agent" case.
    let finish: (() => void) | null = null;
    scriptedExec = (stdout, stderr, statusCb) => {
      finish = () => {
        stdout.write(Buffer.from("done"));
        stdout.end();
        stderr.end();
        statusCb({ status: "Success" });
      };
    };
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();

    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      await flush(); // deliver the pong
    }
    expect(state.settled).toBe(false);
    expect(fakeWs.pings).toBe(120);

    finish!();
    await flush();
    expect(state.value).toEqual({ exitCode: 0, stdout: "done", stderr: "" });

    // Monitor is torn down: no more pings after the exec resolved.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeWs.pings).toBe(120);
    expect(fakeWs.listenerCount("close")).toBe(0);
    expect(fakeWs.listenerCount("pong")).toBe(0);
  });

  it("treats inbound output frames as liveness even when pongs are lost", async () => {
    fakeWs.autoPong = false;
    scriptedExec = () => undefined;
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      fakeWs.emit("message", Buffer.from([1, 0x41])); // a stdout frame arrived
    }
    expect(state.settled).toBe(false);
  });

  it("treats outbound send progress as liveness (big stdin upload queued ahead of the ping)", async () => {
    fakeWs.autoPong = false;
    fakeWs.bufferedAmount = 10_000_000;
    scriptedExec = () => undefined;
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();
    // Send buffer drains a little every tick for 5 minutes -> peer is ACKing.
    for (let i = 0; i < 20; i++) {
      fakeWs.bufferedAmount -= 100_000;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(state.settled).toBe(false);
    // Draining stops: the connection is dead after the liveness window.
    await vi.advanceTimersByTimeAsync(75_000);
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("keepalive_timeout");
  });

  it("ignores the normal close that follows the status frame", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("out"));
      statusCb({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "3" }] } });
      // Close lands before the stream `end` events have drained.
      fakeWs.emit("close", 1000, Buffer.from(""));
      stdout.end();
      stderr.end();
    };
    const result = await execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS);
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "" });
  });

  it("keepaliveIntervalMs=0 disables pinging but still honors close events", async () => {
    fakeWs.autoPong = false;
    let drop: (() => void) | null = null;
    scriptedExec = () => {
      drop = () => fakeWs.emit("close", 1006, "");
    };
    const state = track(
      execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS, undefined, undefined, {
        keepaliveIntervalMs: 0,
      }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.settled).toBe(false);
    expect(fakeWs.pings).toBe(0);
    drop!();
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("connection_closed");
  });

  it("floors the liveness timeout at two keepalive intervals", async () => {
    fakeWs.autoPong = false;
    scriptedExec = () => undefined;
    const state = track(
      execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS, undefined, undefined, {
        keepaliveIntervalMs: 30_000,
        timeoutMs: 1_000, // nonsensically small; must not fire before 2 intervals
      }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("keepalive_timeout");
  });

  it("fails immediately when the socket is already closed at setup", async () => {
    fakeWs.readyState = 3;
    scriptedExec = () => undefined;
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, RUN_BUDGET_MS));
    await flush();
    const err = state.error as InstanceType<typeof PodExecTransportError>;
    expect(err.kind).toBe("connection_closed");
    expect(err.message).toMatch(/already closed/);
  });

  it("does not feed stdin into an exec whose socket was already closed at setup", async () => {
    fakeWs.readyState = 3;
    let execStdin: PassThrough | null = null;
    scriptedExec = (_stdout, _stderr, _statusCb, stdin) => { execStdin = stdin; };
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, "payload", RUN_BUDGET_MS));
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("connection_closed");
    // The monitor's synchronous verdict short-circuits the stdin wiring.
    expect(execStdin!.writableEnded).toBe(false);
  });

  it("reports the overall watchdog as kind=timeout with partial output", async () => {
    scriptedExec = (_stdout, stderr) => {
      stderr.write(Buffer.from("still working"));
    };
    const state = track(execInPod(KC, "ns", "pod", "agent", CMD, undefined, 120_000));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    const err = state.error as InstanceType<typeof PodExecTransportError>;
    expect(err).toBeInstanceOf(PodExecTransportError);
    expect(err.kind).toBe("timeout");
    expect(err.partialStderr).toBe("still working");
    expect(fakeWs.pings).toBeGreaterThan(0);
  });

  it("still works with a socket double that exposes no events or ping (watchdog-only)", async () => {
    // Older/foreign clients: degrade to the previous behavior, never crash.
    fakeWs = { close() {} } as unknown as FakeWs;
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(KC, "ns", "pod", "agent", CMD, undefined, 5_000);
    expect(result.exitCode).toBe(0);
  });
});

describe("execInPodStreaming dead-connection detection", () => {
  it("fails fast when the WebSocket closes mid-transfer", async () => {
    scriptedExec = (stdout, stderr) => {
      stdout.write(Buffer.alloc(1024, 0x41));
      stderr.write(Buffer.from("tar: partial"));
      setImmediate(() => fakeWs.emit("close", 1006, ""));
    };
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const source = new Readable({ read() {} }); // never ends: an in-flight upload
    const state = track(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", "tar x"], {
        stdin: source,
        stdout: sink,
        timeoutMs: RUN_BUDGET_MS,
      }),
    );
    await flush();
    const err = state.error as InstanceType<typeof PodExecTransportError>;
    expect(err).toBeInstanceOf(PodExecTransportError);
    expect(err.kind).toBe("connection_closed");
    expect(err.message).toMatch(/^execInPodStreaming lost its exec connection/);
    expect(err.partialStderr).toBe("tar: partial");
  });

  it("counts a draining upload as alive even while its send buffer net-grows", async () => {
    fakeWs.autoPong = false; // our pings (and so the pongs) sit behind the queued upload
    scriptedExec = (_stdout, _stderr, _statusCb, stdin) => {
      // Model the k8s client: every stdin chunk is ws.send()-queued, no backpressure.
      stdin!.on("data", (chunk: Buffer) => { fakeWs.send(Buffer.concat([Buffer.from([0]), chunk])); });
    };
    const source = new Readable({ read() {} });
    const state = track(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", "head -c 9 | tar x"], {
        stdin: source,
        timeoutMs: RUN_BUDGET_MS,
      }),
    );
    await flush();
    // 5 minutes: the source enqueues 300KB per tick but the link drains only
    // 100KB, so bufferedAmount rises at EVERY tick while the peer is ACKing.
    for (let i = 0; i < 20; i++) {
      source.push(Buffer.alloc(300_000));
      await flush();
      fakeWs.bufferedAmount -= 100_000;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(state.settled).toBe(false);
    // The link stalls (nothing drains) while the source keeps enqueuing: a
    // growing buffer alone is not progress, so it dies within the window.
    for (let i = 0; i < 5; i++) {
      source.push(Buffer.alloc(300_000));
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("keepalive_timeout");
    // The counting send wrapper is removed with the monitor.
    expect(Object.prototype.hasOwnProperty.call(fakeWs, "send")).toBe(false);
  });

  it("does not pipe the caller's source into an exec whose socket was already closed", async () => {
    fakeWs.readyState = 3;
    scriptedExec = () => undefined;
    const source = new Readable({ read() {} });
    const state = track(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", "tar x"], {
        stdin: source,
        timeoutMs: RUN_BUDGET_MS,
      }),
    );
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("connection_closed");
    expect(source.readableFlowing).toBeNull(); // never piped
  });

  it("detects a half-open connection using the passed liveness options", async () => {
    fakeWs.autoPong = false;
    scriptedExec = () => undefined;
    const state = track(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", "tar c"], {
        timeoutMs: RUN_BUDGET_MS,
        liveness: { keepaliveIntervalMs: 5_000, timeoutMs: 20_000 },
      }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect((state.error as InstanceType<typeof PodExecTransportError>).kind).toBe("keepalive_timeout");
  });
});
