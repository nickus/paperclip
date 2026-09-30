import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent, publishStreamJsonEvent } from "../services/live-events.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const COMPANY = "company-ws-stream-json";

class FakeHub {
  retained = 0;
  released = 0;
  disposed = 0;
  retainCompany = vi.fn((_companyId: string) => {
    this.retained += 1;
    return () => {
      this.released += 1;
    };
  });
  dispose = () => {
    this.disposed += 1;
  };
}

interface Connection {
  status: number;
  socket: WebSocket | null;
  messages: string[];
}

describe("live events socket with format=claude-stream-json", () => {
  let server: Server | null = null;
  let wss: ReturnType<typeof setupLiveEventsWebSocketServer> | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    (wss as unknown as { close(): void } | null)?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    wss = null;
    vi.unstubAllEnvs();
  });

  async function start(hub: FakeHub | null) {
    server = createServer();
    wss = setupLiveEventsWebSocketServer(server, {} as never, {
      deploymentMode: "local_trusted",
      ...(hub ? { streamJson: { hub } } : {}),
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  function connect(port: number, query = ""): Promise<Connection> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${COMPANY}/events/ws${query}`);
    const messages: string[] = [];
    // Collect from the first frame on: the hello can arrive with the upgrade.
    socket.on("message", (data) => messages.push(String(data)));
    return new Promise((resolve, reject) => {
      socket.once("open", () => {
        sockets.push(socket);
        resolve({ status: 101, socket, messages });
      });
      socket.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, socket: null, messages: [body] }));
      });
      socket.once("error", reject);
    });
  }

  async function waitFor(messages: string[], count: number) {
    await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(count), { timeout: 2000 });
  }

  function runLogEvent(marker: string) {
    return publishLiveEvent({
      companyId: COMPANY,
      type: "heartbeat.run.log",
      payload: { runId: "run-1", seq: 1, stream: "stdout", chunk: `${marker}\n`, ts: new Date().toISOString(), truncated: false },
    });
  }

  it("leaves a default socket's event stream byte-identical and free of translated events", async () => {
    const port = await start(new FakeHub());
    const connection = await connect(port);
    const withIgnoredFlags = await connect(port, "?includeRawLogs=1&partial=1");
    const expected = [
      runLogEvent("raw-1"),
      (publishStreamJsonEvent({ companyId: COMPANY, payload: { kind: "reset", runId: "run-1", reason: "evicted" } }), null),
      publishLiveEvent({ companyId: COMPANY, type: "activity.logged", payload: { marker: "sentinel" } }),
    ].filter((event) => event !== null);
    await waitFor(connection.messages, 2);
    await waitFor(withIgnoredFlags.messages, 2);
    expect(connection.messages).toEqual(expected.map((event) => JSON.stringify(event)));
    expect(withIgnoredFlags.messages).toEqual(expected.map((event) => JSON.stringify(event)));
  });

  it("sends a hello first, then translated events and every other event except raw run logs", async () => {
    const hub = new FakeHub();
    const port = await start(hub);
    const connection = await connect(port, "?format=claude-stream-json");
    await waitFor(connection.messages, 1);
    expect(JSON.parse(connection.messages[0]!)).toMatchObject({
      companyId: COMPANY,
      type: "heartbeat.run.stream_json",
      payload: { kind: "hello", format: "claude-stream-json", formatVersion: 1, includeRawLogs: false, partial: false },
    });
    expect(hub.retainCompany).toHaveBeenCalledWith(COMPANY);

    runLogEvent("suppressed");
    const translated = publishStreamJsonEvent({
      companyId: COMPANY,
      payload: { kind: "reset", runId: "run-1", reason: "evicted" },
    });
    const other = publishLiveEvent({ companyId: COMPANY, type: "heartbeat.run.status", payload: { runId: "run-1", status: "running" } });
    await waitFor(connection.messages, 3);
    expect(connection.messages.slice(1)).toEqual([JSON.stringify(translated), JSON.stringify(other)]);

    connection.socket!.close();
    await vi.waitFor(() => expect(hub.released).toBe(1));
  });

  it("keeps raw run logs with includeRawLogs=1", async () => {
    const port = await start(new FakeHub());
    const connection = await connect(port, "?format=claude-stream-json&includeRawLogs=1&partial=1");
    await waitFor(connection.messages, 1);
    expect(JSON.parse(connection.messages[0]!).payload).toMatchObject({ includeRawLogs: true, partial: false });
    const raw = runLogEvent("kept");
    await waitFor(connection.messages, 2);
    expect(connection.messages[1]).toBe(JSON.stringify(raw));
  });

  it.each([
    ["?format=transcript", "unsupported format"],
    ["?format=claude-stream-json&includeRawLogs=yes", "unsupported includeRawLogs value"],
    ["?format=claude-stream-json&partial=2", "unsupported partial value"],
  ])("rejects %s with 400", async (query, message) => {
    const port = await start(new FakeHub());
    const connection = await connect(port, query);
    expect(connection.status).toBe(400);
    expect(connection.messages[0]).toBe(message);
  });

  it("rejects the format when no hub is configured or the kill switch is set", async () => {
    let port = await start(null);
    expect((await connect(port, "?format=claude-stream-json")).status).toBe(400);
    expect((await connect(port)).status).toBe(101);
    for (const socket of sockets.splice(0)) socket.terminate();
    (wss as unknown as { close(): void }).close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    vi.stubEnv("PAPERCLIP_STREAM_JSON", "off");
    const hub = new FakeHub();
    port = await start(hub);
    expect((await connect(port, "?format=claude-stream-json")).status).toBe(400);
    expect(hub.retainCompany).not.toHaveBeenCalled();
  });
});
