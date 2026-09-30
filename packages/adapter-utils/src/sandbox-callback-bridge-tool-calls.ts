/**
 * Long-running tool-call routes on the sandbox callback bridge.
 *
 * Most Paperclip API calls an agent makes through the bridge finish in well
 * under a second, and the bridge budgets them tightly (a 30 s host forward, a
 * 10 s host poll iteration, a 30 s in-sandbox wait). A connected tool call is
 * different: the gateway lets it run for as long as its tool timeout, up to
 * `MAX_TOOL_CALL_TIMEOUT_MS`, and answers with a `tool_timeout` error when that
 * passes. These routes get budgets derived from that ceiling instead, each hop
 * slightly longer than the one it wraps, so the gateway's answer is what the
 * caller sees.
 */

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import {
  TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS,
  TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS,
} from "@paperclipai/shared/tool-call-timeouts";

export { TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS, TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS };

/** One method + canonical path pattern. */
interface ToolCallRouteRule {
  method: string;
  path: RegExp;
}

/**
 * Routes that execute one connected tool call per request: the REST tool
 * gateway's call route and the MCP gateway protocol endpoint (whose
 * `tools/call` messages share the route with quick protocol methods; those
 * finish fast, so the longer ceiling costs them nothing). A route policy
 * decides separately whether a run may reach them at all.
 */
export const SANDBOX_CALLBACK_BRIDGE_TOOL_CALL_ROUTES: readonly ToolCallRouteRule[] = [
  { method: "POST", path: /^\/api\/tool-gateway\/tools\/call$/ },
  { method: "POST", path: /^\/mcp\/gateways\/[^/]+$/ },
];

/** True when the bridge request runs a connected tool call. */
export function isSandboxCallbackBridgeToolCallRoute(request: { method: string; path: string }): boolean {
  const method = request.method.trim().toUpperCase();
  return SANDBOX_CALLBACK_BRIDGE_TOOL_CALL_ROUTES.some(
    (route) => route.method === method && route.path.test(request.path),
  );
}

/**
 * The host forward budget for one bridge request: the tool-call budget for a
 * tool-call route, never less than the caller's configured budget.
 */
export function sandboxCallbackBridgeForwardTimeoutMs(
  request: { method: string; path: string },
  defaultTimeoutMs: number,
): number {
  return isSandboxCallbackBridgeToolCallRoute(request)
    ? Math.max(defaultTimeoutMs, TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS)
    : defaultTimeoutMs;
}

/**
 * Source for the in-sandbox gateway: a function that returns how long the
 * gateway waits for the host to answer one request. The generated gateway has
 * no imports, so the route patterns are embedded as literals.
 */
export function sandboxCallbackBridgeGatewayWaitSource(): string {
  const routes = SANDBOX_CALLBACK_BRIDGE_TOOL_CALL_ROUTES.map((route) => ({
    method: route.method,
    source: route.path.source,
  }));
  return `const toolCallRoutes = ${JSON.stringify(routes)}.map((route) => ({ method: route.method, path: new RegExp(route.source) }));
const toolCallResponseTimeoutMs = Number(
  process.env.PAPERCLIP_BRIDGE_TOOL_CALL_RESPONSE_TIMEOUT_MS || "${TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS}",
);
// A connected tool call can legitimately run for minutes; every other route
// keeps the short default deadline.
function responseTimeoutMsFor(method, pathname) {
  const upper = String(method || "GET").toUpperCase();
  return toolCallRoutes.some((route) => route.method === upper && route.path.test(pathname))
    ? Math.max(responseTimeoutMs, toolCallResponseTimeoutMs)
    : responseTimeoutMs;
}`;
}

/**
 * Send one long-running forward with `node:http`/`node:https`.
 *
 * Platform `fetch` stops waiting for response headers after its built-in 300 s
 * `headersTimeout`, whatever the caller's `AbortSignal` says, which is exactly
 * the longest tool call the gateway allows. This request has no deadline of its
 * own: `init.signal` bounds it. It asks for an identity-encoded response, so the
 * body bytes are what the caller relays.
 */
export function requestWithCallerDeadline(
  url: URL,
  init: {
    method: string;
    headers: Headers;
    body?: string | Buffer;
    signal: AbortSignal;
  },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    init.headers.forEach((value, key) => {
      headers[key] = value;
    });
    headers["accept-encoding"] = "identity";
    if (init.body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(init.body));
    }
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      // A fresh connection: the shared agent's idle-socket timeout must not
      // apply while the server is still working on the answer.
      { method: init.method, headers, signal: init.signal, agent: false },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const entry of value) responseHeaders.append(key, entry);
          } else {
            responseHeaders.set(key, value);
          }
        }
        const status = res.statusCode ?? 502;
        const bodyless = init.method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (bodyless) {
          // Nothing reads this response; keep a late socket error from
          // surfacing as an unhandled `error` event.
          res.on("error", () => undefined);
          res.resume();
        }
        resolve(
          new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers: responseHeaders,
          }),
        );
      },
    );
    // Before the response, an error rejects the call; after it, the body
    // stream reports the failure and this rejection is a no-op.
    req.on("error", reject);
    if (init.body !== undefined) {
      req.end(init.body);
    } else {
      req.end();
    }
  });
}

/**
 * Send one relayed bridge request to the host API: the forward step of both
 * bridge transports.
 *
 * `signal` is the caller's own (the queue worker's per-request abort, or the
 * HTTP/2 stream's); the forward also stops at its budget, which is the
 * tool-call forward budget for a tool-call route and `defaultTimeoutMs` for any
 * other. A tool-call route goes through `requestWithCallerDeadline`, because
 * platform `fetch` stops waiting for response headers after its own 300 s
 * whatever the signal allows; every other route keeps platform `fetch`.
 */
export function sendSandboxCallbackBridgeForward(
  url: URL,
  request: { method: string; path: string; headers: Headers; body?: string | Buffer },
  options: { defaultTimeoutMs: number; signal?: AbortSignal | null },
): Promise<Response> {
  const route = { method: request.method.trim().toUpperCase() || "GET", path: request.path };
  const timeoutSignal = AbortSignal.timeout(
    sandboxCallbackBridgeForwardTimeoutMs(route, options.defaultTimeoutMs),
  );
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  // A GET or a HEAD carries no body.
  const body = route.method !== "GET" && route.method !== "HEAD" ? request.body : undefined;
  if (isSandboxCallbackBridgeToolCallRoute(route)) {
    return requestWithCallerDeadline(url, { method: route.method, headers: request.headers, body, signal });
  }
  const init: RequestInit = { method: route.method, headers: request.headers, signal };
  // Undici accepts a `Buffer` body (an `ArrayBufferView`) as it is. The cast
  // only bridges a typing gap: the DOM `BodyInit` this project's ambient
  // `RequestInit` resolves to excludes `Buffer`.
  if (body !== undefined) init.body = body as BodyInit;
  return fetch(url, init);
}
