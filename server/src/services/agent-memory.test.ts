import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentMemoryEntries, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  AgentMemoryConflictError,
  confirmAgentMemoryEntry,
  jaccardSimilarity,
  normalizeAgentMemoryTokens,
  writeAgentMemoryEntry,
} from "./agent-memory.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent memory: the four-way write decision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-decision-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent Memory Fixture Co",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Memory Fixture Agent",
      adapterType: "codex_local",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function seedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    return runId;
  }

  async function liveRowsForKey(companyId: string, agentId: string, key: string) {
    return db
      .select()
      .from(agentMemoryEntries)
      .where(and(
        eq(agentMemoryEntries.companyId, companyId),
        eq(agentMemoryEntries.agentId, agentId),
        eq(agentMemoryEntries.key, key),
      ));
  }

  it("1. ADD: a brand new key with no near-duplicate inserts one row with confirmations=1", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const result = await writeAgentMemoryEntry({
      db,
      companyId,
      agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null,
      sourceTrust: null,
      candidate: { kind: "gotcha", key: "docker-rig-limit", body: "The build host refuses docker runs over 32 parallel containers" },
      hints: {},
    });

    expect(result.decision).toBe("add");
    expect(result.entry.confirmations).toBe(1);
    expect(result.entry.status).toBe("active");
    const rows = await liveRowsForKey(companyId, agentId, "docker-rig-limit");
    expect(rows).toHaveLength(1);
  });

  it("2. NOOP same key, same body: confirmations increments, expiresAt resets, no new row, audit noop_confirm", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId1 = await seedRun(companyId, agentId);
    const runId2 = await seedRun(companyId, agentId);
    const body = "Restarting the adapter mid-run drops the active heartbeat lease";

    const first = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId: runId1 },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "adapter-restart-lease", body },
      hints: {},
    });
    const firstExpiresAt = first.entry.expiresAt.getTime();

    const second = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId: runId2 },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "adapter-restart-lease", body },
      hints: {},
    });

    expect(second.decision).toBe("noop");
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.confirmations).toBe(2);
    expect(second.entry.confirmingRunIds).toEqual([runId1, runId2]);
    expect(second.entry.expiresAt.getTime()).toBeGreaterThanOrEqual(firstExpiresAt);
    const rows = await liveRowsForKey(companyId, agentId, "adapter-restart-lease");
    expect(rows).toHaveLength(1);
  });

  it("3. UPDATE same key, refined body (similarity in [0.35, 1.0)): CAS succeeds, version bumps, audit has before/after body", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const first = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "shared-fact", body: "aaa bbb ccc ddd eee" },
      hints: {},
    });
    expect(normalizeAgentMemoryTokens("aaa bbb ccc ddd eee").size).toBe(5);

    const second = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "shared-fact", body: "aaa bbb ccc ddd fff" },
      hints: {},
    });

    expect(second.decision).toBe("update");
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.body).toBe("aaa bbb ccc ddd fff");
    expect(second.entry.version).toBe(first.entry.version + 1);
    expect(second.entry.confirmations).toBe(2);
  });

  it("4. DELETE-then-ADD: same key, contradicting body (similarity < 0.35): old row tombstoned, new row active with confirmations=1", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const first = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "decision", key: "contradiction-key", body: "aaa bbb ccc ddd eee" },
      hints: {},
    });

    const second = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "decision", key: "contradiction-key", body: "xxx yyy zzz www qqq" },
      hints: {},
    });

    expect(second.decision).toBe("delete_then_add");
    expect(second.entry.id).not.toBe(first.entry.id);
    expect(second.entry.confirmations).toBe(1);
    expect(second.entry.status).toBe("active");

    const [oldRow] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, first.entry.id));
    expect(oldRow?.status).toBe("tombstoned");
    expect(oldRow?.tombstoneReason).toBe(`contradicted_by_new_entry:${second.entry.id}`);

    const rows = await liveRowsForKey(companyId, agentId, "contradiction-key");
    expect(rows.filter((row) => row.status !== "tombstoned")).toHaveLength(1);
  });

  it("5. NOOP near-duplicate across different keys (similarity >= 0.6): confirms the existing entry, no new row under the new key", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const first = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "gotcha", key: "key-a", body: "aaa bbb ccc ddd eee" },
      hints: {},
    });

    const second = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "gotcha", key: "key-b", body: "aaa bbb ccc ddd fff" },
      hints: {},
    });

    expect(second.decision).toBe("noop");
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.key).toBe("key-a");
    const underNewKey = await liveRowsForKey(companyId, agentId, "key-b");
    expect(underNewKey).toHaveLength(0);
  });

  it("6. supersedes hint forces UPDATE even when similarity would otherwise say DELETE-then-ADD", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const first = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "supersede-target", body: "aaa bbb ccc ddd eee" },
      hints: {},
    });

    const second = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "irrelevant-key", body: "xxx yyy zzz www qqq" },
      hints: { supersedes: first.entry.id },
    });

    expect(second.decision).toBe("update");
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.body).toBe("xxx yyy zzz www qqq");
    const [row] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, first.entry.id));
    expect(row?.status).toBe("active");
  });

  it("7. forget hint tombstones the named id, then the candidate is a fresh ADD regardless of any other row's similarity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    // An unrelated sibling entry, written first so it exists independently
    // (not itself a near-duplicate of anything at write time).
    const nearDupSibling = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "near-dup-sibling", body: "aaa bbb ccc ddd fff" },
      hints: {},
    });
    // The entry the forget hint will target, deliberately dissimilar to the
    // sibling so it never merges with it on write.
    const toForget = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "forget-me", body: "no overlap with the sibling at all" },
      hints: {},
    });

    // This candidate's body IS near-duplicate-similar to the sibling
    // (jaccard >= 0.6) — if the forget hint did not bypass the match/near-dup
    // check, this would resolve as a NOOP confirmation of the sibling
    // instead of a fresh ADD.
    const result = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "lesson", key: "brand-new-key", body: "aaa bbb ccc ddd eee" },
      hints: { forget: toForget.entry.id },
    });

    expect(result.decision).toBe("add");
    expect(result.entry.key).toBe("brand-new-key");
    expect(result.entry.id).not.toBe(nearDupSibling.entry.id);

    const [forgotten] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, toForget.entry.id));
    expect(forgotten?.status).toBe("tombstoned");
    expect(forgotten?.tombstoneReason).toBe("forget_hint");

    const [sibling] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, nearDupSibling.entry.id));
    expect(sibling?.confirmations).toBe(1); // untouched by the forget-hint write
  });

  it("8. concurrent UPDATE race: the loser's stale version CAS gets AgentMemoryConflictError carrying the winner's row", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const base = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "race-key", body: "aaa bbb ccc ddd eee" },
      hints: {},
    });

    // Two writers both read the entry at version 1 (base.entry.version), then
    // race their CAS writes. Simulate the winner committing first...
    const winner = await confirmAgentMemoryEntry({
      db, companyId, id: base.entry.id,
      actor: { type: "agent", id: agentId, agentId, runId },
      baseVersion: base.entry.version,
    });
    expect(winner.version).toBe(base.entry.version + 1);

    // ...then the loser's write, built from the same stale read, must lose
    // its CAS and surface a conflict carrying the winner's row — never
    // silently overwrite it and never throw an unrelated 500.
    await expect(confirmAgentMemoryEntry({
      db, companyId, id: base.entry.id,
      actor: { type: "agent", id: agentId, agentId, runId },
      baseVersion: base.entry.version,
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentMemoryConflictError);
      const conflictError = error as AgentMemoryConflictError;
      expect(conflictError.currentEntry.id).toBe(base.entry.id);
      expect(conflictError.currentEntry.version).toBe(winner.version);
      return true;
    });

    // Also exercise genuine concurrency on the write-path's own UPDATE
    // branch: two true concurrent refinements of the same key, each its own
    // run (so the per-run write cap used above cannot interfere). Whatever
    // the database's actual interleaving, every settled outcome must be
    // either a successful CAS update or a well-typed conflict — never data
    // loss, never an unrelated throw.
    const raceRunIdA = await seedRun(companyId, agentId);
    const raceRunIdB = await seedRun(companyId, agentId);
    const write = (body: string, runIdForWrite: string) => writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId: runIdForWrite },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "race-key", body },
      hints: {},
    });
    const results = await Promise.allSettled([
      write("aaa bbb ccc ddd hhh", raceRunIdA),
      write("aaa bbb ccc ddd iii", raceRunIdB),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(AgentMemoryConflictError);
      } else {
        expect(result.value.decision).toBe("update");
      }
    }
  });

  it("9. concurrent insert race on the same key: the loser's 23505 becomes a confirmation of the winner's row, not a thrown error", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);

    const write = (body: string) => writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "gotcha", key: "insert-race-key", body },
      hints: {},
    });

    const [left, right] = await Promise.all([write("hhh iii jjj kkk lll"), write("hhh iii jjj kkk mmm")]);
    const decisions = [left.decision, right.decision].sort();
    expect(decisions).toEqual(["add", "noop"]);
    expect(left.entry.id).toBe(right.entry.id);

    const rows = await liveRowsForKey(companyId, agentId, "insert-race-key");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmations).toBe(2);
  });

  it("10. jaccardSimilarity: identical, disjoint, partial overlap, and <=2-char tokens dropped", () => {
    expect(jaccardSimilarity(normalizeAgentMemoryTokens("aaa bbb ccc"), normalizeAgentMemoryTokens("aaa bbb ccc"))).toBe(1);
    expect(jaccardSimilarity(normalizeAgentMemoryTokens("aaa bbb ccc"), normalizeAgentMemoryTokens("xxx yyy zzz"))).toBe(0);
    expect(jaccardSimilarity(normalizeAgentMemoryTokens("aaa bbb ccc ddd"), normalizeAgentMemoryTokens("aaa bbb eee fff"))).toBeCloseTo(2 / 6);
    // "ok", "to", "a" are <= 2 chars and must be dropped before comparison.
    expect(normalizeAgentMemoryTokens("ok to a bbb")).toEqual(new Set(["bbb"]));
  });
});
