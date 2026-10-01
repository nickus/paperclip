import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createDurableRunLogStore } from "../services/run-log-store.js";
import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping embedded Postgres run-log tests on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

/**
 * A client polling `GET /heartbeat-runs/:runId/log` for a run it just
 * created, before the adapter has written its first log chunk, must see an
 * empty page it can keep paging from -- not a 404. A 404 (or any 4xx) about a
 * second after creation reads to a client that treats any 4xx as an error as
 * "this run is already broken".
 */
suite("heartbeat run log before the first chunk is written", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let logBaseDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    savedEnv.RUN_LOG_BASE_PATH = process.env.RUN_LOG_BASE_PATH;
    logBaseDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-base-"));
    // heartbeatService's run-log store is a process-wide singleton that reads
    // this env var on its first use, so it must be set before the service is
    // constructed below.
    process.env.RUN_LOG_BASE_PATH = logBaseDir;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-log-empty-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
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

  async function seedRun(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Log Co",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
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

  it("returns an empty, pageable page instead of 404 when the log store has not been created yet", async () => {
    const { runId } = await seedRun();

    const result = await heartbeat.readLog(runId, {});

    // store/logRef come back as "" rather than null: every other page of
    // this endpoint returns non-null strings there, and the UI client's
    // (and any strictly typed mobile client's) non-optional String fields
    // would fail decoding null.
    expect(result).toEqual({
      runId,
      store: "",
      logRef: "",
      content: "",
      nextOffset: 0,
    });
  });

  it("echoes back the requested offset instead of always resetting to 0", async () => {
    const { runId } = await seedRun();

    const result = await heartbeat.readLog(runId, { offset: 42 });

    expect(result.content).toBe("");
    expect(result.nextOffset).toBe(42);
  });

  it.each(["cancelled", "failed", "timed_out", "interrupted"] as const)(
    "omits nextOffset for a %s run that never got a log, instead of echoing the offset forever",
    async (status) => {
      // A run cancelled while queued, or that failed before the adapter
      // started streaming output, never gets a log store -- it will stay in
      // the "no log yet" branch above forever. Echoing `nextOffset` back for
      // a run like this would have a client poll it in an infinite loop.
      // Mirror the normal (log-store-backed) path's own "caught up" shape
      // instead: omit `nextOffset` entirely.
      const { runId } = await seedRun({ status });

      const result = await heartbeat.readLog(runId, { offset: 10 });

      expect(result).toEqual({
        runId,
        store: "",
        logRef: "",
        content: "",
      });
      expect(result).not.toHaveProperty("nextOffset");
    },
  );

  it("still throws 404 for a run id that does not exist", async () => {
    await expect(heartbeat.readLog(randomUUID(), {})).rejects.toMatchObject({
      status: 404,
      message: "Heartbeat run not found",
    });
  });

  it("keeps existing paging behaviour for a log store that was created but is still empty", async () => {
    // Distinct from "no log store yet": begin() has run (e.g. the adapter
    // started but has not flushed any output), so an on-disk file exists at
    // size 0. This path is unchanged by the fix above and still reports no
    // `nextOffset` for a reader that is caught up -- callers use its absence
    // to mean "nothing more yet", same as before this change.
    const standaloneStore = createDurableRunLogStore({ basePath: logBaseDir });
    const { runId, companyId, agentId } = await seedRun();
    const handle = await standaloneStore.begin({ companyId, agentId, runId });
    await db
      .update(heartbeatRuns)
      .set({ logStore: handle.store, logRef: handle.logRef })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.readLog(runId, { offset: 0 });

    expect(result).toEqual({
      runId,
      store: "local_file",
      logRef: handle.logRef,
      content: "",
      nextOffset: undefined,
    });
  });

  it("keeps existing behaviour unchanged for a log that already has content", async () => {
    const standaloneStore = createDurableRunLogStore({ basePath: logBaseDir });
    const { runId, companyId, agentId } = await seedRun();
    const handle = await standaloneStore.begin({ companyId, agentId, runId });
    await standaloneStore.append(handle, { stream: "stdout", chunk: "hello\n", ts: new Date().toISOString(), seq: 1 });
    await db
      .update(heartbeatRuns)
      .set({ logStore: handle.store, logRef: handle.logRef })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.readLog(runId, { offset: 0 });

    // The store persists each appended event as one NDJSON record; readLog
    // returns that raw file content unchanged (callers that want the plain
    // chunk text parse the NDJSON themselves).
    expect(result.content).toContain('"chunk":"hello\\n"');
    expect(result.store).toBe("local_file");
    expect(result.logRef).toBe(handle.logRef);
  });
});
