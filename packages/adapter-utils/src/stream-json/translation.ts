import { formatStreamJsonCursor, streamJsonTranslatorTag } from "./cursor.js";
import { StreamJsonEncoder, type StreamJsonEncoderSink } from "./encoder.js";
import { LineFramer, type FramedLine } from "./framer.js";
import { hashUuid } from "./hash.js";
import { isHostNoticeLine, parseStdoutLine, readTruncationMarker } from "./repair.js";
import { serializeWithinLimit } from "./shrink.js";
import {
  DEFAULT_STREAM_JSON_LIMITS,
  type RunLogRecord,
  type StreamJsonItem,
  type StreamJsonLimits,
  type StreamJsonLineTranslator,
  type StreamJsonRunOutcome,
  type StreamJsonTranslator,
} from "./types.js";
import { utf8ByteLength } from "./utf8.js";

export interface StreamJsonTranslationOptions {
  runId: string;
  adapterType: string;
  /** Source identity from `computeStreamJsonSid`. */
  sid: string;
  translator: StreamJsonTranslator;
  /**
   * Applied to every string leaf of lines the host constructs (not to
   * passthrough lines). Must be deterministic for a given input.
   */
  redactString?: (value: string) => string;
  limits?: Partial<StreamJsonLimits>;
  /** Reports a translator exception. The line is then emitted as `paperclip_raw`. */
  onTranslatorError?: (error: unknown, phase: "create" | "line" | "finish") => void;
}

// Keys whose values are ids or fixed vocabulary, never adapter text.
const STRUCTURAL_KEYS = new Set([
  "type",
  "subtype",
  "id",
  "uuid",
  "tool_use_id",
  "session_id",
  "role",
  "timestamp",
  "level",
  "stop_reason",
  "block",
  "adapterType",
  "runStatus",
  "errorCode",
]);

function redactLeaves(value: unknown, redact: (value: string) => string, key: string | null): unknown {
  if (typeof value === "string") return key !== null && STRUCTURAL_KEYS.has(key) ? value : redact(value);
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, redact, null));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = redactLeaves(child, redact, childKey);
    return out;
  }
  return value;
}

function parseTimeMs(ts: string): number {
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Translates one run's log, record by record, into stream-json items.
 *
 * The output is a pure function of the records pushed so far (and of the
 * outcome, once set): pushing the records of a file in order always yields
 * the same items with the same cursors, whether they arrive in one call or
 * over many. The live hub and the log API both rely on this.
 *
 * Finish placement: once the outcome is known, the finish lines (closing
 * open blocks, the synthesized result) are emitted right before the first
 * record whose timestamp is after `finishedAt`, or at the end of the log.
 */
export class StreamJsonRunTranslation {
  readonly tag: string;
  readonly sid: string;
  private readonly runId: string;
  private readonly limits: StreamJsonLimits;
  private readonly redact: ((value: string) => string) | null;
  private readonly encoder: StreamJsonEncoder;
  private readonly framer: LineFramer;
  private readonly lineTranslator: StreamJsonLineTranslator | null;
  private readonly onTranslatorError: StreamJsonTranslationOptions["onTranslatorError"];

  // Position of the next emitted line: (posOffset, posK).
  private posOffset = -1;
  private posK = 0;
  private batch: string[] = [];
  private batchStart: { offset: number; k: number } | null = null;
  private tsIso = "";
  private tsMs = 0;
  private lastCursorValue: string | null = null;
  private afterTruncationMarker = false;

  private outcome: StreamJsonRunOutcome | null = null;
  private finishedAtMs = Number.POSITIVE_INFINITY;
  private finishPlacement: "none" | "before_record" | "end" = "none";
  private awaitingRecordAfterEndFinish = false;
  private maxRecordMs = Number.NEGATIVE_INFINITY;
  private conflictValue = false;

  constructor(options: StreamJsonTranslationOptions) {
    this.runId = options.runId;
    this.sid = options.sid;
    this.tag = streamJsonTranslatorTag(options.translator);
    this.limits = { ...DEFAULT_STREAM_JSON_LIMITS, ...(options.limits ?? {}) };
    this.redact = options.redactString ?? null;
    this.onTranslatorError = options.onTranslatorError;
    this.framer = new LineFramer(this.limits.maxPendingLineChars);
    this.encoder = new StreamJsonEncoder(options.runId, options.adapterType, this.limits, this.createSink());
    let lineTranslator: StreamJsonLineTranslator | null = null;
    try {
      lineTranslator = options.translator.create({ runId: options.runId, adapterType: options.adapterType });
    } catch (error) {
      this.onTranslatorError?.(error, "create");
    }
    this.lineTranslator = lineTranslator && typeof lineTranslator.line === "function" ? lineTranslator : null;
  }

  /** Cursor of the last item produced, or null. The next item's `prev`. */
  get lastCursor(): string | null {
    return this.lastCursorValue;
  }

  /** True once the finish lines were emitted. */
  get finished(): boolean {
    return this.finishPlacement !== "none";
  }

  /** True when the outcome is known. */
  get hasOutcome(): boolean {
    return this.outcome !== null;
  }

  /**
   * True when records arrived in an order that contradicts the finish
   * placement already emitted (live translation only; a replay of the whole
   * file never conflicts). The caller must re-translate from the start.
   */
  get conflict(): boolean {
    return this.conflictValue;
  }

  /** Rough heap footprint, for memory budgets. */
  approxBytes(): number {
    return this.framer.pendingChars * 2 + this.encoder.approxBytes() + 1024;
  }

  /**
   * Records the run outcome. Returns `conflict: true` when a record after
   * `finishedAt` was already translated, i.e. the finish should have been
   * placed earlier than it now can be.
   */
  setOutcome(outcome: StreamJsonRunOutcome): { conflict: boolean } {
    if (this.outcome) return { conflict: this.conflictValue };
    this.outcome = outcome;
    const finishedAt = outcome.finishedAt ? parseTimeMs(outcome.finishedAt) : Number.NaN;
    this.finishedAtMs = Number.isFinite(finishedAt) ? finishedAt : Number.POSITIVE_INFINITY;
    if (this.maxRecordMs > this.finishedAtMs) this.conflictValue = true;
    return { conflict: this.conflictValue };
  }

  /** Translates the next record of the log (records must arrive in file order). */
  push(record: RunLogRecord): StreamJsonItem[] {
    const items: StreamJsonItem[] = [];
    const recordMs = parseTimeMs(record.ts);
    const late = Number.isFinite(recordMs) && recordMs > this.finishedAtMs;
    if (this.outcome && this.finishPlacement === "none" && late) {
      const finishItem = this.runFinish(record.offset);
      if (finishItem) items.push(finishItem);
      this.finishPlacement = "before_record";
    } else if (this.awaitingRecordAfterEndFinish) {
      this.awaitingRecordAfterEndFinish = false;
      // The finish went at the end of the log; a following record that is
      // not after finishedAt belongs before it.
      if (!late) this.conflictValue = true;
    }
    if (Number.isFinite(recordMs)) {
      this.maxRecordMs = Math.max(this.maxRecordMs, recordMs);
      this.tsMs = recordMs;
    }
    this.tsIso = record.ts;
    this.beginBatch(record.offset);
    if (record.stream === "stdout") {
      this.translateStdout(record, this.framer.push(record.chunk));
      this.encoder.checkSegments();
    } else if (record.chunk.length > 0) {
      // stderr and system text is passed through unchanged, as one line slot.
      this.batch.push(record.chunk);
      this.posK += 1;
    }
    const item = this.endBatch(record.stream, record.seq, record.ts, record.stream !== "stdout");
    if (item) items.push(item);
    return items;
  }

  /**
   * Called when the reader reached the end of the log (`eofOffset` is the
   * offset after the last complete record). Emits the finish lines when the
   * outcome is known and they were not emitted yet.
   */
  end(eofOffset: number): StreamJsonItem[] {
    if (!this.outcome || this.finishPlacement !== "none") return [];
    const item = this.runFinish(eofOffset);
    this.finishPlacement = "end";
    this.awaitingRecordAfterEndFinish = true;
    return item ? [item] : [];
  }

  // ---------------------------------------------------------------------------

  private runFinish(offset: number): StreamJsonItem | null {
    const outcome = this.outcome!;
    this.tsIso = outcome.finishedAt ?? this.tsIso;
    const finishedMs = outcome.finishedAt ? parseTimeMs(outcome.finishedAt) : Number.NaN;
    if (Number.isFinite(finishedMs)) this.tsMs = finishedMs;
    this.beginBatch(offset);
    const tail = this.framer.flush();
    if (tail) this.translateStdout({ offset, seq: null, ts: this.tsIso }, [tail]);
    if (this.lineTranslator?.finish) {
      try {
        this.lineTranslator.finish(outcome, this.encoder);
      } catch (error) {
        this.onTranslatorError?.(error, "finish");
      }
    }
    this.encoder.finishRun(outcome);
    return this.endBatch("stdout", null, this.tsIso, false);
  }

  private translateStdout(record: { offset: number; seq: number | null; ts: string }, lines: FramedLine[]) {
    for (let index = 0; index < lines.length; index += 1) {
      const framed = lines[index]!;
      if (framed.kind === "overflow") {
        this.afterTruncationMarker = false;
        this.encoder.notice(
          "warn",
          `an adapter output line of ${framed.droppedChars} characters exceeded the ${this.limits.maxPendingLineChars}-character limit and was dropped`,
        );
        continue;
      }
      const text = framed.text;
      if (text.trim().length === 0) continue;
      const omitted = readTruncationMarker(text);
      if (omitted !== null) {
        this.afterTruncationMarker = true;
        this.encoder.notice("warn", `adapter output was truncated: ${omitted} characters omitted`);
        continue;
      }
      if (isHostNoticeLine(text)) {
        this.afterTruncationMarker = false;
        this.encoder.notice("info", text);
        continue;
      }
      const parsed = parseStdoutLine(text);
      if (parsed.kind !== "json") {
        // The pieces of a line cut by the truncation marker are fragments.
        const next = lines[index + 1];
        const nextIsMarker = next?.kind === "line" && readTruncationMarker(next.text) !== null;
        if (this.afterTruncationMarker || nextIsMarker) {
          this.afterTruncationMarker = false;
          continue;
        }
      }
      this.afterTruncationMarker = false;
      const lineText = parsed.kind === "json" ? parsed.text : text;
      if (!this.lineTranslator) {
        this.encoder.raw(text);
        continue;
      }
      this.encoder.setParsedLine(parsed.kind === "json" ? lineText : null, parsed.kind === "json" ? parsed.value : undefined);
      try {
        this.lineTranslator.line(
          lineText,
          {
            offset: record.offset,
            seq: record.seq,
            ts: record.ts,
            json: parsed.kind === "json" ? parsed.value : undefined,
            repaired: parsed.kind === "json" && parsed.repaired,
          },
          this.encoder,
        );
      } catch (error) {
        this.onTranslatorError?.(error, "line");
        this.encoder.raw(text);
      } finally {
        this.encoder.setParsedLine(null);
      }
    }
  }

  private beginBatch(offset: number) {
    if (offset !== this.posOffset) {
      this.posOffset = offset;
      this.posK = 0;
    }
    this.batch = [];
    this.batchStart = { offset, k: this.posK };
  }

  private endBatch(
    stream: StreamJsonItem["stream"],
    seq: number | null,
    ts: string,
    rawText: boolean,
  ): StreamJsonItem | null {
    const start = this.batchStart;
    const lines = this.batch;
    this.batch = [];
    this.batchStart = null;
    if (!start || lines.length === 0) return null;
    const cursor = formatStreamJsonCursor({ tag: this.tag, sid: this.sid, offset: start.offset, k: start.k });
    const item: StreamJsonItem = {
      cursor,
      prev: this.lastCursorValue,
      offset: start.offset,
      k: start.k,
      lines: lines.length,
      seq,
      ts,
      stream,
      chunk: rawText ? lines.join("") : `${lines.join("\n")}\n`,
    };
    this.lastCursorValue = cursor;
    return item;
  }

  private nextUuid(): string {
    return hashUuid([this.runId, this.sid, this.posOffset, this.posK]);
  }

  private createSink(): StreamJsonEncoderSink {
    return {
      emitObject: (line) => {
        line.uuid = this.nextUuid();
        const redacted = this.redact ? (redactLeaves(line, this.redact, null) as Record<string, unknown>) : line;
        const serialized = serializeWithinLimit(redacted, this.limits.maxLineBytes);
        this.batch.push(serialized ? serialized.text : this.oversizeNotice(line));
        this.posK += 1;
      },
      emitPassthrough: (text, parsed) => {
        if (utf8ByteLength(text) <= this.limits.maxLineBytes) {
          this.batch.push(text);
        } else {
          const serialized = serializeWithinLimit(parsed, this.limits.maxLineBytes);
          this.batch.push(serialized ? serialized.text : this.oversizeNotice(parsed));
        }
        this.posK += 1;
      },
      currentTs: () => this.tsIso,
      currentTimeMs: () => this.tsMs,
    };
  }

  private oversizeNotice(line: Record<string, unknown>): string {
    return JSON.stringify({
      type: "system",
      subtype: "paperclip_notice",
      level: "warn",
      text: `a ${typeof line.type === "string" ? line.type : "output"} line exceeded the ${this.limits.maxLineBytes}-byte limit and was dropped`,
      session_id: typeof line.session_id === "string" ? line.session_id : `paperclip-run-${this.runId}`,
      uuid: this.nextUuid(),
    });
  }
}
