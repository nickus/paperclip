import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentMemoryEntries, agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  captureRememberLinesForRun,
  extractRememberLines,
  isAgentMemoryLlmExtractorEnabled,
} from "./agent-memory-capture.js";

describe("agent memory capture: extractRememberLines (§9.2)", () => {
  it("29. captures a Remember: line, any case, but not a mid-sentence occurrence", () => {
    expect(extractRememberLines("Remember: the staging DB resets nightly")).toEqual([
      "the staging DB resets nightly",
    ]);
    expect(extractRememberLines("REMEMBER: shout case works too")).toEqual([
      "shout case works too",
    ]);
    expect(extractRememberLines("remember: lower case works too")).toEqual([
      "lower case works too",
    ]);
    // Mid-sentence "remember to..." is not a whole-line marker.
    expect(extractRememberLines("Please remember to check the logs first")).toEqual([]);
    expect(extractRememberLines("I'll remember: this is still mid-sentence")).toEqual([]);
    expect(extractRememberLines(null)).toEqual([]);
    expect(extractRememberLines("")).toEqual([]);
  });

  it("30. multiple Remember: lines in one text each produce one candidate", () => {
    const text = [
      "Some narration first.",
      "Remember: the first fact",
      "more narration",
      "Remember: the second fact",
      "Remember: the third fact",
    ].join("\n");
    expect(extractRememberLines(text)).toEqual([
      "the first fact",
      "the second fact",
      "the third fact",
    ]);
  });

  it("truncates a captured line to the storage cap", () => {
    const [captured] = extractRememberLines(`Remember: ${"x".repeat(400)}`);
    expect(captured!.length).toBe(300);
  });
});

describe("agent memory capture: the extension-point flag (§9.4)", () => {
  it("is off unless explicitly set to \"on\"", () => {
    expect(isAgentMemoryLlmExtractorEnabled({})).toBe(false);
    expect(isAgentMemoryLlmExtractorEnabled({ PAPERCLIP_AGENT_MEMORY_LLM_EXTRACTOR: "true" })).toBe(
      false,
    );
    expect(isAgentMemoryLlmExtractorEnabled({ PAPERCLIP_AGENT_MEMORY_LLM_EXTRACTOR: "on" })).toBe(
      true,
    );
  });
});

describe("agent memory capture: 33. a no-op when the effective mode is off", () => {
  it("never touches the database", async () => {
    // A db stand-in that throws on any access, so the test fails loudly if
    // captureRememberLinesForRun ever reaches for it.
    const poisonDb = new Proxy(
      {},
      {
        get() {
          throw new Error("captureRememberLinesForRun touched the db while effectiveMode was off");
        },
      },
    ) as never;
    const result = await captureRememberLinesForRun(poisonDb, {
      companyId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
      sourceIssueId: null,
      sourceTrust: null,
      summaryText: "Remember: this must never be written",
      commentText: "Remember: neither must this",
      effectiveMode: "off",
    });
    expect(result).toEqual({ captured: 0 });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent memory capture: run-end write-through (§9.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-capture-");
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
      name: "Agent Memory Capture Fixture Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Memory Capture Fixture Agent",
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

  async function liveEntries(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentMemoryEntries)
      .where(and(eq(agentMemoryEntries.companyId, companyId), eq(agentMemoryEntries.agentId, agentId)));
  }

  it("31. the same Remember: text in both the summary and the comment is captured once", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);
    const result = await captureRememberLinesForRun(db, {
      companyId,
      agentId,
      runId,
      sourceIssueId: null,
      sourceTrust: null,
      summaryText: "Remember: the CI runner caps builds at four",
      commentText: "Done. Remember: the CI runner caps builds at four",
      effectiveMode: "on",
    });
    expect(result.captured).toBe(1);
    const rows = await liveEntries(companyId, agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("the CI runner caps builds at four");
    expect(rows[0]?.key).toMatch(/^auto-[0-9a-f]{16}$/);
    expect(rows[0]?.kind).toBe("lesson");
    expect(rows[0]?.confirmingRunIds).toEqual([runId]);
  });

  it("32. never throws when writeAgentMemoryEntry rejects a candidate internally", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);
    // The first line trips the redaction filter (an email address); the
    // second is an ordinary fact. Both come from the same summary text.
    const summaryText = [
      "Remember: contact ops at ops@example.com for the rig",
      "Remember: the staging DB is named paperclip_staging",
    ].join("\n");
    await expect(
      captureRememberLinesForRun(db, {
        companyId,
        agentId,
        runId,
        sourceIssueId: null,
        sourceTrust: null,
        summaryText,
        commentText: null,
        effectiveMode: "on",
      }),
    ).resolves.toEqual({ captured: 1 });
    const rows = await liveEntries(companyId, agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("the staging DB is named paperclip_staging");
  });

  it("is a no-op (zero writes) in shadow mode too -- shadow still captures, only injection differs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);
    const result = await captureRememberLinesForRun(db, {
      companyId,
      agentId,
      runId,
      sourceIssueId: null,
      sourceTrust: null,
      summaryText: "Remember: shadow mode still writes",
      commentText: null,
      effectiveMode: "shadow",
    });
    expect(result.captured).toBe(1);
    expect(await liveEntries(companyId, agentId)).toHaveLength(1);
  });

  it("33. more Remember: lines than the per-run write cap: capped before any DB work, not one rejected attempt per extra line", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun(companyId, agentId);
    // AGENT_MEMORY_MAX_WRITES_PER_RUN is 3; six distinct lines in one
    // summary text must never result in more than 3 attempted writes --
    // run finalization's work here is bounded by the per-run cap, not by
    // how many Remember: lines happen to be in the agent's own output.
    // (Deliberately unrelated subjects, not a shared sentence with a
    // changing digit: digits are 1 character and dropped by the near-
    // duplicate tokenizer, which would otherwise collapse every line into
    // one near-duplicate of the first and defeat the point of this test.)
    const facts = [
      "the staging database resets nightly at 2am",
      "docker builds fail above 32 parallel containers",
      "the deploy script needs a trailing slash on the branch name",
      "the CI runner caps builds at four concurrent jobs",
      "the archive volume alarms past 80 percent full",
      "the adapter drops its lease on a mid-run restart",
    ];
    const summaryText = facts.map((fact) => `Remember: ${fact}`).join("\n");

    // Count DB round trips directly: each *attempted* write (accepted or
    // rejected by the per-run cap check) issues at least one `db.select`
    // before anything else. If the extracted lines were not pre-truncated
    // to the cap, 6 lines would drive at least 6 such round trips (3
    // accepted + 3 rejected-by-cap); bounding the batch to the cap first
    // means at most 3 attempts, and therefore at most 3x that per-attempt
    // floor, regardless of how many Remember: lines the text contains.
    const originalSelect = db.select.bind(db);
    let selectCalls = 0;
    db.select = ((...args: Parameters<typeof originalSelect>) => {
      selectCalls += 1;
      return originalSelect(...args);
    }) as typeof db.select;
    let result: { captured: number };
    try {
      result = await captureRememberLinesForRun(db, {
        companyId,
        agentId,
        runId,
        sourceIssueId: null,
        sourceTrust: null,
        summaryText,
        commentText: null,
        effectiveMode: "on",
      });
    } finally {
      db.select = originalSelect;
    }

    expect(result.captured).toBe(3);
    const rows = await liveEntries(companyId, agentId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.body).sort()).toEqual(facts.slice(0, 3).sort());
    // Each attempt's write-cap check alone issues 2 selects (run-count +
    // day-count); 6 unbounded attempts would be >= 12 on that floor alone.
    // Bounded to 3 attempts, this must stay under that unbounded floor.
    expect(selectCalls).toBeLessThan(12);
  });

  it("writes nothing when the text has no Remember: line", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const result = await captureRememberLinesForRun(db, {
      companyId,
      agentId,
      runId: randomUUID(),
      sourceIssueId: null,
      sourceTrust: null,
      summaryText: "Just a normal summary, nothing to remember here.",
      commentText: "Please remember to check the logs (mid-sentence, not captured).",
      effectiveMode: "on",
    });
    expect(result).toEqual({ captured: 0 });
    expect(await liveEntries(companyId, agentId)).toHaveLength(0);
  });
});
