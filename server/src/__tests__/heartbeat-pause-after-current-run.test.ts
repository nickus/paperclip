import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pause-after-current-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Pausing an agent "after the current run" only skips the cancellation the
// pause route otherwise performs. These tests pin the scheduler behavior that
// relies on: a paused agent's live run finishes normally and leaves the agent
// paused, and its queued runs stay queued until the agent is resumed.
describeEmbeddedPostgres("heartbeat pause after the current run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let markerDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pause-after-current-run-");
    db = createDb(tempDb.connectionString);
    markerDir = mkdtempSync(path.join(tmpdir(), "pause-after-run-"));
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  });

  async function seed(startedMarker: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pause Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        // Signal that the process started, then work for a moment.
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(startedMarker)}, "started"); setTimeout(() => process.exit(0), 1500);`,
        ],
      },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work in flight when the agent is paused",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function insertQueuedRun(input: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function waitFor(condition: () => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the run's process to start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function runStatus(runId: string) {
    const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return row?.status;
  }

  it("lets the live run finish, keeps the agent paused, and holds its queued run until resume", async () => {
    const startedMarker = path.join(markerDir, `${randomUUID()}.started`);
    const fixture = await seed(startedMarker);
    const heartbeat = heartbeatService(db);
    const liveRunId = await insertQueuedRun(fixture);

    await heartbeat.resumeQueuedRuns();
    await waitFor(() => existsSync(startedMarker));
    expect(await runStatus(liveRunId)).toBe("running");

    // The pause route with afterCurrentRun pauses the agent and cancels nothing.
    await agentService(db).pause(fixture.agentId);
    const queuedRunId = await insertQueuedRun(fixture);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await runStatus(liveRunId)).toBe("succeeded");
    const [agentAfterRun] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, fixture.agentId));
    expect(agentAfterRun?.status).toBe("paused");
    // The scheduler neither starts nor cancels a paused agent's queued run.
    await heartbeat.resumeQueuedRuns();
    expect(await runStatus(queuedRunId)).toBe("queued");

    await agentService(db).resume(fixture.agentId);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queuedRunId)).toBe("succeeded");
  }, 60_000);
});
