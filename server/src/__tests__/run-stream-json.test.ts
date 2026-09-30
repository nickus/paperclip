import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  streamJsonItemLines,
  translateRunLogContent,
  type StreamJsonItem,
} from "@paperclipai/adapter-utils/stream-json";
import { claudeStreamJsonTranslator } from "@paperclipai/adapter-claude-local/server";
import type { HeartbeatRunStreamJsonPage } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { createDurableRunLogStore, type RunLogHandle, type RunLogStore } from "../services/run-log-store.js";

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: (type: string) =>
    type === "claude_local" ? { type, streamJsonTranslator: claudeStreamJsonTranslator } : null,
}));

const { readRunStreamJsonPage } = await import("../services/run-stream-json.js");
type RunStreamJsonMeta = import("../services/run-stream-json.js").RunStreamJsonMeta;

const RUN_ID = "7a0c1c2e-1111-4aaa-8bbb-000000000001";
const T0 = Date.parse("2026-03-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const identity = (value: string) => value;

const assistant = (id: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: "m", content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage: {} },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: `u-${id}`,
  });

describe("readRunStreamJsonPage", () => {
  let dir: string;
  let store: RunLogStore;
  let handle: RunLogHandle;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "stream-json-log-api-"));
    store = createDurableRunLogStore({ basePath: dir });
    handle = await store.begin({ companyId: "company-1", agentId: "agent-1", runId: RUN_ID });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function meta(overrides: Partial<RunStreamJsonMeta> = {}): RunStreamJsonMeta {
    return {
      id: RUN_ID,
      companyId: "company-1",
      agentId: "agent-1",
      issueId: null,
      adapterType: "claude_local",
      status: "running",
      startedAt: new Date(T0),
      finishedAt: null,
      error: null,
      errorCode: null,
      usageJson: null,
      logStore: handle.store,
      logRef: handle.logRef,
      ...overrides,
    };
  }

  const terminal = (overrides: Partial<RunStreamJsonMeta> = {}) =>
    meta({ status: "succeeded", finishedAt: new Date(T0 + 60_000), ...overrides });

  async function appendRun(count: number) {
    for (let index = 0; index < count; index += 1) {
      await store.append(handle, {
        stream: index % 5 === 4 ? "stderr" : "stdout",
        chunk: index % 5 === 4 ? `stderr line ${index}\n` : `${assistant(`msg_${index}`, `text ${index} ${"x".repeat(200)}`)}\n`,
        ts: at(index * 100),
        seq: index + 1,
      });
    }
  }

  async function page(runMeta: RunStreamJsonMeta, query: Parameters<typeof readRunStreamJsonPage>[2]) {
    return readRunStreamJsonPage({ store, redactString: identity }, runMeta, query);
  }

  async function readAll(runMeta: RunStreamJsonMeta, limitBytes: number) {
    const items: HeartbeatRunStreamJsonPage["items"] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 1000; guard += 1) {
      const result: HeartbeatRunStreamJsonPage = await page(runMeta, { after, limitBytes });
      expect(result.reset).toBe(false);
      items.push(...result.items);
      if (result.items.length === 0 || result.complete) return { items, last: result };
      after = result.nextCursor;
    }
    throw new Error("paging did not finish");
  }

  function localContent() {
    return readFileSync(path.join(dir, handle.logRef), "utf8");
  }

  it("pages forward through the same items a full translation yields", async () => {
    await appendRun(23);
    const runMeta = terminal();
    const { items, last } = await readAll(runMeta, 700);
    expect(last.complete).toBe(true);
    expect(last.runStatus).toBe("succeeded");
    const expected = translateRunLogContent({
      runId: RUN_ID,
      adapterType: "claude_local",
      translator: claudeStreamJsonTranslator,
      content: localContent(),
      outcome: {
        status: "succeeded",
        startedAt: at(0),
        finishedAt: at(60_000),
        error: null,
        errorCode: null,
        usage: null,
      },
      redactString: identity,
    }).items;
    expect(items).toEqual(expected);
    // The finish synthesized a result because the log has none.
    expect(JSON.parse(streamJsonItemLines(items as StreamJsonItem[]).at(-1)!)).toMatchObject({ type: "result", paperclip: { synthesized: true } });
    // Items chain.
    items.forEach((item, index) => expect(item.prev).toBe(index === 0 ? null : items[index - 1]!.cursor));
  });

  it("returns at least one item per page and continues from nextCursor", async () => {
    await appendRun(6);
    const first = await page(meta(), { limitBytes: 1 });
    expect(first.items).toHaveLength(1);
    const second = await page(meta(), { after: first.nextCursor, limitBytes: 1 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.prev).toBe(first.items[0]!.cursor);
  });

  it("does not finish an active run", async () => {
    await appendRun(3);
    const result = await page(meta(), {});
    expect(result.complete).toBe(false);
    expect(streamJsonItemLines(result.items as StreamJsonItem[]).some((line) => JSON.parse(line).type === "result")).toBe(false);
    // Caught up: nothing after the last cursor, and the cursor is kept.
    const again = await page(meta(), { after: result.nextCursor });
    expect(again.items).toEqual([]);
    expect(again.nextCursor).toBe(result.nextCursor);
  });

  it("leaves a record that is still being written for the next read", async () => {
    await appendRun(2);
    appendFileSync(path.join(dir, handle.logRef), '{"ts":"2026-03-01T12:00:05.000Z","stream":"stdout","chunk":"par');
    const result = await page(meta(), {});
    expect(result.items).toHaveLength(2);
  });

  it("returns the newest items for tail and pages backward with before", async () => {
    await appendRun(10);
    const all = (await page(terminal(), {})).items;
    const tail = await page(terminal(), { tail: true, limitBytes: 1 });
    expect(tail.items).toEqual([all.at(-1)]);
    expect(tail.complete).toBe(true);
    // Backward pages continue from their oldest item.
    expect(tail.nextCursor).toBe(all.at(-1)!.cursor);
    const before = await page(terminal(), { before: tail.nextCursor, limitBytes: 600 });
    expect(before.items.length).toBeGreaterThan(0);
    expect(before.items.at(-1)).toEqual(all.at(-2));
    expect(before.complete).toBe(false);
    expect(before.nextCursor).toBe(before.items[0]!.cursor);
    const older = await page(terminal(), { before: before.nextCursor, limitBytes: 600 });
    expect(older.items.length).toBeGreaterThan(0);
    expect(older.items.at(-1)!.cursor).toBe(before.items[0]!.prev);
  });

  it("pages backward from the tail to the first item without overlap", async () => {
    await appendRun(23);
    const runMeta = terminal();
    const all = (await page(runMeta, {})).items;
    const pages: HeartbeatRunStreamJsonPage["items"][] = [];
    let result = await page(runMeta, { tail: true, limitBytes: 700 });
    pages.unshift(result.items);
    for (let guard = 0; result.nextCursor !== null; guard += 1) {
      if (guard > 100) throw new Error("backward paging did not finish");
      result = await page(runMeta, { before: result.nextCursor, limitBytes: 700 });
      expect(result.reset).toBe(false);
      expect(result.items.length).toBeGreaterThan(0);
      pages.unshift(result.items);
    }
    expect(pages.length).toBeGreaterThan(2);
    // Concatenated oldest-first, the pages are the whole output exactly once.
    expect(pages.flat()).toEqual(all);
    expect(result.items[0]!.prev).toBeNull();
  });

  it("ends backward paging with a null cursor when the page starts at the first item", async () => {
    await appendRun(4);
    const all = (await page(terminal(), {})).items;
    const tail = await page(terminal(), { tail: true });
    expect(tail.items).toEqual(all);
    expect(tail.nextCursor).toBeNull();
    const first = await page(terminal(), { before: all[1]!.cursor });
    expect(first.items).toEqual([all[0]]);
    expect(first.nextCursor).toBeNull();
    const none = await page(terminal(), { before: all[0]!.cursor });
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBeNull();
  });

  it("starts over with reset when the cursor belongs to another translation", async () => {
    await appendRun(4);
    const all = (await page(meta(), {})).items;
    const cursor = all[1]!.cursor;
    const [tag, , position] = cursor.split("/");
    const otherSid = await page(meta(), { after: `${tag}/OTHERSID00/${position}` });
    expect(otherSid.reset).toBe(true);
    expect(otherSid.items).toEqual(all);
    const otherVersion = await page(meta(), { after: cursor.replace("claude_local@1", "claude_local@2") });
    expect(otherVersion.reset).toBe(true);
    const tailReset = await page(meta(), { before: `${tag}/OTHERSID00/${position}`, limitBytes: 1 });
    expect(tailReset).toMatchObject({ reset: true, items: [all.at(-1)], nextCursor: all.at(-1)!.cursor });
  });

  it("changes the source id when the log is rewritten", async () => {
    await appendRun(2);
    const before = await page(meta(), {});
    writeFileSync(path.join(dir, handle.logRef), "");
    await store.append(handle, { stream: "stdout", chunk: `${assistant("other", "rewritten")}\n`, ts: at(0), seq: 1 });
    const after = await page(meta(), { after: before.nextCursor });
    expect(after.sid).not.toBe(before.sid);
    expect(after.reset).toBe(true);
  });

  it("uses the raw fallback for adapters without a translator", async () => {
    await appendRun(1);
    const result = await page(meta({ adapterType: "mystery_local" }), {});
    expect(result.translator).toBe("raw@1");
    expect(streamJsonItemLines(result.items as StreamJsonItem[]).map((line) => JSON.parse(line).subtype)).toEqual(["init", "paperclip_raw"]);
  });

  it("synthesizes the result of a terminal run without a log", async () => {
    const result = await page(
      terminal({ logStore: null, logRef: null, status: "failed", error: "could not start", errorCode: "adapter_failed" }),
      {},
    );
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(JSON.parse(streamJsonItemLines(result.items as StreamJsonItem[])[0]!)).toMatchObject({
      type: "result",
      is_error: true,
      errors: ["could not start"],
      paperclip: { synthesized: true, runStatus: "failed", errorCode: "adapter_failed" },
    });
  });

  it("applies the string redactor to strings it re-serializes", async () => {
    const result = await readRunStreamJsonPage(
      { store, redactString: (value) => value.replaceAll("could not", "[x]") },
      terminal({ logStore: null, logRef: null, status: "failed", error: "could not start" }),
      {},
    );
    expect(JSON.parse(streamJsonItemLines(result.items as StreamJsonItem[])[0]!).errors).toEqual(["[x] start"]);
  });

  it.each([
    [{ after: "not a cursor" }, 400],
    [{ before: "x@1/abc/1.0/2" }, 400],
    [{ after: "claude_local@1/abc/1.0", tail: true }, 400],
  ])("rejects %j", async (query, status) => {
    await expect(page(meta(), query)).rejects.toMatchObject({ status });
  });

  it("refuses logs over the translation limit", async () => {
    await appendRun(20);
    const error = await readRunStreamJsonPage({ store, redactString: identity, sourceLimitBytes: 1000 }, meta(), {}).catch((err) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 413, details: { code: "log_too_large_for_translation" } });
  });
});
