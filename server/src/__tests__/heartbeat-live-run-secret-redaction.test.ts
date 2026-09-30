import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import {
  contextSnapshotKeepingRedactionRegistry,
  createRunSecretRedactionRegistry,
} from "../services/run-secret-redaction.ts";
import { REDACTED_EVENT_VALUE } from "../redaction.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "live_secret_output_capture";
// A value an agent obtained through the secrets API during its run.
const SECRET = "live-output-secret-4d7e1b9a";
let reportRuntimeService = false;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres live run secret redaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

function parseLogLines(content: string) {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { stream: string; chunk: string; seq?: number });
}

describeEmbeddedPostgres("registered run secrets in live run output", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-live-secret-redaction-");
    db = createDb(tempDb.connectionString);
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_API_URL", "PAPERCLIP_SECRETS_MASTER_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-live-secret-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        // The secrets route registers the value on the run before the agent
        // receives it; everything the agent prints afterwards may contain it.
        await createRunSecretRedactionRegistry(db).register(ctx.agent.companyId, ctx.runId, SECRET);
        await ctx.onLog("stdout", `fetched token ${SECRET}\n`);
        await ctx.onEvent?.({
          eventType: "tool.result",
          stream: "stdout",
          level: "info",
          message: `tool printed ${SECRET}`,
          payload: { output: `value=${SECRET}`, nested: [{ text: SECRET }] },
        });
        await ctx.onRuntimeProgress?.({
          phase: "running",
          message: `working with ${SECRET}`,
          lastAssistantSnippet: `the token is ${SECRET}`,
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: `Finished. The token was ${SECRET}.`,
          ...(reportRuntimeService
            ? {
                runtimeServices: [{
                  id: randomUUID(),
                  serviceName: "preview",
                  status: "running" as const,
                  scopeType: "run" as const,
                }],
              }
            : {}),
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    reportRuntimeService = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "workspace_runtime_services",
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function runAgentThatPrintsSecret() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Secret Printer",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const events: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => events.push(event));
    const heartbeat = heartbeatService(db);
    try {
      const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);
      expect({ status: finished?.status, error: finished?.error ?? null })
        .toEqual({ status: "succeeded", error: null });
      return { companyId, runId: queued!.id, heartbeat, events };
    } finally {
      unsubscribe();
    }
  }

  it("masks the secret in the published log event exactly as the log route does", async () => {
    const { companyId, runId, heartbeat, events } = await runAgentThatPrintsSecret();
    const runEvents = events.filter((event) => event.payload.runId === runId);
    const liveLogChunks = runEvents
      .filter((event) => event.type === "heartbeat.run.log")
      .map((event) => event.payload as { chunk: string; seq: number; stream: string });
    const liveSecretChunk = liveLogChunks.find((payload) => payload.chunk.startsWith("fetched token"));
    expect(liveSecretChunk?.chunk).toBe(`fetched token ${REDACTED_EVENT_VALUE}\n`);

    // GET /heartbeat-runs/:runId/log: read the stored log and apply the run's
    // registered-secret redaction.
    const logAccess = await heartbeat.getRunLogAccess(runId);
    const stored = await heartbeat.readLog(logAccess!, {});
    const logResponse = await createRunSecretRedactionRegistry(db).redactForRun(companyId, runId, stored);
    const routeLine = parseLogLines(logResponse.content).find((line) => line.chunk.startsWith("fetched token"));
    expect(routeLine).toMatchObject({
      stream: liveSecretChunk!.stream,
      chunk: liveSecretChunk!.chunk,
      seq: liveSecretChunk!.seq,
    });
    // The persisted NDJSON line is already redacted, so the log file and its
    // object-storage mirror never hold the value.
    expect(stored.content).not.toContain(SECRET);
    expect(stored.content).toContain(REDACTED_EVENT_VALUE);
  });

  it("masks the secret in run events, progress and status payloads and in the stored events", async () => {
    const { runId, heartbeat, events } = await runAgentThatPrintsSecret();
    const runEvents = events.filter((event) => event.payload.runId === runId);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(runEvents)).not.toContain(SECRET);

    const liveToolEvent = runEvents.find(
      (event) => event.type === "heartbeat.run.event" && event.payload.eventType === "tool.result",
    );
    expect(liveToolEvent?.payload).toMatchObject({
      message: `tool printed ${REDACTED_EVENT_VALUE}`,
      payload: { output: `value=${REDACTED_EVENT_VALUE}`, nested: [{ text: REDACTED_EVENT_VALUE }] },
    });
    const storedToolEvent = (await heartbeat.listEvents(runId)).find((event) => event.eventType === "tool.result");
    expect(storedToolEvent).toMatchObject({
      message: liveToolEvent!.payload.message,
      payload: liveToolEvent!.payload.payload,
    });

    const progress = runEvents.find(
      (event) => event.type === "heartbeat.run.progress" && event.payload.lastAssistantSnippet,
    );
    expect(progress?.payload).toMatchObject({
      message: `working with ${REDACTED_EVENT_VALUE}`,
      lastAssistantSnippet: `the token is ${REDACTED_EVENT_VALUE}`,
    });

    const terminalStatus = runEvents.find(
      (event) => event.type === "heartbeat.run.status" && event.payload.status === "succeeded",
    );
    expect(terminalStatus?.payload.finalText).toBe(`Finished. The token was ${REDACTED_EVENT_VALUE}.`);

    const run = await heartbeat.getRun(runId);
    expect(run?.stdoutExcerpt).toContain(`fetched token ${REDACTED_EVENT_VALUE}`);
  });

  it("keeps values registered during the run when the context snapshot is rewritten", async () => {
    // Reporting adapter-managed runtime services rewrites the run context
    // after the adapter returns, i.e. after the value was registered.
    reportRuntimeService = true;
    const { companyId, runId, heartbeat } = await runAgentThatPrintsSecret();
    const readContext = async () =>
      db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]?.contextSnapshot as Record<string, unknown>);
    const stored = await readContext();
    expect(stored.paperclipRuntimeServices).toEqual([expect.objectContaining({ serviceName: "preview" })]);
    const registry = stored.paperclipSecretRedactions;
    expect(Array.isArray(registry) && registry.length).toBe(1);
    // The read routes keep masking the value after the rewrite.
    const detail = await createRunSecretRedactionRegistry(db).redactForRun(
      companyId,
      runId,
      await heartbeat.getRun(runId),
    );
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(detail?.resultJson).toMatchObject({ summary: `Finished. The token was ${REDACTED_EVENT_VALUE}.` });

    await db.update(heartbeatRuns)
      .set({ contextSnapshot: contextSnapshotKeepingRedactionRegistry({ rewritten: true }) })
      .where(eq(heartbeatRuns.id, runId));
    expect(await readContext()).toEqual({ rewritten: true, paperclipSecretRedactions: registry });

    await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: contextSnapshotKeepingRedactionRegistry({ rewritten: "again" }) })
      .where(eq(heartbeatRuns.id, runId));
    expect(await readContext()).toEqual({ rewritten: "again" });
  });
});
