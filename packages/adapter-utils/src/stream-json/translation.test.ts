import { describe, expect, it } from "vitest";
import { parseStreamJsonCursor } from "./cursor.js";
import { computeStreamJsonSid, parseRunLogRecords } from "./records.js";
import { buildRunLogContent, streamJsonItemLines, translateRunLogContent, type RunLogRecordInput } from "./replay.js";
import { rawStreamJsonTranslator } from "./raw-translator.js";
import { StreamJsonRunTranslation } from "./translation.js";
import {
  DEFAULT_STREAM_JSON_LIMITS,
  STREAM_JSON_CONTRACT,
  type StreamJsonItem,
  type StreamJsonRunOutcome,
  type StreamJsonTranslator,
} from "./types.js";
import { utf8ByteLength } from "./utf8.js";

// A translator driven by the log itself: each stdout line is a JSON object
// naming one operation, so tests can exercise the host encoder directly.
const scriptTranslator: StreamJsonTranslator = {
  contract: STREAM_JSON_CONTRACT,
  id: "script",
  version: 1,
  create() {
    return {
      line(line, meta, ops) {
        const op = meta.json as Record<string, any> | undefined;
        if (!op || typeof op.op !== "string") {
          ops.raw(line);
          return;
        }
        switch (op.op) {
          case "init":
            ops.init({ sessionId: op.sessionId, model: op.model });
            return;
          case "message":
            ops.message(op.key, { model: op.model });
            return;
          case "delta":
            ops.delta({ blockKey: op.key ?? "k", kind: op.kind ?? "text", text: op.text });
            return;
          case "block":
            ops.block({ kind: op.kind ?? "text", text: op.text, reconciled: op.reconciled });
            return;
          case "tool":
            ops.toolUse({ sourceId: op.id, name: op.name ?? "Bash", input: op.input });
            return;
          case "toolResult":
            ops.toolResult({ sourceId: op.id, content: op.content ?? "", isError: op.isError === true, structured: op.structured });
            return;
          case "usage":
            ops.usage(op.usage);
            return;
          case "apiError":
            ops.apiError({ message: op.message, code: op.code });
            return;
          case "notice":
            ops.notice(op.level ?? "info", op.text, { recordError: op.recordError });
            return;
          case "result":
            ops.result(op.result);
            return;
          case "entry":
            ops.entry(op.entry);
            return;
          case "throw":
            ops.notice("info", "before throw");
            throw new Error("translator failure");
          default:
            ops.raw(line);
        }
      },
    };
  },
};

const RUN_ID = "run-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function at(ms: number) {
  return new Date(T0 + ms).toISOString();
}

function stdout(ms: number, value: unknown | string, seq?: number): RunLogRecordInput {
  const chunk = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  return { stream: "stdout", chunk, ts: at(ms), seq };
}

function translate(records: RunLogRecordInput[], outcome?: StreamJsonRunOutcome | null, translator = scriptTranslator) {
  return translateRunLogContent({
    runId: RUN_ID,
    adapterType: "script_local",
    translator,
    content: buildRunLogContent(records),
    outcome,
  });
}

function lines(items: StreamJsonItem[]) {
  return streamJsonItemLines(items).map((line) => JSON.parse(line) as Record<string, any>);
}

function outcome(overrides: Partial<StreamJsonRunOutcome> = {}): StreamJsonRunOutcome {
  return {
    status: "succeeded",
    startedAt: at(0),
    finishedAt: at(60_000),
    error: null,
    errorCode: null,
    usage: null,
    ...overrides,
  };
}

// Pushes records one by one through a live-style translation, like the hub.
function translateIncrementally(content: string, pageBytes: number, finalOutcome?: StreamJsonRunOutcome) {
  const first = parseRunLogRecords(content, 0).records[0]?.raw ?? null;
  const translation = new StreamJsonRunTranslation({
    runId: RUN_ID,
    adapterType: "script_local",
    sid: computeStreamJsonSid(RUN_ID, first),
    translator: scriptTranslator,
  });
  const bytes = new TextEncoder().encode(content);
  const items: StreamJsonItem[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const slice = new TextDecoder().decode(bytes.slice(offset, offset + pageBytes));
    const page = parseRunLogRecords(slice, offset);
    for (const record of page.records) items.push(...translation.push(record));
    if (page.consumedBytes === 0) {
      pageBytes *= 2;
      continue;
    }
    offset += page.consumedBytes;
  }
  if (finalOutcome) {
    translation.setOutcome(finalOutcome);
    items.push(...translation.end(offset));
  }
  return items;
}

describe("StreamJsonRunTranslation", () => {
  it("emits one item per record with chained cursors", () => {
    const { items, sid, tag } = translate([
      stdout(0, { op: "init", sessionId: "s-1", model: "m-1" }, 1),
      { stream: "stderr", chunk: "raw stderr ✓\n", ts: at(10), seq: 2 },
      stdout(20, { op: "block", text: "hello" }, 3),
    ]);
    expect(tag).toBe("script@1");
    expect(items.map((item) => item.stream)).toEqual(["stdout", "stderr", "stdout"]);
    expect(items[0]!.prev).toBeNull();
    expect(items[1]!.prev).toBe(items[0]!.cursor);
    expect(items[2]!.prev).toBe(items[1]!.cursor);
    expect(items[1]!.chunk).toBe("raw stderr ✓\n");
    for (const item of items) {
      expect(parseStreamJsonCursor(item.cursor)).toEqual({ tag, sid, offset: item.offset, k: item.k });
    }
    const [init, text] = lines(items);
    expect(init).toMatchObject({ type: "system", subtype: "init", session_id: "s-1", model: "m-1", paperclip: { translated: true, adapterType: "script_local" } });
    expect(init).not.toHaveProperty("claude_code_version");
    expect(text).toMatchObject({
      type: "assistant",
      session_id: "s-1",
      message: { role: "assistant", model: "m-1", content: [{ type: "text", text: "hello" }] },
      paperclip: { block: "b1", seg: 0, last: true },
    });
  });

  it("keeps one content block per assistant line and groups a message's lines by id", () => {
    const { items } = translate([
      stdout(0, { op: "message", key: "turn-1" }),
      stdout(1, { op: "block", kind: "thinking", text: "think" }),
      stdout(2, { op: "block", text: "answer" }),
      stdout(3, { op: "tool", id: "call_1", input: { command: "ls" } }),
      stdout(4, { op: "toolResult", id: "call_1", content: "out" }),
      stdout(5, { op: "block", text: "after tool" }),
    ]);
    const out = lines(items);
    const assistant = out.filter((line) => line.type === "assistant");
    for (const line of assistant) expect(line.message.content).toHaveLength(1);
    expect(new Set(assistant.slice(0, 3).map((line) => line.message.id)).size).toBe(1);
    // A new message starts after a tool result.
    expect(assistant[3]!.message.id).not.toBe(assistant[0]!.message.id);
    expect(assistant[0]!.message.content[0]).toEqual({ type: "thinking", thinking: "think", signature: "" });
    expect(assistant[0]!.message.id).toMatch(/^msg_pc_[A-Za-z0-9]{24}$/);
  });

  describe("tool ids", () => {
    it("keeps valid source ids, hashes others and suffixes reuse", () => {
      const out = lines(
        translate([
          stdout(0, { op: "tool", id: "call_1", input: { a: 1 } }),
          stdout(1, { op: "toolResult", id: "call_1", content: "r1" }),
          stdout(2, { op: "tool", id: "call_1", input: "not an object" }),
          stdout(3, { op: "toolResult", id: "call_1", content: "r2" }),
          stdout(4, { op: "tool", id: "bad id/with slash", input: {} }),
          stdout(5, { op: "toolResult", id: "bad id/with slash", content: "r3", isError: true }),
        ]).items,
      );
      const uses = out.filter((line) => line.type === "assistant").map((line) => line.message.content[0]);
      const results = out.filter((line) => line.type === "user").map((line) => line.message.content[0]);
      expect(uses.map((use) => use.id)).toEqual(["call_1", "call_1_2", expect.stringMatching(/^toolu_pc_[A-Za-z0-9]{24}$/)]);
      expect(uses[1].input).toEqual({ arguments: "not an object" });
      expect(results.map((result) => result.tool_use_id)).toEqual(uses.map((use) => use.id));
      expect(results[2]).toMatchObject({ is_error: true, content: "r3" });
    });

    it("synthesizes a tool_use for a result without one", () => {
      const out = lines(translate([stdout(0, { op: "toolResult", id: "orphan", content: "x" })]).items);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ type: "assistant", message: { content: [{ type: "tool_use", id: "orphan", name: "unknown", input: {} }] }, paperclip: { synthesized: true } });
      expect(out[1]).toMatchObject({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "orphan" }] } });
    });

    it("puts structured tool data in tool_use_result", () => {
      const out = lines(
        translate([
          stdout(0, { op: "tool", id: "c", input: {} }),
          stdout(1, { op: "toolResult", id: "c", content: "x", structured: { status: "completed" } }),
        ]).items,
      );
      expect(out[1]).toMatchObject({ tool_use_result: { status: "completed" } });
    });
  });

  describe("segmenting", () => {
    it("coalesces deltas into one line when the block closes quickly", () => {
      const out = lines(
        translate([
          stdout(0, { op: "delta", text: "Hel" }),
          stdout(100, { op: "delta", text: "lo " }),
          stdout(200, { op: "delta", text: "world" }),
          stdout(300, { op: "notice", text: "done" }),
        ]).items,
      );
      expect(out[0]).toMatchObject({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] }, paperclip: { block: "b1", seg: 0, last: true } });
      expect(out[1]).toMatchObject({ type: "system", subtype: "paperclip_notice", text: "done" });
    });

    it("cuts a segment at a boundary once its oldest text is older than the window", () => {
      const out = lines(
        translate([
          stdout(0, { op: "delta", text: "First sentence. " }),
          stdout(1000, { op: "delta", text: "Second sentence. Third" }),
          stdout(1600, { op: "delta", text: " part" }),
          stdout(1700, { op: "block", text: "next block" }),
        ]).items,
      );
      const segments = out.filter((line) => line.paperclip?.block === "b1");
      expect(segments.map((line) => line.message.content[0].text)).toEqual(["First sentence. Second sentence. ", "Third part"]);
      expect(segments.map((line) => [line.paperclip.seg, line.paperclip.last])).toEqual([[0, false], [1, true]]);
    });

    it("switches blocks when the block key or kind changes", () => {
      const out = lines(
        translate([
          stdout(0, { op: "delta", key: "a", kind: "thinking", text: "t1" }),
          stdout(1, { op: "delta", key: "a", kind: "text", text: "x1" }),
          stdout(2, { op: "delta", key: "b", kind: "text", text: "y1" }),
          stdout(3, { op: "delta", key: "b", kind: "text", text: "y2" }),
        ], outcome()).items,
      );
      const blocks = out.filter((line) => line.type === "assistant").map((line) => line.message.content[0]);
      expect(blocks).toEqual([
        { type: "thinking", thinking: "t1", signature: "" },
        { type: "text", text: "x1" },
        { type: "text", text: "y1y2" },
      ]);
    });

    it("never emits a segment longer than the hard limit and loses no text", () => {
      const words = Array.from({ length: 3000 }, (_, index) => `word${index}`).join(" ");
      const noBoundaries = "z".repeat(25_000);
      const out = lines(
        translate([
          stdout(0, { op: "delta", text: words }),
          stdout(1, { op: "delta", text: noBoundaries }),
          stdout(2, { op: "block", text: "tail" }),
        ]).items,
      );
      const segments = out.filter((line) => line.paperclip?.block === "b1").map((line) => line.message.content[0].text as string);
      expect(segments.length).toBeGreaterThan(3);
      for (const segment of segments) expect(segment.length).toBeLessThanOrEqual(DEFAULT_STREAM_JSON_LIMITS.segmentHardChars);
      expect(segments.join("")).toBe(words + noBoundaries);
    });

    it("splits a large complete block into segments instead of truncating it", () => {
      const text = "paragraph. ".repeat(4000);
      const out = lines(translate([stdout(0, { op: "block", text })]).items);
      expect(out.length).toBeGreaterThan(1);
      expect(out.map((line) => line.message.content[0].text).join("")).toBe(text);
      expect(out.at(-1)!.paperclip.last).toBe(true);
    });

    it("keeps memory bounded for many deltas without boundaries", () => {
      const translation = new StreamJsonRunTranslation({ runId: RUN_ID, adapterType: "x", sid: "s", translator: scriptTranslator });
      let emitted = "";
      let maxBytes = 0;
      const delta = `${JSON.stringify({ op: "delta", text: "abc" })}\n`;
      for (let index = 0; index < 100_000; index += 1) {
        const items = translation.push({ offset: index * 100, byteLength: 100, raw: "", seq: index, ts: at(0), stream: "stdout", chunk: delta });
        for (const line of streamJsonItemLines(items)) emitted += JSON.parse(line).message.content[0].text;
        maxBytes = Math.max(maxBytes, translation.approxBytes());
      }
      expect(maxBytes).toBeLessThan(200_000);
      translation.setOutcome(outcome());
      for (const line of streamJsonItemLines(translation.end(100_000 * 100))) {
        const parsed = JSON.parse(line);
        if (parsed.type === "assistant") emitted += parsed.message.content[0].text;
      }
      expect(emitted.length).toBe(300_000);
    });
  });

  describe("finish", () => {
    it("synthesizes exactly one result when the adapter reported none", () => {
      const { items } = translate(
        [stdout(0, { op: "block", text: "final words" }), stdout(10, { op: "usage", usage: { input: 5, output: 7, cacheRead: 3, cacheWrite: 1 } })],
        outcome({
          status: "failed",
          error: "adapter exited with code 1",
          errorCode: "adapter_failed",
          usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 20, costUsd: 0.5, model: "model-x", sessionId: "sess-9" },
        }),
      );
      const out = lines(items);
      const results = out.filter((line) => line.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 60_000,
        result: "final words",
        session_id: "sess-9",
        total_cost_usd: 0.5,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 },
        modelUsage: { "model-x": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 4 } },
        errors: ["adapter exited with code 1"],
        paperclip: { synthesized: true, runStatus: "failed", errorCode: "adapter_failed" },
      });
      // The finish item sits at the end of the log with no source sequence.
      const finishItem = items.at(-1)!;
      expect(finishItem.seq).toBeNull();
      expect(finishItem.ts).toBe(at(60_000));
    });

    it("uses summed message usage when the run row has none", () => {
      const out = lines(
        translate(
          [
            stdout(0, { op: "message", key: "m1" }),
            stdout(1, { op: "usage", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
            stdout(2, { op: "message", key: "m2" }),
            stdout(3, { op: "usage", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } }),
          ],
          outcome(),
        ).items,
      );
      expect(out.at(-1)).toMatchObject({ type: "result", is_error: false, subtype: "success", usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } });
    });

    it("does not synthesize a result when the adapter reported one", () => {
      const out = lines(
        translate([stdout(0, { op: "result", result: { isError: false, result: "ok", numTurns: 3, totalCostUsd: 1.25 } })], outcome()).items,
      );
      expect(out.filter((line) => line.type === "result")).toEqual([
        expect.objectContaining({ subtype: "success", result: "ok", num_turns: 3, total_cost_usd: 1.25 }),
      ]);
      expect(out[0]).not.toHaveProperty("paperclip");
    });

    it("records error notices for the synthesized result", () => {
      const out = lines(
        translate([stdout(0, { op: "notice", level: "error", text: "runner crashed", recordError: true }), stdout(1, { op: "apiError", message: "overloaded", code: "529" })], outcome({ status: "failed" })).items,
      );
      expect(out[1]).toMatchObject({ type: "assistant", message: { content: [{ type: "text", text: "API Error: overloaded" }] }, error: "unknown", is_api_error_message: true, api_error_code: "529" });
      expect(out.at(-1)!.errors).toEqual(["runner crashed", "overloaded"]);
    });

    it("places the finish before the first record after finishedAt and continues numbering there", () => {
      const records = [
        stdout(0, { op: "delta", text: "open block" }),
        stdout(50_000, { op: "block", text: "in time" }),
        stdout(70_000, { op: "block", text: "late" }),
      ];
      const { items } = translate(records, outcome());
      const late = parseRunLogRecords(buildRunLogContent(records), 0).records[2]!;
      const finishItem = items.find((item) => item.chunk.includes('"type":"result"'))!;
      expect(finishItem.seq).toBeNull();
      expect(finishItem.offset).toBe(late.offset);
      expect(finishItem.k).toBe(0);
      const lateItem = items.at(-1)!;
      expect(lateItem.offset).toBe(late.offset);
      expect(lateItem.k).toBe(finishItem.lines);
      expect(lines([finishItem]).at(-1)).toMatchObject({ type: "result" });
      expect(lines([lateItem])[0]).toMatchObject({ message: { content: [{ text: "late" }] } });
    });

    it("flushes an unterminated last line at the finish", () => {
      const out = lines(translate([stdout(0, JSON.stringify({ op: "block", text: "no newline" }))], outcome()).items);
      expect(out[0]).toMatchObject({ message: { content: [{ text: "no newline" }] } });
    });

    it("reports a conflict when a translated record is after finishedAt", () => {
      const content = buildRunLogContent([stdout(0, { op: "block", text: "a" }), stdout(90_000, { op: "block", text: "b" })]);
      const translation = new StreamJsonRunTranslation({ runId: RUN_ID, adapterType: "x", sid: "s", translator: scriptTranslator });
      for (const record of parseRunLogRecords(content, 0).records) translation.push(record);
      expect(translation.setOutcome(outcome()).conflict).toBe(true);
    });

    it("reports a conflict when a record not after finishedAt follows a finish at the end", () => {
      const content = buildRunLogContent([stdout(0, { op: "block", text: "a" }), stdout(10, { op: "block", text: "b" })]);
      const records = parseRunLogRecords(content, 0).records;
      const translation = new StreamJsonRunTranslation({ runId: RUN_ID, adapterType: "x", sid: "s", translator: scriptTranslator });
      translation.push(records[0]!);
      translation.setOutcome(outcome());
      translation.end(records[1]!.offset);
      expect(translation.conflict).toBe(false);
      translation.push(records[1]!);
      expect(translation.conflict).toBe(true);
    });
  });

  describe("determinism", () => {
    const records: RunLogRecordInput[] = [
      stdout(0, { op: "init", sessionId: "s", model: "m" }, 1),
      stdout(100, `${JSON.stringify({ op: "delta", text: "Streaming text that " })}\n${JSON.stringify({ op: "delta", text: "spans several records. " })}\n`, 2),
      stdout(900, `{"op":"delta","te`, 3),
      stdout(1700, `xt":"More words here.\\n\\nNew para "}\n`, 4),
      { stream: "stderr", chunk: "progress\n", ts: at(1800), seq: 5 },
      stdout(2600, { op: "tool", id: "c1", input: { q: 1 } }, 6),
      stdout(2700, { op: "toolResult", id: "c1", content: "result ✓ 𝄞" }, 7),
      stdout(4000, "[paperclip] host notice\nplain text line\n", 8),
      stdout(4100, { op: "delta", kind: "thinking", text: "hmm" }, 9),
    ];
    const content = buildRunLogContent(records);

    it("yields the same items whole, record by record and page by page", () => {
      const whole = translate(records, outcome()).items;
      for (const pageBytes of [1, 7, 64, 333, 4096]) {
        expect(translateIncrementally(content, pageBytes, outcome())).toEqual(whole);
      }
    });

    it("is prefix-monotonic: translating a prefix yields a prefix of the items", () => {
      const whole = translate(records).items;
      const parsed = parseRunLogRecords(content, 0).records;
      for (let cut = 1; cut <= parsed.length; cut += 1) {
        const prefix = translateRunLogContent({
          runId: RUN_ID,
          adapterType: "script_local",
          translator: scriptTranslator,
          content: parsed.slice(0, cut).map((record) => `${record.raw}\n`).join(""),
        }).items;
        expect(whole.slice(0, prefix.length)).toEqual(prefix);
      }
    });

    it("gives the same line contents when stdout is re-chunked at other boundaries", () => {
      const text = records.filter((record) => record.stream !== "stderr").map((record) => record.chunk).join("");
      const baseline = streamJsonItemLines(translate([stdout(0, text)], outcome()).items);
      let seed = 7;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      for (let trial = 0; trial < 20; trial += 1) {
        const pieces: RunLogRecordInput[] = [];
        let rest = text;
        while (rest.length > 0) {
          const size = 1 + Math.floor(random() * 40);
          pieces.push(stdout(0, rest.slice(0, size)));
          rest = rest.slice(size);
        }
        const out = streamJsonItemLines(translate(pieces, outcome()).items);
        // uuids depend on positions; compare everything else.
        const strip = (line: string) => {
          const parsed = JSON.parse(line);
          delete parsed.uuid;
          return parsed;
        };
        expect(out.map(strip)).toEqual(baseline.map(strip));
      }
    });
  });

  describe("line handling", () => {
    it("turns host lines into notices and other text into raw lines", () => {
      const out = lines(translate([stdout(0, "[paperclip] Enabled skills: a, b\nnot json at all\n")]).items);
      expect(out[0]).toMatchObject({ type: "system", subtype: "paperclip_notice", level: "info", text: "[paperclip] Enabled skills: a, b" });
      expect(out[1]).toMatchObject({ type: "system", subtype: "paperclip_raw", text: "not json at all", truncated: false });
    });

    it("drops the fragments around a truncation marker and emits one notice", () => {
      const head = '{"op":"block","text":"cut in the mid';
      const tail = 'dle of the line"}';
      const chunk = `${JSON.stringify({ op: "block", text: "before" })}\n${head}\n[paperclip truncated run log chunk: omitted 70000 chars]\n${tail}\n${JSON.stringify({ op: "block", text: "after" })}\n`;
      const out = lines(translate([stdout(0, chunk)]).items);
      expect(out.map((line) => line.subtype ?? line.message?.content?.[0]?.text)).toEqual([
        "before",
        "paperclip_notice",
        "after",
      ]);
      expect(out[1]).toMatchObject({ level: "warn", text: "adapter output was truncated: 70000 characters omitted" });
    });

    it("passes the repaired spelling of a damaged line to the translator", () => {
      const damaged = '{"op":"block","text":"run FOO_TOKEN=***REDACTED***" now"}';
      const out = lines(translate([stdout(0, `${damaged}\n`)]).items);
      expect(out[0]).toMatchObject({ message: { content: [{ text: 'run FOO_TOKEN=***REDACTED***" now' }] } });
    });

    it("emits a throwing translator's line raw and keeps going", () => {
      const errors: unknown[] = [];
      const content = buildRunLogContent([stdout(0, { op: "throw" }), stdout(1, { op: "block", text: "still here" })]);
      const page = parseRunLogRecords(content, 0);
      const translation = new StreamJsonRunTranslation({
        runId: RUN_ID,
        adapterType: "x",
        sid: "s",
        translator: scriptTranslator,
        onTranslatorError: (error) => errors.push(error),
      });
      const out = lines(page.records.flatMap((record) => translation.push(record)));
      expect(out.map((line) => line.subtype ?? line.type)).toEqual(["paperclip_notice", "paperclip_raw", "assistant"]);
      expect(out[1]!.text).toBe('{"op":"throw"}');
      expect(errors).toHaveLength(1);
    });

    it("caps raw text and flags it", () => {
      const out = lines(translate([stdout(0, `${"r".repeat(20_000)}\n`)]).items);
      expect(out[0]).toMatchObject({ subtype: "paperclip_raw", truncated: true });
      expect(out[0]!.text).toHaveLength(DEFAULT_STREAM_JSON_LIMITS.maxRawTextChars);
    });

    it("drops a line over the pending cap with a notice and keeps memory bounded", () => {
      const translation = new StreamJsonRunTranslation({ runId: RUN_ID, adapterType: "x", sid: "s", translator: scriptTranslator });
      const piece = "q".repeat(64_000);
      let maxBytes = 0;
      const items: StreamJsonItem[] = [];
      for (let index = 0; index < 160; index += 1) {
        items.push(...translation.push({ offset: index, byteLength: 1, raw: "", seq: index, ts: at(index), stream: "stdout", chunk: piece }));
        maxBytes = Math.max(maxBytes, translation.approxBytes());
      }
      items.push(...translation.push({ offset: 1000, byteLength: 1, raw: "", seq: 1000, ts: at(1000), stream: "stdout", chunk: "\n" }));
      expect(maxBytes).toBeLessThan(2 * DEFAULT_STREAM_JSON_LIMITS.maxPendingLineChars + 100_000);
      expect(lines(items)).toEqual([expect.objectContaining({ subtype: "paperclip_notice", level: "warn" })]);
    });

    it("redacts string leaves of constructed lines", () => {
      const { items } = translateRunLogContent({
        runId: RUN_ID,
        adapterType: "x",
        translator: scriptTranslator,
        content: buildRunLogContent([stdout(0, { op: "block", text: "secret-value here" }), stdout(1, { op: "tool", id: "secret-value", input: { v: "secret-value" } })]),
        redactString: (value) => value.replaceAll("secret-value", "[redacted]"),
      });
      const out = lines(items);
      expect(out[0]!.message.content[0].text).toBe("[redacted] here");
      // Ids are structural and stay intact so results still match their calls.
      expect(out[1]!.message.content[0]).toMatchObject({ id: "secret-value", input: { v: "[redacted]" } });
    });

    it("keeps every stdout line valid JSON under the size cap", () => {
      const { items } = translate([
        stdout(0, { op: "tool", id: "c", input: { blob: "i".repeat(200_000) } }),
        stdout(1, { op: "toolResult", id: "c", content: "o".repeat(300_000) }),
      ]);
      for (const line of streamJsonItemLines(items)) {
        expect(utf8ByteLength(line)).toBeLessThanOrEqual(DEFAULT_STREAM_JSON_LIMITS.maxLineBytes);
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(lines(items).map((line) => line.paperclip?.truncated)).toEqual([true, true]);
    });
  });

  it("keeps the output invariants on mixed input", () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const ops = [
      () => ({ op: "delta", key: `k${Math.floor(random() * 3)}`, kind: random() < 0.3 ? "thinking" : "text", text: "word ".repeat(1 + Math.floor(random() * 400)) }),
      () => ({ op: "block", text: "complete block" }),
      () => ({ op: "tool", id: `call_${Math.floor(random() * 5)}`, input: { n: 1 } }),
      () => ({ op: "toolResult", id: `call_${Math.floor(random() * 8)}`, content: "out", isError: random() < 0.2 }),
      () => ({ op: "message", key: `m${Math.floor(random() * 4)}` }),
      () => ({ op: "usage", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
      () => ({ op: "notice", text: "note" }),
      () => ({ op: "apiError", message: "boom" }),
    ];
    const records = Array.from({ length: 400 }, (_, index) => stdout(index * 300, ops[Math.floor(random() * ops.length)]!()));
    const out = lines(translate(records, outcome({ finishedAt: at(400 * 300) })).items);
    const allowed = new Set(["system", "assistant", "user", "result"]);
    const toolUses = new Set<string>();
    const uuids = new Set<string>();
    for (const line of out) {
      expect(allowed.has(line.type)).toBe(true);
      expect(line.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(uuids.has(line.uuid)).toBe(false);
      uuids.add(line.uuid);
      if (line.type === "assistant") {
        expect(line.message.content).toHaveLength(1);
        expect(line.message.id).toMatch(/^msg_pc_/);
        const block = line.message.content[0];
        if (block.type === "tool_use") toolUses.add(block.id);
        if (block.type === "text" || block.type === "thinking") {
          expect((block.text ?? block.thinking).length).toBeLessThanOrEqual(DEFAULT_STREAM_JSON_LIMITS.segmentHardChars);
        }
      }
      if (line.type === "user") {
        const result = line.message.content[0];
        expect(result.type).toBe("tool_result");
        expect(toolUses.has(result.tool_use_id)).toBe(true);
      }
    }
    expect(out.filter((line) => line.type === "result")).toHaveLength(1);
    expect(out.at(-1)!.type).toBe("result");
  });

  describe("entry bridge", () => {
    it("maps transcript entries to operations", () => {
      const ts = at(0);
      const entries = [
        { kind: "init", ts, model: "m", sessionId: "s" },
        { kind: "assistant", ts, text: "Hel", delta: true },
        { kind: "assistant", ts, text: "lo", delta: true },
        { kind: "tool_call", ts, name: "Read", input: { path: "a" }, toolUseId: "t1" },
        { kind: "tool_result", ts, toolUseId: "t1", content: "part1 ", isError: false, delta: true },
        { kind: "tool_result", ts, toolUseId: "t1", content: "part2", isError: false, delta: true },
        { kind: "user", ts, text: "follow-up" },
        { kind: "stderr", ts, text: "warning" },
        { kind: "diff", ts, changeType: "add", text: "+x" },
        { kind: "result", ts, text: "done", inputTokens: 1, outputTokens: 2, cachedTokens: 3, costUsd: 0.1, subtype: "success", isError: false, errors: [] },
      ];
      const out = lines(translate(entries.map((entry, index) => stdout(index, { op: "entry", entry })), outcome()).items);
      expect(out.map((line) => line.subtype ?? line.type)).toEqual([
        "init",
        "assistant",
        "assistant",
        "user",
        "user",
        "paperclip_notice",
        "paperclip_entry",
        "success",
      ]);
      expect(out[1]!.message.content[0]).toEqual({ type: "text", text: "Hello" });
      expect(out[3]!.message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "part1 part2" });
      expect(out[4]!.message.content[0]).toEqual({ type: "text", text: "follow-up" });
      expect(out.at(-1)).toMatchObject({ result: "done", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }, total_cost_usd: 0.1 });
    });
  });

  describe("raw fallback", () => {
    it("wraps every stdout line and synthesizes init and result", () => {
      const out = lines(
        translate([stdout(0, '{"type":"custom"}\nplain\n')], outcome({ status: "cancelled" }), rawStreamJsonTranslator).items,
      );
      expect(out.map((line) => line.subtype)).toEqual(["init", "paperclip_raw", "paperclip_raw", "error_during_execution"]);
      expect(out[0]).toMatchObject({ session_id: `paperclip-run-${RUN_ID}`, paperclip: { fallback: true } });
      expect(out[1]!.text).toBe('{"type":"custom"}');
      expect(out.at(-1)).toMatchObject({ paperclip: { synthesized: true, runStatus: "cancelled" } });
    });
  });
});
