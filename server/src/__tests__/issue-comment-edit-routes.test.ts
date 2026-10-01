import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getComment: vi.fn(),
  editComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  decide: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  getExperimental: vi.fn(async () => ({
    enableExternalObjects: false,
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockDocumentAnnotationService = vi.hoisted(() => ({
  cleanupForIssueCommentDeletion: vi.fn(async () => ({ deletedCommentIds: [], resolvedThreadIds: [] })),
  remapOpenThreadsForDocument: vi.fn(async () => []),
}));
const mockDecisionTrainingService = vi.hoisted(() => ({
  scrubDeletedComments: vi.fn(async () => ({ updatedCount: 0 })),
}));
const mockIssueReferenceService = vi.hoisted(() => ({
  deleteCommentSource: vi.fn(async () => undefined),
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(async () => ({ summaries: {} })),
  getIssueSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  listForIssue: vi.fn(async () => []),
  refreshIssueObjects: vi.fn(async () => []),
  syncCommentSafely: vi.fn(async () => undefined),
  syncDocumentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/decision-training.js", () => ({
    decisionTrainingService: () => mockDecisionTrainingService,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null) }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => mockDocumentAnnotationService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueReferenceService: () => mockIssueReferenceService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

let lastErrorContext: unknown;

function describeResponse(res: request.Response) {
  return JSON.stringify({ body: res.body, errorContext: lastErrorContext });
}

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    executionRunId: "run-1",
    identifier: "PAP-1353",
    title: "Edit comment target",
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: ISSUE_ID,
    authorAgentId: ASSIGNEE_AGENT_ID,
    authorUserId: null,
    body: "Original comment body",
    deletedAt: null,
    createdAt: new Date("2026-04-11T15:01:00.000Z"),
    updatedAt: new Date("2026-04-11T15:01:00.000Z"),
    ...overrides,
  };
}

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

function agentActor(agentId: string, runId = "run-1") {
  return {
    type: "agent",
    agentId,
    companyId: "company-1",
    runId,
  };
}

describe.sequential("issue comment edit routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { issueRoutes, errorHandler };
  });

  function installActor(app: express.Express, actor?: Record<string, unknown>) {
    const { issueRoutes, errorHandler } = routeModules.value;

    app.use((req, res, next) => {
      res.on("finish", () => {
        lastErrorContext = (res as any).__errorContext ?? null;
      });
      (req as any).actor = actor ?? boardActor;
      next();
    });
    // Only the agent-actor path exercises `db` directly, through
    // `resolveTaskWatchdogMutationScope`'s `select(...).from(heartbeatRuns)
    // .where(...).then((rows) => rows[0] ?? null)` lookup. An empty result
    // here makes it resolve to `{ kind: "none" }` (no watchdog scope), which
    // is all every test below needs: none of them exercise watchdog-scoped
    // runs. The board-actor path never touches `db` at all.
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
          })),
        })),
      })),
    };
    app.use("/api", issueRoutes(db as any, {} as any));
    app.use(errorHandler);
    return app;
  }

  function createApp() {
    const app = express();
    app.use(express.json());
    return app;
  }

  beforeEach(() => {
    lastErrorContext = undefined;
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getComment.mockResolvedValue(makeComment());
    mockIssueService.editComment.mockImplementation(async (commentId: string, body: string) =>
      makeComment({ id: commentId, body, updatedAt: new Date("2026-04-11T15:10:00.000Z") }),
    );
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: ASSIGNEE_AGENT_ID,
      status: "running",
      startedAt: new Date("2026-04-11T15:00:00.000Z"),
      createdAt: new Date("2026-04-11T14:59:00.000Z"),
    });
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableExternalObjects: false,
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueReferenceService.syncComment.mockResolvedValue(undefined);
    mockExternalObjectService.syncCommentSafely.mockResolvedValue(undefined);
  });

  it("lets the authoring agent edit its own comment", async () => {
    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Corrected body" });

    expect(res.status, describeResponse(res)).toBe(200);
    expect(res.body).toMatchObject({ id: "comment-1", body: "Corrected body" });
    expect(mockIssueService.editComment).toHaveBeenCalledWith(
      "comment-1",
      "Corrected body",
      expect.objectContaining({ afterEdit: expect.any(Function) }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_edited",
        details: expect.objectContaining({
          commentId: "comment-1",
          editedByType: "agent",
          editedByAgentId: ASSIGNEE_AGENT_ID,
        }),
      }),
    );
  });

  it("runs the after-edit hook to resync references and external objects", async () => {
    mockIssueService.editComment.mockImplementation(
      async (commentId: string, body: string, options?: { afterEdit?: (c: unknown, tx: unknown) => Promise<void> }) => {
        const edited = makeComment({ id: commentId, body });
        await options?.afterEdit?.(edited, "tx");
        return edited;
      },
    );

    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Updated with a link" });

    expect(res.status, describeResponse(res)).toBe(200);
    expect(mockIssueReferenceService.syncComment).toHaveBeenCalledWith("comment-1", "tx");
    expect(mockExternalObjectService.syncCommentSafely).toHaveBeenCalledWith("comment-1", "tx");
  });

  it("rejects an agent editing a comment it does not own, even one it may otherwise mutate the issue for", async () => {
    // The actor is the issue's assignee (so the broader issue-mutation gate
    // that `assertAgentIssueMutationAllowed` applies passes trivially) but
    // the comment itself was authored by a different agent — this isolates
    // the comment-author ownership check the way the sibling DELETE route's
    // "rejects deleting another actor's normal comment" test does.
    mockIssueService.getComment.mockResolvedValue(
      makeComment({ authorAgentId: OTHER_AGENT_ID }),
    );

    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Trying to edit someone else's comment" });

    expect(res.status, describeResponse(res)).toBe(403);
    expect(res.body.error).toBe("Only the comment author can edit comments");
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("lets an agent edit its own comment on an issue assigned to a different agent", async () => {
    // This is the main reason to edit rather than just post a correction:
    // the agent commented (as a reviewer, through a mention grant, or
    // because it used to be the assignee) and the issue is now someone
    // else's. `assertAgentIssueMutationAllowed` (issue:mutate) would deny
    // this actor outright with "Agent cannot mutate another agent's issue",
    // because it is not the assignee and holds no checkout-management
    // override. Editing your own comment's text does not need that
    // issue-ownership boundary — it never gives the agent anything it could
    // not already get by posting a brand-new comment — so the route gates
    // on the broader issue:comment boundary instead, same as POST /comments.
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "open", assigneeAgentId: ASSIGNEE_AGENT_ID }),
    );
    mockIssueService.getComment.mockResolvedValue(
      makeComment({ authorAgentId: OTHER_AGENT_ID }),
    );

    const res = await request(
      installActor(createApp(), agentActor(OTHER_AGENT_ID)),
    )
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Fixing my own earlier comment on someone else's issue" });

    expect(res.status, describeResponse(res)).toBe(200);
    expect(mockIssueService.editComment).toHaveBeenCalledWith(
      "comment-1",
      "Fixing my own earlier comment on someone else's issue",
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_edited",
        details: expect.objectContaining({
          editedByType: "agent",
          editedByAgentId: OTHER_AGENT_ID,
        }),
      }),
    );
  });

  it("lets a board user edit a comment it authored", async () => {
    // Ownership is strictly by comment author, the same as the DELETE route:
    // a board/user actor is not a blanket override for every agent's
    // comment, it is only ever "the author" when it posted that comment
    // itself (authorUserId matching its own actor id).
    mockIssueService.getComment.mockResolvedValue(
      makeComment({ authorAgentId: null, authorUserId: "local-board" }),
    );

    const res = await request(installActor(createApp(), boardActor))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Board correction" });

    expect(res.status, describeResponse(res)).toBe(200);
    expect(mockIssueService.editComment).toHaveBeenCalledWith(
      "comment-1",
      "Board correction",
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_edited",
        details: expect.objectContaining({ editedByType: "user", editedByUserId: "local-board" }),
      }),
    );
  });

  it("rejects a board user editing another user's comment when they are not its author", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({ authorAgentId: null, authorUserId: "someone-else" }),
    );

    const res = await request(installActor(createApp(), boardActor))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Not mine to edit" });

    expect(res.status, describeResponse(res)).toBe(403);
    expect(res.body.error).toBe("Only the comment author can edit comments");
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("returns 400 instead of 500 when the comment id is a malformed UUID", async () => {
    // Postgres rejects a malformed (e.g. truncated) UUID path parameter
    // against the `issue_comments.id` uuid column with SQLSTATE 22P02;
    // Drizzle wraps the driver failure, so the code/message live on `cause`.
    // This exercises the real (unmocked) error handler mapping it to 400.
    mockIssueService.getComment.mockRejectedValue(
      Object.assign(new Error('Failed query: select * from "issue_comments" where "id" = $1'), {
        cause: { code: "22P02", message: 'invalid input syntax for type uuid: "trunc-1234"' },
      }),
    );

    const res = await request(installActor(createApp(), boardActor))
      .patch(`/api/issues/${ISSUE_ID}/comments/trunc-1234`)
      .send({ body: "Does not matter" });

    expect(res.status, describeResponse(res)).toBe(400);
    expect(res.body.error).toBe("Invalid id: expected a UUID");
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("returns 404 when the comment does not exist", async () => {
    mockIssueService.getComment.mockResolvedValue(null);

    const res = await request(installActor(createApp(), boardActor))
      .patch(`/api/issues/${ISSUE_ID}/comments/missing-comment`)
      .send({ body: "Does not matter" });

    expect(res.status, describeResponse(res)).toBe(404);
    expect(res.body.error).toBe("Comment not found");
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("returns 404 when the comment belongs to a different issue", async () => {
    mockIssueService.getComment.mockResolvedValue(makeComment({ issueId: "other-issue" }));

    const res = await request(installActor(createApp(), boardActor))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Does not matter" });

    expect(res.status, describeResponse(res)).toBe(404);
    expect(res.body.error).toBe("Comment not found");
  });

  it("returns 404 when the comment has already been deleted", async () => {
    mockIssueService.getComment.mockResolvedValue(
      makeComment({ deletedAt: new Date("2026-04-11T15:05:00.000Z") }),
    );

    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Trying to revive a deleted comment" });

    expect(res.status, describeResponse(res)).toBe(404);
    expect(res.body.error).toBe("Comment not found");
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("returns 404 when the comment was deleted concurrently by the time of the write", async () => {
    mockIssueService.editComment.mockResolvedValue(null);

    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "Racing a delete" });

    expect(res.status, describeResponse(res)).toBe(404);
    expect(res.body.error).toBe("Comment not found");
  });

  it("rejects an oversized body with the field, limit and actual length, before unknown-field alias concerns apply", async () => {
    // 100_000 is ISSUE_COMMENT_MAX_BODY_LENGTH (packages/shared/src/validators/issue.ts),
    // shared with POST /issues/:id/comments so the two routes never drift.
    const overLimit = "a".repeat(100_001);

    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: overLimit });

    expect(res.status, describeResponse(res)).toBe(400);
    expect(res.body).toEqual({
      error: "Comment edit body is too long",
      field: "body",
      maxLength: 100_000,
      actualLength: 100_001,
    });
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "" });

    expect(res.status, describeResponse(res)).toBe(400);
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("rejects a missing body field", async () => {
    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({});

    expect(res.status, describeResponse(res)).toBe(400);
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("rejects unknown fields with a helpful hint", async () => {
    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ text: "wrong field name" });

    expect(res.status, describeResponse(res)).toBe(400);
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("accepts the comment alias for body", async () => {
    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ comment: "Aliased body field" });

    expect(res.status, describeResponse(res)).toBe(200);
    expect(mockIssueService.editComment).toHaveBeenCalledWith(
      "comment-1",
      "Aliased body field",
      expect.anything(),
    );
  });

  it("rejects an oversized body on comment creation with the same limit and shape as edit", async () => {
    // Confirms parity with the edit route's equivalent test above: creation
    // uses the exact same ISSUE_COMMENT_MAX_BODY_LENGTH, and the only
    // difference in the response is the create-specific message text.
    const overLimit = "a".repeat(100_001);

    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: overLimit });

    expect(res.status, describeResponse(res)).toBe(400);
    expect(res.body).toEqual({
      error: "Comment body is too long",
      field: "body",
      maxLength: 100_000,
      actualLength: 100_001,
    });
    expect(mockIssueService.editComment).not.toHaveBeenCalled();
  });

  it("never wakes the assignee agent on an edit", async () => {
    const res = await request(installActor(createApp(), agentActor(ASSIGNEE_AGENT_ID)))
      .patch(`/api/issues/${ISSUE_ID}/comments/comment-1`)
      .send({ body: "@SomeAgent fresh mention added on edit" });

    expect(res.status, describeResponse(res)).toBe(200);
    // The route never reaches for wake/mention machinery for an edit; there is
    // no wakeup-related mock here at all, so a wake attempt would throw
    // instead of silently no-op-ing. Reaching 200 is itself the assertion.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.comment_edited" }),
    );
  });
});
