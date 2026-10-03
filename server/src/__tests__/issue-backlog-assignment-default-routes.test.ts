import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdForUpdate: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  normalizePlainAgentMentions: vi.fn(async (_companyId: string, body: string) => body),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  listReviewAttention: vi.fn(),
  isBacklogFromUnassignedCreationDefault: vi.fn(),
}));

const mockPauseGate = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown> | null> => null));
const mockAccessDecide = vi.hoisted(() => vi.fn(async (input: { action?: string; resource?: { issueId?: string } }) => ({
  allowed: true,
  action: input.action,
  reason: "allow_explicit_grant",
  explanation: "Allowed by test grant.",
})));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  nativeQuestionRunToCancel: vi.fn(async () => null),
  validateNativeQuestionResponseInput: vi.fn(),
}));

vi.mock("../services/runner-goals.js", () => ({
  runnerGoalService: () => mockRunnerGoalService,
  RunnerGoalActionError: class RunnerGoalActionError extends Error {},
  RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: mockAccessDecide,
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueTreeControlService: () => ({ getActivePauseHoldGate: mockPauseGate }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  questionResponseDeliveryService: () => ({
    deliver: vi.fn(async () => undefined),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  } as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "backlog",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Defaulted backlog issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("assigning a creation-default backlog issue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessDecide.mockImplementation(async (input) => ({ allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "Allowed by test grant." }));
    mockPauseGate.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
  });

  it("moves an unassigned-creation-default backlog issue to todo on assignment and queues the wake", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.isBacklogFromUnassignedCreationDefault.mockResolvedValue(true);
    mockIssueService.update.mockResolvedValue(
      makeIssue({ status: "todo", assigneeAgentId: ASSIGNEE_AGENT_ID }),
    );

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: ASSIGNEE_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.isBacklogFromUnassignedCreationDefault).toHaveBeenCalledWith(existing.id);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "todo" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
        }),
      }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ source: "assignment", reason: "issue_assigned" }),
    );
  });

  it("leaves a deliberately-parked backlog issue in backlog on assignment, with no wake", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    // The issue was created explicitly in backlog, or someone later chose
    // backlog on purpose: the service signals this is not the creation
    // default any more.
    mockIssueService.isBacklogFromUnassignedCreationDefault.mockResolvedValue(false);
    mockIssueService.update.mockResolvedValue(
      makeIssue({ status: "backlog", assigneeAgentId: ASSIGNEE_AGENT_ID }),
    );

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: ASSIGNEE_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.isBacklogFromUnassignedCreationDefault).toHaveBeenCalledWith(existing.id);
    const updateCallData = mockIssueService.update.mock.calls[0]?.[1];
    expect(updateCallData).toEqual(expect.objectContaining({ assigneeAgentId: ASSIGNEE_AGENT_ID }));
    expect(updateCallData).not.toHaveProperty("status");
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("lets an explicit status in the same request win over the assignment default", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(
      makeIssue({ status: "in_progress", assigneeAgentId: ASSIGNEE_AGENT_ID }),
    );

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "in_progress" });

    expect(res.status).toBe(200);
    // The request already pins a status, so the creation-default lookup
    // never needs to run.
    expect(mockIssueService.isBacklogFromUnassignedCreationDefault).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "in_progress" }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ source: "assignment", reason: "issue_assigned" }),
    );
  });

  it("does not re-default an issue that was explicitly moved back to backlog, even when assigned", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(
      makeIssue({ status: "backlog", assigneeAgentId: ASSIGNEE_AGENT_ID }),
    );

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "backlog" });

    expect(res.status).toBe(200);
    expect(mockIssueService.isBacklogFromUnassignedCreationDefault).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ assigneeAgentId: ASSIGNEE_AGENT_ID, status: "backlog" }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("never defaults the status when the update does not touch the assignee", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(makeIssue({ description: "Updated text" }));

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ description: "Updated text" });

    expect(res.status).toBe(200);
    expect(mockIssueService.isBacklogFromUnassignedCreationDefault).not.toHaveBeenCalled();
    const updateCallData = mockIssueService.update.mock.calls[0]?.[1];
    expect(updateCallData).not.toHaveProperty("status");
  });
});
