import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { deriveRunOrientationMetrics } from "../services/run-orientation-metrics.js";

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

describeEmbeddedPostgres(
  "run finalize persists resultJson.metrics",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
      null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "run-orientation-metrics-finalize-",
      );
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    it("writes the run-orientation metrics derived at finalize onto resultJson.metrics", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Run Orientation Metrics",
        issuePrefix,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "OpenCode worker",
        adapterType: "opencode_local",
        status: "running",
      });

      // A run mid-flight: the state heartbeat.ts's finalize path sees right
      // before it derives and merges the metrics object under test here.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { wakeReason: "issue_comment_mentioned" },
      });

      // A minimal opencode_local stdout capture, in the same shape
      // `adapterResult.resultJson.stdout` carries it into the finalize path:
      // one read, then one write (the first mutating call), with a step
      // boundary in between reporting generated tokens and context size.
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

      // Mirrors what the finalize block in heartbeat.ts does: derive the
      // metrics from the adapter's own reported result and the
      // already-resolved session-resume state, then merge the result onto
      // the run's persisted resultJson under `metrics`.
      const metrics = deriveRunOrientationMetrics({
        adapterType: "opencode_local",
        adapterResultJson: { stdout },
        sessionResumed: true,
        sessionResumeReason: "issue_comment_mentioned",
      });

      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          resultJson: { summary: "done", metrics },
        })
        .where(eq(heartbeatRuns.id, runId));

      const persisted = await db
        .select({ resultJson: heartbeatRuns.resultJson, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(persisted?.status).toBe("succeeded");
      expect(persisted?.resultJson?.metrics).toEqual({
        stepsBeforeFirstMutation: 1,
        genTokensBeforeFirstMutation: 25,
        skillLoads: 0,
        controlPlaneDenials: 0,
        sessionResumed: true,
        sessionResumeReason: "issue_comment_mentioned",
        peakContextTokens: 900,
      });
    });

    it("persists an all-null metrics object when the run never made a tool call", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Run Orientation Metrics No Tools",
        issuePrefix,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "OpenCode worker",
        adapterType: "opencode_local",
        status: "running",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: {},
      });

      const metrics = deriveRunOrientationMetrics({
        adapterType: "opencode_local",
        adapterResultJson: {},
        sessionResumed: false,
        sessionResumeReason: null,
      });

      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          resultJson: { metrics },
        })
        .where(eq(heartbeatRuns.id, runId));

      const persisted = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      // No stdout at all means there is no tool-call data to inspect, which
      // is a different, stronger "unknown" than having inspected a stream
      // with zero tool calls in it — so every tool-call-derived field is
      // null here, not 0.
      expect(persisted?.resultJson?.metrics).toEqual({
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
