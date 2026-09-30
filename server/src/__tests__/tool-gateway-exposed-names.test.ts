import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  projects,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "../routes/tool-gateway.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { createAssignedMcpTools } from "../services/native-runtime/assigned-mcp-tools.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolActionDeliveryService } from "../services/tool-action-delivery.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const SIGNING_SECRET = "exposed-names-test-only-signing-secret";
const REMOTE_URL = "https://tickets.example.test/mcp";

type RemoteTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

/** A remote MCP server behind the transport seam that records which upstream tool each call names. */
function recordingRemote(initialTools: RemoteTool[] = []) {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let tools = initialTools;
  const remoteHttpRequest = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as {
      id?: string;
      method: string;
      params?: { name?: string; arguments?: unknown };
    };
    if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (payload.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "tickets", version: "1" } },
      });
    }
    if (payload.method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id: payload.id, result: { tools } });
    }
    calls.push({ name: payload.params?.name ?? "", arguments: payload.params?.arguments });
    return Response.json({
      jsonrpc: "2.0",
      id: payload.id,
      result: { content: [{ type: "text", text: `ran ${payload.params?.name}` }] },
    });
  };
  return { calls, remoteHttpRequest, setTools: (next: RemoteTool[]) => { tools = next; } };
}

async function createCompanyFixture(db: Db) {
  const company = await db.insert(companies).values({
    name: `Exposed names ${randomUUID()}`,
    issuePrefix: `EX${randomUUID().slice(0, 6).toUpperCase()}`,
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
    title: "Triage tickets",
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
  return { company, agent, issue, run, profile: profile! };
}

async function createConnectionFixture(
  db: Db,
  companyId: string,
  input: {
    name?: string;
    config?: Record<string, unknown>;
    tools?: Array<{ toolName: string; riskLevel?: "read" | "write"; description?: string }>;
  } = {},
) {
  const [application] = await db.insert(toolApplications).values({
    companyId,
    applicationKey: `tickets-${randomUUID().slice(0, 8)}`,
    name: input.name ?? "Tickets",
    type: "mcp_http",
    status: "active",
  }).returning();
  const config = { url: REMOTE_URL, ...(input.config ?? {}) };
  const [connection] = await db.insert(toolConnections).values({
    companyId,
    applicationId: application!.id,
    name: input.name ?? "Tickets",
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
    companyId,
    connectionId: connection!.id,
    kind: "organization",
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
  });
  const tools = input.tools ?? [
    { toolName: "search", description: "Upstream search description." },
    { toolName: "create_ticket", riskLevel: "write" as const, description: "Upstream create description." },
  ];
  const entries = [];
  for (const tool of tools) {
    const riskLevel = tool.riskLevel ?? "read";
    const [entry] = await db.insert(toolCatalogEntries).values({
      companyId,
      applicationId: application!.id,
      connectionId: connection!.id,
      entryKind: "tool",
      name: tool.toolName,
      toolName: tool.toolName,
      title: tool.toolName,
      description: tool.description ?? `Call ${tool.toolName}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      annotations: { readOnlyHint: riskLevel === "read" },
      riskLevel,
      isReadOnly: riskLevel === "read",
      isWrite: riskLevel === "write",
      status: "active",
      versionHash: randomUUID(),
    }).returning();
    entries.push(entry!);
  }
  return { application: application!, connection: connection!, entries };
}

function gatewayApp(gateway: ReturnType<typeof createToolGatewayService>, db: Db) {
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  app.use("/api", toolGatewayRoutes(db, gateway));
  return app;
}

const RENAMED_SEARCH = {
  toolOverrides: {
    search: { name: "find_tickets", description: "Find support tickets by keyword." },
    create_ticket: { name: "open_ticket" },
  },
};

describeEmbeddedPostgres("tool gateway exposed tool names", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-exposed-names-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists a renamed tool under its exposed name on the MCP gateway and maps calls back to the upstream tool", async () => {
    const { company, profile } = await createCompanyFixture(db);
    const { connection } = await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    const remote = recordingRemote();
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
    const app = gatewayApp(gateway, db);

    const listed = await request(app)
      .post(named.endpointPath)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      .expect(200);
    const tools = listed.body.result.tools as Array<{ name: string; title?: string; description: string }>;
    expect(tools.find((tool) => tool.name === "find_tickets")).toMatchObject({
      title: "find_tickets",
      description: "Find support tickets by keyword.",
    });
    expect(tools.find((tool) => tool.name === "open_ticket")).toMatchObject({
      description: "Upstream create description.",
    });
    // The generated name of a renamed tool is not listed.
    expect(tools.some((tool) => tool.name.endsWith(":search"))).toBe(false);

    const called = await request(app)
      .post(named.endpointPath)
      .set("authorization", `Bearer ${token.token}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_tickets", arguments: { query: "refund" } } })
      .expect(200);
    expect(called.body.result).toMatchObject({ content: [{ type: "text", text: "ran search" }], isError: false });
    expect(remote.calls).toEqual([{ name: "search", arguments: { query: "refund" } }]);

    // The audit keeps the generated identity, the upstream name and the exposed name.
    const [event] = await db.select().from(toolCallEvents).where(and(
      eq(toolCallEvents.companyId, company.id),
      eq(toolCallEvents.eventType, "call_completed"),
    ));
    expect(event!.toolName).toMatch(/^mcp\..+:search$/);
    expect(event!.connectionId).toBe(connection.id);
    expect(event!.metadata).toMatchObject({ upstreamToolName: "search", exposedToolName: "find_tickets" });
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, company.id));
    expect(invocation).toMatchObject({ toolName: event!.toolName, upstreamToolName: "search", status: "succeeded" });
  });

  it("serves the exposed name on the REST gateway, accepts it for calls and echoes it back", async () => {
    const { company, agent, run } = await createCompanyFixture(db);
    await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    const remote = recordingRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const app = gatewayApp(gateway, db);

    const listed = await request(app)
      .get("/api/tool-gateway/tools")
      .set("x-paperclip-tool-gateway-token", session.token)
      .expect(200);
    const search = (listed.body as Array<Record<string, unknown>>).find((tool) => tool.upstreamToolName === "search")!;
    expect(search).toMatchObject({
      name: "find_tickets",
      exposedName: "find_tickets",
      description: "Find support tickets by keyword.",
      providerMetadata: { upstreamToolName: "search", exposedToolName: "find_tickets" },
    });
    const generatedName = (search.providerMetadata as { gatewayToolName: string }).gatewayToolName;
    expect(generatedName).toMatch(/^mcp\..+:search$/);

    const byExposedName = await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", session.token)
      .send({ tool: "find_tickets", parameters: { query: "late" } })
      .expect(200);
    expect(byExposedName.body).toMatchObject({ status: "completed", tool: "find_tickets" });

    // The generated name keeps working, so existing callers are unaffected.
    await request(app)
      .post("/api/tool-gateway/tools/call")
      .set("x-paperclip-tool-gateway-token", session.token)
      .send({ tool: generatedName, parameters: {} })
      .expect(200);
    expect(remote.calls.map((call) => call.name)).toEqual(["search", "search"]);
  });

  it("keeps policies matching the generated and upstream names, not the alias", async () => {
    const { company, agent, run } = await createCompanyFixture(db);
    await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    const remote = recordingRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const generatedName = (await gateway.listToolsForSession(session.token))
      .find((tool) => tool.upstreamToolName === "search")!.name;
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Block ticket search",
      policyType: "block",
      selectors: { toolName: generatedName },
      priority: 1,
    });

    // A block written against the generated name still applies to calls by alias.
    const fresh = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    await expect(gateway.executeTool({ sessionToken: fresh.token, tool: "find_tickets", parameters: {} }))
      .rejects.toMatchObject({ status: 403, details: expect.objectContaining({ tool: "find_tickets" }) });
    expect(remote.calls).toEqual([]);
  });

  it("posts an approval card that names the exposed and the upstream tool", async () => {
    const { company, agent, run, issue } = await createCompanyFixture(db);
    const { entries } = await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    const createEntry = entries.find((entry) => entry.toolName === "create_ticket")!;
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review ticket writes",
      policyType: "require_approval",
      selectors: { catalogEntryId: createEntry.id },
      priority: 1,
    });
    const remote = recordingRemote();
    const gateway = createToolGatewayService(db, {
      remoteHttpRequest: remote.remoteHttpRequest,
      toolActionSigningSecret: SIGNING_SECRET,
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

    await expect(gateway.executeTool({ sessionToken: session.token, tool: "open_ticket", parameters: { title: "Printer" } }))
      .rejects.toMatchObject({
        status: 409,
        reasonCode: "approval_required",
        details: expect.objectContaining({ tool: "open_ticket" }),
      });
    expect(remote.calls).toEqual([]);

    const [interaction] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issue.id));
    const payload = interaction!.payload as {
      prompt: string;
      detailsMarkdown: string;
      toolAction: Record<string, unknown>;
    };
    expect(payload.prompt).toBe("Approve open_ticket?");
    expect(payload.detailsMarkdown).toContain("Tool: `open_ticket`");
    expect(payload.detailsMarkdown).toContain("Upstream tool: `create_ticket`");
    expect(payload.toolAction).toMatchObject({
      toolDisplayName: "open_ticket",
      exposedToolName: "open_ticket",
      upstreamToolName: "create_ticket",
    });
    expect(String(payload.toolAction.toolName)).toMatch(/^mcp\..+:create-ticket$/);

    // Calling again by the generated name reaches the same pending request.
    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: String(payload.toolAction.toolName),
      parameters: { title: "Printer" },
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issue.id))).toHaveLength(1);
  });

  it("runs an approved renamed tool upstream and names it by its alias in the outcome wake", async () => {
    const { company, agent, run, issue } = await createCompanyFixture(db);
    const { entries } = await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Review ticket writes",
      policyType: "require_approval",
      selectors: { catalogEntryId: entries.find((entry) => entry.toolName === "create_ticket")!.id },
      priority: 1,
    });
    const wakeup = vi.fn(async (agentId: string, input: any) => (await db.insert(agentWakeupRequests).values({
      companyId: company.id, agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload,
    }).returning())[0] as any);
    const deliveries = toolActionDeliveryService(db, { wakeup });
    const remote = recordingRemote();
    const gateway = createToolGatewayService(db, {
      remoteHttpRequest: remote.remoteHttpRequest,
      toolActionSigningSecret: SIGNING_SECRET,
      onToolActionSettled: deliveries.deliver,
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const rejection = await gateway.executeTool({ sessionToken: session.token, tool: "open_ticket", parameters: { title: "VPN" } })
      .then(() => null, (error: { details?: { actionRequestId?: string } }) => error);
    const actionRequestId = rejection?.details?.actionRequestId;
    expect(actionRequestId).toEqual(expect.any(String));

    await gateway.approveActionRequest({ companyId: company.id, actionRequestId: actionRequestId!, actor: { userId: "reviewer" } });
    expect(remote.calls).toEqual([{ name: "create_ticket", arguments: { title: "VPN" } }]);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await deliveries.deliverForRun({ companyId: company.id, runId: run.id });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const payload = wakeup.mock.calls[0]![1].payload;
    expect(payload.issueId).toBe(issue.id);
    expect(payload.toolAction).toMatchObject({ toolName: "open_ticket", executionStatus: "executed" });
    expect(payload.paperclipAgentMessage.untrustedToolResults).toMatchObject([{ toolName: "open_ticket" }]);
  });

  it("uses the exposed name in on-demand search_tools results and run_tool calls", async () => {
    const { company, agent, run } = await createCompanyFixture(db);
    await createConnectionFixture(db, company.id, { config: { ...RENAMED_SEARCH, onDemandTools: true } });
    const remote = recordingRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });

    const listed = (await gateway.listToolsForSession(session.token)).map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(["search_tools", "run_tool"]));
    expect(listed).not.toContain("find_tickets");

    const found = await gateway.executeTool({ sessionToken: session.token, tool: "search_tools", parameters: { query: "support tickets" } });
    const results = (found.result as { data: { tools: Array<Record<string, unknown>> } }).data.tools;
    expect(results).toEqual([
      expect.objectContaining({
        name: "find_tickets",
        displayName: "find_tickets",
        description: "Find support tickets by keyword.",
        upstreamToolName: "search",
      }),
    ]);

    const ran = await gateway.executeTool({
      sessionToken: session.token,
      tool: "run_tool",
      parameters: { tool: "find_tickets", arguments: { query: "vpn" } },
    });
    expect(ran).toMatchObject({ status: "completed", tool: "run_tool", targetTool: "find_tickets" });
    expect(remote.calls).toEqual([{ name: "search", arguments: { query: "vpn" } }]);
  });

  it("falls back to the generated name when an alias is claimed twice or is reserved", async () => {
    const { company, agent, run } = await createCompanyFixture(db);
    // Stored configs can predate validation; the gateway must not trust them.
    await createConnectionFixture(db, company.id, {
      name: "Tickets A",
      config: { toolOverrides: { search: { name: "find_tickets" }, create_ticket: { name: "search_tools" } } },
    });
    await createConnectionFixture(db, company.id, {
      name: "Tickets B",
      config: { toolOverrides: { search: { name: "FIND_TICKETS", description: "Second desk search." } } },
    });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: recordingRemote().remoteHttpRequest });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tools = await gateway.listToolsForSession(session.token);
    const connected = tools.filter((tool) => tool.connectionId);
    expect(connected).toHaveLength(4);
    expect(connected.every((tool) => tool.exposedName === null)).toBe(true);
    expect(connected.every((tool) => /^mcp\..+:(search|create-ticket)$/.test(tool.name))).toBe(true);
    // The description override does not depend on the name and still applies.
    expect(connected.map((tool) => tool.description)).toContain("Second desk search.");
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "find_tickets", parameters: {} }))
      .rejects.toMatchObject({ status: 404, reasonCode: "tool_not_found" });
  });

  it("names relayed runner tools after the alias", async () => {
    const { company, profile } = await createCompanyFixture(db);
    await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    const remote = recordingRemote();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const named = await gateway.createNamedGateway({
      companyId: company.id,
      body: { name: "Runner relay", profileId: profile.id },
    });
    const token = await gateway.createNamedGatewayToken({
      companyId: company.id,
      gatewayId: named.id,
      body: { name: "Runner relay" },
    });
    const assigned = await createAssignedMcpTools({
      gateway,
      gatewayPublicId: named.gatewayPublicId,
      bearerToken: token.token,
    });
    const definition = assigned.definitions()
      .find((tool) => String(tool.name).startsWith("app_find_tickets_"));
    expect(definition).toMatchObject({ description: "find_tickets: Find support tickets by keyword." });
    await assigned.execute({ tool: String(definition!.name), arguments: { query: "dns" } });
    expect(remote.calls).toEqual([{ name: "search", arguments: { query: "dns" } }]);
  });
});

describeEmbeddedPostgres("tool connection exposed tool name overrides", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-overrides-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects an exposed name that another connection of the company already uses", async () => {
    const { company } = await createCompanyFixture(db);
    await createConnectionFixture(db, company.id, { config: RENAMED_SEARCH });
    const { connection: other } = await createConnectionFixture(db, company.id, { name: "Other desk" });
    const service = toolAccessService(db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });

    await expect(service.updateConnection(other.id, {
      config: { url: REMOTE_URL, toolOverrides: { search: { name: "Find_Tickets" } } },
    })).rejects.toMatchObject({ status: 422, details: expect.objectContaining({ code: "exposed_tool_name_conflict" }) });
    await expect(service.updateConnection(other.id, {
      config: { url: REMOTE_URL, toolOverrides: { search: { name: "paperclip_search" } } },
    })).rejects.toMatchObject({ status: 422, details: expect.objectContaining({ code: "invalid_tool_overrides" }) });

    const updated = await service.updateConnection(other.id, {
      config: { url: REMOTE_URL, toolOverrides: { search: { name: "find_other_tickets" } } },
    });
    expect(updated.config).toMatchObject({ toolOverrides: { search: { name: "find_other_tickets" } } });
  });

  it("reports exposed names and descriptions in the catalog a refresh returns, as the catalog listing does", async () => {
    const { company } = await createCompanyFixture(db);
    const remote = recordingRemote([
      {
        name: "search",
        description: "Upstream search description.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
      { name: "create_ticket", description: "Upstream create description.", inputSchema: { type: "object", properties: {} } },
    ]);
    const service = toolAccessService(db, {
      remoteHttpRequest: remote.remoteHttpRequest,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    const connection = await service.createConnection(company.id, {
      name: "Tickets",
      transport: "mcp_remote",
      authKind: "none",
      connectionPurpose: "tool",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
      transportConfig: {},
      config: {
        url: REMOTE_URL,
        toolOverrides: { search: { name: "find_tickets", description: "Find support tickets by keyword." } },
      },
    });

    // Callers such as the connect flow render the refresh result directly.
    const refresh = await service.refreshCatalog(connection.id);
    const refreshed = new Map(refresh.catalog.map((entry) => [entry.toolName, entry]));
    expect(refreshed.get("search")).toMatchObject({
      toolName: "search",
      description: "Upstream search description.",
      exposedName: "find_tickets",
      exposedDescription: "Find support tickets by keyword.",
    });
    expect(refreshed.get("create_ticket")).toMatchObject({
      toolName: "create_ticket",
      exposedName: null,
      exposedDescription: null,
    });

    const listed = await service.listCatalog(connection.id, company.id);
    expect(listed).toHaveLength(2);
    for (const entry of listed) {
      expect(refreshed.get(entry.toolName)).toMatchObject({
        exposedName: entry.exposedName,
        exposedDescription: entry.exposedDescription,
      });
    }
  });

  it("keeps overrides through catalog refreshes and still quarantines a changed upstream schema", async () => {
    const { company, agent, run } = await createCompanyFixture(db);
    const remote = recordingRemote([
      { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
    ]);
    const service = toolAccessService(db, {
      remoteHttpRequest: remote.remoteHttpRequest,
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    const connection = await service.createConnection(company.id, {
      name: "Tickets",
      transport: "mcp_remote",
      authKind: "none",
      connectionPurpose: "tool",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
      transportConfig: {},
      config: { url: REMOTE_URL, quarantineNewEntries: true, toolOverrides: { search: { name: "find_tickets" } } },
    });
    await service.refreshCatalog(connection.id);
    await service.updateConnection(connection.id, { status: "active", enabled: true });
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, connection.id));
    const gateway = createToolGatewayService(db, { remoteHttpRequest: remote.remoteHttpRequest });
    const visible = async () => {
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
      return (await gateway.listToolsForSession(session.token)).map((tool) => tool.exposedName ?? tool.name);
    };
    expect(await visible()).toContain("find_tickets");

    // An unchanged refresh keeps the alias.
    await service.refreshCatalog(connection.id);
    expect(await visible()).toContain("find_tickets");

    // A changed upstream schema still needs review: the alias does not bypass quarantine.
    remote.setTools([
      { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "string" } } }, annotations: { readOnlyHint: true } },
    ]);
    await service.refreshCatalog(connection.id);
    const [entry] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, connection.id));
    expect(entry!.status).toBe("quarantined");
    expect(await visible()).not.toContain("find_tickets");

    const stored = await service.getConnection(connection.id);
    expect(stored.config).toMatchObject({ toolOverrides: { search: { name: "find_tickets" } } });
    expect((await service.listCatalog(connection.id, company.id))[0]).toMatchObject({
      toolName: "search",
      exposedName: "find_tickets",
      status: "quarantined",
    });
  });
});
