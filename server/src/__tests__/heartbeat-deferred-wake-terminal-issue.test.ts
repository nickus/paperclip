import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { createDurableChatWakeupRequest } from "../services/durable-chat-wakeup.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred-wake terminal-issue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage for the deferred-wake / terminal-issue heartbeat bug:
// an `agent_wakeup_requests` row parked in `deferred_issue_execution` for an
// issue that is already `done`/`cancelled` used to be re-selected by the
// periodic scheduler sweep forever (its `updated_at` kept bumping, but it
// never resolved), and a fresh wake attempt on an already-terminal issue
// could still create another such row.
describeEmbeddedPostgres("heartbeat deferred wakes on terminal issues", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-deferred-wake-terminal-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterEach(async () => {
    await db.execute(
      sql.raw(`
        TRUNCATE TABLE
          "issue_recovery_actions",
          "issues",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `),
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
  }) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId: input.issueId,
        _paperclipWakeContext: {
          issueId: input.issueId,
          wakeCommentIds: [randomUUID()],
        },
      },
      status: "deferred_issue_execution",
    });
    return id;
  }

  it("finalizes a deferred wake once its issue is already cancelled, and never re-selects it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Closed while a wake was deferred",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });

    await heartbeat.resumeQueuedRuns();

    const [finalized] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(finalized?.status).toBe("cancelled");
    expect(finalized?.finishedAt).not.toBeNull();
    expect(finalized?.error).toMatch(/terminal/i);
    const finalizedUpdatedAt = finalized!.updatedAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 20));

    // The next sweep must not reselect (or re-stamp) the now-finalized row:
    // this is the exact symptom the bug produced (`updated_at` bumping
    // forever without the row ever resolving).
    const secondSweep = await heartbeat.finalizeDeferredWakesForTerminalIssues();
    expect(secondSweep.finalized).toBe(0);

    const [reswept] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(reswept?.status).toBe("cancelled");
    expect(reswept?.updatedAt.getTime()).toBe(finalizedUpdatedAt);
  });

  it("finalizes a deferred wake once its issue is already done", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Done while a wake was deferred",
      status: "done",
      assigneeAgentId: agentId,
    });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });

    const result = await heartbeat.finalizeDeferredWakesForTerminalIssues();
    expect(result.finalized).toBe(1);

    const [finalized] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(finalized?.status).toBe("cancelled");
  });

  it("leaves a deferred wake on an open issue untouched (behaves as before)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still open",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });

    await heartbeat.resumeQueuedRuns();

    const result = await heartbeat.finalizeDeferredWakesForTerminalIssues();
    expect(result.finalized).toBe(0);

    const [row] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId));
    expect(row?.status).toBe("deferred_issue_execution");
  });

  it("does not create a new deferred wake for an issue that already reached a terminal status", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled before the wake could be admitted",
      status: "cancelled",
      assigneeAgentId: agentId,
      responsibleUserId: "board-user",
    });
    // A resolved-but-still-blocking recovery hold, matching the shape
    // `getExecutionBlocker` treats as an effective no-replay hold.
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation",
      status: "resolved",
      fingerprint: randomUUID(),
      evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Check the stopped execution before resuming.",
    });

    const commentId = randomUUID();
    const authorize = vi.fn(async () => {});
    const durableRequest = createDurableChatWakeupRequest({
      id: randomUUID(),
      companyId,
      agentId,
      issueId,
      commentId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      requestedAt: new Date(),
      authorize,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId, commentId },
      contextSnapshot: { issueId, source: "chat:slack", wakeCommentId: commentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      durableChatRequest: durableRequest,
    });

    expect(run).toBeNull();

    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "skipped",
      reason: "issue_terminal_status",
    });
    expect(receipts.some((r) => r.status === "deferred_issue_execution")).toBe(
      false,
    );
  });
});
