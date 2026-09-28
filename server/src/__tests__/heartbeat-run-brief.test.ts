import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

const execute = vi.hoisted(() =>
  vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })),
);
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

// Lets a test make the brief lookup fail; otherwise the real lookup runs.
const briefLookup = vi.hoisted(() => ({ fail: false }));
vi.mock("../services/run-brief.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/run-brief.js")>();
  return {
    ...actual,
    loadRunBrief: vi.fn(async (input: Parameters<typeof actual.loadRunBrief>[0]) => {
      if (briefLookup.fail) throw new Error("injected run brief lookup failure");
      return actual.loadRunBrief(input);
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("run brief on a heartbeat run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-brief-heartbeat-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    database = await startEmbeddedPostgresTestDatabase("run-brief-heartbeat");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (input) => {
      // Finish the task so no liveness follow-up run is queued.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: `session-${input.runId}` },
        sessionDisplayId: `session-${input.runId}`,
        summary: "Finished the task.",
      };
    });
  }, 30_000);

  afterEach(async () => {
    briefLookup.fail = false;
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Brief",
      issuePrefix: `B${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 900 },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Add the export endpoint",
      status: "todo",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  async function runWake(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId },
    });
    expect(run).not.toBeNull();
    await vi.waitFor(
      async () => {
        const latest = await heartbeat.getRun(run!.id);
        expect({ status: latest?.status, error: latest?.error }).toEqual({
          status: "succeeded",
          error: null,
        });
      },
      { timeout: 15_000 },
    );
    // heartbeatRuns flips to "succeeded" (with its own sessionIdAfter) well
    // before the finalize path's later upsertTaskSession call lands the same
    // session in agentTaskSessions, the table the *next* wake's environment
    // line reads to decide resumed/fresh. Waiting on run status alone races
    // that later write; drainActiveRunExecutions only returns once executeRun
    // itself has settled, which is after that upsert, so the task session a
    // following runWake() call resolves is always the one this run produced.
    await heartbeat.drainActiveRunExecutions();
    const call = execute.mock.calls.find(([input]) => input.runId === run!.id);
    expect(call).toBeDefined();
    return call![0].context.paperclipWake as Record<string, any>;
  }

  it("fills the environment line once the session, workspace and timeout are known", async () => {
    const { agentId, issueId } = await seed();
    const startedAt = Date.now();
    const wake = await runWake(agentId, issueId);
    const finishedAt = Date.now();

    expect(wake.runBrief).toMatchObject({
      version: 1,
      issueId,
      authority: "execute",
      environment: {
        session: "fresh",
        sessionReason: "no_saved_session",
        timeoutSec: 900,
      },
    });
    const environment = wake.runBrief.environment;
    expect(["reused", "fresh", "shared"]).toContain(environment.workspace);
    const deadline = Date.parse(environment.deadlineAt);
    expect(deadline).toBeGreaterThanOrEqual(startedAt + 900_000);
    expect(deadline).toBeLessThanOrEqual(finishedAt + 900_000);

    const prompt = renderPaperclipWakePrompt(wake);
    expect(prompt.startsWith("## Run Brief\n")).toBe(true);
    expect(prompt).toContain("- environment: session fresh (no saved session for this task); workspace ");
    expect(prompt).toContain("timeout 900s, deadline ~");

    // The next wake on the same task resumes the saved session, and the
    // first run now shows up in the digest.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const second = await runWake(agentId, issueId);
    expect(second.runBrief.environment).toMatchObject({
      session: "resumed",
      sessionReason: "saved_task_session",
      timeoutSec: 900,
    });
    expect(second.runBrief.priorRuns).toEqual([
      expect.objectContaining({ status: "succeeded", summary: "Finished the task." }),
    ]);
  }, 40_000);

  it("still builds the wake payload when the brief lookup fails", async () => {
    const { agentId, issueId } = await seed();
    briefLookup.fail = true;
    const wake = await runWake(agentId, issueId);
    expect(wake.issue).toMatchObject({ id: issueId, title: "Add the export endpoint" });
    expect("runBrief" in wake).toBe(false);
    const prompt = renderPaperclipWakePrompt(wake);
    expect(prompt).not.toContain("## Run Brief");
    expect(prompt.startsWith("## Paperclip Wake Payload")).toBe(true);
  }, 40_000);
});
