import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-orientation-metrics finalize test on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const ADAPTER_TYPE = "opencode_local";

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
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres(
  "run finalize persists resultJson.metrics",
  () => {
    let db!: ReturnType<typeof createDb>;
    let heartbeat!: ReturnType<typeof heartbeatService>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
      null;
    const execute = vi.fn<ServerAdapterModule["execute"]>();

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "run-orientation-metrics-finalize-",
      );
      db = createDb(tempDb.connectionString);
      heartbeat = heartbeatService(db);
      registerServerAdapter({
        type: ADAPTER_TYPE,
        supportsLocalAgentJwt: false,
        execute,
      });
    }, 60_000);

    afterEach(async () => {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      vi.clearAllMocks();
      await db.execute(
        sql.raw(`
          TRUNCATE TABLE
            "environment_leases",
            "environments",
            "activity_log",
            "heartbeat_run_events",
            "heartbeat_runs",
            "agent_wakeup_requests",
            "agent_runtime_state",
            "company_skills",
            "agents",
            "companies"
          RESTART IDENTITY CASCADE
        `),
      );
    });

    afterAll(async () => {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      unregisterServerAdapter(ADAPTER_TYPE);
      await tempDb?.cleanup();
    });

    it("computes and persists resultJson.metrics through the real finalize path", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      // A minimal opencode_local stdout capture, in the same shape
      // `adapterResult.resultJson.stdout` carries it into the finalize
      // path: one read, then one write (the first mutating call), with a
      // step boundary in between reporting generated tokens and context
      // size.
      const stdout = [
        JSON.stringify({
          type: "tool_use",
          part: { tool: "read", callID: "1", state: { status: "completed" } },
        }),
        JSON.stringify({
          type: "step_finish",
          part: { tokens: { input: 900, output: 25 } },
        }),
        JSON.stringify({
          type: "tool_use",
          part: { tool: "write", callID: "2", state: { status: "completed" } },
        }),
      ].join("\n");

      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "done",
        provider: "test",
        model: "test-model",
        resultJson: { stdout },
      });

      await db.insert(companies).values({
        id: companyId,
        name: "Run Orientation Metrics",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "OpenCode worker",
        role: "engineer",
        status: "idle",
        adapterType: ADAPTER_TYPE,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      // Drives the run through heartbeatService end to end — invoke,
      // execute (via the mocked adapter above), and finalize — rather than
      // calling the metrics function directly, so this test actually
      // exercises the heartbeat.ts wiring (adapterType, adapterResult
      // parsing, wakeReason) it's meant to cover.
      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        { wakeReason: "issue_comment_mentioned" },
        "manual",
      );
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(execute).toHaveBeenCalledOnce();
      expect(finished?.status).toBe("succeeded");

      const persistedResult = finished?.resultJson as Record<string, unknown> | null;
      expect(persistedResult?.metrics).toEqual({
        stepsBeforeFirstMutation: 1,
        genTokensBeforeFirstMutation: 25,
        skillLoads: 0,
        controlPlaneDenials: 0,
        // A first-ever run for this agent offers no previous session, so
        // there is nothing to resume regardless of the wake reason.
        sessionResumed: false,
        sessionResumeReason: null,
        peakContextTokens: 900,
      });
    });

    it("persists an all-null metrics object when the adapter result has no stdout to inspect, and the run still succeeds", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "done",
        provider: "test",
        model: "test-model",
        // No `resultJson` at all: the shape a real adapter leaves it in
        // when it has nothing else to report.
      });

      await db.insert(companies).values({
        id: companyId,
        name: "Run Orientation Metrics No Stdout",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "OpenCode worker",
        role: "engineer",
        status: "idle",
        adapterType: ADAPTER_TYPE,
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(finished?.status).toBe("succeeded");
      const persistedResult = finished?.resultJson as Record<string, unknown> | null;
      // No stdout at all means there is no tool-call data to inspect,
      // which is a different, stronger "unknown" than having inspected a
      // stream with zero tool calls in it — so every tool-call-derived
      // field is null here, not 0. The run itself still succeeds: a
      // best-effort metrics computation must never affect run outcome.
      expect(persistedResult?.metrics).toEqual({
        stepsBeforeFirstMutation: null,
        genTokensBeforeFirstMutation: null,
        skillLoads: null,
        controlPlaneDenials: null,
        sessionResumed: false,
        sessionResumeReason: null,
        peakContextTokens: null,
      });
    });
  },
);
