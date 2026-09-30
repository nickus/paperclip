import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

type AdapterContext = { runId: string; agent: { id: string } };
type AdapterResult = {
  exitCode: number;
  signal: null;
  timedOut: boolean;
  errorMessage: string | null;
  summary: string;
  provider: string;
  model: string;
};

function succeeded(summary: string): AdapterResult {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary, provider: "test", model: "test-model" };
}

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterContext): Promise<AdapterResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Child completion route test run.",
    provider: "test",
    model: "test-model",
  })),
);

// Each parent lookup the issue routes make after a child reaches a terminal
// status. The routes send their wakes right after the lookup returns, so a
// test waits for it before asserting that no wake was sent.
const parentLookups = vi.hoisted(() => [] as Array<{ parentIssueId: string; woken: boolean }>);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const svc = actual.issueService(...args);
      const lookup = svc.getWakeableParentAfterChildCompletion;
      svc.getWakeableParentAfterChildCompletion = async (...lookupArgs) => {
        const parent = await lookup(...lookupArgs);
        parentLookups.push({
          parentIssueId: lookupArgs[0],
          woken: Boolean(parent && !parent.completedChildBlocksParent),
        });
        return parent;
      };
      return svc;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres child completion wake route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER_ID = "board-owner";

// A parent issue's assignee is woken with `issue_children_completed` when its
// last open child finishes, but only while the parent is waiting on its
// children, and once per child and waiting cycle.
describeEmbeddedPostgres("issue_children_completed wakes from issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-children-completed-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(authUsers).values({
      id: BOARD_USER_ID,
      name: "Board Owner",
      email: "board-owner@example.com",
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => succeeded("Child completion route test run."));
    parentLookups.length = 0;
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: BOARD_USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  /** A manager's parent issue with one child handed to the board user. */
  async function seed(input: {
    parentStatus: string;
    childCreatedByManager?: boolean;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: BOARD_USER_ID,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: BOARD_USER_ID,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent",
      status: input.parentStatus,
      priority: "medium",
      assigneeAgentId: managerId,
      createdByUserId: BOARD_USER_ID,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issues).values({
      id: childId,
      companyId,
      parentId,
      title: "Child",
      status: "in_progress",
      priority: "medium",
      assigneeUserId: BOARD_USER_ID,
      ...(input.childCreatedByManager === false
        ? { createdByUserId: BOARD_USER_ID }
        : { createdByAgentId: managerId }),
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    return { companyId, managerId, parentId, childId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** Moves the child to `status` and waits for the route's wake work. */
  async function setChildStatus(seeded: Seeded, status: string) {
    const lookupsBefore = parentLookups.length;
    const res = await request(createApp(seeded.companyId))
      .patch(`/api/issues/${seeded.childId}`)
      .send({ status });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (status === "done" || status === "cancelled") {
      await vi.waitFor(() => expect(parentLookups.length).toBe(lookupsBefore + 1));
    }
  }

  async function wakesFor(seeded: Seeded) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, seeded.managerId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${seeded.parentId}`,
      ));
  }

  // A finished run that leaves no disposition gets follow-up wakes of its
  // own; only the child-completion and dependency wakes matter here. A wake
  // merged into another run of the parent may take that run's reason, so its
  // payload identifies a child-completion wake.
  function isChildCompletionWake(wake: {
    reason: string;
    idempotencyKey: string | null;
    payload: Record<string, unknown> | null;
  }) {
    return (
      wake.reason === "issue_children_completed" ||
      wake.idempotencyKey?.startsWith("issue_children_completed:") === true ||
      typeof wake.payload?.completedChildIssueId === "string"
    );
  }

  async function childCompletedWakesFor(seeded: Seeded) {
    return (await wakesFor(seeded)).filter(isChildCompletionWake);
  }

  async function childOrDependencyWakesFor(seeded: Seeded) {
    return (await wakesFor(seeded)).filter(
      (wake) => isChildCompletionWake(wake) || wake.reason === "issue_blockers_resolved",
    );
  }

  async function managerRunsWokenBy(seeded: Seeded, wakeReason: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, seeded.managerId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${seeded.parentId}`,
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = ${wakeReason}`,
      ));
  }

  /** Holds the manager's next run open until the returned release is called. */
  function holdNextManagerRun(seeded: Seeded) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    mockAdapterExecute.mockImplementation(async (ctx) => {
      if (ctx.agent.id === seeded.managerId && !started) {
        started = true;
        await released;
      }
      return succeeded("Child completion route test run.");
    });
    return { release, isStarted: () => started };
  }

  it("does not wake an in_review parent that waits on a pending confirmation", async () => {
    const seeded = await seed({ parentStatus: "in_review" });
    await db.insert(issueThreadInteractions).values({
      companyId: seeded.companyId,
      issueId: seeded.parentId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdByAgentId: seeded.managerId,
      payload: { version: 1, prompt: "Approve the merge?" },
    });

    await setChildStatus(seeded, "done");
    await setChildStatus(seeded, "todo");
    await setChildStatus(seeded, "done");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await wakesFor(seeded)).toEqual([]);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(parentLookups.map((lookup) => lookup.woken)).toEqual([false, false]);
  });

  it("does not wake an active parent that waits on a human answer", async () => {
    const seeded = await seed({ parentStatus: "in_progress" });
    await db.insert(issueThreadInteractions).values({
      companyId: seeded.companyId,
      issueId: seeded.parentId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdByAgentId: seeded.managerId,
      payload: { version: 1, prompt: "Ship the release?" },
    });

    await setChildStatus(seeded, "done");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    // Answering the confirmation wakes the parent's assignee instead.
    expect(await wakesFor(seeded)).toEqual([]);
    expect(parentLookups.map((lookup) => lookup.woken)).toEqual([false]);
  });

  it("wakes a parent that delegated the work when its last child is done", async () => {
    const seeded = await seed({ parentStatus: "in_progress" });

    await setChildStatus(seeded, "done");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const wakes = await childCompletedWakesFor(seeded);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      reason: "issue_children_completed",
      status: "completed",
      idempotencyKey: `issue_children_completed:${seeded.parentId}:${seeded.childId}:none`,
      payload: expect.objectContaining({ completedChildIssueId: seeded.childId }),
    });
    expect(await managerRunsWokenBy(seeded, "issue_children_completed")).toHaveLength(1);
  });

  it("wakes the parent once when its child is closed, reopened and closed again during the parent's run", async () => {
    const seeded = await seed({ parentStatus: "in_progress" });
    const managerRun = holdNextManagerRun(seeded);

    await setChildStatus(seeded, "done");
    await vi.waitFor(() => expect(managerRun.isStarted()).toBe(true));
    // The parent's run is still reading the first completion.
    await setChildStatus(seeded, "todo");
    await setChildStatus(seeded, "done");
    managerRun.release();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await childCompletedWakesFor(seeded)).toHaveLength(1);
    expect(await managerRunsWokenBy(seeded, "issue_children_completed")).toHaveLength(1);
    expect(parentLookups.map((lookup) => lookup.woken)).toEqual([true, false]);
  });

  it("wakes the parent again for a child sent back for rework during the parent's run", async () => {
    const seeded = await seed({ parentStatus: "in_progress" });
    const managerRun = holdNextManagerRun(seeded);

    await setChildStatus(seeded, "done");
    await vi.waitFor(() => expect(managerRun.isStarted()).toBe(true));
    // The child goes back for rework while the parent's run is still going,
    // so the parent waits on it again once that run has ended.
    await setChildStatus(seeded, "todo");
    managerRun.release();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await setChildStatus(seeded, "done");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(parentLookups.map((lookup) => lookup.woken)).toEqual([true, true]);
    const wakes = await childCompletedWakesFor(seeded);
    expect(wakes).toHaveLength(2);
    expect(new Set(wakes.map((wake) => wake.idempotencyKey)).size).toBe(2);
  });

  it("does not wake a parent for a child that appeared after its assignee's last run", async () => {
    const seeded = await seed({ parentStatus: "in_progress", childCreatedByManager: false });
    const lastRunFinishedAt = new Date(Date.now() - 60 * 60_000);
    await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.managerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      createdAt: new Date(lastRunFinishedAt.getTime() - 60_000),
      startedAt: new Date(lastRunFinishedAt.getTime() - 60_000),
      finishedAt: lastRunFinishedAt,
      contextSnapshot: { issueId: seeded.parentId, taskId: seeded.parentId },
    });

    await setChildStatus(seeded, "done");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await wakesFor(seeded)).toEqual([]);
    expect(parentLookups.map((lookup) => lookup.woken)).toEqual([false]);
  });

  it("wakes a parent blocked on its last child only through the dependency wake", async () => {
    const seeded = await seed({ parentStatus: "blocked" });
    await db.insert(issueRelations).values({
      companyId: seeded.companyId,
      issueId: seeded.childId,
      relatedIssueId: seeded.parentId,
      type: "blocks",
    });

    await setChildStatus(seeded, "done");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const wakes = await childOrDependencyWakesFor(seeded);
    expect(wakes.map((wake) => wake.reason)).toEqual(["issue_blockers_resolved"]);
    // The finalize-time and periodic dependency backstops find this wake by
    // its ready-state key, so they do not send the parent a second one.
    expect(wakes[0]).toMatchObject({
      status: "completed",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: seeded.parentId,
        blockerIssueIds: [seeded.childId],
        blockedTransitionAt: null,
      }),
    });
    expect(await managerRunsWokenBy(seeded, "issue_blockers_resolved")).toHaveLength(1);
    expect(await managerRunsWokenBy(seeded, "issue_children_completed")).toHaveLength(0);
    expect(parentLookups.map((lookup) => lookup.woken)).toEqual([false]);
  });
});
