import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "../issue-dependency-wakeups.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native parent wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const DONE_DECISION: NativeStatusDecision = {
  policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
  statusAction: "done",
  toStatus: "done",
  reasonCode: "completion_contract_satisfied",
  unblockDescriptor: null,
  effects: [],
};

// A native run closes a child that blocks its parent. The parent becomes
// dependency-ready, and the committer sends its assignee one wake that carries
// the child summaries in place of the parent's issue_blockers_resolved wake.
describeEmbeddedPostgres("native status committer: wake for a parent blocked on its finished child", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let managerAgentId: string;
  let workerAgentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-parent-wake-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    managerAgentId = randomUUID();
    workerAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Parent wakes", issuePrefix: "PWK" });
    await db.insert(agents).values([
      { id: managerAgentId, companyId, name: "Manager", adapterType: "codex_local", status: "idle" },
      { id: workerAgentId, companyId, name: "Worker", adapterType: "codex_local", status: "idle" },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedParentBlockedOnChild() {
    const parentId = randomUUID();
    const childId = randomUUID();
    const contractId = randomUUID();
    const blockedTransitionAt = new Date("2026-01-05T10:00:00.000Z");
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent waiting on its child",
      status: "blocked",
      blockedTransitionAt,
      assigneeAgentId: managerAgentId,
    });
    await db.insert(issues).values({
      id: childId,
      companyId,
      parentId,
      title: "Delegated child",
      status: "in_progress",
      assigneeAgentId: workerAgentId,
      createdByAgentId: managerAgentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: childId,
      relatedIssueId: parentId,
      type: "blocks",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId: childId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "parent-wake-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "parent-wake-v1",
        objective: "Finish the child",
        criteria: [{ id: "objective", requirement: "Complete the task" }],
      },
      canonicalSha256: `contract-${contractId}`,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    return { parentId, childId, contractId, blockedTransitionAt };
  }

  /** Commits a `done` decision for the child from a fresh native run of its assignee. */
  async function commitChildDone(fixture: Awaited<ReturnType<typeof seedParentBlockedOnChild>>) {
    const runId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const child = await db
      .select({
        status: issues.status,
        statusVersion: issues.statusVersion,
        lastStatusDecisionId: issues.lastStatusDecisionId,
      })
      .from(issues)
      .where(eq(issues.id, fixture.childId))
      .then((rows) => rows[0]!);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerAgentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: fixture.childId,
      nativeSessionId: randomUUID(),
      runnerInstanceId: randomUUID(),
      completionContractId: fixture.contractId,
      completionContractSha256: `contract-${fixture.contractId}`,
      contextSnapshot: { issueId: fixture.childId },
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId: fixture.childId,
      runId,
      completionContractId: fixture.contractId,
      serverFingerprint: `fp-${resultId}`,
      schemaStatus: "accepted",
      resultJson: {},
      canonicalSha256: `sha-${resultId}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId: fixture.childId,
      runId,
      contractId: fixture.contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: child.status,
      priorStatusVersion: Number(child.statusVersion),
      policyVersion: "parent-wake-v1",
      assessmentJson: {},
      inputDigest: `digest-${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId: fixture.childId,
      phase: "arbitrating",
      attempt: 0,
      resultId,
    });
    await commitNativeStatusDecision({
      db,
      companyId,
      issueId: fixture.childId,
      runId,
      assessmentId,
      priorStatus: child.status,
      priorStatusVersion: Number(child.statusVersion),
      priorDecisionId: child.lastStatusDecisionId,
      decision: DONE_DECISION,
    });
  }

  async function reopenChild(childId: string) {
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, childId));
  }

  async function parentWakes(parentId: string) {
    return db
      .select({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${parentId}`,
        ),
      )
      .orderBy(agentWakeupRequests.createdAt);
  }

  async function markWakesCompleted(parentId: string) {
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${parentId}`,
        ),
      );
  }

  it("keys the single parent wake like the parent's dependency wake, so the dependency backstops see it", async () => {
    const fixture = await seedParentBlockedOnChild();

    await commitChildDone(fixture);

    const wakes = await parentWakes(fixture.parentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId: managerAgentId,
      reason: "issue_children_completed",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: fixture.parentId,
        blockerIssueIds: [fixture.childId],
        blockedTransitionAt: fixture.blockedTransitionAt,
      }),
      payload: expect.objectContaining({
        completedChildIssueId: fixture.childId,
        resolvedBlockerIssueId: fixture.childId,
        childIssueIds: [fixture.childId],
      }),
    });

    // The finalize-time and periodic dependency wakes look up this ready state
    // before they wake the parent. They must find the wake the committer sent,
    // also after it ran, instead of sending a second issue_blockers_resolved
    // wake for the same state.
    const readyState = {
      companyId,
      dependentIssueId: fixture.parentId,
      blockerIssueIds: [fixture.childId],
      blockedTransitionAt: fixture.blockedTransitionAt,
    };
    expect(await findExistingIssueBlockersResolvedWakeForReadyState(db, readyState)).toMatchObject({
      id: wakes[0]!.id,
    });
    await markWakesCompleted(fixture.parentId);
    expect(await findExistingIssueBlockersResolvedWakeForReadyState(db, readyState)).toMatchObject({
      id: wakes[0]!.id,
    });
  });

  it("wakes once per blocked cycle when the child is closed, reopened and closed again", async () => {
    const fixture = await seedParentBlockedOnChild();

    await commitChildDone(fixture);
    await markWakesCompleted(fixture.parentId);

    // Reopened and closed again while the parent is still in the same blocked
    // cycle: the ready state is the one the first wake already covered.
    await reopenChild(fixture.childId);
    await commitChildDone(fixture);
    expect(await parentWakes(fixture.parentId)).toHaveLength(1);

    // The parent left `blocked` and was blocked on the reopened child again.
    // That is a new waiting cycle, so the next completion wakes it again.
    const nextBlockedTransitionAt = new Date("2026-01-05T12:00:00.000Z");
    await db
      .update(issues)
      .set({ status: "blocked", blockedTransitionAt: nextBlockedTransitionAt })
      .where(eq(issues.id, fixture.parentId));
    await reopenChild(fixture.childId);
    await commitChildDone(fixture);

    const wakes = await parentWakes(fixture.parentId);
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).toMatchObject({
      agentId: managerAgentId,
      reason: "issue_children_completed",
      status: "queued",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: fixture.parentId,
        blockerIssueIds: [fixture.childId],
        blockedTransitionAt: nextBlockedTransitionAt,
      }),
    });
  });
});
