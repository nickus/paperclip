import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRoutes } from "../routes/environments.js";
import { HttpError } from "../errors.js";
import {
  environmentCustomImageTerminalConnectionRegistry,
  environmentCustomImageTerminalSessionStore,
} from "../services/environment-custom-image-terminal-sessions.js";

const now = new Date("2026-06-25T20:00:00.000Z");

const mockIssueService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  clearExecutionWorkspaceEnvironmentSelection: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listLeases: vi.fn(),
  getLeaseById: vi.fn(),
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
  relinkActiveTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  cleanupExpiredSetupSessions: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  clearEnvironmentSelection: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  create: vi.fn(),
  normalizeEnvBindingsForPersistence: vi.fn(),
  listBindingCompanyIdsForTarget: vi.fn(),
  resolveSecretValueForEphemeralAccess: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  projectService: () => mockProjectService,
  instanceSettingsService: () => mockInstanceSettingsService,
  environmentService: () => mockEnvironmentService,
  environmentCustomImageService: () => mockEnvironmentCustomImageService,
  logActivity: mockLogActivity,
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

vi.mock("../services/environment-probe.js", () => ({
  probeEnvironment: vi.fn(),
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
}));

// Environment, setup session and company ids are UUIDs: the routes reject
// any other form with a 400 before they look the record up.
const ENV_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_COMPANY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function createEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: ENV_ID,
    name: "Daytona",
    description: null,
    driver: "sandbox",
    status: "active",
    config: {
      provider: "daytona",
      snapshot: "base-snapshot",
      reuseLease: false,
    },
    envVars: {},
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "template-1",
    companyId: COMPANY_ID,
    environmentId: ENV_ID,
    provider: "daytona",
    templateKind: "snapshot",
    templateRef: "snapshot-secret-ref",
    sourceTemplateRef: "base-snapshot-secret",
    sourceEnvironmentConfigFingerprint: "sha256:base",
    status: "active",
    createdByUserId: "user-1",
    createdByAgentId: null,
    capturedAt: now,
    lastUsedAt: null,
    supersededByTemplateId: null,
    metadata: { safeLabel: "codex" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    companyId: COMPANY_ID,
    environmentId: ENV_ID,
    templateId: "template-1",
    promotedTemplateId: null,
    provider: "daytona",
    providerLeaseId: "lease-secret",
    environmentLeaseId: null,
    status: "waiting_for_user",
    startedByUserId: "user-1",
    startedByAgentId: null,
    baseTemplateRef: "snapshot-secret-ref",
    expiresAt: new Date("2026-06-25T21:00:00.000Z"),
    finishedAt: null,
    failureReason: null,
    connectionSummary: {
      type: "ssh",
      username: "token",
      hostRedacted: true,
      portRedacted: true,
      instructions: "ssh token@203.0.113.10",
    },
    connectionSecretRef: null,
    metadata: {
      setupRpcCompanyId: COMPANY_ID,
      safeLabel: "setup",
      connectUrl: "https://203.0.113.10/setup",
    },
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
  app.use("/api", environmentRoutes({} as never));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return app;
}

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    companyIds: [COMPANY_ID],
    isInstanceAdmin: true,
    ...overrides,
  };
}

function agentActor() {
  return {
    type: "agent",
    agentId: "agent-1",
    companyId: COMPANY_ID,
    source: "agent_key",
    runId: "run-1",
  };
}

function loggedActivityJson() {
  return JSON.stringify(mockLogActivity.mock.calls);
}

function futureDate(minutes = 60) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

describe("environment customImage setup routes", () => {
  beforeEach(() => {
    mockIssueService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockProjectService.clearExecutionWorkspaceEnvironmentSelection.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    Object.values(mockEnvironmentService).forEach((mock) => mock.mockReset());
    Object.values(mockEnvironmentCustomImageService).forEach((mock) => mock.mockReset());
    mockExecutionWorkspaceService.clearEnvironmentSelection.mockReset();
    Object.values(mockSecretService).forEach((mock) => mock.mockReset());
    mockLogActivity.mockReset();
    environmentCustomImageTerminalSessionStore.clear();
    environmentCustomImageTerminalConnectionRegistry.clear();

    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([COMPANY_ID]);
    mockEnvironmentService.getById.mockResolvedValue(createEnvironment());
    mockEnvironmentCustomImageService.getOverview.mockResolvedValue({
      activeTemplate: null,
      activeSession: null,
      latestSession: null,
    });
    mockEnvironmentCustomImageService.getActiveTemplate.mockResolvedValue(null);
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(null);
    mockEnvironmentCustomImageService.startSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: {
        type: "ssh",
        command: "ssh token@203.0.113.10 -p 2222",
      },
    });
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValue({
      session: createSession(),
      connectionPayload: {
        type: "ssh",
        command: "ssh token@203.0.113.10 -p 2222",
      },
    });
    mockEnvironmentCustomImageService.finishSetupSession.mockResolvedValue({
      session: createSession({
        status: "promoted",
        promotedTemplateId: "template-2",
        finishedAt: now,
      }),
      template: createTemplate({
        id: "template-2",
        templateRef: "captured-template-secret",
        sourceTemplateRef: "snapshot-secret-ref",
        metadata: { sandboxId: "sandbox-secret" },
      }),
      connectionPayload: null,
    });
    mockEnvironmentCustomImageService.cancelSetupSession.mockResolvedValue(createSession({
      status: "cancelled",
      finishedAt: now,
      failureReason: "operator requested",
    }));
    mockEnvironmentCustomImageService.rollbackTemplate.mockResolvedValue({
      activeTemplate: createTemplate({ id: "template-1", templateRef: "old-template-secret" }),
      supersededTemplate: createTemplate({ id: "template-2", templateRef: "new-template-secret" }),
    });
    mockEnvironmentCustomImageService.disableTemplate.mockResolvedValue(createTemplate({
      id: "template-2",
      templateRef: "disabled-template-secret",
      status: "revoked",
    }));
    mockEnvironmentCustomImageService.relinkActiveTemplate.mockResolvedValue({
      template: createTemplate({ id: "template-1", templateRef: "relinked-template-secret" }),
      classification: "knob_only",
    });
  });

  it("starts a setup session, returns the live payload, and logs redacted details", async () => {
    const res = await request(createApp(boardActor()))
      .post(`/api/environments/${ENV_ID}/custom-image-setup-sessions?companyId=${COMPANY_ID}`)
      .send({ ttlSeconds: 3600 });

    expect(res.status).toBe(201);
    expect(res.body.connectionPayload.command).toContain("203.0.113.10");
    expect(mockEnvironmentCustomImageService.startSetupSession).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      templateId: null,
      ttlSeconds: 3600,
      actor: {
        userId: "user-1",
        agentId: null,
      },
      secretContextCompanyId: COMPANY_ID,
    });
    const activity = loggedActivityJson();
    expect(activity).not.toContain("203.0.113.10");
    expect(activity).not.toContain("lease-secret");
    expect(activity).not.toContain("snapshot-secret-ref");
  });

  it("refreshes active setup status and can return the live payload to board admins", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor()))
      .get(`/api/environment-custom-image-setup-sessions/${SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.connectionPayload.command).toContain("203.0.113.10");
    expect(mockEnvironmentCustomImageService.refreshSetupSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      includeConnectionPayload: true,
    });
  });

  it("mints a redacted terminal token for waiting SSH setup sessions", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession({
      expiresAt: futureDate(),
    }));
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValue({
      session: createSession({
        expiresAt: futureDate(),
        connectionSummary: {
          type: "ssh",
          username: "ssh-token-secret",
          hostRedacted: true,
          portRedacted: true,
          instructions: "ssh ssh-token-secret@203.0.113.10 -p 2222",
        },
      }),
      connectionPayload: {
        type: "ssh",
        command: "ssh ssh-token-secret@203.0.113.10 -p 2222",
        expiresAt: futureDate(15).toISOString(),
      },
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      setupSessionId: SESSION_ID,
      environmentId: ENV_ID,
      connectionType: "ssh",
    });
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.token).toBe("string");
    expect(typeof res.body.expiresAt).toBe("string");
    expect(res.body.websocketPath).toContain(
      `/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal/ws?terminalSessionId=${encodeURIComponent(res.body.id)}`,
    );
    expect(res.body.websocketPath).not.toContain("token=");
    expect(res.body.websocketPath).not.toContain(res.body.token);
    expect(mockEnvironmentCustomImageService.refreshSetupSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      includeConnectionPayload: true,
    });
    const responseJson = JSON.stringify(res.body);
    expect(responseJson).not.toContain("ssh-token-secret");
    expect(responseJson).not.toContain("203.0.113.10");
    expect(responseJson).not.toContain("ssh ");
    const activity = loggedActivityJson();
    expect(activity).not.toContain("ssh-token-secret");
    expect(activity).not.toContain("203.0.113.10");
    expect(activity).not.toContain("ssh ");
  });

  it("denies terminal token minting to agent API key actors before customImage state is read", async () => {
    const res = await request(createApp(agentActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("denies terminal token minting to non-admin board users before connection payload refresh", async () => {
    const res = await request(createApp(boardActor({
      companyIds: [OTHER_COMPANY_ID],
      isInstanceAdmin: false,
    })))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("rejects terminal tokens unless the refreshed setup session is waiting for the user", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession({
      expiresAt: futureDate(),
    }));
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValue({
      session: createSession({ status: "starting", expiresAt: futureDate() }),
      connectionPayload: {
        type: "ssh",
        command: "ssh user@example.test",
      },
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain("user@example.test");
  });

  it("rejects terminal tokens for expired setup sessions", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValue({
      session: createSession({
        status: "waiting_for_user",
        expiresAt: new Date("2026-06-25T19:00:00.000Z"),
      }),
      connectionPayload: {
        type: "ssh",
        command: "ssh user@example.test",
      },
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(res.status).toBe(409);
  });

  it("rejects non-SSH or unsupported SSH terminal payloads without echoing secrets", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession({
      expiresAt: futureDate(),
    }));
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValueOnce({
      session: createSession({ expiresAt: futureDate() }),
      connectionPayload: {
        type: "browser_terminal",
        command: "ssh ssh-token-secret@203.0.113.10",
      },
    });

    const unsupportedType = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(unsupportedType.status).toBe(422);
    expect(JSON.stringify(unsupportedType.body)).not.toContain("ssh-token-secret");
    expect(JSON.stringify(unsupportedType.body)).not.toContain("203.0.113.10");

    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValueOnce({
      session: createSession({ expiresAt: futureDate() }),
      connectionPayload: {
        type: "ssh",
        command: "ssh ssh-token-secret@203.0.113.10 -i /tmp/private-key",
      },
    });

    const unsupportedShape = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(unsupportedShape.status).toBe(422);
    expect(JSON.stringify(unsupportedShape.body)).not.toContain("ssh-token-secret");
    expect(JSON.stringify(unsupportedShape.body)).not.toContain("203.0.113.10");
    expect(loggedActivityJson()).not.toContain("ssh-token-secret");
  });

  it("rejects invalid and expired terminal payload expiries without minting tokens", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession({
      expiresAt: futureDate(),
    }));
    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValueOnce({
      session: createSession({ expiresAt: futureDate() }),
      connectionPayload: {
        type: "ssh",
        command: "ssh ssh-token-secret@ssh.app.daytona.io",
        expiresAt: "not-a-date",
      },
    });

    const invalidExpiry = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(invalidExpiry.status).toBe(422);
    expect(JSON.stringify(invalidExpiry.body)).not.toContain("ssh-token-secret");

    mockEnvironmentCustomImageService.refreshSetupSession.mockResolvedValueOnce({
      session: createSession({ expiresAt: futureDate() }),
      connectionPayload: {
        type: "ssh",
        command: "ssh ssh-token-secret@ssh.app.daytona.io",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    const expiredPayload = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/terminal-session-token`)
      .send({});

    expect(expiredPayload.status).toBe(409);
    expect(JSON.stringify(expiredPayload.body)).not.toContain("ssh-token-secret");
  });

  it("denies agent API key actors before customImage state or payloads are read", async () => {
    const app = createApp(agentActor());
    const start = await request(app)
      .post(`/api/environments/${ENV_ID}/custom-image-setup-sessions?companyId=${COMPANY_ID}`)
      .send({});
    const status = await request(app)
      .get(`/api/environment-custom-image-setup-sessions/${SESSION_ID}`);

    expect(start.status).toBe(403);
    expect(status.status).toBe(403);
    expect(mockEnvironmentCustomImageService.startSetupSession).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("denies non-admin board users before connection payload refresh", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor({
      companyIds: [OTHER_COMPANY_ID],
      isInstanceAdmin: false,
    })))
      .get(`/api/environment-custom-image-setup-sessions/${SESSION_ID}`);

    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    expect(mockEnvironmentCustomImageService.refreshSetupSession).not.toHaveBeenCalled();
  });

  it("denies single-company fallback when the board actor is not a member", async () => {
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([OTHER_COMPANY_ID]);

    const res = await request(createApp(boardActor({
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    })))
      .post(`/api/environments/${ENV_ID}/custom-image-setup-sessions`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.startSetupSession).not.toHaveBeenCalled();
  });

  it("finishes and promotes a template while logging redacted template details", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());
    const terminal = environmentCustomImageTerminalSessionStore.create({
      setupSessionId: SESSION_ID,
      companyId: COMPANY_ID,
      environmentId: ENV_ID,
      provider: "daytona",
      ssh: { username: "token-secret", host: "203.0.113.10", port: 2222 },
      setupExpiresAt: futureDate(),
    });
    const closeReasons: string[] = [];
    environmentCustomImageTerminalConnectionRegistry.add({
      setupSessionId: SESSION_ID,
      close: (reason) => closeReasons.push(reason),
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/finish`)
      .send({ metadata: { safeLabel: "done" } });

    expect(res.status).toBe(200);
    expect(res.body.template.templateRef).toBe("captured-template-secret");
    expect(mockEnvironmentCustomImageService.finishSetupSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      metadata: { safeLabel: "done" },
    });
    expect(environmentCustomImageTerminalSessionStore.get({
      id: terminal.session.id,
      token: terminal.token,
    })).toBeNull();
    expect(closeReasons).toEqual(["setup_finished"]);
    const activity = loggedActivityJson();
    expect(activity).not.toContain("captured-template-secret");
    expect(activity).not.toContain("snapshot-secret-ref");
    expect(activity).not.toContain("sandbox-secret");
  });

  it("cancels active sessions without logging lease details", async () => {
    mockEnvironmentCustomImageService.getSessionById.mockResolvedValue(createSession());

    const res = await request(createApp(boardActor()))
      .post(`/api/environment-custom-image-setup-sessions/${SESSION_ID}/cancel`)
      .send({ reason: "operator requested" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(mockEnvironmentCustomImageService.cancelSetupSession).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      reason: "operator requested",
    });
    expect(loggedActivityJson()).not.toContain("lease-secret");
  });

  it("rolls back and disables active templates through company-scoped routes", async () => {
    const app = createApp(boardActor());
    const rollback = await request(app)
      .post(`/api/environments/${ENV_ID}/custom-image-template/rollback?companyId=${COMPANY_ID}`)
      .send({});
    const disable = await request(app)
      .delete(`/api/environments/${ENV_ID}/custom-image-template?companyId=${COMPANY_ID}&deleteProviderTemplate=true`);

    expect(rollback.status).toBe(200);
    expect(disable.status).toBe(200);
    expect(mockEnvironmentCustomImageService.rollbackTemplate).toHaveBeenCalledWith({
      environmentId: ENV_ID,
    });
    expect(mockEnvironmentCustomImageService.disableTemplate).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      deleteProviderTemplate: true,
    });
    const activity = loggedActivityJson();
    expect(activity).not.toContain("new-template-secret");
    expect(activity).not.toContain("old-template-secret");
    expect(activity).not.toContain("disabled-template-secret");
  });

  it("relinks the active template through the company-scoped route", async () => {
    const res = await request(createApp(boardActor()))
      .post(`/api/environments/${ENV_ID}/custom-image-template/relink?companyId=${COMPANY_ID}`)
      .send({ confirmBootSourceDrift: true });

    expect(res.status).toBe(200);
    expect(res.body.classification).toBe("knob_only");
    expect(mockEnvironmentCustomImageService.relinkActiveTemplate).toHaveBeenCalledWith({
      environmentId: ENV_ID,
      confirmBootSourceDrift: true,
      actor: {
        actorType: "user",
        actorId: "user-1",
        agentId: null,
        runId: null,
        agentApiKeyId: null,
      },
      companyId: COMPANY_ID,
    });
  });

  it("defaults the confirmation flag to false and rejects unknown body keys", async () => {
    const app = createApp(boardActor());
    const withoutFlag = await request(app)
      .post(`/api/environments/${ENV_ID}/custom-image-template/relink?companyId=${COMPANY_ID}`)
      .send({});
    expect(withoutFlag.status).toBe(200);
    expect(mockEnvironmentCustomImageService.relinkActiveTemplate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ confirmBootSourceDrift: false }),
    );

    // The strict schema rejects unknown keys before the handler runs, so the
    // relink service is never reached for the malformed body.
    const unknownKey = await request(app)
      .post(`/api/environments/${ENV_ID}/custom-image-template/relink?companyId=${COMPANY_ID}`)
      .send({ confirmBootSourceDrift: false, unexpected: true });
    expect(unknownKey.status).not.toBe(200);
    expect(mockEnvironmentCustomImageService.relinkActiveTemplate).toHaveBeenCalledTimes(1);
  });

  it("propagates the drift conflict from the relink service", async () => {
    mockEnvironmentCustomImageService.relinkActiveTemplate.mockImplementationOnce(async () => {
      throw new HttpError(409, "Confirm the relink to keep the captured snapshot.", {
        classification: "boot_source_drift",
        driftedPaths: [{ path: "image", from: "fake:base", to: "fake:other" }],
      });
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/environments/${ENV_ID}/custom-image-template/relink?companyId=${COMPANY_ID}`)
      .send({});

    expect(res.status).toBe(409);
  });

  it("denies agent API key actors before the relink service is called", async () => {
    const res = await request(createApp(agentActor()))
      .post(`/api/environments/${ENV_ID}/custom-image-template/relink?companyId=${COMPANY_ID}`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.relinkActiveTemplate).not.toHaveBeenCalled();
  });

  it("denies non-admin board users before the relink service is called", async () => {
    const res = await request(createApp(boardActor({
      companyIds: [OTHER_COMPANY_ID],
      isInstanceAdmin: false,
    })))
      .post(`/api/environments/${ENV_ID}/custom-image-template/relink?companyId=${COMPANY_ID}`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockEnvironmentCustomImageService.relinkActiveTemplate).not.toHaveBeenCalled();
  });

  describe("path id validation", () => {
    // Values that cannot name a row: a truncated id, a placeholder from an
    // unset client variable, and a UUID with surrounding whitespace.
    const malformedIds = ["1a2b3c4d", "undefined", ` ${ENV_ID}`];

    it("rejects malformed environment ids with 400 before the custom image service runs", async () => {
      const app = createApp(boardActor());
      const routes: Array<[method: "get" | "post" | "delete", suffix: string, body?: object]> = [
        ["get", "/custom-image-template"],
        ["post", "/custom-image-setup-sessions", {}],
        ["post", "/custom-image-template/rollback", {}],
        ["post", "/custom-image-template/relink", { confirmBootSourceDrift: true }],
        ["delete", "/custom-image-template"],
      ];
      for (const [method, suffix, body] of routes) {
        for (const id of malformedIds) {
          const req = request(app)[method](`/api/environments/${encodeURIComponent(id)}${suffix}?companyId=${COMPANY_ID}`);
          const res = body ? await req.send(body) : await req;
          expect(res.status, `${method} ${id}${suffix}`).toBe(400);
          expect(res.body).toEqual({ error: "Invalid environment ID" });
        }
      }
      for (const mock of Object.values(mockEnvironmentCustomImageService)) {
        expect(mock).not.toHaveBeenCalled();
      }
    });

    it("rejects malformed setup session ids with 400 before the session lookup", async () => {
      const app = createApp(boardActor());
      const routes: Array<[method: "get" | "post", suffix: string, body?: object]> = [
        ["get", ""],
        ["post", "/terminal-session-token", {}],
        ["post", "/finish", {}],
        ["post", "/cancel", {}],
      ];
      for (const [method, suffix, body] of routes) {
        for (const id of malformedIds) {
          const req = request(app)[method](`/api/environment-custom-image-setup-sessions/${encodeURIComponent(id)}${suffix}`);
          const res = body ? await req.send(body) : await req;
          expect(res.status, `${method} ${id}${suffix}`).toBe(400);
          expect(res.body).toEqual({ error: "Invalid environment custom image setup session ID" });
        }
      }
      expect(mockEnvironmentCustomImageService.getSessionById).not.toHaveBeenCalled();
    });

    it("rejects a malformed companyId query with 400 before the custom image service runs", async () => {
      // The company id is only written to the activity log after the service
      // call, so it must be checked up front or a rollback would take effect
      // and then fail.
      const app = createApp(boardActor());
      const routes: Array<[method: "get" | "post" | "delete", suffix: string, body?: object]> = [
        ["get", "/custom-image-template"],
        ["post", "/custom-image-setup-sessions", {}],
        ["post", "/custom-image-template/rollback", {}],
        ["post", "/custom-image-template/relink", { confirmBootSourceDrift: true }],
        ["delete", "/custom-image-template"],
      ];
      for (const [method, suffix, body] of routes) {
        for (const companyId of ["1a2b3c4d", "undefined"]) {
          const req = request(app)[method](`/api/environments/${ENV_ID}${suffix}?companyId=${companyId}`);
          const res = body ? await req.send(body) : await req;
          expect(res.status, `${method} ${suffix} ${companyId}`).toBe(400);
          expect(res.body).toEqual({ error: "Invalid company ID" });
        }
      }
      for (const mock of Object.values(mockEnvironmentCustomImageService)) {
        expect(mock).not.toHaveBeenCalled();
      }
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("keeps the access checks ahead of id validation", async () => {
      const res = await request(createApp(agentActor()))
        .get("/api/environment-custom-image-setup-sessions/undefined");
      expect(res.status).toBe(403);
      const template = await request(createApp(boardActor({ companyIds: [OTHER_COMPANY_ID], isInstanceAdmin: false })))
        .delete(`/api/environments/undefined/custom-image-template?companyId=${COMPANY_ID}`);
      expect(template.status).toBe(403);
    });
  });
});
