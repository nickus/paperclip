import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { STREAM_JSON_FORMAT, STREAM_JSON_FORMAT_VERSION } from "@paperclipai/adapter-utils/stream-json";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { boardAuthService } from "../services/board-auth.js";
import {
  createLiveEvent,
  subscribeCompanyLiveEvents,
  subscribeCompanyStreamJsonEvents,
} from "../services/live-events.js";
import type { RunStreamJsonHub } from "../services/run-stream-json-hub.js";
import { isStreamJsonEnabled } from "../services/run-stream-json-flags.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  /** Set when the socket opted in to translated run output. */
  streamJson?: StreamJsonOptIn | null;
}

/** Query options of `?format=claude-stream-json`. */
interface StreamJsonOptIn {
  /** Keep raw `heartbeat.run.log` events next to the translated ones. */
  includeRawLogs: boolean;
}

/** Cloud-proxied browser identity resolved from trusted x-paperclip-cloud-* headers. */
export interface CloudUpgradeActor {
  userId: string;
  /** Companies this actor may subscribe to (primary stack company + real memberships). */
  companyIds: string[];
}

type BoardAuthService = ReturnType<typeof boardAuthService>;

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Returns the request target without its query string or fragment. Clients may
 * send an API key as `?token=`, so the raw `req.url` must never be logged.
 */
function pathForLog(rawUrl: string | undefined) {
  if (!rawUrl) return rawUrl;
  const queryStart = rawUrl.search(/[?#]/);
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

function isWritableUpgradeSocket(socket: Duplex) {
  const maybeWritableState = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && maybeWritableState.writable !== false && !maybeWritableState.writableEnded && !maybeWritableState.writableDestroyed;
}

function closeUpgradeSocket(socket: Duplex) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    closeUpgradeSocket(socket);
    return;
  }

  try {
    socket.once("finish", () => closeUpgradeSocket(socket));
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch (err) {
    logger.warn({ err }, "failed to reject live websocket upgrade");
    closeUpgradeSocket(socket);
  }
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseQueryFlag(value: string | null): boolean | null {
  if (value === null || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  return null;
}

/**
 * Reads the stream-json opt-in. Without `format` the socket is a default
 * socket and every other parameter is ignored, so its event stream stays
 * exactly as before.
 */
function parseStreamJsonOptIn(
  url: URL,
  available: boolean,
): { ok: true; value: StreamJsonOptIn | null } | { ok: false; message: string } {
  const format = url.searchParams.get("format");
  if (format === null) return { ok: true, value: null };
  if (format !== STREAM_JSON_FORMAT || !available) return { ok: false, message: "unsupported format" };
  const includeRawLogs = parseQueryFlag(url.searchParams.get("includeRawLogs"));
  if (includeRawLogs === null) return { ok: false, message: "unsupported includeRawLogs value" };
  // Partial (per-delta) stream events are not produced yet; the hello event
  // reports `partial: false` so clients know.
  if (parseQueryFlag(url.searchParams.get("partial")) === null) {
    return { ok: false, message: "unsupported partial value" };
  }
  return { ok: true, value: { includeRawLogs } };
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

/**
 * Authorizes a bearer token as a board API key (issued by the CLI auth flow),
 * mirroring the board-key branch of actorMiddleware. Company scope follows the
 * session path: instance admins, or users with an active membership.
 */
async function authorizeBoardApiKeyUpgrade(
  boardAuth: BoardAuthService,
  token: string,
  companyId: string,
): Promise<UpgradeContext | null> {
  // Only returns keys that are neither revoked nor expired.
  const boardKey = await boardAuth.findBoardApiKeyByToken(token);
  if (!boardKey) return null;

  const access = await boardAuth.resolveBoardAccess(boardKey.userId);
  // Like actorMiddleware, a key whose user no longer exists does not authenticate.
  if (!access.user) return null;
  if (!access.isInstanceAdmin && !access.companyIds.includes(companyId)) return null;

  // Recording last use must not delay or fail the upgrade; never log the token.
  void boardAuth.touchBoardApiKey(boardKey.id).catch((err) => {
    logger.warn({ err, boardApiKeyId: boardKey.id }, "failed to record live websocket board API key use");
  });

  return {
    companyId,
    actorType: "board",
    actorId: boardKey.userId,
  };
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    boardAuth: BoardAuthService;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    resolveCloudActor?: (req: IncomingMessage) => Promise<CloudUpgradeActor | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
      };
    }

    // Cloud-managed deployments authenticate proxied browsers with trusted
    // x-paperclip-cloud-* headers, never a local Better Auth session — the
    // session fallback below can only 403 them, which left the live-events
    // socket permanently unreachable behind the Cloud front door. A resolved
    // cloud actor is authoritative: authorize against its membership scope.
    // Absent/invalid cloud headers fall through to the session path, so
    // self-hosted behavior is unchanged.
    if (opts.resolveCloudActor) {
      const cloudActor = await opts.resolveCloudActor(req);
      if (cloudActor) {
        if (!cloudActor.companyIds.includes(companyId)) return null;
        return {
          companyId,
          actorType: "board",
          actorId: cloudActor.userId,
        };
      }
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  // Agent keys are checked first; a token that matches no active agent key may
  // still be a board API key.
  if (!key) {
    return authorizeBoardApiKeyUpgrade(opts.boardAuth, token, companyId);
  }

  if (key.companyId !== companyId) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
  };
}

/**
 * Wires an opted-in socket: a hello event first, then every company event
 * except raw run logs (unless `includeRawLogs`), plus the translated
 * `heartbeat.run.stream_json` events. The company stays retained in the hub
 * while the socket is open. Returns the cleanup.
 */
function attachStreamJsonSocket(
  socket: WsSocket,
  companyId: string,
  optIn: StreamJsonOptIn,
  hub: Pick<RunStreamJsonHub, "retainCompany">,
) {
  const send = (event: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(event));
  };
  send(createLiveEvent({
    companyId,
    type: "heartbeat.run.stream_json",
    payload: {
      kind: "hello",
      format: STREAM_JSON_FORMAT,
      formatVersion: STREAM_JSON_FORMAT_VERSION,
      includeRawLogs: optIn.includeRawLogs,
      partial: false,
    },
  }));
  const release = hub.retainCompany(companyId);
  const unsubscribeTranslated = subscribeCompanyStreamJsonEvents(companyId, send);
  const unsubscribeEvents = subscribeCompanyLiveEvents(companyId, (event) => {
    if (!optIn.includeRawLogs && event.type === "heartbeat.run.log") return;
    send(event);
  });
  return () => {
    unsubscribeEvents();
    unsubscribeTranslated();
    release();
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    /**
     * Resolves a Cloud-proxied browser's identity from the trusted
     * x-paperclip-cloud-* headers on the upgrade request. Wired by managed
     * deployments; self-hosted instances leave it unset.
     */
    resolveCloudActor?: (req: IncomingMessage) => Promise<CloudUpgradeActor | null>;
    /**
     * Translated run output for sockets that pass `format=claude-stream-json`.
     * Without it such requests are rejected with 400.
     */
    streamJson?: { hub: Pick<RunStreamJsonHub, "retainCompany"> & Partial<Pick<RunStreamJsonHub, "dispose">> };
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const boardAuth = boardAuthService(db);
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const streamJsonOptIn = context.streamJson ?? null;
    const unsubscribe = streamJsonOptIn && opts.streamJson
      ? attachStreamJsonSocket(socket, context.companyId, streamJsonOptIn, opts.streamJson.hub)
      : subscribeCompanyLiveEvents(context.companyId, (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(event));
      });

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
    opts.streamJson?.hub.dispose?.();
  });

  server.on("upgrade", (req, socket, head) => {
    if ((req as IncomingMessageWithContext).paperclipWebSocketHandled) {
      return;
    }

    const onRawSocketError = (err: Error) => {
      logger.warn({ err, path: pathForLog(req.url) }, "live websocket upgrade socket error");
    };
    const cleanupRawSocketListeners = () => {
      socket.off("error", onRawSocketError);
      socket.off("close", cleanupRawSocketListeners);
    };

    socket.on("error", onRawSocketError);
    socket.once("close", cleanupRawSocketListeners);

    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      closeUpgradeSocket(socket);
      return;
    }

    const streamJsonOptIn = parseStreamJsonOptIn(url, Boolean(opts.streamJson) && isStreamJsonEnabled());
    if (!streamJsonOptIn.ok) {
      rejectUpgrade(socket, "400 Bad Request", streamJsonOptIn.message);
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      boardAuth,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
      resolveCloudActor: opts.resolveCloudActor,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        if (!isWritableUpgradeSocket(socket)) {
          cleanupRawSocketListeners();
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = { ...context, streamJson: streamJsonOptIn.value };

        cleanupRawSocketListeners();
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: pathForLog(req.url) }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
