import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "running",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp() {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
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

describe("POST /agents/:id/pause", () => {
  beforeAll(async () => {
    await loadRouteModules();
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({ ...baseAgent });
    mockAgentService.pause.mockResolvedValue({
      ...baseAgent,
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-04-11T00:01:00.000Z"),
    });
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant" });
  });

  it("cancels the live and queued runs by default, including a bare POST", async () => {
    const app = await createApp();
    for (const send of [
      (base: string) => request(base).post(`/api/agents/${agentId}/pause`),
      (base: string) => request(base).post(`/api/agents/${agentId}/pause`).send({}),
      (base: string) => request(base).post(`/api/agents/${agentId}/pause`).send({ afterCurrentRun: false }),
    ]) {
      const res = await requestApp(app, send);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("paused");
    }

    expect(mockAgentService.pause).toHaveBeenCalledTimes(3);
    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledTimes(3);
    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(agentId);
    for (const [, entry] of mockLogActivity.mock.calls) {
      expect(entry).toMatchObject({ action: "agent.paused", entityId: agentId });
      expect(entry).not.toHaveProperty("details");
    }
  });

  it("pauses without cancelling the live run when asked to pause after the current run", async () => {
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post(`/api/agents/${agentId}/pause`).send({ afterCurrentRun: true }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("paused");
    expect(mockAgentService.pause).toHaveBeenCalledWith(agentId);
    expect(mockHeartbeatService.cancelActiveForAgent).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "agent.paused",
      entityId: agentId,
      details: { afterCurrentRun: true },
    });
  });

  it("rejects a malformed afterCurrentRun value without pausing", async () => {
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post(`/api/agents/${agentId}/pause`).send({ afterCurrentRun: "yes" }),
    );

    expect(res.status).toBe(400);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelActiveForAgent).not.toHaveBeenCalled();
  });
});
