import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { getRunLogStore } from "../services/run-log-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat run-log route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * HTTP-level coverage for `GET /heartbeat-runs/:runId/log`, hitting the real
 * route (not a mocked service) backed by a real Postgres database, to pin
 * down the exact JSON body a client gets back for each run state: a run
 * that has not logged anything yet, a terminal run that never will, an
 * unknown run, and a run with a real log.
 */
describeEmbeddedPostgres("GET /heartbeat-runs/:runId/log (routes + postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logBaseDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedEnv.RUN_LOG_BASE_PATH = process.env.RUN_LOG_BASE_PATH;
    logBaseDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-routes-"));
    // The run-log store is a process-wide singleton created on first use, so
    // this must be set before any request below exercises it.
    process.env.RUN_LOG_BASE_PATH = logBaseDir;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-log-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns).catch(() => undefined);
    await db.delete(agents).catch(() => undefined);
    await db.delete(companies).catch(() => undefined);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
    process.env.RUN_LOG_BASE_PATH = savedEnv.RUN_LOG_BASE_PATH;
    await rm(logBaseDir, { recursive: true, force: true });
  }, 60_000);

  function app() {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      // A board actor with `source: "local_implicit"` clears every
      // company-scope and telemetry-read check this route applies, so the
      // test exercises the route's own log-shaping logic instead of its
      // authorization boundary (covered elsewhere).
      req.actor = {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [],
      };
      next();
    });
    testApp.use("/api", agentRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedRun(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const prefix = `L${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      contextSnapshot: {},
      ...overrides,
    });
    return { companyId, agentId, runId };
  }

  it("returns empty non-null strings and echoes the offset for a just-created run without a log", async () => {
    const { runId } = await seedRun({ status: "running" });

    const res = await request(app()).get(`/api/heartbeat-runs/${runId}/log`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      runId,
      store: "",
      logRef: "",
      content: "",
      nextOffset: 0,
    });
  });

  it("omits nextOffset for a terminal run that never got a log, instead of echoing the offset forever", async () => {
    const { runId } = await seedRun({ status: "cancelled" });

    const res = await request(app()).get(`/api/heartbeat-runs/${runId}/log?offset=10`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      runId,
      store: "",
      logRef: "",
      content: "",
    });
    expect(res.body).not.toHaveProperty("nextOffset");
  });

  it("returns 404 for an unknown run id", async () => {
    const res = await request(app()).get(`/api/heartbeat-runs/${randomUUID()}/log`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
  });

  it("keeps the existing shape unchanged for a run with a real log", async () => {
    const { runId, companyId, agentId } = await seedRun({ status: "succeeded" });
    const store = getRunLogStore();
    const handle = await store.begin({ companyId, agentId, runId });
    await store.append(handle, {
      stream: "stdout",
      chunk: "hello\n",
      ts: new Date().toISOString(),
      seq: 1,
    });
    await db
      .update(heartbeatRuns)
      .set({ logStore: handle.store, logRef: handle.logRef })
      .where(eq(heartbeatRuns.id, runId));

    const res = await request(app()).get(`/api/heartbeat-runs/${runId}/log?offset=0`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.store).toBe("local_file");
    expect(res.body.logRef).toBe(handle.logRef);
    expect(res.body.content).toContain('"chunk":"hello\\n"');
    // The store is caught up after reading its one chunk, so `nextOffset`
    // is absent -- unchanged by this change, same contract as before.
    expect(res.body).not.toHaveProperty("nextOffset");
  });
});
