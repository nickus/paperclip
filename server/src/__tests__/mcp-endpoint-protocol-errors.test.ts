import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(async () => undefined),
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
    search: mocks.search,
    request: mocks.request,
  }),
}));

const { runtimeConnectionIntentRoutes } = await import("../routes/connection-intents.js");
const { mcpGatewayProtocolRoutes } = await import("../routes/tool-gateway.js");
const { errorHandler } = await import("../middleware/index.js");

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
    mocks.validate.mockClear();
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
    expect(mocks.validate).toHaveBeenCalledTimes(1);

    const res = await request(app)
      .post("/mcp/runtime-tools")
      .send({ jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(res.status).toBe(401);
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
