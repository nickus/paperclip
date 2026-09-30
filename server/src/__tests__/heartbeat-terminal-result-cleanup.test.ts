import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// The evidence runChildProcess() attaches when it stops a process that kept
// running after the agent's final result, as the Claude adapter reports it.
const stoppedAfterFinalResult = {
  kind: "terminal_result_cleanup",
  stopped: true,
  stopReason: "unmanaged_background_task_stopped",
  reason: "unmanaged background task stopped; no durable live path",
  terminalResultSeen: true,
  signal: "SIGTERM",
  forceKilled: false,
};

type AdapterResult = Record<string, unknown>;

const adapterExecute = vi.hoisted(() => vi.fn(async (): Promise<AdapterResult> => ({})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "claude_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "claude_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

function completedTurnStoppedByCleanup(overrides: AdapterResult = {}): AdapterResult {
  return {
    // The stop signal reaches the CLI through a remote shell, which reports it
    // as exit status 255 rather than as a signal.
    exitCode: 255,
    signal: null,
    timedOut: false,
    errorMessage: null,
    errorCode: null,
    summary: "Posted the update and finished the turn.",
    resultJson: {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 12,
      stop_reason: "end_turn",
      result: "Posted the update and finished the turn.",
      unmanagedBackgroundTask: stoppedAfterFinalResult,
    },
    provider: "anthropic",
    model: "claude-test",
    ...overrides,
  };
}

describe("heartbeat finalization after terminal-result cleanup", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  let issueCounter = 0;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-terminal-cleanup-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal cleanup",
      issuePrefix: "TRC",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Cleanup project", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      isPrimary: true,
    });
  }, 30_000);

  beforeEach(() => {
    adapterExecute.mockReset();
  });

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await temporary.cleanup();
    }
  });

  async function seedAgentWithIssue() {
    const agentId = randomUUID();
    const issueId = randomUUID();
    issueCounter += 1;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Cleanup agent ${issueCounter}`,
      adapterType: "claude_local",
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Finish the update",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
      issueNumber: issueCounter,
      identifier: `TRC-${issueCounter}`,
    });
    return { agentId, issueId };
  }

  async function runOnce(agentId: string, issueId: string) {
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
    });
    expect(queued).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued!.id))
      .then((rows) => rows[0]!);
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    const warnings = await db
      .select()
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.level, "warn")))
      .orderBy(asc(heartbeatRunEvents.seq));
    return { run, agent, warnings };
  }

  it("records a completed turn as succeeded with a warning when cleanup stopped a leftover background task", async () => {
    const { agentId, issueId } = await seedAgentWithIssue();
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return completedTurnStoppedByCleanup();
    });

    const { run, agent, warnings } = await runOnce(agentId, issueId);

    expect(run).toMatchObject({
      status: "succeeded",
      error: null,
      errorCode: null,
      exitCode: 255,
    });
    expect(run.resultJson).toMatchObject({
      stopReason: "completed",
      unmanagedBackgroundTask: { kind: "terminal_result_cleanup", terminalResultSeen: true },
    });
    expect(run.livenessState).not.toBe("failed");
    expect(run.livenessReason).not.toBe("unmanaged background task stopped; no durable live path");
    expect(agent.status).not.toBe("error");
    expect(warnings).toEqual([
      expect.objectContaining({
        eventType: "lifecycle",
        message: expect.stringContaining("background task"),
        payload: expect.objectContaining({ reason: "unmanaged_background_task_stopped", exitCode: 255 }),
      }),
    ]);
  }, 60_000);

  it("also accepts a cleanup stop that the process reports as a signal", async () => {
    const { agentId, issueId } = await seedAgentWithIssue();
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return completedTurnStoppedByCleanup({ exitCode: null, signal: "SIGTERM" });
    });

    const { run, warnings } = await runOnce(agentId, issueId);

    expect(run).toMatchObject({ status: "succeeded", signal: "SIGTERM", errorCode: null });
    expect(warnings).toHaveLength(1);
  }, 60_000);

  it("keeps a run failed when the adapter reported an error for the turn", async () => {
    const { agentId, issueId } = await seedAgentWithIssue();
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return completedTurnStoppedByCleanup({
        errorMessage: "Claude reported an execution error",
        resultJson: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          unmanagedBackgroundTask: stoppedAfterFinalResult,
        },
      });
    });

    const { run, warnings } = await runOnce(agentId, issueId);

    expect(run).toMatchObject({
      status: "failed",
      error: "Claude reported an execution error",
      errorCode: "adapter_failed",
    });
    expect(warnings).toHaveLength(0);
  }, 60_000);

  it("keeps a non-zero exit without cleanup evidence a failure", async () => {
    const { agentId, issueId } = await seedAgentWithIssue();
    adapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      const result = completedTurnStoppedByCleanup();
      const { unmanagedBackgroundTask: _omitted, ...resultJson } = result.resultJson as Record<string, unknown>;
      return { ...result, resultJson };
    });

    const { run } = await runOnce(agentId, issueId);

    expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
  }, 60_000);

  it("still requires a durable next step when the agent left the issue waiting on the stopped task", async () => {
    const { agentId, issueId } = await seedAgentWithIssue();
    // The source run leaves the issue in progress: the only thing that would
    // have moved it forward was the background task that cleanup stopped. The
    // follow-up run settles the issue so the recovery chain ends.
    adapterExecute
      .mockImplementationOnce(async () =>
        completedTurnStoppedByCleanup({
          summary: "Started a background poll; will check its log when it finishes.",
        }),
      )
      .mockImplementation(async () => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        return completedTurnStoppedByCleanup({ exitCode: 0, resultJson: { type: "result", subtype: "success" } });
      });

    const { run, agent, warnings } = await runOnce(agentId, issueId);

    expect(run.status).toBe("succeeded");
    expect(agent.status).not.toBe("error");
    // The run names the stopped task as the reason the issue needs a durable
    // next step, rather than a generic no-progress reason.
    expect(run.livenessReason).toBe("unmanaged background task stopped; no durable live path");
    expect(run.resultJson).toMatchObject({
      stopReason: "unmanaged_background_task_stopped",
      unmanagedBackgroundTask: { kind: "terminal_result_cleanup" },
    });
    // Fields written earlier in finalization are kept.
    expect(run.resultJson).toHaveProperty("presentationDecision");
    expect(warnings).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ reason: "unmanaged_background_task_stopped", exitCode: 255 }),
      }),
      expect.objectContaining({
        eventType: "lifecycle",
        message: expect.stringContaining("left open"),
        payload: expect.objectContaining({
          livenessReason: "unmanaged background task stopped; no durable live path",
          followUpReason: "issue_disposition_repair",
          followUpOutcome: "queued",
        }),
      }),
    ]);
    const followups = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const repair = followups.find((candidate) => candidate.id !== run.id);
    expect(repair?.contextSnapshot).toMatchObject({
      issueId,
      retryReason: "issue_disposition_repair",
      retryOfRunId: run.id,
    });
  }, 60_000);
});
