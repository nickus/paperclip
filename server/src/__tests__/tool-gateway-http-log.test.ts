import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const ARGUMENT_CANARY = "private-note-canary";

// Every call waits for approval, which the gateway answers with 409: the
// status that sends a request body to the HTTP failure log.
function approvalGatedGateway(): ToolGatewayService {
  const approvalRequired = async () => {
    throw new ToolGatewayHttpError(409, "Approval required", "approval_required", {
      actionRequestId: "request-1",
    });
  };
  return {
    executeTool: approvalRequired,
    executeContextForNamedGateway: approvalRequired,
  } as unknown as ToolGatewayService;
}

function loggedApp(mount: (app: express.Express, gateway: ToolGatewayService) => void) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const app = express();
  app.use(express.json());
  app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
  mount(app, approvalGatedGateway());
  return { app, logs: () => chunks.join("") };
}

const mcpToolCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "notes:update", arguments: { body: ARGUMENT_CANARY } },
};
const mcpPromptGet = {
  jsonrpc: "2.0",
  id: 2,
  method: "prompts/get",
  params: { name: "summarize", arguments: { text: ARGUMENT_CANARY } },
};

describe("tool gateway routes and the HTTP failure log", () => {
  it.each([
    { prefix: "/api", label: "at their usual mount points" },
    { prefix: "/v2", label: "under any other mount point" },
  ])("keep call arguments out of the log $label", async ({ prefix }) => {
    const db = {} as Db;
    const { app, logs } = loggedApp((target, gateway) => {
      target.use(prefix === "/api" ? "/" : prefix, mcpGatewayProtocolRoutes(gateway));
      target.use(prefix, toolGatewayRoutes(db, gateway));
    });
    const protocolPrefix = prefix === "/api" ? "" : prefix;

    const calls = [
      request(app)
        .post(`${prefix}/tool-gateway/tools/call`)
        .set("X-Paperclip-Tool-Gateway-Token", "session-token")
        .send({ tool: "notes:update", parameters: { body: ARGUMENT_CANARY } }),
      request(app)
        .post(`${protocolPrefix}/mcp/gateways/gw-public-1`)
        .set("Authorization", "Bearer gateway-token")
        .send(mcpToolCall),
      request(app)
        .post(`${prefix}/tool-gateway/gateways/gw-1/mcp`)
        .set("Authorization", "Bearer gateway-token")
        .send(mcpToolCall),
      request(app)
        .post(`${prefix}/tool-gateway/gateways/gw-1/mcp`)
        .set("Authorization", "Bearer gateway-token")
        .send(mcpPromptGet),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(409);
    }

    const output = logs();
    expect(output).not.toContain(ARGUMENT_CANARY);
    const entries = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(calls.length);
    for (const entry of entries) {
      expect(entry.res.statusCode).toBe(409);
      expect(entry.reqBody).toBe("[REDACTED]");
    }
  });
});
