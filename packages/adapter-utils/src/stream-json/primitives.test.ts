import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareStreamJsonPositions, formatStreamJsonCursor, parseStreamJsonCursor } from "./cursor.js";
import { findSegmentBoundary } from "./encoder.js";
import { LineFramer } from "./framer.js";
import { hashId, hashUuid, sha256, toHex } from "./hash.js";
import { computeStreamJsonSid, parseRunLogRecords } from "./records.js";
import { parseStdoutLine, readTruncationMarker } from "./repair.js";
import { buildRunLogContent } from "./replay.js";
import { serializeWithinLimit } from "./shrink.js";
import { utf8ByteLength } from "./utf8.js";
import { describeInvalidStreamJsonTranslator } from "./validate.js";

describe("sha256", () => {
  it.each(["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "héllo wörld ✓ 𝄞", "x".repeat(10_000)])(
    "matches node:crypto for %#",
    (input) => {
      expect(toHex(sha256(input))).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    },
  );

  it("derives stable ids and UUIDs", () => {
    expect(hashId(["run", "message", "k"], 24)).toHaveLength(24);
    expect(hashId(["run", "message", "k"], 24)).toBe(hashId(["run", "message", "k"], 24));
    expect(hashId(["run", "message", "k"], 24)).not.toBe(hashId(["run", "message", "k2"], 24));
    expect(hashUuid(["a", 1])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("utf8ByteLength", () => {
  it.each(["", "abc", "é", "✓", "𝄞", "a𝄞b✓é", "\ud800x"])("matches the encoder for %#", (value) => {
    expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).length);
  });
});

describe("parseRunLogRecords", () => {
  const content = buildRunLogContent([
    { stream: "stdout", chunk: "héllo\n", ts: "2026-01-01T00:00:00.000Z", seq: 1 },
    { stream: "stderr", chunk: "warn ✓\n", ts: "2026-01-01T00:00:01.000Z", seq: 2 },
    { stream: "stdout", chunk: "𝄞 tail", ts: "2026-01-01T00:00:02.000Z", seq: 3 },
  ]);

  it("returns byte offsets of complete records", () => {
    const page = parseRunLogRecords(content, 0);
    expect(page.records.map((record) => record.seq)).toEqual([1, 2, 3]);
    const bytes = new TextEncoder().encode(content);
    for (const record of page.records) {
      const line = new TextDecoder().decode(bytes.slice(record.offset, record.offset + record.byteLength));
      expect(line).toBe(`${record.raw}\n`);
    }
    expect(page.consumedBytes).toBe(bytes.length);
  });

  it("leaves a partial trailing record (even a cut UTF-8 sequence) for the next read", () => {
    const bytes = new TextEncoder().encode(content);
    const firstTwo = parseRunLogRecords(content, 0).records[2]!.offset;
    // Cut inside the multi-byte character of the third record.
    const cut = firstTwo + content.split("\n")[2]!.indexOf("𝄞") + 2;
    const partial = new TextDecoder().decode(bytes.slice(0, cut));
    const page = parseRunLogRecords(partial, 0);
    expect(page.records).toHaveLength(2);
    expect(page.consumedBytes).toBe(firstTwo);
    const rest = new TextDecoder().decode(bytes.slice(page.consumedBytes));
    const next = parseRunLogRecords(rest, page.consumedBytes);
    expect(next.records[0]).toMatchObject({ offset: firstTwo, seq: 3, chunk: "𝄞 tail" });
  });

  it("skips malformed lines but consumes their bytes", () => {
    const page = parseRunLogRecords(`not json\n{"no":"chunk"}\n${content}`, 100);
    expect(page.skipped).toBe(2);
    expect(page.records[0]!.offset).toBe(100 + "not json\n".length + '{"no":"chunk"}\n'.length);
  });

  it("derives the source id from the run and the first record", () => {
    const first = parseRunLogRecords(content, 0).records[0]!.raw;
    expect(computeStreamJsonSid("run-1", first)).toBe(computeStreamJsonSid("run-1", first));
    expect(computeStreamJsonSid("run-1", first)).not.toBe(computeStreamJsonSid("run-2", first));
    expect(computeStreamJsonSid("run-1", first)).not.toBe(computeStreamJsonSid("run-1", `${first} `));
    expect(computeStreamJsonSid("run-1", first)).toMatch(/^[A-Za-z0-9]{10}$/);
  });
});

describe("LineFramer", () => {
  it("joins lines across pushes and strips CR", () => {
    const framer = new LineFramer(100);
    expect(framer.push('{"a":')).toEqual([]);
    expect(framer.push('1}\r\n{"b"')).toEqual([{ kind: "line", text: '{"a":1}' }]);
    expect(framer.push(":2}\nx")).toEqual([{ kind: "line", text: '{"b":2}' }]);
    expect(framer.flush()).toEqual({ kind: "line", text: "x" });
    expect(framer.flush()).toBeNull();
  });

  it("drops a line longer than the cap and reports it when it ends", () => {
    const framer = new LineFramer(10);
    expect(framer.push("0123456789ab")).toEqual([]);
    expect(framer.pendingChars).toBe(0);
    expect(framer.push("cd\nok\n")).toEqual([
      { kind: "overflow", droppedChars: 14 },
      { kind: "line", text: "ok" },
    ]);
  });
});

describe("parseStdoutLine", () => {
  it("parses valid JSON without repair", () => {
    expect(parseStdoutLine('{"type":"x"}')).toMatchObject({ kind: "json", repaired: false });
    expect(parseStdoutLine("plain text")).toEqual({ kind: "text" });
    expect(parseStdoutLine("{broken")).toEqual({ kind: "invalid_json" });
  });

  it("restores a backslash eaten before an escaped quote", () => {
    // Original: {"cmd":"FOO_TOKEN=abc\" more","n":1} with the value redacted.
    const damaged = '{"cmd":"FOO_TOKEN=***REDACTED***" more","n":1}';
    const parsed = parseStdoutLine(damaged);
    expect(parsed).toMatchObject({ kind: "json", repaired: true });
    if (parsed.kind !== "json") throw new Error("expected json");
    expect(parsed.value).toEqual({ cmd: 'FOO_TOKEN=***REDACTED***" more', n: 1 });
  });

  it("restores an eaten backslash at the end of a string", () => {
    const damaged = '{"cmd":"echo FOO_TOKEN=***REDACTED***""}';
    const parsed = parseStdoutLine(damaged);
    expect(parsed).toMatchObject({ kind: "json", repaired: true, value: { cmd: 'echo FOO_TOKEN=***REDACTED***"' } });
  });

  it("escapes a dangling backslash before a marker but keeps escaped backslashes", () => {
    const parsed = parseStdoutLine('{"a":"x\\***REDACTED***","b":"y\\\\***REDACTED***"}');
    expect(parsed).toMatchObject({ kind: "json", repaired: true });
    if (parsed.kind !== "json") throw new Error("expected json");
    expect(parsed.value).toEqual({ a: "x\\***REDACTED***", b: "y\\***REDACTED***" });
  });

  it("leaves other damage invalid", () => {
    expect(parseStdoutLine('{"a":"***REDACTED***')).toEqual({ kind: "invalid_json" });
  });

  it("recognizes the run-log truncation marker", () => {
    expect(readTruncationMarker("[paperclip truncated run log chunk: omitted 1234 chars]")).toBe(1234);
    expect(readTruncationMarker("[paperclip] something")).toBeNull();
  });
});

describe("serializeWithinLimit", () => {
  it("returns small values unchanged", () => {
    expect(serializeWithinLimit({ a: "b" }, 100)).toEqual({ text: '{"a":"b"}', truncated: false });
  });

  it("cuts the middle of the longest leaves and flags the line", () => {
    const value = {
      type: "user",
      message: { content: [{ type: "tool_result", content: `HEAD${"x".repeat(200_000)}TAIL` }] },
      paperclip: { block: "b1" },
    };
    const result = serializeWithinLimit(value, 64 * 1024);
    expect(result).not.toBeNull();
    expect(utf8ByteLength(result!.text)).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(result!.text);
    const content = parsed.message.content[0].content as string;
    expect(content.startsWith("HEAD")).toBe(true);
    expect(content.endsWith("TAIL")).toBe(true);
    expect(content).toMatch(/\[paperclip: \d+ characters omitted\]/);
    expect(parsed.paperclip).toEqual({ block: "b1", truncated: true });
    expect(value.message.content[0]!.content.length).toBe(200_008);
  });

  it("gives up when no leaf is long enough to cut", () => {
    const value = { items: Array.from({ length: 2000 }, (_, index) => `v${index}`) };
    expect(serializeWithinLimit(value, 1000)).toBeNull();
  });
});

describe("cursors", () => {
  it("round-trips and orders positions", () => {
    const text = formatStreamJsonCursor({ tag: "claude_local@1", sid: "abc123XYZ0", offset: 18342, k: 1 });
    expect(text).toBe("claude_local@1/abc123XYZ0/18342.1");
    expect(parseStreamJsonCursor(text)).toEqual({ tag: "claude_local@1", sid: "abc123XYZ0", offset: 18342, k: 1 });
    expect(compareStreamJsonPositions({ offset: 1, k: 5 }, { offset: 2, k: 0 })).toBeLessThan(0);
    expect(compareStreamJsonPositions({ offset: 2, k: 1 }, { offset: 2, k: 0 })).toBeGreaterThan(0);
  });

  it.each(["", "a/b", "x@1/sid/1", "x@0/sid/1.0", "x@1/s-d/1.0", "x@1/sid/01.0", "x y@1/sid/1.0", "x@1/sid/1.0/extra"])(
    "rejects %j",
    (value) => {
      expect(parseStreamJsonCursor(value)).toBeNull();
    },
  );
});

describe("findSegmentBoundary", () => {
  it("prefers blank lines, then line breaks, then sentence ends, then whitespace", () => {
    expect(findSegmentBoundary("aaaa\n\nbbbb\ncc", 13, 2)).toBe(6);
    expect(findSegmentBoundary("aaaa bbbb\ncc", 12, 2)).toBe(10);
    expect(findSegmentBoundary("First one. Second one", 21, 2)).toBe(11);
    expect(findSegmentBoundary("aaaa bbbb", 9, 2)).toBe(5);
    expect(findSegmentBoundary("aaaaaaaa", 8, 2)).toBe(-1);
    // A boundary in the first half does not count.
    expect(findSegmentBoundary("a\n" + "b".repeat(20), 22, 11)).toBe(-1);
  });
});

describe("describeInvalidStreamJsonTranslator", () => {
  const valid = { contract: 1, id: "x_local", version: 1, create: () => ({ line() {} }) };
  it("accepts a valid factory", () => {
    expect(describeInvalidStreamJsonTranslator(valid)).toBeNull();
  });
  it.each([
    [null, "must be an object"],
    [{ ...valid, contract: 2 }, "unsupported contract"],
    [{ ...valid, id: "has/slash" }, "id must match"],
    [{ ...valid, version: 0 }, "version must be"],
    [{ ...valid, version: 1.5 }, "version must be"],
    [{ ...valid, create: "nope" }, "create must be"],
  ])("rejects %j", (value, message) => {
    expect(describeInvalidStreamJsonTranslator(value)).toContain(message);
  });
});
