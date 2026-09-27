import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { KubeConfig } from "@kubernetes/client-node";
import { execInPod, PodExecTransportError } from "../../src/pod-exec.js";

// End-to-end check of the keepalive against the REAL @kubernetes/client-node
// Exec + the real `ws` WebSocket it returns, talking to a local `ws` server that
// speaks the k8s channel protocol (1-byte stream prefix, status on channel 3).
// This pins the assumptions the fake-socket tests make: the exec promise yields
// a `ws` instance with on()/ping()/terminate(), the server auto-answers pings,
// and a server-side drop surfaces as a 'close' event with no status frame.

// `ws` is not a direct dependency; load the exact copy the k8s client uses.
// Resolve from the client's real (pnpm store) directory, where `ws` is a sibling.
const clientDir = realpathSync(
  fileURLToPath(new URL("../../node_modules/@kubernetes/client-node/package.json", import.meta.url)),
);
const requireFromClient = createRequire(clientDir);
const { WebSocketServer } = requireFromClient("ws") as typeof import("ws");

type Behavior = (socket: import("ws").WebSocket) => void;
let behavior: Behavior = () => undefined;
let server: InstanceType<typeof WebSocketServer>;
let kc: KubeConfig;

const frame = (channel: number, payload: string | Buffer) =>
  Buffer.concat([Buffer.from([channel]), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
const SUCCESS = JSON.stringify({ metadata: {}, status: "Success" });

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, handleProtocols: () => "v4.channel.k8s.io" });
  server.on("connection", (socket) => behavior(socket));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "local", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: "anon" }],
    contexts: [{ name: "local", cluster: "local", user: "anon" }],
    currentContext: "local",
  });
});

afterAll(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const FAST = { keepaliveIntervalMs: 100, timeoutMs: 400 };

describe("execInPod over a real WebSocket", () => {
  it("completes normally and ignores the close that follows the status frame", async () => {
    behavior = (socket) => {
      socket.send(frame(1, "hello"));
      socket.send(frame(3, SUCCESS));
      socket.close(1000);
    };
    const result = await execInPod(kc, "ns", "pod", "agent", ["true"], undefined, 10_000, undefined, undefined, FAST);
    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
  });

  it("fails fast when the server drops the connection without a status frame", async () => {
    behavior = (socket) => {
      socket.send(frame(1, "partial"));
      setTimeout(() => socket.terminate(), 50);
    };
    const started = Date.now();
    const err = await execInPod(kc, "ns", "pod", "agent", ["sleep", "3600"], undefined, 60_000, undefined, undefined, FAST)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PodExecTransportError);
    expect((err as InstanceType<typeof PodExecTransportError>).kind).toBe("connection_closed");
    expect((err as InstanceType<typeof PodExecTransportError>).partialStdout).toBe("partial");
    expect(Date.now() - started).toBeLessThan(5_000); // not the 60s watchdog
  });

  it("detects a half-open connection (server stops reading, so no pongs)", async () => {
    behavior = (socket) => {
      // Stop reading the TCP socket: pings are never processed, pongs never
      // sent, but the connection stays up — the silent-drop / NAT case.
      (socket as unknown as { _socket: { pause(): void } })._socket.pause();
    };
    const started = Date.now();
    const err = await execInPod(kc, "ns", "pod", "agent", ["sleep", "3600"], undefined, 60_000, undefined, undefined, FAST)
      .then(() => null, (e: unknown) => e);
    expect((err as InstanceType<typeof PodExecTransportError>).kind).toBe("keepalive_timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps a quiet but connected command alive well past the liveness window", async () => {
    behavior = (socket) => {
      // Silent for 5x the liveness window; the server's automatic pongs are
      // the only traffic. Then exit 7.
      setTimeout(() => {
        socket.send(frame(3, JSON.stringify({
          status: "Failure",
          details: { causes: [{ reason: "ExitCode", message: "7" }] },
        })));
        socket.close(1000);
      }, 2_000);
    };
    const result = await execInPod(kc, "ns", "pod", "agent", ["sleep", "2"], undefined, 10_000, undefined, undefined, FAST);
    expect(result.exitCode).toBe(7);
  });
});
