import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(async () => undefined),
  validateActiveRun: vi.fn(async () => undefined),
  search: vi.fn(),
  request: vi.fn(),
}));

vi.mock("../runtime-tools-token.js", () => ({
  verifyRuntimeToolsToken: (token: string) => (token === "runtime-token"
    ? {
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
      responsible_user_id: "user-1",
      scope: "connection_intents",
      iat: 0,
      exp: Number.MAX_SAFE_INTEGER,
      instance_id: "instance-1",
    }
    : null),
}));

vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => ({
    validate: mocks.validate,
    validateActiveRun: mocks.validateActiveRun,
    search: mocks.search,
    request: mocks.request,
  }),
}));

const { runtimeConnectionIntentRoutes } = await import("../routes/connection-intents.js");
const { mcpGatewayProtocolRoutes } = await import("../routes/tool-gateway.js");
const { errorHandler } = await import("../middleware/index.js");
const { conflict, forbidden, unprocessable } = await import("../errors.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(runtimeConnectionIntentRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

function rpc(app: express.Express, body: Record<string, unknown>) {
  return request(app)
    .post("/mcp/runtime-tools")
    .set("Authorization", "Bearer runtime-token")
    .send(body);
}

describe("runtime tools MCP endpoint protocol responses", () => {
  beforeEach(() => {
    mocks.validate.mockReset();
    mocks.validate.mockResolvedValue(undefined);
    mocks.validateActiveRun.mockReset();
    mocks.validateActiveRun.mockResolvedValue(undefined);
    mocks.search.mockReset();
    mocks.request.mockReset();
  });

  it("answers methods it does not implement with a JSON-RPC method-not-found error in a 200 response", async () => {
    const app = createApp();
    for (const method of ["prompts/list", "resources/list", "resources/templates/list", "logging/setLevel"]) {
      const res = await rpc(app, { jsonrpc: "2.0", id: 7, method, params: {} });
      expect(res.status, method).toBe(200);
      expect(res.body, method).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
    }
  });

  it("answers an unknown tool with a JSON-RPC invalid-params error in a 200 response", async () => {
    const res = await rpc(createApp(), {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "not_a_tool", arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      error: { code: -32602, message: "Unknown tool: not_a_tool" },
    });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("acknowledges every notification with 202 and no body", async () => {
    const app = createApp();
    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"]) {
      const res = await rpc(app, { jsonrpc: "2.0", method, params: { requestId: 3 } });
      expect(res.status, method).toBe(202);
      expect(res.text, method).toBe("");
    }
  });

  it("answers ping with an empty result", async () => {
    const res = await rpc(createApp(), { jsonrpc: "2.0", id: 9, method: "ping" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });

  it("still revalidates the run and rejects a missing token before answering", async () => {
    const app = createApp();
    await rpc(app, { jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(mocks.validateActiveRun).toHaveBeenCalledTimes(1);

    const res = await request(app)
      .post("/mcp/runtime-tools")
      .send({ jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(res.status).toBe(401);
  });

  it("refuses the handshake once the token's run is no longer live", async () => {
    mocks.validateActiveRun.mockRejectedValue(forbidden("Runtime tool token is no longer active"));
    const app = createApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(403);
    const get = await request(app).get("/mcp/runtime-tools").set("Authorization", "Bearer runtime-token");
    expect(get.status).toBe(403);
  });

  it("completes the handshake for a live run that cannot make connection requests", async () => {
    // A run woken by a mention on another agent's task, or with no task at
    // all: the task preconditions fail, but the token and its run are valid.
    mocks.validate.mockRejectedValue(conflict("The requesting agent no longer owns this task"));
    const app = createApp();

    const initialize = await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initialize.status).toBe(200);
    expect(initialize.body.result.serverInfo).toEqual({ name: "paperclip-runtime-tools", version: "1" });

    const list = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "connections_search",
      "connection_request",
    ]);

    const get = await request(app).get("/mcp/runtime-tools").set("Authorization", "Bearer runtime-token");
    expect(get.status).toBe(200);
    expect(mocks.validateActiveRun).toHaveBeenCalledTimes(3);
  });

  it("reports a connection request the run cannot make as an MCP tool error", async () => {
    mocks.search.mockRejectedValue(conflict("The requesting agent no longer owns this task"));
    mocks.request.mockRejectedValue(unprocessable("Connection requests require a task-bound heartbeat run"));
    const app = createApp();

    const search = await rpc(app, {
      jsonrpc: "2.0",
      id: "s-1",
      method: "tools/call",
      params: { name: "connections_search", arguments: { query: "github" } },
    });
    expect(search.status).toBe(200);
    expect(search.body).toEqual({
      jsonrpc: "2.0",
      id: "s-1",
      result: { content: [{ type: "text", text: "The requesting agent no longer owns this task" }], isError: true },
    });

    const requested = await rpc(app, {
      jsonrpc: "2.0",
      id: "r-1",
      method: "tools/call",
      params: { name: "connection_request", arguments: { service: "github" } },
    });
    expect(requested.status).toBe(200);
    expect(requested.body.result).toEqual({
      content: [{ type: "text", text: "Connection requests require a task-bound heartbeat run" }],
      isError: true,
    });
  });

  it("returns connection tool results for a run that can make requests", async () => {
    mocks.search.mockResolvedValue({ results: [] });
    const res = await rpc(createApp(), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "connections_search", arguments: { query: "github" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
      structuredContent: { results: [] },
    });
  });
});

describe("MCP gateway endpoint protocol responses", () => {
  const gateway = {
    initializeNamedGatewayProtocol: vi.fn(),
    listToolsForNamedGateway: vi.fn(),
    executeContextForNamedGateway: vi.fn(),
    executeTool: vi.fn(),
  };

  function createGatewayApp() {
    const app = express();
    app.use(express.json());
    app.use(mcpGatewayProtocolRoutes(gateway as unknown as Parameters<typeof mcpGatewayProtocolRoutes>[0]));
    app.use(errorHandler);
    return app;
  }

  function gatewayRpc(app: express.Express, body: Record<string, unknown>) {
    return request(app)
      .post("/mcp/gateways/gateway-1")
      .set("Authorization", "Bearer gateway-token")
      .send(body);
  }

  it("answers methods it does not implement with a JSON-RPC method-not-found error in a 200 response", async () => {
    const app = createGatewayApp();
    for (const method of ["completion/complete", "logging/setLevel", "resources/subscribe"]) {
      const res = await gatewayRpc(app, { jsonrpc: "2.0", id: 4, method, params: {} });
      expect(res.status, method).toBe(200);
      expect(res.body, method).toEqual({
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32601, message: "Method not found" },
      });
    }
  });

  it("acknowledges every notification with 202 and no body, and answers ping", async () => {
    const app = createGatewayApp();
    for (const method of ["notifications/initialized", "notifications/cancelled"]) {
      const res = await gatewayRpc(app, { jsonrpc: "2.0", method, params: { requestId: 3 } });
      expect(res.status, method).toBe(202);
      expect(res.text, method).toBe("");
    }
    const ping = await gatewayRpc(app, { jsonrpc: "2.0", id: 5, method: "ping" });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
    for (const fn of Object.values(gateway)) expect(fn).not.toHaveBeenCalled();
  });
});
