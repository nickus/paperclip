import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issues,
  projects,
  toolAccessAuditEvents,
  toolActionDeliveries,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolGatewayRateLimitCounters,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolActionDeliveryService } from "../services/tool-action-delivery.js";
import { TOOL_CONTENT_RETENTION_DEFAULT_ENV } from "../services/tool-content-retention.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// Canaries: private text that goes into a call's arguments and comes back in
// its result or error. A connection with contentRetention "none" must not leave
// any of them in the database.
const ARGUMENT_CANARY = "private-query-canary";
const RESULT_CANARY = "private-note-body-canary";
const ERROR_CANARY = "private-error-canary";
const SIGNING_SECRET = "content-retention-test-signing-secret";

/** A remote MCP server behind the gateway's transport seam. */
function notesServer() {
  const calls: string[] = [];
  const remoteHttpRequest = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as {
      id: string;
      params?: { name?: string };
    };
    const toolName = payload.params?.name ?? "";
    calls.push(toolName);
    const result = toolName === "fail_note"
      ? { content: [{ type: "text", text: `upstream refused: ${ERROR_CANARY}` }], isError: true }
      : { content: [{ type: "text", text: `note: ${RESULT_CANARY}` }] };
    return Response.json({ jsonrpc: "2.0", id: payload.id, result });
  };
  return { calls, remoteHttpRequest };
}

async function createFixture(db: Db, connectionConfig: Record<string, unknown> = {}) {
  const company = await db.insert(companies).values({
    name: `Retention ${randomUUID()}`,
    issuePrefix: `CR${randomUUID().slice(0, 6).toUpperCase()}`,
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
    title: "Notes work",
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
    applicationKey: `notes-${randomUUID().slice(0, 8)}`,
    name: "Notes",
    type: "mcp_http",
    status: "active",
  }).returning();
  const config = { url: "https://notes.example.test/mcp", ...connectionConfig };
  const [connection] = await db.insert(toolConnections).values({
    companyId: company.id,
    applicationId: application!.id,
    name: "Notes",
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
  for (const toolName of ["search_notes", "fail_note", "update_note"]) {
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
      annotations: toolName === "update_note" ? {} : { readOnlyHint: true },
      riskLevel: toolName === "update_note" ? "write" : "read",
      isReadOnly: toolName !== "update_note",
      isWrite: toolName === "update_note",
      status: "active",
      versionHash: randomUUID(),
    });
  }
  return { company, agent, issue, run, connection: connection! };
}

async function openSession(
  db: Db,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  remote: ReturnType<typeof notesServer>,
  options: { onToolActionSettled?: (actionRequestId: string) => Promise<unknown> } = {},
) {
  const gateway = createToolGatewayService(db, {
    remoteHttpRequest: remote.remoteHttpRequest,
    toolActionSigningSecret: SIGNING_SECRET,
    ...options,
  });
  const session = await gateway.createSession({
    companyId: fixture.company.id,
    agentId: fixture.agent.id,
    runId: fixture.run.id,
  });
  const tools = await gateway.listToolsForSession(session.token);
  const toolNamed = (upstream: string) => tools.find((tool) => tool.upstreamToolName === upstream)!.name;
  return { gateway, session, toolNamed };
}

/** Every stored row that can hold call content, serialized for canary search. */
async function storedCallRecords(db: Db, companyId: string) {
  const [invocations, callEvents, auditEvents, activity, actionRequests, interactions, formalApprovals] = await Promise.all([
    db.select().from(toolInvocations).where(eq(toolInvocations.companyId, companyId)),
    db.select().from(toolCallEvents).where(eq(toolCallEvents.companyId, companyId)),
    db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, companyId)),
    db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
    db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, companyId)),
    db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
    db.select().from(approvals).where(eq(approvals.companyId, companyId)),
  ]);
  return {
    invocations,
    callEvents,
    auditEvents,
    activity,
    actionRequests,
    interactions,
    serialized: JSON.stringify([invocations, callEvents, auditEvents, activity, actionRequests, interactions, formalApprovals]),
  };
}

const SHA256 = /^[a-f0-9]{64}$/;

describeEmbeddedPostgres("tool gateway per-connection content retention", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalDefault = process.env[TOOL_CONTENT_RETENTION_DEFAULT_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-content-retention-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalDefault === undefined) delete process.env[TOOL_CONTENT_RETENTION_DEFAULT_ENV];
    else process.env[TOOL_CONTENT_RETENTION_DEFAULT_ENV] = originalDefault;
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(toolCallEvents);
    await db.delete(toolGatewaySessions);
    await db.delete(toolGatewayRateLimitCounters);
    await db.delete(toolActionDeliveries);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolAccessAuditEvents);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(toolPolicies);
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
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stores hashes and sizes but no argument or result text for a connection that keeps none", async () => {
    const fixture = await createFixture(db, { contentRetention: "none" });
    const remote = notesServer();
    const { gateway, session, toolNamed } = await openSession(db, fixture, remote);

    const result = await gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("search_notes"),
      parameters: { query: ARGUMENT_CANARY },
    });
    // The agent still receives the full result.
    expect(JSON.stringify(result.result)).toContain(RESULT_CANARY);

    const stored = await storedCallRecords(db, fixture.company.id);
    expect(stored.serialized).not.toContain(ARGUMENT_CANARY);
    expect(stored.serialized).not.toContain(RESULT_CANARY);

    const [invocation] = stored.invocations;
    expect(invocation).toMatchObject({
      status: "succeeded",
      argumentsHash: expect.stringMatching(SHA256),
      argumentsSummary: {
        summary: "",
        sha256: expect.stringMatching(SHA256),
        sizeBytes: expect.any(Number),
        contentRetention: "none",
      },
      resultHash: expect.stringMatching(SHA256),
      resultSizeBytes: expect.any(Number),
      resultSummary: {
        summary: "",
        sha256: expect.stringMatching(SHA256),
        contentRetention: "none",
      },
    });
    expect(invocation!.argumentsSummary!.sizeBytes).toBeGreaterThan(ARGUMENT_CANARY.length);
    expect(invocation!.resultSizeBytes).toBeGreaterThan(RESULT_CANARY.length);

    const completed = stored.callEvents.find((event) => event.eventType === "call_completed")!;
    expect(completed).toMatchObject({
      outcome: "success",
      requestHash: expect.stringMatching(SHA256),
      requestSummary: { summary: "", contentRetention: "none" },
      resultHash: invocation!.resultHash,
      resultSummary: { summary: "", contentRetention: "none" },
      resultSizeBytes: invocation!.resultSizeBytes,
    });
    const decision = stored.callEvents.find((event) => event.eventType === "policy_decision")!;
    expect(decision.argumentsSummary).toMatchObject({ summary: "", sha256: expect.stringMatching(SHA256) });

    const audit = stored.auditEvents.find((event) => event.action === "call_completed")!;
    expect(audit.details).toMatchObject({
      contentRetention: "none",
      argumentsSummary: { summary: "", sha256: invocation!.argumentsSummary!.sha256 },
      resultSummary: { summary: "", sha256: invocation!.resultHash },
      result: { hasContent: true },
    });
  });

  it("keeps summaries for a connection without the setting", async () => {
    const fixture = await createFixture(db);
    const remote = notesServer();
    const { gateway, session, toolNamed } = await openSession(db, fixture, remote);

    await gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("search_notes"),
      parameters: { query: ARGUMENT_CANARY },
    });

    const stored = await storedCallRecords(db, fixture.company.id);
    const [invocation] = stored.invocations;
    expect(invocation!.argumentsSummary!.summary).toContain(ARGUMENT_CANARY);
    expect(invocation!.resultSummary!.summary).toContain(RESULT_CANARY);
    expect(invocation!.argumentsSummary).not.toHaveProperty("contentRetention");
    const completed = stored.callEvents.find((event) => event.eventType === "call_completed")!;
    expect(completed.requestSummary!.summary).toContain(ARGUMENT_CANARY);
    expect(completed.resultSummary!.summary).toContain(RESULT_CANARY);
    const audit = stored.auditEvents.find((event) => event.action === "call_completed")!;
    expect(JSON.stringify(audit.details)).toContain(RESULT_CANARY);
    expect(audit.details).not.toHaveProperty("contentRetention");
  });

  it("stores the error code but not the upstream error text", async () => {
    const fixture = await createFixture(db, { contentRetention: "none" });
    const remote = notesServer();
    const { gateway, session, toolNamed } = await openSession(db, fixture, remote);

    // The caller still gets the provider's words.
    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: toolNamed("fail_note"),
      parameters: { query: ARGUMENT_CANARY },
    })).rejects.toMatchObject({ reasonCode: "tool_error", message: expect.stringContaining(ERROR_CANARY) });

    const stored = await storedCallRecords(db, fixture.company.id);
    expect(stored.serialized).not.toContain(ERROR_CANARY);
    expect(stored.serialized).not.toContain(ARGUMENT_CANARY);
    expect(stored.invocations[0]).toMatchObject({
      status: "failed",
      errorCode: "tool_error",
      errorMessage: expect.stringContaining("tool_error"),
    });
    const failed = stored.auditEvents.find((event) => event.action === "call_failed")!;
    expect(failed.details).toMatchObject({ reasonCode: "tool_error", contentRetention: "none" });
  });

  it("keeps approval-gated calls content-free and drops their signed arguments once settled", async () => {
    const fixture = await createFixture(db, { contentRetention: "none" });
    const remote = notesServer();
    const { gateway, session, toolNamed } = await openSession(db, fixture, remote);
    const updateTool = toolNamed("update_note");
    await db.insert(toolPolicies).values({
      companyId: fixture.company.id,
      name: "Ask before writing notes",
      policyType: "require_approval",
      selectors: { toolName: updateTool },
    });

    const call = (body: string) => gateway.executeTool({
      sessionToken: session.token,
      tool: updateTool,
      parameters: { noteId: "n1", body: `${ARGUMENT_CANARY} ${body}` },
    });
    await expect(call("approved")).rejects.toMatchObject({ reasonCode: "approval_required" });
    await expect(call("declined")).rejects.toMatchObject({ reasonCode: "approval_required" });

    const pending = await storedCallRecords(db, fixture.company.id);
    // The card and the request carry the hash; only the signed arguments, which
    // execution needs, hold the call until it settles.
    expect(pending.serialized.replaceAll(/"signedArguments":"[^"]*"/g, "")).not.toContain(ARGUMENT_CANARY);
    expect(pending.actionRequests).toHaveLength(2);
    for (const request of pending.actionRequests) {
      expect(request.signedArguments).toEqual(expect.any(String));
      expect(request.canonicalArgumentsSummary).toMatchObject({ summary: "", contentRetention: "none" });
      expect(request.previewMarkdown).toContain("Details are not saved for this connection");
    }
    const card = pending.interactions[0]!.payload as { detailsMarkdown?: string; toolAction?: { argumentsSummaryJson?: string } };
    expect(card.toolAction?.argumentsSummaryJson).toBe("");
    expect(card.detailsMarkdown).toContain("does not store call content");

    const [first, second] = [...pending.actionRequests].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const approved = await gateway.approveActionRequest({
      companyId: fixture.company.id,
      actionRequestId: first!.id,
      actor: { userId: "reviewer" },
    });
    expect(approved).toMatchObject({ status: "executed", contentRetention: "none" });
    expect(remote.calls).toEqual(["update_note"]);
    await gateway.declineActionRequest({
      companyId: fixture.company.id,
      actionRequestId: second!.id,
      actor: { userId: "reviewer" },
    });

    const settled = await storedCallRecords(db, fixture.company.id);
    expect(settled.serialized).not.toContain(ARGUMENT_CANARY);
    expect(settled.serialized).not.toContain(RESULT_CANARY);
    for (const request of settled.actionRequests) {
      expect(request.signedArguments).toBeNull();
    }
    const executedCard = settled.interactions.find((interaction) => interaction.id === first!.interactionId)!;
    expect(executedCard.result).toMatchObject({
      toolAction: { status: "executed", resultSummary: null, contentRetention: "none" },
    });
    const executedInvocation = settled.invocations.find((invocation) => invocation.id === first!.invocationId)!;
    expect(executedInvocation).toMatchObject({
      status: "succeeded",
      resultHash: expect.stringMatching(SHA256),
      resultSummary: { summary: "", contentRetention: "none" },
    });

    // A retry of the executed call is not repeated and says why no result is returned.
    const replay = await call("approved");
    expect(replay.status).toBe("replayed");
    expect(replay.result).toMatchObject({ contentRetained: false, resultSha256: executedInvocation.resultHash });
    expect(remote.calls).toEqual(["update_note"]);
  });

  it("never returns the signed argument envelope from action request reads or reviews", async () => {
    // The envelope is signed, not encrypted: anyone who reads it reads the full
    // arguments, including values the stored summary redacts. It applies to
    // every connection, whatever it retains.
    const secretCanary = "private-password-canary";
    const originalSecret = process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
    process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = SIGNING_SECRET;
    try {
      for (const connectionConfig of [{}, { contentRetention: "none" }]) {
        const fixture = await createFixture(db, connectionConfig);
        const remote = notesServer();
        const { gateway, session, toolNamed } = await openSession(db, fixture, remote);
        const updateTool = toolNamed("update_note");
        await db.insert(toolPolicies).values({
          companyId: fixture.company.id,
          name: "Ask before writing notes",
          policyType: "require_approval",
          selectors: { toolName: updateTool },
        });
        const call = (noteId: string) => gateway.executeTool({
          sessionToken: session.token,
          tool: updateTool,
          parameters: { noteId, password: secretCanary },
        });
        await expect(call("n1")).rejects.toMatchObject({ reasonCode: "approval_required" });
        await expect(call("n2")).rejects.toMatchObject({ reasonCode: "approval_required" });

        // The row keeps the envelope, and it does carry the value.
        const rows = await db.select().from(toolActionRequests)
          .where(eq(toolActionRequests.companyId, fixture.company.id));
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(Buffer.from(row.signedArguments!, "base64url").toString("utf8")).toContain(secretCanary);
        }

        const queue = await toolAccessService(db).listActionRequests(fixture.company.id);
        expect(queue).toHaveLength(2);
        for (const item of queue) expect(item.request).not.toHaveProperty("signedArguments");
        expect(JSON.stringify(queue)).not.toContain(secretCanary);

        const [first, second] = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const approved = await gateway.approveActionRequest({
          companyId: fixture.company.id,
          actionRequestId: first!.id,
          actor: { userId: "reviewer" },
        });
        const declined = await gateway.declineActionRequest({
          companyId: fixture.company.id,
          actionRequestId: second!.id,
          actor: { userId: "reviewer" },
        });
        for (const reviewed of [approved, declined]) {
          expect(reviewed).not.toHaveProperty("signedArguments");
          expect(JSON.stringify(reviewed)).not.toContain(secretCanary);
        }
      }
    } finally {
      if (originalSecret === undefined) delete process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;
      else process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = originalSecret;
    }
  });

  it("tells the agent an approved action ran without handing it a stored result", async () => {
    const fixture = await createFixture(db, { contentRetention: "none" });
    const remote = notesServer();
    const wakeup = vi.fn(async (agentId: string, input: any) => {
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId: fixture.company.id,
        agentId,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      }).returning();
      return wake as any;
    });
    const deliveries = toolActionDeliveryService(db, { wakeup });
    const { gateway, session, toolNamed } = await openSession(db, fixture, remote, {
      onToolActionSettled: deliveries.deliver,
    });
    const updateTool = toolNamed("update_note");
    await db.insert(toolPolicies).values({
      companyId: fixture.company.id,
      name: "Ask before writing notes",
      policyType: "require_approval",
      selectors: { toolName: updateTool },
    });
    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: updateTool,
      parameters: { noteId: "n1", body: ARGUMENT_CANARY },
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests)
      .where(eq(toolActionRequests.companyId, fixture.company.id));
    await gateway.approveActionRequest({
      companyId: fixture.company.id,
      actionRequestId: request!.id,
      actor: { userId: "reviewer" },
    });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, fixture.run.id));
    await deliveries.deliverForRun({ companyId: fixture.company.id, runId: fixture.run.id });

    expect(wakeup).toHaveBeenCalledTimes(1);
    const payload = wakeup.mock.calls[0]![1].payload;
    expect(JSON.stringify(payload)).not.toContain(ARGUMENT_CANARY);
    expect(JSON.stringify(payload)).not.toContain(RESULT_CANARY);
    expect(payload.toolAction).toMatchObject({
      executionStatus: "executed",
      resultSummary: "",
      instructions: expect.stringContaining("does not store call content"),
    });
    expect(payload.toolAction.instructions).toContain("Do not call it again");
  });

  it("keeps test calls content-free", async () => {
    const fixture = await createFixture(db, { contentRetention: "none" });
    const remote = notesServer();
    const { gateway } = await openSession(db, fixture, remote);
    await db.insert(companyMemberships).values({
      companyId: fixture.company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
    });

    const result = await gateway.executeTestCall({
      companyId: fixture.company.id,
      connectionId: fixture.connection.id,
      agentId: fixture.agent.id,
      userId: "board-user",
      toolName: "search_notes",
      parameters: { query: ARGUMENT_CANARY },
    });
    expect(JSON.stringify(result)).toContain(RESULT_CANARY);
    const stored = await storedCallRecords(db, fixture.company.id);
    expect(stored.invocations).toHaveLength(1);
    expect(stored.serialized).not.toContain(ARGUMENT_CANARY);
    expect(stored.serialized).not.toContain(RESULT_CANARY);
  });

  it("applies the instance default to connections that choose no retention", async () => {
    process.env[TOOL_CONTENT_RETENTION_DEFAULT_ENV] = "none";
    const unset = await createFixture(db);
    const remote = notesServer();
    const first = await openSession(db, unset, remote);
    await first.gateway.executeTool({
      sessionToken: first.session.token,
      tool: first.toolNamed("search_notes"),
      parameters: { query: ARGUMENT_CANARY },
    });
    const storedUnset = await storedCallRecords(db, unset.company.id);
    expect(storedUnset.serialized).not.toContain(ARGUMENT_CANARY);
    expect(storedUnset.serialized).not.toContain(RESULT_CANARY);

    // A connection that opts into summaries keeps them under a "none" default.
    const optedIn = await createFixture(db, { contentRetention: "summary" });
    const second = await openSession(db, optedIn, remote);
    await second.gateway.executeTool({
      sessionToken: second.session.token,
      tool: second.toolNamed("search_notes"),
      parameters: { query: ARGUMENT_CANARY },
    });
    const storedOptedIn = await storedCallRecords(db, optedIn.company.id);
    expect(storedOptedIn.invocations[0]!.resultSummary!.summary).toContain(RESULT_CANARY);
  });
});
