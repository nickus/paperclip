import type { TranscriptEntry } from "../types.js";

/** Version of the translator contract below. Factories declare it as `contract`. */
export const STREAM_JSON_CONTRACT = 1 as const;

/** The output format name used by the log API and the live-events opt-in. */
export const STREAM_JSON_FORMAT = "claude-stream-json" as const;

/** Version of the client-facing wire format (items, cursors, events). */
export const STREAM_JSON_FORMAT_VERSION = 1 as const;

/**
 * Version of the host encoder (segmenting constants, id rules, size caps).
 * It is folded into every source id (`sid`), so a change here invalidates
 * client cursors the same way a rewritten log does.
 */
export const STREAM_JSON_ENCODER_VERSION = 1 as const;

export type StreamJsonNoticeLevel = "info" | "warn" | "error";

export type StreamJsonBlockKind = "text" | "thinking";

/** Token usage in Claude's terms. `input` excludes cache reads and cache writes. */
export interface StreamJsonUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A final result reported by the adapter itself. */
export interface StreamJsonResult {
  isError: boolean;
  /** Defaults to `success` or `error_during_execution` from `isError`. */
  subtype?: string;
  /** Final answer text. Defaults to the last assistant text block. */
  result?: string;
  sessionId?: string;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
  usage?: StreamJsonUsage;
  /** Model name used as the `modelUsage` key when usage is known. */
  model?: string;
  errors?: string[];
  stopReason?: string | null;
}

/**
 * What the host knows about a finished run, from the run's database row.
 * Strings are already redacted.
 */
export interface StreamJsonRunOutcome {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  errorCode: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    model: string | null;
    sessionId: string | null;
  } | null;
}

/** Where a stdout line came from. */
export interface StreamJsonLineMeta {
  /** Byte offset of the run-log record in which the line completed. */
  offset: number;
  /** The record's sequence number, when it has one. */
  seq: number | null;
  /** The record's timestamp (ISO 8601). */
  ts: string;
  /**
   * The parsed line when it is valid JSON, possibly after the host repaired
   * redaction damage (see `repaired`). Undefined for non-JSON lines.
   */
  json?: unknown;
  /** True when `line` is the host's repaired spelling of a damaged JSON line. */
  repaired: boolean;
}

/**
 * Operations a translator emits. The host turns them into Claude stream-json
 * lines and owns ids, message grouping, segmenting of long text, size caps
 * and redaction, so every output line is valid JSON with stable ids.
 *
 * Every operation except `delta` closes the open text or thinking block.
 */
export interface StreamJsonOps {
  /** Starts an adapter session: emits `system/init`. */
  init(p: { sessionId: string; model?: string; extra?: Record<string, unknown> }): void;
  /**
   * Opens or switches the current assistant message. All assistant lines
   * until the next switch share one `message.id`, derived from `key`.
   * Without a call the host starts a new message after each tool result,
   * user message, init and result.
   */
  message(key: string, p?: { model?: string }): void;
  /**
   * Streamed text or thinking. Consecutive deltas with the same `blockKey`
   * form one block, emitted as one or more segment lines.
   */
  delta(p: { blockKey: string; kind: StreamJsonBlockKind; text: string }): void;
  /** A complete text or thinking block. `reconciled` marks text repeated from a final response. */
  block(p: { kind: StreamJsonBlockKind; text: string; reconciled?: boolean }): void;
  /** Closes the open block, if any. */
  closeBlocks(): void;
  /**
   * Emits an assistant `tool_use` block and returns its id. A non-object
   * `input` is wrapped as `{ arguments: input }`.
   */
  toolUse(p: { sourceId?: string; name: string; input: unknown; synthesized?: boolean }): string;
  /**
   * Emits a user `tool_result`. The id is looked up from `sourceId`; when no
   * `tool_use` was emitted for it, the host synthesizes one first.
   */
  toolResult(p: { sourceId?: string; content: string; isError: boolean; structured?: unknown }): void;
  /** True when a `tool_use` was emitted for `sourceId` (and is still in the id table). */
  hasToolUse(sourceId: string): boolean;
  /** Usage of the current assistant message. */
  usage(p: StreamJsonUsage): void;
  /** A model API error, in Claude Code's own shape. */
  apiError(p: { message: string; code?: string }): void;
  /** A user text message. */
  user(p: { text: string }): void;
  /**
   * A `system/paperclip_notice` line. With `recordError`, the text is also
   * added to the `errors` of a result the host synthesizes.
   */
  notice(level: StreamJsonNoticeLevel, text: string, p?: { recordError?: boolean }): void;
  /** A `system/paperclip_raw` line carrying a line no translator understood. */
  raw(line: string): void;
  /**
   * Emits a line that already is Claude stream-json, byte for byte. The line
   * must be a JSON object; otherwise it is emitted as `raw`. Lines over the
   * size cap are shrunk and re-serialized.
   */
  passthrough(line: string): void;
  /** Generic bridge from a UI transcript entry. */
  entry(e: TranscriptEntry): void;
  /** A final result reported by the adapter. The host then synthesizes none. */
  result(p: StreamJsonResult): void;
}

export interface StreamJsonTranslatorContext {
  runId: string;
  adapterType: string;
}

/**
 * Per-run translator state. `line()` must be a pure function of the lines it
 * has received so far: no clock, no randomness, no I/O. Live output and
 * backfill replay the same lines and must produce the same operations.
 */
export interface StreamJsonLineTranslator {
  /** One complete stdout line (without its line terminator). */
  line(line: string, meta: StreamJsonLineMeta, ops: StreamJsonOps): void;
  /** Called once when the run ends, before the host closes blocks and synthesizes a result. */
  finish?(outcome: StreamJsonRunOutcome, ops: StreamJsonOps): void;
}

/**
 * A stream-json translator for one adapter type. Adapters expose it as
 * `ServerAdapterModule.streamJsonTranslator`.
 */
export interface StreamJsonTranslator {
  contract: typeof STREAM_JSON_CONTRACT;
  /** Stable identifier, `[A-Za-z0-9_.-]{1,64}`, usually the adapter type. */
  id: string;
  /** Positive integer. Bump it whenever output for the same input changes. */
  version: number;
  create(ctx: StreamJsonTranslatorContext): StreamJsonLineTranslator;
}

/** Alias kept for readers of the design notes. */
export type StreamJsonTranslatorFactory = StreamJsonTranslator;

/** One persisted run-log record (one NDJSON line of the run-log file). */
export interface RunLogRecord {
  /** Byte offset of the record's first byte in the run-log file. */
  offset: number;
  /** Byte length of the record including its trailing newline. */
  byteLength: number;
  /** The NDJSON line as stored, without its newline. */
  raw: string;
  seq: number | null;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

/**
 * One translated unit. A source record yields at most one item; the run's
 * finish yields one more. `cursor` names the item's first line, `(offset, k)`,
 * and the item covers lines `k .. k + lines - 1` at that offset.
 */
export interface StreamJsonItem {
  cursor: string;
  /** Cursor of the previous item of this translation, or null for the first. */
  prev: string | null;
  offset: number;
  k: number;
  lines: number;
  seq: number | null;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  /** Complete lines, each terminated by `\n`. stderr and system items carry the raw text. */
  chunk: string;
}

/** Host limits. They are constants of the encoder version. */
export interface StreamJsonLimits {
  /** Largest emitted line, in UTF-8 bytes. */
  maxLineBytes: number;
  /** Largest pending (not yet terminated) stdout line, in characters. */
  maxPendingLineChars: number;
  /** Longest text kept in a `paperclip_raw` line, in characters. */
  maxRawTextChars: number;
  /** A text segment is cut once its oldest character is this old (record time). */
  segmentMs: number;
  /** A text segment is cut at a boundary once the buffer is this long. */
  segmentSoftChars: number;
  /** No segment is longer than this. */
  segmentHardChars: number;
  /** Size of the source tool-call id table. */
  maxToolIds: number;
  /** Longest final text kept for a synthesized result. */
  maxResultTextChars: number;
}

export const DEFAULT_STREAM_JSON_LIMITS: Readonly<StreamJsonLimits> = Object.freeze({
  maxLineBytes: 64 * 1024,
  maxPendingLineChars: 1024 * 1024,
  maxRawTextChars: 8 * 1024,
  segmentMs: 1500,
  segmentSoftChars: 2000,
  segmentHardChars: 8000,
  maxToolIds: 4096,
  maxResultTextChars: 64 * 1024,
});
