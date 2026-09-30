import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TOOL_CALL_TIMEOUT_MS,
  TOOL_CALL_CLIENT_TIMEOUT_MS,
} from "@paperclipai/shared/tool-call-timeouts";
import {
  isSandboxCallbackBridgeToolCallRoute,
  requestWithCallerDeadline,
  sandboxCallbackBridgeForwardTimeoutMs,
  sendSandboxCallbackBridgeForward,
  TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS,
  TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS,
} from "./sandbox-callback-bridge-tool-calls.js";
import { getSandboxCallbackBridgeServerSource } from "./sandbox-callback-bridge.js";

describe("sandbox callback bridge tool-call budgets", () => {
  it("recognizes the routes that run one connected tool call", () => {
    expect(isSandboxCallbackBridgeToolCallRoute({ method: "POST", path: "/api/tool-gateway/tools/call" })).toBe(true);
    expect(isSandboxCallbackBridgeToolCallRoute({ method: "post", path: "/mcp/gateways/gw_0123abcd" })).toBe(true);
    expect(isSandboxCallbackBridgeToolCallRoute({ method: "GET", path: "/api/tool-gateway/tools" })).toBe(false);
    expect(isSandboxCallbackBridgeToolCallRoute({ method: "GET", path: "/mcp/gateways/gw_0123abcd" })).toBe(false);
    expect(isSandboxCallbackBridgeToolCallRoute({ method: "POST", path: "/api/issues/abc/comments" })).toBe(false);
    expect(isSandboxCallbackBridgeToolCallRoute({ method: "POST", path: "/api/tool-gateway/tools/call/extra" })).toBe(false);
  });

  it("gives tool-call forwards a budget above the longest gateway tool call and leaves other routes alone", () => {
    expect(sandboxCallbackBridgeForwardTimeoutMs(
      { method: "POST", path: "/api/tool-gateway/tools/call" },
      30_000,
    )).toBeGreaterThan(MAX_TOOL_CALL_TIMEOUT_MS);
    expect(sandboxCallbackBridgeForwardTimeoutMs(
      { method: "POST", path: "/mcp/gateways/gw_0123abcd" },
      30_000,
    )).toBeGreaterThan(MAX_TOOL_CALL_TIMEOUT_MS);
    // A caller that configured an even longer forward budget keeps it.
    expect(sandboxCallbackBridgeForwardTimeoutMs(
      { method: "POST", path: "/api/tool-gateway/tools/call" },
      900_000,
    )).toBe(900_000);
    expect(sandboxCallbackBridgeForwardTimeoutMs({ method: "GET", path: "/api/agents/me" }, 30_000)).toBe(30_000);
  });

  it("nests each hop's budget inside the next one", () => {
    // gateway tool deadline < host forward < in-sandbox wait < agent MCP client
    expect(TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS).toBeGreaterThan(MAX_TOOL_CALL_TIMEOUT_MS);
    expect(TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS).toBeGreaterThan(TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS);
    expect(TOOL_CALL_CLIENT_TIMEOUT_MS).toBeGreaterThan(TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS);
  });

  it("embeds the tool-call wait in the generated in-sandbox gateway", () => {
    const source = getSandboxCallbackBridgeServerSource();
    expect(source).toContain("PAPERCLIP_BRIDGE_TOOL_CALL_RESPONSE_TIMEOUT_MS");
    expect(source).toContain(`"${TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS}"`);
    expect(source).toContain("responseTimeoutMsFor(payload.method, payload.path)");
  });
});

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function startServer(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("requestWithCallerDeadline", () => {
  it("relays the method, headers and body and returns the raw response", async () => {
    const baseUrl = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json", etag: "\"v1\"" });
        res.end(JSON.stringify({
          method: req.method,
          path: req.url,
          encoding: req.headers["accept-encoding"],
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
    });
    const response = await requestWithCallerDeadline(new URL("/api/tool-gateway/tools/call?x=1", baseUrl), {
      method: "POST",
      headers: new Headers({ authorization: "Bearer host-token", "content-type": "application/json" }),
      body: JSON.stringify({ tool: "slow" }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe("\"v1\"");
    expect(await response.json()).toEqual({
      method: "POST",
      path: "/api/tool-gateway/tools/call?x=1",
      encoding: "identity",
      authorization: "Bearer host-token",
      body: "{\"tool\":\"slow\"}",
    });
  });

  it("stops waiting when the caller's signal aborts", async () => {
    const baseUrl = await startServer(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = requestWithCallerDeadline(new URL("/api/tool-gateway/tools/call", baseUrl), {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{}",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sendSandboxCallbackBridgeForward", () => {
  function forward(baseUrl: string, method: string, path: string, options: {
    defaultTimeoutMs: number;
    signal?: AbortSignal;
  }) {
    return sendSandboxCallbackBridgeForward(
      new URL(path, baseUrl),
      { method, path, headers: new Headers({ "content-type": "application/json" }), body: "{}" },
      options,
    );
  }

  it("gives tool-call routes the tool-call budget and a caller-deadline request, other routes the default", async () => {
    const received: Array<{ path: string; encoding: string | undefined; body: string }> = [];
    const baseUrl = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({
          path: req.url ?? "",
          encoding: req.headers["accept-encoding"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        // Answer after the default forward budget used below has passed.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url }));
        }, 300);
      });
    });

    // The REST tool gateway and the MCP gateway both outlive the default.
    for (const path of ["/api/tool-gateway/tools/call", "/mcp/gateways/gw_0123abcd"]) {
      const response = await forward(baseUrl, "POST", path, { defaultTimeoutMs: 100 });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ path });
    }
    // Any other route keeps the default budget.
    await expect(forward(baseUrl, "POST", "/api/issues/abc/comments", { defaultTimeoutMs: 100 }))
      .rejects.toMatchObject({ name: "TimeoutError" });

    // Tool calls went out as caller-deadline requests (identity encoding),
    // the other route through platform fetch; every body was relayed.
    expect(received.map(({ path, encoding }) => ({ path, identity: encoding === "identity" }))).toEqual([
      { path: "/api/tool-gateway/tools/call", identity: true },
      { path: "/mcp/gateways/gw_0123abcd", identity: true },
      { path: "/api/issues/abc/comments", identity: false },
    ]);
    expect(received.map(({ body }) => body)).toEqual(["{}", "{}", "{}"]);
  });

  it("still stops a tool-call forward when the caller's signal aborts", async () => {
    const baseUrl = await startServer(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = forward(baseUrl, "POST", "/mcp/gateways/gw_0123abcd", {
      defaultTimeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
