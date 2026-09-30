import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
}));

const mockEnvironmentCustomImageService = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getActiveTemplate: vi.fn(),
  getSessionById: vi.fn(),
  startSetupSession: vi.fn(),
  refreshSetupSession: vi.fn(),
  finishSetupSession: vi.fn(),
  cancelSetupSession: vi.fn(),
  rollbackTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  cleanupExpiredSetupSessions: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
  replaceSecretRefsForInstanceTarget: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/plugin-environment-driver.js", () => ({
  // The runtime reads this published constant at import time. Mirror the real
  // value so the mocked module keeps the same reusable-lease method contract.
  REUSABLE_LEASE_WORKER_METHODS: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
  listReadyPluginEnvironmentDrivers: vi.fn(async () => []),
  resolvePluginSandboxProviderDriverByKey: vi.fn(async () => null),
  validatePluginEnvironmentDriverConfig: vi.fn(async ({ config }) => config),
  validatePluginSandboxProviderConfig: vi.fn(async ({ provider, config }) => ({
    normalizedConfig: config,
    pluginId: `plugin-${provider}`,
    pluginKey: `plugin.${provider}`,
    driver: {
      driverKey: provider,
      kind: "sandbox_provider",
      displayName: provider,
      configSchema: { type: "object" },
    },
  })),
  startPluginEnvironmentInteractiveSetup: vi.fn(),
  getPluginEnvironmentInteractiveSetup: vi.fn(),
  capturePluginEnvironmentTemplate: vi.fn(),
  cancelPluginEnvironmentInteractiveSetup: vi.fn(),
  deletePluginEnvironmentTemplate: vi.fn(),
}));

// Environment and company ids are UUIDs: the routes reject
// any other form with a 400 before they look the record up.
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_COMPANY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function createEnvironment(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: ENV_ID,
    name: "Local",
    description: "Default execution environment",
    driver: "local",
    status: "active" as const,
    config: {},
    envVars: {},
    metadata: { managedByPaperclip: true },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", environmentRoutes({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as never));
  app.use(errorHandler);
  return app;
}

describe("environment instance routes", () => {
  beforeEach(() => {
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockInstanceSettingsService.getExperimental.mockReset();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    mockEnvironmentService.list.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.create.mockReset();
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    mockLogActivity.mockReset();
    mockSecretService.create.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockReset();
    mockSecretService.listBindingCompanyIdsForTarget.mockReset();
    mockSecretService.resolveSecretValueForEphemeralAccess.mockReset();
    mockSecretService.syncEnvBindingsForTarget.mockReset();
    mockSecretService.syncSecretRefsForTarget.mockReset();
    mockSecretService.replaceSecretRefsForInstanceTarget.mockReset();
    mockSecretService.replaceSecretRefsForInstanceTarget.mockResolvedValue([]);

    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([COMPANY_ID, OTHER_COMPANY_ID]);
    mockEnvironmentService.list.mockResolvedValue([]);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment());
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env ?? {});
    mockSecretService.listBindingCompanyIdsForTarget.mockResolvedValue([]);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue([]);
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("lists the instance environment catalog for a local board actor", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/environments?driver=local`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledWith({
      status: undefined,
      driver: "local",
    });
  });

  it("allows non-admin board members with company access to read the shared environment catalog", async () => {
    mockEnvironmentService.list.mockResolvedValue([createEnvironment()]);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: [COMPANY_ID],
      memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/environments`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockEnvironmentService.list).toHaveBeenCalledTimes(1);
  });

  it("rejects company agents from enumerating the shared environment catalog", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_ID,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/environments`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });

  it("rejects non-admin signed-in board members from mutating instance environments", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/environments`)
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockEnvironmentService.create).not.toHaveBeenCalled();
  });

  it("creates an instance-scoped environment and logs the mutation to every company", async () => {
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/environments`)
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
      });

    expect(res.status).toBe(201);
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Shared Local",
        driver: "local",
        status: "active",
      }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockSecretService.replaceSecretRefsForInstanceTarget).toHaveBeenCalledWith(
      { targetType: "environment", targetId: ENV_ID },
      [],
      { db: expect.anything() },
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      COMPANY_ID,
      { targetType: "environment", targetId: ENV_ID },
      {},
      { db: expect.anything() },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls.map((call) => call[1].companyId)).toEqual([COMPANY_ID, OTHER_COMPANY_ID]);
  });

  it("normalizes and syncs environment envVars on create", async () => {
    const envVars = {
      ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(envVars);
    mockEnvironmentService.create.mockResolvedValue(createEnvironment({ envVars }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/environments`)
      .send({
        name: "Shared Local",
        driver: "local",
        config: {},
        envVars,
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      COMPANY_ID,
      envVars,
      expect.objectContaining({ fieldPath: "envVars" }),
    );
    expect(mockEnvironmentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ envVars }),
      undefined,
      { db: expect.anything() },
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      COMPANY_ID,
      { targetType: "environment", targetId: ENV_ID },
      envVars,
      { db: expect.anything() },
    );
  });

  it("returns full environment details for an instance admin", async () => {
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment({ config: { shell: "zsh" } }));
    const app = createApp({
      type: "board",
      userId: "board-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app).get(`/api/environments/${ENV_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ shell: "zsh" });
  });
});
