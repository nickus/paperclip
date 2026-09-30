import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeStreamJsonTranslator } from "@paperclipai/adapter-claude-local/server";
import type {
  HeartbeatRunStreamJsonItem,
  HeartbeatRunStreamJsonPage,
  HeartbeatRunStreamJsonPayload,
  LiveEvent,
} from "@paperclipai/shared";
import { createDurableRunLogStore, type RunLogHandle, type RunLogStore } from "../services/run-log-store.js";

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: (type: string) =>
    type === "claude_local" ? { type, streamJsonTranslator: claudeStreamJsonTranslator } : null,
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { createRunStreamJsonHub } = await import("../services/run-stream-json-hub.js");
const { readRunStreamJsonPage } = await import("../services/run-stream-json.js");
type RunStreamJsonMeta = import("../services/run-stream-json.js").RunStreamJsonMeta;
type RunStreamJsonHub = import("../services/run-stream-json-hub.js").RunStreamJsonHub;

const COMPANY = "company-1";
const T0 = Date.parse("2026-04-01T08:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const assistant = (id: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: "m", content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage: {} },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: `u-${id}`,
  });

class Bus {
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private nextId = 0;
  subscribe = (listener: (event: LiveEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  emit(companyId: string, type: LiveEvent["type"], payload: Record<string, unknown>) {
    this.nextId += 1;
    const event: LiveEvent = { id: this.nextId, companyId, type, createdAt: new Date().toISOString(), payload };
    for (const listener of this.listeners) listener(event);
  }
}

interface Harness {
  hub: RunStreamJsonHub;
  bus: Bus;
  store: RunLogStore;
  published: Array<{ companyId: string; payload: HeartbeatRunStreamJsonPayload }>;
  secretValues: { current: () => Promise<string[]> };
  clock: { now: number };
  addRun(runId: string): Promise<Run>;
}

interface Run {
  runId: string;
  handle: RunLogHandle;
  meta: RunStreamJsonMeta;
  log(stream: "stdout" | "stderr", chunk: string, ms: number): Promise<void>;
  finish(status: string, finishedMs: number): void;
}

describe("createRunStreamJsonHub", () => {
  let dir: string;
  const harnesses: Harness[] = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "stream-json-hub-"));
  });

  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.hub.dispose();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function createHarness(
    options: { maxRuns?: number; lingerMs?: number; sweepIntervalMs?: number; resolveTranslator?: (adapterType: string | null) => typeof claudeStreamJsonTranslator } = {},
  ): Harness {
    const bus = new Bus();
    const store = createDurableRunLogStore({ basePath: dir });
    const metas = new Map<string, RunStreamJsonMeta>();
    const published: Harness["published"] = [];
    const secretValues = { current: async () => [] as string[] };
    const clock = { now: T0 };
    const hub = createRunStreamJsonHub({
      store,
      loadRunMeta: async (runId) => {
        const meta = metas.get(runId);
        return meta ? { ...meta } : null;
      },
      registeredSecretValues: () => secretValues.current(),
      publish: (companyId, payload) => published.push({ companyId, payload }),
      subscribe: bus.subscribe,
      now: () => clock.now,
      maxRuns: options.maxRuns,
      lingerMs: options.lingerMs,
      sweepIntervalMs: options.sweepIntervalMs ?? 3_600_000,
      resolveTranslator: options.resolveTranslator,
    });
    const harness: Harness = {
      hub,
      bus,
      store,
      published,
      secretValues,
      clock,
      async addRun(runId) {
        const handle = await store.begin({ companyId: COMPANY, agentId: "agent-1", runId });
        const meta: RunStreamJsonMeta = {
          id: runId,
          companyId: COMPANY,
          agentId: "agent-1",
          issueId: "issue-1",
          adapterType: "claude_local",
          status: "running",
          startedAt: new Date(T0),
          finishedAt: null,
          error: null,
          errorCode: null,
          usageJson: null,
          logStore: handle.store,
          logRef: handle.logRef,
        };
        metas.set(runId, meta);
        let seq = 0;
        return {
          runId,
          handle,
          meta,
          // Mirrors the heartbeat: persist the record, then publish the event.
          async log(stream, chunk, ms) {
            seq += 1;
            await store.append(handle, { stream, chunk, ts: at(ms), seq });
            bus.emit(COMPANY, "heartbeat.run.log", { runId, seq, stream, chunk: "live payloads are not read", ts: at(ms) });
          },
          finish(status, finishedMs) {
            meta.status = status;
            meta.finishedAt = new Date(T0 + finishedMs);
            bus.emit(COMPANY, "heartbeat.run.status", { runId, status });
          },
        };
      },
    };
    harnesses.push(harness);
    return harness;
  }

  function publishedItems(harness: Harness, runId: string) {
    return harness.published.flatMap(({ payload }) =>
      payload.kind === "items" && payload.runId === runId ? payload.items : [],
    );
  }

  async function apiItems(harness: Harness, run: Run) {
    const items: HeartbeatRunStreamJsonItem[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 500; guard += 1) {
      const page: HeartbeatRunStreamJsonPage = await readRunStreamJsonPage(
        { store: harness.store, redactString: (value) => value },
        { ...run.meta },
        { after, limitBytes: 2000 },
      );
      items.push(...page.items);
      if (page.items.length === 0 || page.complete) return items;
      after = page.nextCursor;
    }
    throw new Error("paging did not finish");
  }

  // A run whose Claude lines arrive split across chunks, with stderr and host lines.
  async function playRun(run: Run, harness: Harness, from: number, count: number, settleEvery: number) {
    for (let index = from; index < from + count; index += 1) {
      const line = assistant(`msg_${index}`, `step ${index} ${"word ".repeat(index % 7)}`);
      if (index % 6 === 5) {
        await run.log("stderr", `stderr ${index}\n`, index * 250);
      } else if (index % 6 === 3) {
        await run.log("stdout", `[paperclip] host note ${index}\n${line.slice(0, 40)}`, index * 250);
        await run.log("stdout", `${line.slice(40)}\n`, index * 250 + 10);
      } else {
        await run.log("stdout", `${line}\n`, index * 250);
      }
      if (index % settleEvery === 0) await harness.hub.whenIdle();
    }
  }

  it("publishes exactly the items the log API returns for the same run", async () => {
    const harness = createHarness();
    const release = harness.hub.retainCompany(COMPANY);
    const run = await harness.addRun("run-a");
    await playRun(run, harness, 0, 40, 4);
    run.finish("succeeded", 60_000);
    await harness.hub.whenIdle();

    const live = publishedItems(harness, run.runId);
    const backfill = await apiItems(harness, run);
    expect(live.length).toBeGreaterThan(30);
    expect(live).toEqual(backfill);
    live.forEach((item, index) => expect(item.prev).toBe(index === 0 ? null : live[index - 1]!.cursor));
    const lastLine = live.at(-1)!.chunk.trim().split("\n").at(-1)!;
    expect(JSON.parse(lastLine)).toMatchObject({ type: "result", paperclip: { synthesized: true, runStatus: "succeeded" } });
    const events = harness.published.filter(({ payload }) => payload.kind === "items");
    expect(events[0]!.payload).toMatchObject({ kind: "items", runId: "run-a", agentId: "agent-1", issueId: "issue-1", format: "claude-stream-json", translator: "claude_local@1" });
    release();
  });

  it("follows a run that was already running: history stays silent and the first item links to it", async () => {
    const harness = createHarness();
    const run = await harness.addRun("run-b");
    await playRun(run, harness, 0, 10, 1);
    expect(harness.hub.size).toBe(0);

    harness.hub.retainCompany(COMPANY);
    await playRun(run, harness, 10, 8, 3);
    run.finish("failed", 60_000);
    await harness.hub.whenIdle();

    const live = publishedItems(harness, run.runId);
    const backfill = await apiItems(harness, run);
    const start = backfill.findIndex((item) => item.cursor === live[0]!.cursor);
    expect(start).toBeGreaterThan(0);
    expect(live[0]!.prev).toBe(backfill[start - 1]!.cursor);
    expect(live).toEqual(backfill.slice(start));
  });

  it("finishes a run that was already terminal when the hub first saw it", async () => {
    const harness = createHarness();
    const run = await harness.addRun("run-late");
    await playRun(run, harness, 0, 4, 1);
    run.finish("succeeded", 2_000);
    harness.hub.retainCompany(COMPANY);
    // A record written after the run ended starts tracking.
    await run.log("stdout", `${assistant("late", "after the end")}\n`, 9_000);
    await harness.hub.whenIdle();
    const live = publishedItems(harness, run.runId);
    const backfill = await apiItems(harness, run);
    expect(live).toEqual(backfill.slice(backfill.length - live.length));
    expect(live.some((item) => item.chunk.includes('"synthesized":true'))).toBe(true);
  });

  it("does not track runs of companies without an opted-in socket", async () => {
    const harness = createHarness();
    const run = await harness.addRun("run-c");
    await run.log("stdout", `${assistant("m", "x")}\n`, 0);
    run.finish("succeeded", 1000);
    await harness.hub.whenIdle();
    expect(harness.hub.size).toBe(0);
    expect(harness.published).toEqual([]);
  });

  it("does not start translating on a terminal status alone", async () => {
    const harness = createHarness();
    harness.hub.retainCompany(COMPANY);
    const run = await harness.addRun("run-d");
    run.finish("succeeded", 1000);
    await harness.hub.whenIdle();
    expect(harness.hub.size).toBe(0);
  });

  it("redacts registered secret values and withholds output it cannot redact", async () => {
    const harness = createHarness();
    harness.hub.retainCompany(COMPANY);
    const run = await harness.addRun("run-e");
    harness.secretValues.current = async () => ["tok-1234567"];
    await run.log("stdout", `${assistant("m1", "value tok-1234567 here")}\n`, 0);
    await harness.hub.whenIdle();
    const [first] = publishedItems(harness, run.runId);
    expect(first!.chunk).toContain("***REDACTED***");
    expect(first!.chunk).not.toContain("tok-1234567");

    harness.secretValues.current = async () => {
      throw new Error("registry unavailable");
    };
    await run.log("stdout", `${assistant("m2", "withheld")}\n`, 100);
    await harness.hub.whenIdle();
    expect(publishedItems(harness, run.runId)).toHaveLength(1);

    harness.secretValues.current = async () => [];
    await run.log("stdout", `${assistant("m3", "after")}\n`, 200);
    await harness.hub.whenIdle();
    const items = publishedItems(harness, run.runId);
    expect(items).toHaveLength(2);
    // The gap is visible: the new item does not follow the last one received.
    expect(items[1]!.prev).not.toBe(items[0]!.cursor);
  });

  it("resets clients when the log is rewritten", async () => {
    const harness = createHarness();
    harness.hub.retainCompany(COMPANY);
    const run = await harness.addRun("run-f");
    await run.log("stdout", `${assistant("m1", "one")}\n`, 0);
    await harness.hub.whenIdle();
    const sidBefore = (harness.published[0]!.payload as { sid: string }).sid;

    writeFileSync(path.join(dir, run.handle.logRef), "");
    await run.log("stdout", `${assistant("m9", "rewritten")}\n`, 500);
    await harness.hub.whenIdle();
    expect(harness.published.map(({ payload }) => payload.kind)).toEqual(["items", "reset"]);
    expect(harness.published[1]!.payload).toEqual({ kind: "reset", runId: "run-f", reason: "source_rewritten" });

    await run.log("stdout", `${assistant("m10", "next")}\n`, 600);
    await harness.hub.whenIdle();
    const last = harness.published.at(-1)!.payload as { kind: string; sid: string };
    expect(last.kind).toBe("items");
    expect(last.sid).not.toBe(sidBefore);
    expect(publishedItems(harness, run.runId).at(-1)).toEqual((await apiItems(harness, run)).at(-1));
  });

  it("restarts the translation when the adapter's translator changes", async () => {
    let translator = claudeStreamJsonTranslator;
    const harness = createHarness({ resolveTranslator: () => translator });
    harness.hub.retainCompany(COMPANY);
    const run = await harness.addRun("run-t");
    await run.log("stdout", `${assistant("m1", "one")}\n`, 0);
    await harness.hub.whenIdle();
    translator = { ...claudeStreamJsonTranslator, version: 2 };
    await run.log("stdout", `${assistant("m2", "two")}\n`, 100);
    await harness.hub.whenIdle();
    expect(harness.published.at(-1)!.payload).toEqual({ kind: "reset", runId: "run-t", reason: "translator_changed" });
    await run.log("stdout", `${assistant("m3", "three")}\n`, 200);
    await harness.hub.whenIdle();
    expect(harness.published.at(-1)!.payload).toMatchObject({ kind: "items", translator: "claude_local@2" });
  });

  it("resets clients when the finish belongs before output already published", async () => {
    const harness = createHarness();
    harness.hub.retainCompany(COMPANY);
    const run = await harness.addRun("run-g");
    await run.log("stdout", `${assistant("m1", "one")}\n`, 0);
    await run.log("stdout", `${assistant("m2", "two")}\n`, 5_000);
    await harness.hub.whenIdle();
    // The run row says it finished before the second record was written.
    run.finish("cancelled", 1_000);
    await harness.hub.whenIdle();
    expect(harness.published.at(-1)!.payload).toEqual({ kind: "reset", runId: "run-g", reason: "reordered" });
  });

  it("evicts the least recently active run over the budget and resets its clients", async () => {
    const harness = createHarness({ maxRuns: 1 });
    harness.hub.retainCompany(COMPANY);
    const first = await harness.addRun("run-h1");
    await first.log("stdout", `${assistant("m1", "one")}\n`, 0);
    await harness.hub.whenIdle();
    harness.clock.now += 1000;
    const second = await harness.addRun("run-h2");
    await second.log("stdout", `${assistant("m2", "two")}\n`, 100);
    await harness.hub.whenIdle();
    expect(harness.hub.size).toBe(1);
    expect(harness.published.map(({ payload }) => [payload.kind, "runId" in payload ? payload.runId : null])).toEqual([
      ["items", "run-h1"],
      ["reset", "run-h1"],
      ["items", "run-h2"],
    ]);
  });

  it("drops state once a finished run or a released company lingers past the limit", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const harness = createHarness({ lingerMs: 10_000, sweepIntervalMs: 1_000 });
    const release = harness.hub.retainCompany(COMPANY);
    const running = await harness.addRun("run-i1");
    const finished = await harness.addRun("run-i2");
    await running.log("stdout", `${assistant("m1", "one")}\n`, 0);
    await finished.log("stdout", `${assistant("m2", "two")}\n`, 0);
    finished.finish("succeeded", 1000);
    await harness.hub.whenIdle();
    expect(harness.hub.size).toBe(2);

    harness.clock.now += 11_000;
    vi.advanceTimersByTime(1_000);
    expect(harness.hub.size).toBe(1);

    release();
    harness.clock.now += 5_000;
    vi.advanceTimersByTime(1_000);
    expect(harness.hub.size).toBe(1);
    harness.clock.now += 6_000;
    vi.advanceTimersByTime(1_000);
    expect(harness.hub.size).toBe(0);
  });
});
