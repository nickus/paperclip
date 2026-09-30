import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Activity-based run limits, end to end through the legacy adapter path:
// an inactivity timeout stops only quiet runs, and a hard time cap that
// interrupts a run that is still working becomes a checkpoint plus an
// automatic continuation instead of a reconciliation hold.
//
// The agents use the generic "process" adapter type: like external adapters,
// it has no conversation-continuation contract, so an ordinary timeout of it
// leaves a reconciliation hold on the task.

const { adapterExecute, runningProcesses } = vi.hoisted(() => ({
  adapterExecute: vi.fn<(ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>>(),
  runningProcesses: new Map<string, { child: import("node:child_process").ChildProcess; graceSec: number; processGroupId: number | null }>(),
}));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses,
}));

import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CAP_MESSAGE =
  "Run exceeded the adapter execution timeout (timeoutSec=1, configured via adapterConfig.timeoutSec). " +
  "Set adapterConfig.timeoutSec to raise it.";

/** Emit a line of agent output every `everyMs` for `forMs`. */
async function emitSteadily(ctx: AdapterExecutionContext, forMs: number, everyMs: number) {
  const until = Date.now() + forMs;
  let step = 0;
  while (Date.now() < until) {
    await ctx.onLog("stdout", `{"type":"tool_call","step":${step++}}\n`);
    await sleep(everyMs);
  }
}

describe("activity-based run limits", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-activity-timeouts-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    await db.insert(companies).values({
      id: companyId,
      name: "Activity limits",
      issuePrefix: "ACT",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      isPrimary: true,
    });
  }, 60_000);

  afterAll(async () => {
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await temporary.cleanup();
    }
  });

  async function runOnce(adapterConfig: Record<string, unknown>, adapterType = "process") {
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      adapterType,
      adapterConfig,
      status: "idle",
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Long task on a slow model",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
    });
    expect(queued).not.toBeNull();
    const startedAt = Date.now();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const run = await heartbeat.getRun(queued!.id);
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, queued!.id));
    const holds = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.sourceIssueId, issueId),
          eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
        ),
      );
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const successors = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, queued!.id));
    const agentRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return {
      run: run!,
      events,
      holds,
      issue: issue!,
      agent: agent!,
      successors,
      agentRuns,
      elapsedMs: Date.now() - startedAt,
    };
  }

  it("does not stop a run that keeps producing output past its inactivity window", async () => {
    adapterExecute.mockImplementationOnce(async (ctx) => {
      // Three idle windows long, with output every 200 ms.
      await emitSteadily(ctx, 3_000, 200);
      // Record a disposition so no follow-up run is queued for the task.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(ctx.context.issueId)));
      return { exitCode: 0, signal: null, timedOut: false, summary: "done" };
    });

    const { run, events, holds } = await runOnce({ idleTimeoutSec: 1 });

    expect(run.status).toBe("succeeded");
    expect(run.errorCode).toBeNull();
    expect(events.some((event) => /without output or progress/.test(event.message ?? ""))).toBe(false);
    expect(holds).toHaveLength(0);
  }, 60_000);

  it("stops a run whose process went quiet after idleTimeoutSec", async () => {
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    adapterExecute.mockImplementationOnce(async (ctx) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      runningProcesses.set(ctx.runId, { child, graceSec: 1, processGroupId: child.pid ?? null });
      // Safety net so a broken watchdog fails the test instead of hanging it.
      const safety = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await ctx.onLog("stdout", "started, then waiting on a model that never answers\n");
      exit = await new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      clearTimeout(safety);
      runningProcesses.delete(ctx.runId);
      return {
        exitCode: exit!.code,
        signal: exit!.signal,
        timedOut: false,
        errorMessage: `Process terminated by ${exit!.signal}`,
      };
    });

    const { run, events, agent, elapsedMs } = await runOnce({ idleTimeoutSec: 1, timeoutSec: 3600 });

    expect(exit).toMatchObject({ code: null, signal: "SIGTERM" });
    expect(elapsedMs).toBeLessThan(15_000);
    expect(run.status).toBe("timed_out");
    expect(run.errorCode).toBe("idle_timeout");
    expect(run.error).toContain("without output or progress (idleTimeoutSec=1");
    expect(run.resultJson).toMatchObject({
      stopReason: "idle_timeout",
      timeoutFired: true,
      idleTimeout: { stoppedBy: "platform", idleTimeoutSec: 1, source: "configured" },
    });
    expect(events.some((event) => /without output or progress/.test(event.message ?? ""))).toBe(true);
    expect(agent.status).toBe("error");
  }, 60_000);

  it.each(["process", "codex_local"])("turns a hard-cap stop of a still-active %s run into a checkpoint and a queued continuation, not a hold", async (adapterType) => {
    adapterExecute.mockImplementationOnce(async (ctx) => {
      // Busy right up to the cap, then the process runner reports the cap.
      await emitSteadily(ctx, 1_400, 200);
      return { exitCode: null, signal: "SIGTERM", timedOut: true, errorMessage: CAP_MESSAGE };
    });

    const { run, holds, issue, agent, successors, agentRuns } = await runOnce({ idleTimeoutSec: 1, timeoutSec: 1 }, adapterType);

    expect(run.status).toBe("timed_out");
    expect(run.errorCode).toBe("time_cap_checkpoint");
    expect(run.error).toContain("stopped the process as a checkpoint");
    expect(run.error).toContain("(continuation 1/3)");
    expect(run.resultJson).toMatchObject({
      stopReason: "time_cap_checkpoint",
      timeCapCheckpoint: {
        stoppedBy: "platform",
        reason: "hard_time_cap",
        continuationAttempt: 1,
        continuationMaxAttempts: 3,
        adapterMessage: CAP_MESSAGE,
      },
    });
    expect(holds).toHaveLength(0);
    expect(agent.status).not.toBe("error");

    expect(successors).toHaveLength(1);
    const continuation = successors[0]!;
    // The continuation is the task's only live path; no other recovery ran.
    expect(agentRuns.map((row) => row.id).sort()).toEqual([run.id, continuation.id].sort());
    expect(continuation).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: "time_cap_continuation",
      scheduledRetryAttempt: 1,
    });
    const reachedAt = (run.resultJson as { timeCapCheckpoint: { reachedAt: string } }).timeCapCheckpoint.reachedAt;
    expect(continuation.contextSnapshot).toMatchObject({
      issueId: issue.id,
      retryReason: "time_cap_continuation",
      wakeReason: "time_cap_continuation",
      timeCapContinuation: { sourceRunId: run.id, reachedAt, attempt: 1, maxAttempts: 3 },
    });
    // The task keeps its execution lock for the continuation.
    expect(issue.status).toBe("in_progress");
    expect(issue.executionRunId).toBe(continuation.id);

    // The continuation's wake tells the agent where to pick up.
    const wake = await buildPaperclipWakePayload({
      db,
      companyId,
      agentId: continuation.agentId,
      runId: continuation.id,
      contextSnapshot: continuation.contextSnapshot as Record<string, unknown>,
    });
    expect(wake?.livenessContinuation).toMatchObject({
      attempt: 1,
      maxAttempts: 3,
      sourceRunId: run.id,
      state: "time_cap_checkpoint",
    });
    const prompt = renderPaperclipWakePrompt(wake, { resumedSession: true });
    expect(prompt).toContain(`Your previous run reached the time cap at ${reachedAt}; continue from the workspace state.`);
  }, 60_000);

  it("keeps the reconciliation hold when the hard cap stops a run that had gone quiet", async () => {
    adapterExecute.mockImplementationOnce(async (ctx) => {
      await ctx.onLog("stdout", "started\n");
      // No output for longer than the activity window before the cap hits.
      await sleep(1_600);
      return { exitCode: null, signal: "SIGTERM", timedOut: true, errorMessage: CAP_MESSAGE };
    });

    const { run, holds, successors, events } = await runOnce({ idleTimeoutSec: 1, timeoutSec: 1 });

    expect(run.status).toBe("timed_out");
    expect(run.errorCode).toBe("timeout");
    expect(run.error).toBe(CAP_MESSAGE);
    expect(holds).toHaveLength(1);
    expect(successors).toHaveLength(0);
    // With no process or cancellation hook to stop, the quiet spell is only
    // noted in the run log, once.
    expect(events.filter((event) => /no process the platform can stop/.test(event.message ?? ""))).toHaveLength(1);
  }, 60_000);
});
