import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentMemoryAudit, agentMemoryEntries, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { listAgentMemoryEntries, sweepAgentMemory, writeAgentMemoryEntry } from "./agent-memory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent memory: expiry, decay and the hard-cap sweep (§6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-sweep-");
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
      name: "Agent Memory Sweep Fixture Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Sweep Fixture Agent", adapterType: "codex_local", status: "idle",
    });
    return { companyId, agentId };
  }

  function rawEntry(overrides: {
    companyId: string;
    agentId: string;
    key: string;
    status?: string;
    confirmations?: number;
    expiresAt: Date;
    lastConfirmedAt?: Date;
    lastUsedAt?: Date | null;
    updatedAt?: Date;
    accessCount?: number;
  }) {
    const now = new Date();
    return {
      id: randomUUID(),
      companyId: overrides.companyId,
      scope: "agent" as const,
      agentId: overrides.agentId,
      kind: "fact" as const,
      key: overrides.key,
      body: `fixture body for ${overrides.key}`,
      projectId: null,
      status: overrides.status ?? "active",
      version: 1,
      sourceRunId: null,
      sourceIssueId: null,
      createdByAgentId: overrides.agentId,
      sourceTrust: null,
      confirmations: overrides.confirmations ?? 1,
      confirmingRunIds: [],
      accessCount: overrides.accessCount ?? 0,
      lastUsedAt: overrides.lastUsedAt ?? null,
      lastConfirmedAt: overrides.lastConfirmedAt ?? now,
      expiresAt: overrides.expiresAt,
      createdAt: now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  it("24. a read-time-expired row is hidden from listAgentMemoryEntries' default filter before the sweep ever runs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const past = new Date(Date.now() - DAY_MS);
    await db.insert(agentMemoryEntries).values(rawEntry({
      companyId, agentId, key: "already-past-expiry", status: "active", expiresAt: past,
    }));

    const defaultList = await listAgentMemoryEntries({ db, companyId, agentId });
    expect(defaultList.entries.map((e) => e.key)).not.toContain("already-past-expiry");

    const explicitExpired = await listAgentMemoryEntries({ db, companyId, agentId, status: ["expired"] });
    expect(explicitExpired.entries.map((e) => e.key)).toContain("already-past-expiry");
  });

  it("25. sweepAgentMemory flips a read-time-expired row's stored status to 'expired' and audits it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const past = new Date(Date.now() - DAY_MS);
    const entry = rawEntry({ companyId, agentId, key: "to-be-flipped", status: "active", expiresAt: past });
    await db.insert(agentMemoryEntries).values(entry);

    const result = await sweepAgentMemory({ db });
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, entry.id));
    expect(row?.status).toBe("expired");

    const audit = await db.select().from(agentMemoryAudit).where(and(
      eq(agentMemoryAudit.entryId, entry.id),
      eq(agentMemoryAudit.action, "expire_sweep"),
    ));
    expect(audit).toHaveLength(1);
  });

  it("26 & 27. cap sweep deletes the lowest-ranked expired/tombstoned rows first, and never evicts a twice-confirmed active row even if it scores lowest", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const future = new Date(Date.now() + 30 * DAY_MS);
    const farPast = new Date(Date.now() - 400 * DAY_MS);

    // Terminal (expired/tombstoned) rows at four distinct ages, oldest
    // lastConfirmedAt/lastUsedAt scoring lowest.
    const terminalAges = [1, 5, 10, 20];
    const terminalRows = terminalAges.map((daysAgo, index) => rawEntry({
      companyId, agentId,
      key: `terminal-${daysAgo}d`,
      status: index % 2 === 0 ? "expired" : "tombstoned",
      expiresAt: future,
      lastConfirmedAt: new Date(Date.now() - daysAgo * DAY_MS),
      lastUsedAt: new Date(Date.now() - daysAgo * DAY_MS),
      updatedAt: new Date(Date.now() - daysAgo * DAY_MS),
    }));

    // Three active rows, well within budget on their own.
    const activeRows = ["active-1", "active-2", "active-3"].map((key) => rawEntry({
      companyId, agentId, key, status: "active", confirmations: 1, expiresAt: future,
    }));

    await db.insert(agentMemoryEntries).values([...terminalRows, ...activeRows]);
    // 7 rows total, cap 5 -> overflow 2 -> the 2 lowest-scored terminal rows
    // (oldest activity: 20d and 10d ago) must be the ones deleted.
    const result = await sweepAgentMemory({ db, capPerAgent: 5 });
    expect(result.evicted).toBe(2);

    const remaining = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, agentId));
    expect(remaining).toHaveLength(5);
    const remainingKeys = new Set(remaining.map((row) => row.key));
    expect(remainingKeys.has("terminal-20d")).toBe(false);
    expect(remainingKeys.has("terminal-10d")).toBe(false);
    expect(remainingKeys.has("terminal-5d")).toBe(true);
    expect(remainingKeys.has("terminal-1d")).toBe(true);
    expect(remainingKeys.has("active-1")).toBe(true);
    expect(remainingKeys.has("active-2")).toBe(true);
    expect(remainingKeys.has("active-3")).toBe(true);

    // Protected-confirmation floor: a separate agent whose overflow can only
    // be resolved by evicting an active row. The twice-confirmed one must
    // survive even though it is numerically the lowest-scored row in the
    // whole candidate pool.
    const { agentId: agentId2 } = { agentId: randomUUID() };
    await db.insert(agents).values({ id: agentId2, companyId, name: "Sweep Fixture Agent 2", adapterType: "codex_local", status: "idle" });
    const protectedRow = rawEntry({
      companyId, agentId: agentId2, key: "protected-low-score", status: "active", confirmations: 2,
      expiresAt: future, lastConfirmedAt: farPast, lastUsedAt: farPast, updatedAt: farPast,
    });
    const unprotectedHigher = rawEntry({
      companyId, agentId: agentId2, key: "unprotected-higher-score", status: "active", confirmations: 1,
      expiresAt: future,
    });
    const unprotectedLower = rawEntry({
      companyId, agentId: agentId2, key: "unprotected-lower-score", status: "active", confirmations: 1,
      expiresAt: future, lastConfirmedAt: new Date(Date.now() - 50 * DAY_MS), lastUsedAt: new Date(Date.now() - 50 * DAY_MS),
      updatedAt: new Date(Date.now() - 50 * DAY_MS),
    });
    await db.insert(agentMemoryEntries).values([protectedRow, unprotectedHigher, unprotectedLower]);

    const result2 = await sweepAgentMemory({ db, capPerAgent: 2 });
    expect(result2.evicted).toBeGreaterThanOrEqual(1);

    const remaining2 = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, agentId2));
    const remaining2Keys = new Set(remaining2.map((row) => row.key));
    expect(remaining2Keys.has("protected-low-score")).toBe(true);
    expect(remaining2Keys.has("unprotected-lower-score")).toBe(false);
    expect(remaining2Keys.has("unprotected-higher-score")).toBe(true);
  });

  it("34. the expiry pass is bounded per tick: only expiryBatchSize rows flip per call, the rest wait for the next tick", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const past = new Date(Date.now() - DAY_MS);
    const rows = Array.from({ length: 5 }, (_, i) => rawEntry({
      companyId, agentId, key: `expired-${i}`, status: "active", expiresAt: past,
    }));
    await db.insert(agentMemoryEntries).values(rows);

    const first = await sweepAgentMemory({ db, expiryBatchSize: 2 });
    expect(first.expired).toBe(2);
    const afterFirst = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, agentId));
    expect(afterFirst.filter((row) => row.status === "expired")).toHaveLength(2);
    expect(afterFirst.filter((row) => row.status === "active")).toHaveLength(3);

    // The next tick picks up the remainder -- nothing is skipped or lost,
    // it is only ever spread across ticks.
    const second = await sweepAgentMemory({ db, expiryBatchSize: 2 });
    expect(second.expired).toBe(2);
    const third = await sweepAgentMemory({ db, expiryBatchSize: 2 });
    expect(third.expired).toBe(1);
    const final = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, agentId));
    expect(final.every((row) => row.status === "expired")).toBe(true);
  });

  it("35. the cap-eviction pass is bounded per tick: only maxGroupsPerTick over-cap agents are evicted from per call", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const future = new Date(Date.now() + 30 * DAY_MS);
    // A deliberately high row count and cap (8 rows, cap 6): every earlier
    // fixture in this describe block tops out at 5 live rows for one agent,
    // so a cap of 6 can never make an earlier test's leftover data (this
    // suite shares one db/table across its `it`s) look over-cap here too --
    // this test's own 3 groups are the only ones `sweepAgentMemory` can
    // possibly select from, regardless of what ran before it.
    const capPerAgent = 6;
    const rowsPerAgent = 8;

    // Three agents, each with their own over-cap pool of terminal rows, so
    // three distinct (companyId, agentId) groups are over cap at once.
    const agentIds = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const id = randomUUID();
        await db.insert(agents).values({ id, companyId, name: `Sweep Cap Fixture Agent ${i}`, adapterType: "codex_local", status: "idle" });
        const rows = Array.from({ length: rowsPerAgent }, (_, j) => rawEntry({
          companyId, agentId: id, key: `terminal-${i}-${j}`, status: "expired", expiresAt: future,
        }));
        await db.insert(agentMemoryEntries).values(rows);
        return id;
      }),
    );

    // Each agent's pool of 8 is over cap 6 by 2 -- but this tick must touch
    // at most maxGroupsPerTick=2 of the 3 over-cap groups, never all three.
    const result = await sweepAgentMemory({ db, capPerAgent, maxGroupsPerTick: 2 });
    expect(result.evicted).toBe(4); // exactly 2 groups x 2 overflow each

    const remainingCounts = await Promise.all(
      agentIds.map((id) => db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, id))),
    );
    const untouchedGroups = remainingCounts.filter((rows) => rows.length === rowsPerAgent).length;
    const touchedGroups = remainingCounts.filter((rows) => rows.length === capPerAgent).length;
    // Exactly maxGroupsPerTick groups were brought down to cap; the rest
    // are untouched this tick, left for a later one.
    expect(touchedGroups).toBe(2);
    expect(untouchedGroups).toBe(1);
  });

  it("28. confirmation resets expiresAt forward from now(), not from the stale old expiresAt", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Simulate an entry whose expiresAt was somehow set far beyond the
    // normal 14-day window (e.g. restored from a backup). A confirmation
    // must still land ~14 days from *now*, not ~14 days from that stale value.
    const staleFarFutureExpiry = new Date(Date.now() + 100 * DAY_MS);
    const body = "fixture body for creep-check";
    const entry = rawEntry({
      companyId, agentId, key: "creep-check", status: "active", expiresAt: staleFarFutureExpiry,
    });
    await db.insert(agentMemoryEntries).values({ ...entry, body });

    const result = await writeAgentMemoryEntry({
      db, companyId, agentId,
      actor: { type: "agent", id: agentId, agentId, runId: null },
      sourceIssueId: null, sourceTrust: null,
      candidate: { kind: "fact", key: "creep-check", body },
      hints: {},
    });

    expect(result.decision).toBe("noop");
    const expectedApprox = Date.now() + 14 * DAY_MS;
    expect(Math.abs(result.entry.expiresAt.getTime() - expectedApprox)).toBeLessThan(60_000);
    expect(result.entry.expiresAt.getTime()).toBeLessThan(staleFarFutureExpiry.getTime());
  });
});
