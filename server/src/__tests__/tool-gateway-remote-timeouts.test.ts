import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type RemoteHttpRequest = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A scripted remote MCP server behind the gateway's transport seam. Each
 * tools/call waits until the test answers it (or until the gateway aborts it,
 * which rejects with an AbortError exactly like platform fetch).
 */
function scriptedRemote() {
  const calls: Array<{
    toolName: string;
    signal: AbortSignal | null;
    answer: (text?: string) => void;
    fail: (error: Error) => void;
  }> = [];
  const remoteHttpRequest: RemoteHttpRequest = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as {
      id: string;
      method: string;
      params?: { name?: string };
    };
    const signal = init.signal ?? null;
    const text = await new Promise<string>((resolve, reject) => {
      calls.push({
        toolName: payload.params?.name ?? "",
        signal,
        answer: (value = "ok") => resolve(value),
        fail: reject,
      });
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
    return Response.json({
      jsonrpc: "2.0",
      id: payload.id,
      result: { content: [{ type: "text", text }] },
    });
  };
  return { calls, remoteHttpRequest };
}

async function createFixture(db: Db, connectionConfig: Record<string, unknown> = {}) {
  const company = await db.insert(companies).values({
    name: `Timeouts ${randomUUID()}`,
    issuePrefix: `TO${randomUUID().slice(0, 6).toUpperCase()}`,
  }).returning().then((rows) => rows[0]!);
  const agent = await db.insert(agents).values({
    companyId: company.id,
    name: `Agent ${randomUUID()}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning().then((rows) => rows[0]!);
  const project = await db.insert(projects)
    .values({ companyId: company.id, name: `Project ${randomUUID()}` })
    .returning().then((rows) => rows[0]!);
  const issue = await db.insert(issues).values({
    companyId: company.id,
    projectId: project.id,
    title: "Slow tool work",
    status: "in_progress",
    assigneeAgentId: agent.id,
  }).returning().then((rows) => rows[0]!);
  const run = await db.insert(heartbeatRuns).values({
    companyId: company.id,
    agentId: agent.id,
    invocationSource: "assignment",
    status: "running",
    contextSnapshot: { issueId: issue.id, projectId: project.id },
  }).returning().then((rows) => rows[0]!);
  const [profile] = await db.insert(toolProfiles).values({
    companyId: company.id,
    profileKey: `all-${randomUUID()}`,
    name: `All tools ${randomUUID()}`,
    defaultAction: "allow",
  }).returning();
  await db.insert(toolProfileBindings).values({
    companyId: company.id,
    profileId: profile!.id,
    targetType: "agent",
    targetId: agent.id,
  });
  const [application] = await db.insert(toolApplications).values({
    companyId: company.id,
    applicationKey: `answers-${randomUUID().slice(0, 8)}`,
    name: "Answers",
    type: "mcp_http",
    status: "active",
  }).returning();
  const config = { url: "https://answers.example.test/mcp", ...connectionConfig };
  const [connection] = await db.insert(toolConnections).values({
    companyId: company.id,
    applicationId: application!.id,
    name: "Answers",
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: "active",
    enabled: true,
    healthStatus: "ok",
    credentialPolicy: "shared",
    config,
    transportConfig: config,
  }).returning();
  await db.insert(connectionGrants).values({
    companyId: company.id,
    connectionId: connection!.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });
  for (const toolName of ["ask_question", "search"]) {
    await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application!.id,
      connectionId: connection!.id,
      entryKind: "tool",
      name: toolName,
      toolName,
      title: toolName,
      description: `Call ${toolName}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      annotations: { readOnlyHint: true },
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: randomUUID(),
    });
  }
  return { company, agent, run, profile: profile!, connection: connection! };
}

function gatewayApp(gateway: ReturnType<typeof createToolGatewayService>, db: Db) {
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  app.use("/api", toolGatewayRoutes(db, gateway));
  return app;
}

async function completedTimeouts(db: Db, companyId: string) {
  const events = await db.select().from(toolCallEvents).where(eq(toolCallEvents.companyId, companyId));
  return events
    .filter((event) => event.eventType === "call_completed")
    .map((event) => (event.metadata as { timeoutMs?: number } | null)?.timeoutMs);
}

describeEmbeddedPostgres("tool gateway remote MCP tool-call timeouts", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-timeouts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(activityLog);
    await db.delete(toolCallEvents);
    await db.delete(toolGatewaySessions);
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolPolicies);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lets an MCP gateway call outlive the 10 s default when the connection allows it", async () => {
    const { company, profile } = await createFixture(db, { toolTimeoutMs: 30_000 });
    const remote = scriptedRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const named = await gateway.createNamedGateway({
      companyId: company.id,
      body: { name: "Native client", profileId: profile.id },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: named.id,
      body: { name: "Native client" },
    });
    const listed = await request(gatewayApp(gateway, db))
      .post(named.endpointPath)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    const askTool = (listed.body.result.tools as Array<{ name: string }>)
      .find((tool) => tool.name.endsWith(":ask-question"))!;
    expect(askTool).toBeTruthy();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    // Native MCP clients never send a timeout: the route passes none.
    const response = request(gatewayApp(gateway, db))
      .post(named.endpointPath)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: askTool.name, arguments: {} } })
      .then((result) => result);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(remote.calls[0]!.signal?.aborted).toBe(false);
    remote.calls[0]!.answer("the answer");
    vi.useRealTimers();

    const result = await response;
    expect(result.status).toBe(200);
    expect(result.body.result).toMatchObject({
      content: [{ type: "text", text: "the answer" }],
      isError: false,
    });
    expect(await completedTimeouts(db, company.id)).toEqual([30_000]);
  });

  it("uses the connection default for REST calls without a timeout and caps explicit ones at 300 s", async () => {
    const { company, agent, run } = await createFixture(db, { toolTimeoutMs: 45_000 });
    const remote = scriptedRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const askTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.upstreamToolName === "ask_question")!;
    const app = gatewayApp(gateway, db);
    const call = (body: Record<string, unknown>) => request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", session.token)
      .send({ tool: askTool.name, parameters: {}, ...body })
      .then((result) => result);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    // No timeout in the call: the connection's 45 s default applies.
    const byDefault = call({});
    await vi.waitFor(() => expect(remote.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(44_000);
    expect(remote.calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(remote.calls[0]!.signal?.aborted).toBe(true);
    expect((await byDefault).body).toMatchObject({ reasonCode: "tool_timeout" });

    // An explicit timeout above the old 60 s ceiling is honoured.
    const explicit = call({ timeoutMs: 120_000 });
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(remote.calls[1]!.signal?.aborted).toBe(false);
    remote.calls[1]!.answer();
    expect((await explicit).body).toMatchObject({ status: "completed" });

    // An explicit timeout above the ceiling is clamped to 300 s.
    const clamped = call({ timeoutMs: 900_000 });
    await vi.waitFor(() => expect(remote.calls).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(299_000);
    expect(remote.calls[2]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(remote.calls[2]!.signal?.aborted).toBe(true);
    vi.useRealTimers();
    expect((await clamped).body).toMatchObject({ reasonCode: "tool_timeout" });
    expect(await completedTimeouts(db, company.id)).toEqual([120_000]);
  });

  it("keeps the 10 s default for connections that configure no timeout", async () => {
    const { company, agent, run, connection } = await createFixture(db);
    const remote = scriptedRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const askTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.upstreamToolName === "ask_question")!;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const outcome = gateway.executeTool({ sessionToken: session.token, tool: askTool.name, parameters: {} })
      .then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(remote.calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(remote.calls[0]!.signal?.aborted).toBe(true);
    vi.useRealTimers();
    expect(await outcome).toMatchObject({
      status: 504,
      reasonCode: "tool_timeout",
      details: { connectionId: connection.id, timeoutMs: 10_000 },
    });
  });

  it("does not mark a connection unhealthy or hide its other tools after one tool timeout", async () => {
    const { company, agent, run, connection } = await createFixture(db, { toolTimeoutMs: 1_000 });
    const remote = scriptedRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tools = await gateway.listToolsForSession(session.token);
    const askTool = tools.find((tool) => tool.upstreamToolName === "ask_question")!;
    const searchTool = tools.find((tool) => tool.upstreamToolName === "search")!;

    await expect(gateway.executeTool({ sessionToken: session.token, tool: askTool.name, parameters: {} }))
      .rejects.toMatchObject({ status: 504, reasonCode: "tool_timeout" });

    const [afterTimeout] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
    expect(afterTimeout).toMatchObject({ healthStatus: "ok" });
    const freshSession = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    expect((await gateway.listToolsForSession(freshSession.token)).map((tool) => tool.upstreamToolName))
      .toEqual(expect.arrayContaining(["ask_question", "search"]));

    const search = gateway.executeTool({ sessionToken: freshSession.token, tool: searchTool.name, parameters: {} });
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    remote.calls[1]!.answer("found");
    await expect(search).resolves.toMatchObject({ status: "completed" });
  });

  it("marks a connection unhealthy only after consecutive transport failures", async () => {
    const { company, agent, run, connection } = await createFixture(db);
    let reachable = false;
    const gateway = createToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) => {
        if (!reachable) throw new TypeError("fetch failed");
        const payload = JSON.parse(String(init.body)) as { id: string };
        return Response.json({ jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "bad input" } });
      },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const searchTool = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.upstreamToolName === "search")!;
    const call = () => gateway.executeTool({ sessionToken: session.token, tool: searchTool.name, parameters: {} })
      .catch((error: unknown) => error);
    const health = async () => (await db.select().from(toolConnections)
      .where(eq(toolConnections.id, connection.id)))[0]!.healthStatus;

    await call();
    await call();
    expect(await health()).toBe("ok");
    // A reachable answer, even a per-call JSON-RPC error, resets the streak.
    reachable = true;
    expect(await call()).toMatchObject({ reasonCode: "remote_mcp_error" });
    reachable = false;
    await call();
    await call();
    expect(await health()).toBe("ok");
    expect(await call()).toMatchObject({ reasonCode: "mcp_remote_fetch_failed" });
    expect(await health()).toBe("error");
  });
});
