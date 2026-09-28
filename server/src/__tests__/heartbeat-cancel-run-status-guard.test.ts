import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = { track: () => {} };
import { vi } from "vitest";
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cancelRun status-guard tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression coverage: a comment that supersedes a scheduled retry must only
// ever cancel that retry while it is still unstarted. cancelRun's
// allowedFromStatuses option is what makes that guarantee atomic — a caller
// restricts it to the statuses it believes it is racing against, and the
// write that actually performs the cancellation is gated on the SAME list,
// re-checked fresh at write time. No executor is registered for any run
// seeded directly here, so cancelRun never touches a real process — only the
// DB-level status transition is under test.
describeEmbeddedPostgres("heartbeat.cancelRun allowedFromStatuses guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-cancel-run-status-guard-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(runStatus: "queued" | "scheduled_retry" | "running") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Architect",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: now,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: runStatus,
      wakeupRequestId,
      contextSnapshot: {},
      startedAt: runStatus === "running" ? now : null,
      updatedAt: now,
    });
    return { companyId, agentId, runId };
  }

  it("cancels a still-queued retry restricted to the unstarted statuses", async () => {
    const { runId } = await seedRun("queued");

    const cancelled = await heartbeatService(db).cancelRun(runId, "superseded by comment", {
      allowedFromStatuses: ["queued", "scheduled_retry"],
    });

    expect(cancelled?.status).toBe("cancelled");
  });

  it("cancels a still-pending scheduled_retry restricted to the unstarted statuses", async () => {
    const { runId } = await seedRun("scheduled_retry");

    const cancelled = await heartbeatService(db).cancelRun(runId, "superseded by comment", {
      allowedFromStatuses: ["queued", "scheduled_retry"],
    });

    expect(cancelled?.status).toBe("cancelled");
  });

  // The core regression: a caller that restricts cancellation to the
  // unstarted statuses must never cancel a run that has since started. This
  // is what closes the race where a queued retry gets claimed and starts
  // running between a route's status read and its later cancel call.
  it("does not cancel a run that has already started, even though 'running' is normally cancellable", async () => {
    const { runId } = await seedRun("running");

    const cancelled = await heartbeatService(db).cancelRun(runId, "superseded by comment", {
      allowedFromStatuses: ["queued", "scheduled_retry"],
    });

    expect(cancelled?.status).toBe("running");
    const persisted = await heartbeatService(db).getRun(runId);
    expect(persisted?.status).toBe("running");
  });

  it("keeps the default (no allowedFromStatuses) behavior of cancelling a running run", async () => {
    const { runId } = await seedRun("running");

    const cancelled = await heartbeatService(db).cancelRun(runId, "operator stop");

    expect(cancelled?.status).toBe("cancelled");
  });
});
