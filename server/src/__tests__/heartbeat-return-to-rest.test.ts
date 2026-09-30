import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

type AdapterCall = { runId: string };
// Each test sets what the agent does during its run; by default it only
// replies on the issue thread, as an agent answering a question would.
const agentTurn = vi.hoisted(() => ({
  current: null as null | ((call: AdapterCall) => Promise<void>),
}));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (call: AdapterCall) => {
    await agentTurn.current?.(call);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Answered the question.",
      provider: "test",
      model: "test-model",
    };
  }),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres return-to-rest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await fn()).toBe(true);
}

describeEmbeddedPostgres("a comment wake on a backlog issue", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-return-to-rest-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    agentTurn.current = null;
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seed(status: "backlog" | "todo" = "backlog") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reviewer",
      role: "qa",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Standing review questions",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    agentTurn.current = async ({ runId }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: runId,
        body: "Answered.",
      });
    };
    return { companyId, agentId, issueId };
  }

  async function commentAndRun(fixture: { companyId: string; agentId: string; issueId: string }) {
    const [comment] = await db.insert(issueComments).values({
      companyId: fixture.companyId,
      issueId: fixture.issueId,
      authorUserId: "responsible-user",
      body: "One more question about the rollout.",
    }).returning();
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: fixture.issueId, commentId: comment!.id, mutation: "comment" },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId: fixture.issueId,
        taskId: fixture.issueId,
        commentId: comment!.id,
        wakeCommentId: comment!.id,
        source: "issue.comment",
        wakeReason: "issue_commented",
      },
    });
    expect(run).not.toBeNull();
    await waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      return row?.status === "succeeded";
    });
    await heartbeat.drainActiveRunExecutions();
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    return row!;
  }

  const issueRow = async (issueId: string) =>
    (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const repairWakes = async (companyId: string) =>
    (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter((wake) => wake.reason === "issue_disposition_repair");
  const restActivity = (companyId: string) =>
    db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "issue.returned_to_rest"),
    ));

  it("returns the issue to backlog after each successful run, with no disposition repair wake", async () => {
    const fixture = await seed();
    for (const round of [1, 2]) {
      const run = await commentAndRun(fixture);
      expect(run.contextSnapshot).toMatchObject({
        paperclipHarnessCheckedOut: true,
        paperclipHarnessCheckoutFromStatus: "backlog",
      });
      const issue = await issueRow(fixture.issueId);
      expect(issue.status).toBe("backlog");
      expect(issue.assigneeAgentId).toBe(fixture.agentId);
      expect(issue.executionRunId).toBeNull();
      expect(await repairWakes(fixture.companyId)).toHaveLength(0);
      expect(await restActivity(fixture.companyId)).toHaveLength(round);
    }
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("still requests a disposition repair when the agent recorded a status during the run", async () => {
    const fixture = await seed();
    const reply = agentTurn.current!;
    agentTurn.current = async (call) => {
      await reply(call);
      // The agent moved the issue itself (to todo and back to in_progress).
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, fixture.issueId));
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, fixture.issueId));
    };
    await commentAndRun(fixture);
    await waitFor(async () => (await repairWakes(fixture.companyId)).length > 0);
    expect(await restActivity(fixture.companyId)).toHaveLength(0);
  }, 30_000);

  it("keeps requesting a disposition repair for an issue that was not resting", async () => {
    const fixture = await seed("todo");
    const run = await commentAndRun(fixture);
    expect(run.contextSnapshot).toMatchObject({ paperclipHarnessCheckoutFromStatus: "todo" });
    await waitFor(async () => (await repairWakes(fixture.companyId)).length > 0);
    expect(await restActivity(fixture.companyId)).toHaveLength(0);
  }, 30_000);
});
