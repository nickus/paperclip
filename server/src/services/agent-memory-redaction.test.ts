import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentMemoryEntries, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { agentMemoryWriteInputSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { writeAgentMemoryEntry } from "./agent-memory.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent memory: redaction filter (§7)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-redaction-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent Memory Redaction Fixture Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Redaction Fixture Agent", adapterType: "codex_local", status: "idle",
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    return { companyId, agentId, runId };
  }

  async function countRowsForKey(companyId: string, agentId: string, key: string) {
    const rows = await db
      .select()
      .from(agentMemoryEntries)
      .where(and(
        eq(agentMemoryEntries.companyId, companyId),
        eq(agentMemoryEntries.agentId, agentId),
        eq(agentMemoryEntries.key, key),
      ));
    return rows.length;
  }

  it("11. an email address in the body is rejected (422); the write never reaches the DB", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentRun();
    await expect(writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "contains-email", body: "Ping ops@example.com if the nightly build fails again" },
      hints: {},
    })).rejects.toMatchObject({ status: 422 });
    expect(await countRowsForKey(companyId, agentId, "contains-email")).toBe(0);
  });

  it("12. a secret-assignment shaped body ('password: supersecret123') is rejected", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentRun();
    await expect(writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "gotcha", key: "contains-secret", body: "password: supersecret123 unlocks the staging box" },
      hints: {},
    })).rejects.toMatchObject({ status: 422 });
    expect(await countRowsForKey(companyId, agentId, "contains-secret")).toBe(0);
  });

  it("13. a 150-char quoted span is rejected by the long-quoted-text heuristic", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentRun();
    const quoted = `"${"x".repeat(150)}"`;
    await expect(writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "contains-long-quote", body: `User said ${quoted} verbatim` },
      hints: {},
    })).rejects.toMatchObject({ status: 422 });
    expect(await countRowsForKey(companyId, agentId, "contains-long-quote")).toBe(0);
  });

  it("14. a run-registered secret value embedded in the body is rejected via the registry diff check", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentRun();
    const secretValue = "s3cr3t-rig-token-zz9x";
    await createRunSecretRedactionRegistry(db).register(companyId, runId, secretValue);

    await expect(writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "gotcha", key: "contains-run-secret", body: `the deploy token is ${secretValue} this week` },
      hints: {},
    })).rejects.toMatchObject({ status: 422 });
    expect(await countRowsForKey(companyId, agentId, "contains-run-secret")).toBe(0);
  });

  it("15. ordinary short factual text with no matches is accepted unchanged", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentRun();
    const body = "Retries above three on this adapter waste more time than they save";
    const result = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "plain-fact", body },
      hints: {},
    });
    expect(result.decision).toBe("add");
    expect(result.entry.body).toBe(body);
  });

  it("16. body at exactly 300 chars is accepted; 301 chars is rejected at the validator layer", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentRun();
    const bodyAt300 = `${"a".repeat(299)}.`;
    expect(bodyAt300).toHaveLength(300);
    const result = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "exactly-300-chars", body: bodyAt300 },
      hints: {},
    });
    expect(result.entry.body).toBe(bodyAt300);

    const bodyAt301 = `${bodyAt300}b`;
    const parsed = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "too-long", body: bodyAt301 });
    expect(parsed.success).toBe(false);
  });
});
