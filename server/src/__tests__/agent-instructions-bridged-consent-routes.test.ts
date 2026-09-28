import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatRunUsesPaperclipApiBridge } from "../services/run-api-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping bridged instruction write consent tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * A run in a remote execution environment reaches the API through that
 * environment's bridge. Such a run writes agent instructions only with a
 * change consent a board user accepted, which the write consumes, even when
 * its agent holds a direct `agents:configure` grant. Runs on the host keep
 * the direct grant. The server tells the two apart from the run's environment
 * lease, found by the run id in the agent's signed token.
 */
describeEmbeddedPostgres("bridged instruction writes need an accepted change consent", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  // The instance's one local (host) environment, which migrations create.
  let hostEnvironment!: typeof environments.$inferSelect;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousPaperclipHome = process.env.PAPERCLIP_HOME;
  const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "bridged-instruction-consent-test-secret";
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bridged-instruction-consent-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridged-instruction-consent-");
    db = createDb(tempDb.connectionString);
    [hostEnvironment] = await db.select().from(environments).where(eq(environments.driver, "local"));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
  });

  function authenticatedApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const nonce = randomUUID().slice(0, 8);
    const local = hostEnvironment;
    const [sandbox, otherSandbox] = await db
      .insert(environments)
      .values([
        { name: `Sandbox ${nonce}`, driver: "sandbox" },
        { name: `Other sandbox ${nonce}`, driver: "sandbox" },
      ])
      .returning();
    const [company] = await db
      .insert(companies)
      .values({
        name: `Bridged Consent Co ${nonce}`,
        issuePrefix: `BC${nonce.slice(0, 4).toUpperCase()}`,
      })
      .returning();
    const companyId = company!.id;

    const boardUserId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: boardUserId,
      name: "Board User",
      email: `${boardUserId}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "owner",
    });

    // An agent with a direct change grant, one that may only suggest changes,
    // both placed in the sandbox, and the agent whose instructions change,
    // placed in another environment.
    const [director, proposer, target] = await db
      .insert(agents)
      .values([
        { companyId, name: "Director", role: "ceo", adapterType: "codex_local", defaultEnvironmentId: sandbox!.id },
        { companyId, name: "Proposer", role: "general", adapterType: "codex_local", defaultEnvironmentId: sandbox!.id },
        { companyId, name: "Worker", role: "engineer", adapterType: "codex_local", defaultEnvironmentId: otherSandbox!.id },
      ].map((agent) => ({ ...agent, adapterConfig: {}, runtimeConfig: {}, permissions: {} })))
      .returning();
    await db.insert(companyMemberships).values([director!, proposer!, target!].map((agent) => ({
      companyId,
      principalType: "agent" as const,
      principalId: agent.id,
      status: "active" as const,
      membershipRole: "member" as const,
    })));
    // Runs act for the board user, who may configure agents.
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: boardUserId, permissionKey: "agents:configure", scope: null },
      { companyId, principalType: "agent", principalId: director!.id, permissionKey: "agents:configure", scope: null },
      { companyId, principalType: "agent", principalId: proposer!.id, permissionKey: "agents:suggest-changes", scope: null },
    ]);

    const [proposalIssue] = await db
      .insert(issues)
      .values({ companyId, title: "Proposed instruction change", status: "in_review", priority: "medium" })
      .returning();

    return {
      companyId,
      boardUserId,
      environments: { local, sandbox: sandbox!, otherSandbox: otherSandbox! },
      director: director!,
      proposer: proposer!,
      target: target!,
      proposalIssueId: proposalIssue!.id,
    };
  }

  type Fixture = Awaited<ReturnType<typeof seedCompany>>;

  /** A run of `agentId`, placed in `environmentId` (no lease when null). */
  async function startRun(fixture: Fixture, agentId: string, environmentId: string | null, status = "running") {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: fixture.companyId, agentId, status, responsibleUserId: fixture.boardUserId })
      .returning();
    if (environmentId) {
      await db.insert(environmentLeases).values({
        companyId: fixture.companyId,
        environmentId,
        heartbeatRunId: run!.id,
      });
    }
    return run!.id;
  }

  /**
   * A change-consent card the agent created in an earlier run for the target's
   * instructions, accepted by the board user.
   */
  async function acceptedCard(fixture: Fixture, creatorAgentId: string, targetAgentId = fixture.target.id) {
    const proposalRunId = await startRun(fixture, creatorAgentId, null, "succeeded");
    const [card] = await db
      .insert(issueThreadInteractions)
      .values({
        companyId: fixture.companyId,
        issueId: fixture.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: proposalRunId,
        createdByAgentId: creatorAgentId,
        payload: {
          version: 1,
          prompt: "Apply this instruction change?",
          detailsMarkdown: "```diff\n- Old rule.\n+ New rule.\n```",
          target: { type: "custom", key: `agent:${targetAgentId}:instructions` },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: fixture.boardUserId,
        resolvedAt: new Date(),
      })
      .returning();
    return card!.id;
  }

  async function cardResult(cardId: string) {
    const [row] = await db
      .select({ result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, cardId));
    const result: unknown = row?.result;
    return result as Record<string, unknown> | undefined;
  }

  function tokenFor(fixture: Fixture, agent: { id: string; adapterType: string }, runId: string) {
    const token = createLocalAgentJwt(agent.id, fixture.companyId, agent.adapterType, runId, fixture.boardUserId);
    expect(token).toBeTruthy();
    return token!;
  }

  function writeInstructions(
    fixture: Fixture,
    agent: { id: string; adapterType: string },
    runId: string,
    content: string,
    options: { targetAgentId?: string; runIdHeader?: string | null } = {},
  ) {
    const call = request(authenticatedApp())
      .put(`/api/agents/${options.targetAgentId ?? fixture.target.id}/instructions-bundle/file`)
      .set("Authorization", `Bearer ${tokenFor(fixture, agent, runId)}`);
    // The bridge sends the run id header the host set; `null` omits it.
    const header = options.runIdHeader === undefined ? runId : options.runIdHeader;
    if (header !== null) call.set("X-Paperclip-Run-Id", header);
    return call.send({ path: "AGENTS.md", content });
  }

  async function writtenInstructions(fixture: Fixture, agentId = fixture.target.id) {
    const file = path.join(
      paperclipHome!,
      "instances",
      "default",
      "companies",
      fixture.companyId,
      "agents",
      agentId,
      "instructions",
      "AGENTS.md",
    );
    return fs.readFile(file, "utf8").catch(() => null);
  }

  it("refuses a bridged run's write under a direct agents:configure grant when no card was accepted", async () => {
    const fixture = await seedCompany();
    const runId = await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id);

    const res = await writeInstructions(fixture, fixture.director, runId, "# Rewritten\n");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("need an accepted change consent");
    expect(res.body.details).toMatchObject({ reason: "deny_missing_consent" });
    expect(await writtenInstructions(fixture)).toBeNull();
  });

  it("applies a bridged run's write under a direct grant with a board-accepted card, once", async () => {
    const fixture = await seedCompany();
    const cardId = await acceptedCard(fixture, fixture.director.id);
    const runId = await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id);

    const first = await writeInstructions(fixture, fixture.director, runId, "# Accepted change\n");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await writtenInstructions(fixture)).toBe("# Accepted change\n");
    expect(await cardResult(cardId)).toMatchObject({ outcome: "accepted", consumedByRunId: runId });

    // The card is spent: a second write in the same run is refused.
    const second = await writeInstructions(fixture, fixture.director, runId, "# Another change\n");
    expect(second.status, JSON.stringify(second.body)).toBe(403);
    expect(second.body.details).toMatchObject({ reason: "deny_missing_consent" });
    expect(await writtenInstructions(fixture)).toBe("# Accepted change\n");
  });

  it("does not count a card for another agent, or one an agent accepted", async () => {
    const fixture = await seedCompany();
    const otherTargetCard = await acceptedCard(fixture, fixture.director.id, fixture.proposer.id);
    const agentAcceptedCard = await acceptedCard(fixture, fixture.director.id);
    await db
      .update(issueThreadInteractions)
      .set({ resolvedByUserId: null, resolvedByAgentId: fixture.director.id })
      .where(eq(issueThreadInteractions.id, agentAcceptedCard));
    const runId = await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id);

    const res = await writeInstructions(fixture, fixture.director, runId, "# Rewritten\n");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await writtenInstructions(fixture)).toBeNull();
    for (const cardId of [otherTargetCard, agentAcceptedCard]) {
      expect(await cardResult(cardId)).not.toHaveProperty("consumedByRunId");
    }
  });

  it("lets a suggest-only agent apply an accepted change to an agent in another environment", async () => {
    const fixture = await seedCompany();
    expect(fixture.target.defaultEnvironmentId).not.toBe(fixture.environments.sandbox.id);
    const cardId = await acceptedCard(fixture, fixture.proposer.id);
    const runId = await startRun(fixture, fixture.proposer.id, fixture.environments.sandbox.id);

    const res = await writeInstructions(fixture, fixture.proposer, runId, "# Proposed change\n");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await writtenInstructions(fixture)).toBe("# Proposed change\n");
    expect(await cardResult(cardId)).toMatchObject({ consumedByRunId: runId });

    // Without a fresh card the next write is refused, as before.
    const again = await writeInstructions(fixture, fixture.proposer, runId, "# Again\n");
    expect(again.status, JSON.stringify(again.body)).toBe(403);
    expect(again.body.details).toMatchObject({ reason: "deny_missing_consent" });
  });

  it("keeps the direct grant for runs on the host, with no card", async () => {
    const fixture = await seedCompany();
    const cardId = await acceptedCard(fixture, fixture.director.id);
    // A run placed in the local environment, and a run with no lease at all.
    for (const environmentId of [fixture.environments.local.id, null]) {
      const runId = await startRun(fixture, fixture.director.id, environmentId);
      const content = `# Host change ${environmentId ?? "unleased"}\n`;
      const res = await writeInstructions(fixture, fixture.director, runId, content);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await writtenInstructions(fixture)).toBe(content);
    }
    // The direct grant did not touch the card.
    expect(await cardResult(cardId)).not.toHaveProperty("consumedByRunId");
  });

  it("decides from the signed run id, so a bridged run cannot pass as one on the host", async () => {
    const fixture = await seedCompany();
    const bridgedRunId = await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id);
    const hostRunId = await startRun(fixture, fixture.director.id, fixture.environments.local.id);

    // Naming the host run in the run id header is refused outright.
    const spoofed = await writeInstructions(fixture, fixture.director, bridgedRunId, "# Spoofed\n", {
      runIdHeader: hostRunId,
    });
    expect(spoofed.status, JSON.stringify(spoofed.body)).toBe(422);
    expect(spoofed.body.details).toMatchObject({ code: "agent_jwt_run_id_mismatch" });

    // Leaving the header out changes nothing: the token names the run.
    const headerless = await writeInstructions(fixture, fixture.director, bridgedRunId, "# Headerless\n", {
      runIdHeader: null,
    });
    expect(headerless.status, JSON.stringify(headerless.body)).toBe(403);
    expect(headerless.body.details).toMatchObject({ reason: "deny_missing_consent" });
    expect(await writtenInstructions(fixture)).toBeNull();
  });

  it("refuses a bridged write to an agent of another company without spending the card", async () => {
    const fixture = await seedCompany();
    const other = await seedCompany();
    const cardId = await acceptedCard(fixture, fixture.director.id, other.target.id);
    const runId = await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id);

    const res = await writeInstructions(fixture, fixture.director, runId, "# Elsewhere\n", {
      targetAgentId: other.target.id,
    });

    expect([403, 404]).toContain(res.status);
    expect(await writtenInstructions(other)).toBeNull();
    expect(await cardResult(cardId)).not.toHaveProperty("consumedByRunId");
  });

  describe("heartbeatRunUsesPaperclipApiBridge", () => {
    it("reads the run's environment leases", async () => {
      const fixture = await seedCompany();
      const [ssh] = await db.insert(environments).values({ name: `SSH ${randomUUID()}`, driver: "ssh" }).returning();
      const bridged = (runId: string, companyId = fixture.companyId) =>
        heartbeatRunUsesPaperclipApiBridge(db, { companyId, runId });

      expect(await bridged(await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id))).toBe(true);
      expect(await bridged(await startRun(fixture, fixture.director.id, ssh!.id))).toBe(true);
      expect(await bridged(await startRun(fixture, fixture.director.id, fixture.environments.local.id))).toBe(false);
      expect(await bridged(await startRun(fixture, fixture.director.id, null))).toBe(false);

      // A run's leases count only within its own company.
      const sandboxRunId = await startRun(fixture, fixture.director.id, fixture.environments.sandbox.id);
      expect(await bridged(sandboxRunId, randomUUID())).toBe(false);

      // A lease whose environment was deleted fails closed to bridged.
      const [gone] = await db.insert(environments).values({ name: `Gone ${randomUUID()}`, driver: "sandbox" }).returning();
      const orphanRunId = await startRun(fixture, fixture.director.id, gone!.id);
      await db.delete(environments).where(eq(environments.id, gone!.id));
      expect(await bridged(orphanRunId)).toBe(true);

      for (const runId of [null, undefined, "", "  ", "not-a-run-id", randomUUID()]) {
        expect(await heartbeatRunUsesPaperclipApiBridge(db, { companyId: fixture.companyId, runId })).toBe(false);
      }
    });
  });
});
