import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { publishLiveEvent } from "../services/live-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping live events websocket board API key tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type LiveEventsConnection =
  | { status: 101; socket: WebSocket }
  | { status: number; socket: null };

// Opens a real client connection and reports the handshake status: 101 with an
// open socket, or the HTTP status the server rejected the upgrade with.
function connectLiveEvents(
  port: number,
  companyId: string,
  token: string,
  via: "header" | "query" = "header",
): Promise<LiveEventsConnection> {
  const path = `/api/companies/${encodeURIComponent(companyId)}/events/ws`;
  const url = via === "query"
    ? `ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`
    : `ws://127.0.0.1:${port}${path}`;
  const socket = new WebSocket(url, {
    headers: via === "header" ? { authorization: `Bearer ${token}` } : {},
  });
  return new Promise((resolve, reject) => {
    let upgradeStatus = 0;
    socket.once("upgrade", (res) => {
      upgradeStatus = res.statusCode ?? 0;
    });
    socket.once("open", () => resolve({ status: upgradeStatus as 101, socket }));
    socket.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, socket: null });
    });
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
  });
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });

  it("authorizes a cloud-proxied browser for a company in its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    const socket = new FakeUpgradeSocket();
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => {
        // Stop before the ws handshake writes to the fake socket; the
        // assertion is that authorization passed without any rejection.
        socket.writable = false;
        return { userId: "cloud-user-1", companyIds: ["company-1", "company-2"] };
      },
    });

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("rejects a cloud actor for a company outside its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => ({ userId: "cloud-user-1", companyIds: ["company-other"] }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    // A resolved cloud actor is authoritative; the session path must not run.
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("falls through to session auth when no cloud actor resolves", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => null,
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(socket.endedChunks[0]).toContain("403 Forbidden");
  });
});

describeEmbeddedPostgres("setupLiveEventsWebSocketServer board API keys", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;
  let wss: ReturnType<typeof setupLiveEventsWebSocketServer> | null = null;
  let port = 0;
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-ws-");
    db = createDb(tempDb.connectionString);
    server = createServer();
    wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated" });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }, 20_000);

  afterEach(async () => {
    for (const socket of openSockets) socket.terminate();
    openSockets.clear();
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(boardApiKeys);
    await db.delete(instanceUserRoles);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    for (const client of wss?.clients ?? []) client.terminate();
    (wss as unknown as { close(): void } | null)?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await tempDb?.cleanup();
  });

  async function connect(companyId: string, token: string, via: "header" | "query" = "header") {
    const connection = await connectLiveEvents(port, companyId, token, via);
    if (connection.socket) openSockets.add(connection.socket);
    return connection;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId}`,
      issuePrefix: `WS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedUser(input: {
    memberships?: Array<{ companyId: string; status?: string }>;
    instanceAdmin?: boolean;
  } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Board User",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    for (const membership of input.memberships ?? []) {
      await db.insert(companyMemberships).values({
        companyId: membership.companyId,
        principalType: "user",
        principalId: userId,
        status: membership.status ?? "active",
        membershipRole: "operator",
      });
    }
    if (input.instanceAdmin) {
      await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    }
    return userId;
  }

  function issueBoardKey(userId: string, expiresAt?: Date) {
    return boardAuthService(db).createNamedBoardApiKey({ userId, name: "live events test", expiresAt });
  }

  it("streams company events to a board API key of a company member", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser({ memberships: [{ companyId }] });
    const key = await issueBoardKey(userId);

    const connection = await connect(companyId, key.token);
    expect(connection.status).toBe(101);

    const received = nextMessage(connection.socket!);
    publishLiveEvent({ companyId, type: "activity.logged", payload: { marker: "board-key-stream" } });
    await expect(received).resolves.toMatchObject({
      companyId,
      type: "activity.logged",
      payload: { marker: "board-key-stream" },
    });

    // Last use is recorded in the background, like REST requests with the key.
    await vi.waitFor(async () => {
      const [row] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.id, key.id));
      expect(row?.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  it("rejects a board API key for a company without an active membership", async () => {
    const memberCompanyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const suspendedCompanyId = await seedCompany();
    const userId = await seedUser({
      memberships: [
        { companyId: memberCompanyId },
        { companyId: suspendedCompanyId, status: "suspended" },
      ],
    });
    const key = await issueBoardKey(userId);

    expect((await connect(memberCompanyId, key.token)).status).toBe(101);
    expect((await connect(otherCompanyId, key.token)).status).toBe(403);
    expect((await connect(suspendedCompanyId, key.token)).status).toBe(403);
  });

  it("rejects a board API key once it is revoked", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser({ memberships: [{ companyId }] });
    const key = await issueBoardKey(userId);

    expect((await connect(companyId, key.token)).status).toBe(101);
    await boardAuthService(db).revokeBoardApiKey(key.id);
    expect((await connect(companyId, key.token)).status).toBe(403);
  });

  it("rejects an expired board API key", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser({ memberships: [{ companyId }] });
    const expired = await issueBoardKey(userId, new Date(Date.now() - 60_000));
    const current = await issueBoardKey(userId);

    expect((await connect(companyId, expired.token)).status).toBe(403);
    expect((await connect(companyId, current.token)).status).toBe(101);
  });

  it("allows an instance admin board API key for any company", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser({ instanceAdmin: true });
    const key = await issueBoardKey(userId);

    const connection = await connect(companyId, key.token);
    expect(connection.status).toBe(101);

    const received = nextMessage(connection.socket!);
    publishLiveEvent({ companyId, type: "activity.logged", payload: { marker: "instance-admin" } });
    await expect(received).resolves.toMatchObject({ companyId, payload: { marker: "instance-admin" } });
  });

  it("accepts a board API key in the token query parameter, like agent keys", async () => {
    const companyId = await seedCompany();
    const userId = await seedUser({ memberships: [{ companyId }] });
    const boardKey = await issueBoardKey(userId);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Live events agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const agentToken = `pcp_agent_test_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "live events test",
      keyHash: createHash("sha256").update(agentToken).digest("hex"),
    });

    expect((await connect(companyId, agentToken, "query")).status).toBe(101);
    expect((await connect(companyId, boardKey.token, "query")).status).toBe(101);
  });
});
