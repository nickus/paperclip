import { hashId } from "./hash.js";
import { STREAM_JSON_ENCODER_VERSION, type RunLogRecord } from "./types.js";
import { utf8ByteLength } from "./utf8.js";

export interface RunLogRecordPage {
  /** Complete, well-formed records in file order. */
  records: RunLogRecord[];
  /**
   * Bytes consumed from the start of `content`: every complete line, including
   * malformed ones, which are skipped. A trailing line without a newline is
   * not consumed; the caller reads it again once it is complete.
   */
  consumedBytes: number;
  /** Number of complete lines that were not valid run-log records. */
  skipped: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeStream(value: unknown): RunLogRecord["stream"] {
  return value === "stderr" || value === "system" ? value : "stdout";
}

/**
 * Parses the complete NDJSON records in `content`, which starts at byte
 * `baseOffset` of a run-log file.
 *
 * `content` may end in the middle of a record, and even in the middle of a
 * UTF-8 sequence (decoded as a replacement character): newlines are single
 * bytes that never occur inside a multi-byte sequence, so everything up to
 * the last newline is decoded exactly and its byte length is exact.
 */
export function parseRunLogRecords(content: string, baseOffset: number): RunLogRecordPage {
  const records: RunLogRecord[] = [];
  let skipped = 0;
  let start = 0;
  let offset = baseOffset;
  for (;;) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) break;
    const raw = content.slice(start, newline);
    const byteLength = utf8ByteLength(raw) + 1;
    start = newline + 1;
    const recordOffset = offset;
    offset += byteLength;
    if (raw.trim().length === 0) {
      skipped += 1;
      continue;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.chunk !== "string") {
      skipped += 1;
      continue;
    }
    records.push({
      offset: recordOffset,
      byteLength,
      raw,
      seq: typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? parsed.seq : null,
      ts: typeof parsed.ts === "string" ? parsed.ts : "",
      stream: normalizeStream(parsed.stream),
      chunk: parsed.chunk,
    });
  }
  return { records, consumedBytes: offset - baseOffset, skipped };
}

/**
 * Source identity of a run log: a digest of the run id, the encoder version
 * and the log's first record. A rewritten log or a new encoder yields a new
 * `sid`, which invalidates cursors issued for the old one.
 */
export function computeStreamJsonSid(runId: string, firstRecordRaw: string | null): string {
  return hashId([`enc${STREAM_JSON_ENCODER_VERSION}`, runId, firstRecordRaw ?? ""], 10);
}
