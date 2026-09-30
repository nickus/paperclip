import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRunSecretRedactionRegistry, redactRegisteredSecretValues } from "../services/run-secret-redaction.js";

const secret = "q2a-exact-secret-value";

describe("registered run secret redaction", () => {
  it("redacts exact values across comment and heartbeat/wake projections", () => {
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${secret}` },
        wakeComment: { body: secret },
      },
      wakePayload: {
        comments: [{ body: `prefix-${secret}-suffix` }],
        continuationSummary: { body: secret },
      },
    }, [secret]);

    expect(result).toEqual({
      comment: { body: `agent pasted ${REDACTED_EVENT_VALUE} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${REDACTED_EVENT_VALUE}` },
        wakeComment: { body: REDACTED_EVENT_VALUE },
      },
      wakePayload: {
        comments: [{ body: `prefix-${REDACTED_EVENT_VALUE}-suffix` }],
        continuationSummary: { body: REDACTED_EVENT_VALUE },
      },
    });
  });

  it("redacts run detail, event, and transcript fields and strips registry material", () => {
    const result = redactRegisteredSecretValues({
      contextSnapshot: {
        issueId: "issue-1",
        paperclipSecretRedactions: [{ material: { ciphertext: "encrypted" } }],
      },
      stdoutExcerpt: `stdout ${secret}`,
      events: [{ message: secret, payload: { output: secret } }],
      log: { content: `tool returned ${secret}` },
    }, [secret]);

    expect(result).toEqual({
      contextSnapshot: { issueId: "issue-1" },
      stdoutExcerpt: `stdout ${REDACTED_EVENT_VALUE}`,
      events: [{ message: REDACTED_EVENT_VALUE, payload: { output: REDACTED_EVENT_VALUE } }],
      log: { content: `tool returned ${REDACTED_EVENT_VALUE}` },
    });
  });

  it("replaces longer registered values before overlapping shorter values", () => {
    expect(redactRegisteredSecretValues("token-extended token", ["token-extended", "token"]))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances instead of collapsing them to empty objects (PAP-16607)", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret}`, createdAt, updatedAt: createdAt },
      nested: [{ finishedAt: createdAt }],
    }, [secret]);

    expect(result.comment.createdAt).toBeInstanceOf(Date);
    expect(result.comment.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(result.comment.updatedAt).toBeInstanceOf(Date);
    expect(result.nested[0]?.finishedAt).toBeInstanceOf(Date);
    expect(result.comment.body).toBe(`agent pasted ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances when no secret values are registered", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({ createdAt }, []);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });
});

const { resolveVersion, createSecret } = vi.hoisted(() => ({
  resolveVersion: vi.fn(async ({ material }) => material.value as string),
  createSecret: vi.fn(async ({ value }: { value: string }) => ({ material: { value } })),
}));
vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion, createSecret }) }));

describe("batched run secret redaction", () => {
  beforeEach(() => { resolveVersion.mockClear(); });

  function fixture(rows: unknown[]) {
    const where = vi.fn(async (_predicate: import("drizzle-orm").SQL | undefined) => rows);
    const select = vi.fn((_columns: { contextSnapshot: import("drizzle-orm").SQL }) => ({ from: () => ({ where }) }));
    return { registry: createRunSecretRedactionRegistry({ select } as unknown as Db), select, where };
  }

  it("reads only registry JSON once for 200 runs and resolves shared secrets once", async () => {
    const contextSnapshot = { paperclipSecretRedactions: [{ fingerprintSha256: "shared", material: { value: secret } }] };
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, contextSnapshot }));
    const { registry, select, where } = fixture(rows);
    const result = await registry.redactForRuns("company-1", rows.map(row => ({ ...row, stdoutExcerpt: secret })));
    expect(select).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(result.every(run => run.stdoutExcerpt === REDACTED_EVENT_VALUE)).toBe(true);
    expect(result[0].contextSnapshot).toEqual({});
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.params).toContain("company-1");
    expect(predicate.sql).toContain('"company_id"');
    expect(dialect.sqlToQuery(select.mock.calls[0][0].contextSnapshot).sql).toContain("-> 'paperclipSecretRedactions'");
  });

  it("keeps each run's registry separate and observes new registrations on the next request", async () => {
    const rows = [{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: { value: secret } }] } }];
    const { registry } = fixture(rows);
    expect(await registry.redactForRuns("company", [{ id: "a", text: secret }, { id: "b", text: secret }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }, { id: "b", text: secret }]);
    rows[0].contextSnapshot.paperclipSecretRedactions.push({ fingerprintSha256: "two", material: { value: "new-secret" } });
    expect(await registry.redactForRuns("company", [{ id: "a", text: "new-secret" }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }]);
  });

  it("does not query for an empty list and fails closed on decryption failure", async () => {
    const { registry, select } = fixture([{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: {} }] } }]);
    expect(await registry.redactForRuns("company", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registry.redactForRuns("company", [{ id: "a", text: secret }])).rejects.toThrow("unavailable");
  });
});

describe("live run secret redaction", () => {
  beforeEach(() => { resolveVersion.mockClear(); });

  type Registry = Array<{ fingerprintSha256: string; material: { value: string } }>;

  // A run row whose registry the registry module reads with a projected select
  // and appends to inside a row-locked transaction.
  function liveFixture(initial: Registry) {
    const row = { contextSnapshot: { paperclipSecretRedactions: initial } as Record<string, unknown> };
    let nextRead: Promise<void> | null = null;
    const where = vi.fn(async () => {
      if (nextRead) await nextRead;
      return [{ contextSnapshot: { paperclipSecretRedactions: row.contextSnapshot.paperclipSecretRedactions } }];
    });
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [row] }) }) }),
      update: () => ({
        set: (values: { contextSnapshot: Record<string, unknown> }) => ({
          where: async () => { row.contextSnapshot = values.contextSnapshot; },
        }),
      }),
    };
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx));
    return {
      row,
      where,
      registry: createRunSecretRedactionRegistry({ select, transaction } as unknown as Db),
      holdNextRead() {
        let release!: () => void;
        nextRead = new Promise<void>((resolve) => { release = resolve; });
        return () => { nextRead = null; release(); };
      },
    };
  }

  it("serves a retained run from memory and reloads only after a new registration", async () => {
    const { registry, where } = liveFixture([{ fingerprintSha256: "one", material: { value: secret } }]);
    const release = registry.retainLiveRun("company", "run-live-1");
    try {
      for (let i = 0; i < 5; i += 1) {
        expect(redactRegisteredSecretValues(`out ${secret}`, await registry.valuesForLiveRun("company", "run-live-1")))
          .toBe(`out ${REDACTED_EVENT_VALUE}`);
      }
      expect(where).toHaveBeenCalledTimes(1);

      await registry.register("company", "run-live-1", "fresh-secret-value");
      const values = await registry.valuesForLiveRun("company", "run-live-1");
      expect(values).toEqual(expect.arrayContaining([secret, "fresh-secret-value"]));
      expect(where).toHaveBeenCalledTimes(2);
      // Previously resolved values are not decrypted again.
      expect(resolveVersion).toHaveBeenCalledTimes(2);

      // Registering a value that is already present changes nothing.
      await registry.register("company", "run-live-1", "fresh-secret-value");
      await registry.valuesForLiveRun("company", "run-live-1");
      expect(where).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }

    // Released: every call reads the registry again and nothing stays cached.
    await registry.valuesForLiveRun("company", "run-live-1");
    await registry.valuesForLiveRun("company", "run-live-1");
    expect(where).toHaveBeenCalledTimes(4);
  });

  it("keeps a retained run's values when its stored registry is later rewritten without them", async () => {
    const { registry, row } = liveFixture([{ fingerprintSha256: "one", material: { value: secret } }]);
    const release = registry.retainLiveRun("company", "run-live-2");
    try {
      await registry.valuesForLiveRun("company", "run-live-2");
      row.contextSnapshot = { paperclipSecretRedactions: [] };
      await registry.register("company", "run-live-2", "second-secret-value");
      expect(await registry.valuesForLiveRun("company", "run-live-2"))
        .toEqual(expect.arrayContaining([secret, "second-secret-value"]));
    } finally {
      release();
    }
  });

  it("resolves concurrent callers in call order across a reload", async () => {
    const fixture = liveFixture([{ fingerprintSha256: "one", material: { value: secret } }]);
    const release = fixture.registry.retainLiveRun("company", "run-live-3");
    try {
      const order: string[] = [];
      const releaseFirstRead = fixture.holdNextRead();
      const first = fixture.registry.valuesForLiveRun("company", "run-live-3").then((values) => {
        order.push("first");
        return values;
      });
      await fixture.registry.register("company", "run-live-3", "late-secret-value");
      const second = fixture.registry.valuesForLiveRun("company", "run-live-3").then((values) => {
        order.push("second");
        return values;
      });
      releaseFirstRead();
      const [firstValues, secondValues] = await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
      expect(secondValues).toContain("late-secret-value");
      expect(firstValues).toContain(secret);
    } finally {
      release();
    }
  });

  it("re-reads a retained run's registry once its copy is older than the max age", async () => {
    // A registration served by another server process writes the stored
    // registry without reaching this process's cache.
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, row, where } = liveFixture([{ fingerprintSha256: "one", material: { value: secret } }]);
    const release = registry.retainLiveRun("company", "run-live-5");
    try {
      expect(await registry.valuesForLiveRun("company", "run-live-5")).toEqual([secret]);
      (row.contextSnapshot.paperclipSecretRedactions as Registry).push({
        fingerprintSha256: "remote",
        material: { value: "remote-secret-value" },
      });

      vi.advanceTimersByTime(1_999);
      expect(await registry.valuesForLiveRun("company", "run-live-5")).toEqual([secret]);
      expect(where).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(await registry.valuesForLiveRun("company", "run-live-5"))
        .toEqual(expect.arrayContaining([secret, "remote-secret-value"]));
      expect(where).toHaveBeenCalledTimes(2);

      // Served from memory again until the next expiry.
      await registry.valuesForLiveRun("company", "run-live-5");
      expect(where).toHaveBeenCalledTimes(2);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("rejects when a value cannot be decrypted and retries on the next call", async () => {
    const { registry } = liveFixture([{ fingerprintSha256: "one", material: { value: secret } }]);
    const release = registry.retainLiveRun("company", "run-live-4");
    try {
      resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
      await expect(registry.valuesForLiveRun("company", "run-live-4")).rejects.toThrow("unavailable");
      expect(await registry.valuesForLiveRun("company", "run-live-4")).toContain(secret);
    } finally {
      release();
    }
  });

  it("redacts the JSON-escaped spelling of a value in NDJSON log content", async () => {
    const multiline = "-----BEGIN KEY-----\nabc\"def\\ghi\n-----END KEY-----";
    const { registry } = liveFixture([{ fingerprintSha256: "k", material: { value: multiline } }]);
    const content = `${JSON.stringify({ ts: "t", stream: "stdout", chunk: `key:\n${multiline}\n` })}\n`;
    const result = await registry.redactForRun("company", "a", { content });
    expect(result.content).not.toContain("abc");
    expect(JSON.parse(result.content.trim()).chunk).toBe(`key:\n${REDACTED_EVENT_VALUE}\n`);
  });
});
