import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeSandboxCallbackBridgeRequestForPolicy } from "@paperclipai/adapter-utils/sandbox-callback-bridge";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => mockBuiltInAgentService,
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  findActiveServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    findActiveServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

function boardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp(actor: Record<string, unknown> = boardActor(), db: Record<string, unknown> = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

function makeReflectionCoachAgent(overrides: Record<string, unknown> = {}) {
  return {
    ...makeAgent(),
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reflection Coach",
    metadata: {
      paperclipBuiltInAgent: {
        key: "reflection-coach",
        featureKeys: ["reflection-coach"],
      },
    },
    ...overrides,
  };
}

describe("agent instructions bundle routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
  });

  it("returns bundle metadata", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  it("requires instance-admin access for every external instruction entry point", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    });
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });
    const requests = [
      () => request(app).get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
      () => request(app)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle")
        .send({ entryFile: "AGENTS.md" }),
      () => request(app)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
      () => request(app)
        .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .send({ path: "AGENTS.md", content: "# changed" }),
      () => request(app)
        .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
    ];

    for (const perform of requests) {
      const res = await perform();
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("Instance admin");
    }
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
  });

  it("treats a host root mislabeled as managed as external", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/private/host/instructions",
        instructionsEntryFile: "AGENTS.md",
      },
    });
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle");

    expect(res.status).toBe(403);
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
  });

  it("allows an instance admin to read an external instruction bundle", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    });

    const res = await requestApp(
      await createApp({
        type: "board",
        userId: "instance-admin",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
        source: "session",
        isInstanceAdmin: true,
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  it("rejects a company admin that requests a new external instruction root", async () => {
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => ({
      ...config,
      instructionsBundleMode: "external",
      instructionsRootPath: "/srv/paperclip/external-agent",
      instructionsEntryFile: "AGENTS.md",
    }));
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const compatibilityRes = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-path")
      .send({ path: "/srv/paperclip/external-agent/AGENTS.md" });
    expect(compatibilityRes.status, JSON.stringify(compatibilityRes.body)).toBe(403);

    const bundleRes = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle")
      .send({ mode: "external", rootPath: "/srv/paperclip/external-agent" });
    expect(bundleRes.status, JSON.stringify(bundleRes.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
  });

  it("rejects external instruction roots through the generic agent patch", async () => {
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/srv/paperclip/external-agent",
          instructionsEntryFile: "AGENTS.md",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects external instruction roots during both hire and direct creation", async () => {
    const actor = {
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          }]),
        })),
      })),
    };
    const app = await createApp(actor, db);
    const body = {
      name: "External agent",
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    };

    const hireRes = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send(body);
    expect(hireRes.status, JSON.stringify(hireRes.body)).toBe(403);
    expect(hireRes.body.error).toContain("Instance admin");

    const createRes = await request(app)
      .post("/api/companies/company-1/agents")
      .send(body);
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(403);
    expect(createRes.body.error).toContain("Instance admin");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("denies non-privileged agents from reading peer instructions bundles", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-reader") {
        return {
          ...makeAgent(),
          id: "agent-reader",
          name: "Reader",
          permissions: { canCreateAgents: false },
        };
      }
      return makeAgent();
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_no_grant",
      explanation: "Missing permission: agents:configure or agents:suggest-changes.",
    });

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "agent-reader",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Missing permission");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:read",
      resource: {
        type: "agent",
        companyId: "company-1",
        agentId: "11111111-1111-4111-8111-111111111111",
      },
    }));
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
  });

  it("allows agents to read their own instructions bundles", async () => {
    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  it("allows agents with suggest grants to read peer instructions bundles", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by explicit grant agents:suggest-changes.",
      grant: {
        principalType: "agent",
        principalId: "coach-agent",
        permissionKey: "agents:suggest-changes",
        scope: null,
      },
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "coach-agent") {
        return makeReflectionCoachAgent({ id: "coach-agent" });
      }
      return makeAgent();
    });

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "coach-agent",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:read",
      resource: {
        type: "agent",
        companyId: "company-1",
        agentId: "11111111-1111-4111-8111-111111111111",
      },
    }));
    expect(mockAgentInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
    );
  });

  describe("instruction writes forwarded by the agent-with-instruction-writes bridge policy", () => {
    const TARGET_AGENT_ID = "11111111-1111-4111-8111-111111111111";
    const COACH_AGENT_ID = "coach-agent";
    const APPLY_RUN_ID = "run-apply";
    const FILE_PATH = `/api/agents/${TARGET_AGENT_ID}/instructions-bundle/file`;
    const BUNDLE_PATH = `/api/agents/${TARGET_AGENT_ID}/instructions-bundle`;
    const SUGGEST_ONLY_DENIAL =
      "Permission agents:suggest-changes requires accepted change consent before applying this mutation.";

    function coachActor() {
      return {
        type: "agent",
        agentId: COACH_AGENT_ID,
        companyId: "company-1",
        runId: APPLY_RUN_ID,
        source: "agent_jwt",
      };
    }

    // A request_confirmation row as the change-consent gate reads it. By
    // default a board user accepted it.
    function consentRow(overrides: {
      sourceRunId?: string;
      consumed?: boolean;
      resolvedByUserId?: string | null;
      resolvedByAgentId?: string | null;
    } = {}) {
      return {
        id: "interaction-1",
        sourceRunId: overrides.sourceRunId ?? "run-proposal",
        resolvedByUserId: overrides.resolvedByUserId === undefined ? "board-user" : overrides.resolvedByUserId,
        resolvedByAgentId: overrides.resolvedByAgentId ?? null,
        payload: {
          version: 1,
          prompt: "Apply the proposed instructions change?",
          detailsMarkdown: "```diff\n- old rule\n+ new rule\n```",
          target: { type: "custom", key: `agent:${TARGET_AGENT_ID}:instructions` },
        },
        result: {
          version: 1,
          outcome: "accepted",
          ...(overrides.consumed ? { consumedAt: "2026-01-01T00:00:00.000Z", consumedByRunId: "run-old" } : {}),
        },
      };
    }

    // The gate's only database access: one select of candidate rows and, on a
    // match, one update that marks the row consumed.
    function consentDb(rows: Array<ReturnType<typeof consentRow>>) {
      const consumedUpdates: Array<Record<string, unknown>> = [];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => rows,
              }),
            }),
          }),
        }),
        update: () => ({
          set: (value: Record<string, unknown>) => {
            consumedUpdates.push(value);
            return {
              where: () => ({
                returning: async () => [{ id: rows[0]?.id ?? "missing" }],
              }),
            };
          },
        }),
      };
      return { db, consumedUpdates };
    }

    // The coach may only suggest changes: its direct write is refused for
    // missing consent, and allowed once the gate confirms an accepted card.
    function mockSuggestOnlyCoach() {
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === COACH_AGENT_ID) return makeReflectionCoachAgent({ id: COACH_AGENT_ID });
        return makeAgent();
      });
      mockAccessService.decide.mockImplementation(async (input: { action: string; scope?: Record<string, unknown> }) => {
        if (input.action !== "agent_config:update") {
          return { allowed: true, reason: "allow_explicit_grant", explanation: "Allowed by test grant" };
        }
        if (input.scope?.consentedChange === true) {
          return {
            allowed: true,
            reason: "allow_consented_change",
            explanation: "Allowed by suggest permission agents:suggest-changes after accepted change consent.",
          };
        }
        return { allowed: false, reason: "deny_missing_consent", explanation: SUGGEST_ONLY_DENIAL };
      });
    }

    function bridgeDecision(method: string, path: string, policy: "agent" | "agent-with-instruction-writes") {
      return authorizeSandboxCallbackBridgeRequestForPolicy({ method, path }, { policy, companyId: "company-1" });
    }

    it("passes the bridge only under the opened policy, and never for deletes", () => {
      expect(bridgeDecision("PUT", FILE_PATH, "agent-with-instruction-writes")).toBeNull();
      expect(bridgeDecision("PATCH", BUNDLE_PATH, "agent-with-instruction-writes")).toBeNull();
      expect(bridgeDecision("DELETE", FILE_PATH, "agent-with-instruction-writes")).toContain("Route not allowed");
      expect(bridgeDecision("PUT", FILE_PATH, "agent")).toContain("Route not allowed");
      expect(bridgeDecision("PATCH", BUNDLE_PATH, "agent")).toContain("Route not allowed");
    });

    it("still refuses a suggest-only agent's file write without an accepted change consent", async () => {
      expect(bridgeDecision("PUT", FILE_PATH, "agent-with-instruction-writes")).toBeNull();
      mockSuggestOnlyCoach();
      const { db, consumedUpdates } = consentDb([]);

      const res = await requestApp(
        await createApp(coachActor(), db),
        (baseUrl) => request(baseUrl).put(FILE_PATH).send({ path: "AGENTS.md", content: "# Changed\n" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(SUGGEST_ONLY_DENIAL);
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(consumedUpdates).toEqual([]);
    });

    it("still refuses a suggest-only agent's bundle update without an accepted change consent", async () => {
      expect(bridgeDecision("PATCH", BUNDLE_PATH, "agent-with-instruction-writes")).toBeNull();
      mockSuggestOnlyCoach();
      const { db } = consentDb([]);

      const res = await requestApp(
        await createApp(coachActor(), db),
        (baseUrl) => request(baseUrl).patch(BUNDLE_PATH).send({ entryFile: "AGENTS.md" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("refuses a card created in the applying run itself, or one already consumed", async () => {
      mockSuggestOnlyCoach();
      for (const row of [consentRow({ sourceRunId: APPLY_RUN_ID }), consentRow({ consumed: true })]) {
        const { db, consumedUpdates } = consentDb([row]);
        const res = await requestApp(
          await createApp(coachActor(), db),
          (baseUrl) => request(baseUrl).put(FILE_PATH).send({ path: "AGENTS.md", content: "# Changed\n" }),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(consumedUpdates).toEqual([]);
      }
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    });

    it("refuses a card that an agent accepted, including the agent that created it", async () => {
      mockSuggestOnlyCoach();
      for (const row of [
        consentRow({ resolvedByUserId: null, resolvedByAgentId: COACH_AGENT_ID }),
        consentRow({ resolvedByUserId: null, resolvedByAgentId: "other-agent" }),
        consentRow({ resolvedByUserId: null }),
      ]) {
        const { db, consumedUpdates } = consentDb([row]);
        const res = await requestApp(
          await createApp(coachActor(), db),
          (baseUrl) => request(baseUrl).put(FILE_PATH).send({ path: "AGENTS.md", content: "# Changed\n" }),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(consumedUpdates).toEqual([]);
      }
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    });

    it("names the target agent in the change scope, so scoped grants can match it", async () => {
      mockSuggestOnlyCoach();
      const { db } = consentDb([consentRow()]);

      const res = await requestApp(
        await createApp(coachActor(), db),
        (baseUrl) => request(baseUrl).put(FILE_PATH).send({ path: "AGENTS.md", content: "# Changed\n" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const changeDecisions = mockAccessService.decide.mock.calls
        .map(([input]) => input as { action: string; scope?: Record<string, unknown> })
        .filter((input) => input.action === "agent_config:update");
      expect(changeDecisions.map((input) => input.scope)).toEqual([
        { requiresChangeGrant: true, targetAgentId: TARGET_AGENT_ID },
        { requiresChangeGrant: true, targetAgentId: TARGET_AGENT_ID, consentedChange: true },
      ]);
    });

    it("applies a write from a direct agents:configure grant with no card at all", async () => {
      // A direct change grant never reaches the consent gate. This documents
      // that holders of such a grant need no accepted card.
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === COACH_AGENT_ID) return makeReflectionCoachAgent({ id: COACH_AGENT_ID });
        return makeAgent();
      });
      mockAccessService.decide.mockResolvedValue({
        allowed: true,
        reason: "allow_direct_change",
        explanation: "Allowed by direct change permission agents:configure.",
      });
      const { db, consumedUpdates } = consentDb([]);

      const res = await requestApp(
        await createApp(coachActor(), db),
        (baseUrl) => request(baseUrl).put(FILE_PATH).send({ path: "AGENTS.md", content: "# Changed\n" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledTimes(1);
      expect(consumedUpdates).toEqual([]);
    });

    it("applies the write with a card a board user accepted in an earlier run, and consumes the card", async () => {
      mockSuggestOnlyCoach();
      const { db, consumedUpdates } = consentDb([consentRow()]);

      const res = await requestApp(
        await createApp(coachActor(), db),
        (baseUrl) => request(baseUrl).put(FILE_PATH).send({ path: "AGENTS.md", content: "# Changed\n" }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ id: TARGET_AGENT_ID }),
        "AGENTS.md",
        "# Changed\n",
        expect.any(Object),
      );
      expect(consumedUpdates).toHaveLength(1);
      expect(consumedUpdates[0]!.result).toMatchObject({ outcome: "accepted", consumedByRunId: APPLY_RUN_ID });
    });
  });

  it("writes a bundle file and persists compatibility config", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({
        path: "AGENTS.md",
        content: "# Updated Agent\n",
        clearLegacyPromptTemplate: true,
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
      "# Updated Agent\n",
      { clearLegacyPromptTemplate: true },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves managed instructions config when switching adapters", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "claude_local",
        adapterConfig: expect.objectContaining({
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves paperclip skill-sync selections when switching adapters", async () => {
    // Desired skills live inside the per-adapter config under
    // `paperclipSkillSync`, yet they are adapter-agnostic company-level
    // selections. Switching adapter type must not silently wipe them — the
    // server carries them over from the existing config the same way it
    // preserves env/cwd and the instructions bundle.
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4",
        paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "codex_local",
        replaceAdapterConfig: true,
        adapterConfig: {
          model: "gpt-5.4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "codex_local",
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("merges same-adapter config patches so instructions metadata is not dropped", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          command: "codex --profile engineer",
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("replaces adapter config when replaceAdapterConfig is true", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({
      command: "codex --profile engineer",
    });
    expect(res.body.adapterConfig.instructionsBundleMode).toBeUndefined();
    expect(res.body.adapterConfig.instructionsRootPath).toBeUndefined();
    expect(res.body.adapterConfig.instructionsEntryFile).toBeUndefined();
    expect(res.body.adapterConfig.instructionsFilePath).toBeUndefined();
  });
});
