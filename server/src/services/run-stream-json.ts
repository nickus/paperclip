// Claude stream-json view of run logs: shared pieces of the log API format
// (`GET /heartbeat-runs/:runId/log?format=claude-stream-json`) and of the
// live hub (run-stream-json-hub.ts).
//
// Both translate the persisted run-log file, record by record, with the pure
// translation core in `@paperclipai/adapter-utils/stream-json`. The file is
// the single source: the live path does not translate live event payloads.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { HeartbeatRunStreamJsonItem, HeartbeatRunStreamJsonPage } from "@paperclipai/shared";
import {
  compareStreamJsonPositions,
  computeStreamJsonSid,
  isStreamJsonTranslator,
  parseRunLogRecords,
  parseStreamJsonCursor,
  rawStreamJsonTranslator,
  STREAM_JSON_FORMAT,
  StreamJsonRunTranslation,
  streamJsonTranslatorTag,
  utf8ByteLength,
  type RunLogRecord,
  type StreamJsonItem,
  type StreamJsonRunOutcome,
  type StreamJsonTranslator,
} from "@paperclipai/adapter-utils/stream-json";
import { findActiveServerAdapter } from "../adapters/index.js";
import { badRequest, payloadTooLarge } from "../errors.js";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import type { RunLogHandle, RunLogStore } from "./run-log-store.js";

/** Bytes read from the store per request while translating. */
export const STREAM_JSON_READ_PAGE_BYTES = 1024 * 1024;
/** A single run-log record larger than this is treated as corrupt. */
export const STREAM_JSON_MAX_RECORD_BYTES = 16 * 1024 * 1024;
/** The log API refuses to translate logs larger than this. */
export const STREAM_JSON_SOURCE_LIMIT_BYTES = 64 * 1024 * 1024;
/** Default and maximum total `chunk` size of one log API page. */
export const STREAM_JSON_PAGE_LIMIT_BYTES = 1024 * 1024;
/** Concurrent log API translations per process. */
export const STREAM_JSON_MAX_CONCURRENT_REPLAYS = 4;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

export { isStreamJsonEnabled } from "./run-stream-json-flags.js";

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
}

export interface RunStreamJsonMeta {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  /** The agent's current adapter type; runs do not record their own. */
  adapterType: string | null;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  errorCode: string | null;
  usageJson: Record<string, unknown> | null;
  logStore: string | null;
  logRef: string | null;
}

export async function loadRunStreamJsonMeta(db: Db, runId: string): Promise<RunStreamJsonMeta | null> {
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      adapterType: agents.adapterType,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      usageJson: heartbeatRuns.usageJson,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
    })
    .from(heartbeatRuns)
    .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(eq(heartbeatRuns.id, runId));
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    issueId: typeof row.issueId === "string" && row.issueId.length > 0 ? row.issueId : null,
    adapterType: row.adapterType ?? null,
    usageJson: row.usageJson ?? null,
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The finish input for a terminal run, or null while the run is active. */
export function buildStreamJsonRunOutcome(
  meta: RunStreamJsonMeta,
  redactString: (value: string) => string,
): StreamJsonRunOutcome | null {
  if (!isTerminalRunStatus(meta.status)) return null;
  const usage = meta.usageJson;
  const model = readString(usage?.model);
  return {
    status: meta.status,
    startedAt: meta.startedAt ? meta.startedAt.toISOString() : null,
    finishedAt: meta.finishedAt ? meta.finishedAt.toISOString() : null,
    error: meta.error ? redactString(meta.error) : null,
    errorCode: meta.errorCode ?? null,
    usage: usage
      ? {
          inputTokens: readNumber(usage.inputTokens),
          cachedInputTokens: readNumber(usage.cachedInputTokens),
          outputTokens: readNumber(usage.outputTokens),
          costUsd: typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : null,
          model: model && model !== "unknown" ? model : null,
          sessionId: readString(usage.persistedSessionId),
        }
      : null,
  };
}

/**
 * The translator for an adapter type: the adapter's own when it declares a
 * valid one, otherwise the raw fallback.
 */
export function resolveStreamJsonTranslator(adapterType: string | null): StreamJsonTranslator {
  const candidate = adapterType ? findActiveServerAdapter(adapterType)?.streamJsonTranslator : undefined;
  return candidate && isStreamJsonTranslator(candidate) ? candidate : rawStreamJsonTranslator;
}

/**
 * Redaction for strings the host re-serializes (not passthrough lines):
 * the same text sanitizers the run log applies when it is written.
 */
export function createStreamJsonStringRedactor(options?: CurrentUserRedactionOptions) {
  return (value: string) => redactCurrentUserText(redactSensitiveText(value), options);
}

export function logTranslatorError(context: { runId: string; translator: string }) {
  return (error: unknown, phase: string) => {
    // Never log line contents: only where the failure happened.
    logger.warn(
      { runId: context.runId, translator: context.translator, phase, errorName: error instanceof Error ? error.name : typeof error },
      "stream-json translator threw; the line was emitted raw",
    );
  };
}

export class RunLogRecordTooLargeError extends Error {
  constructor(readonly offset: number) {
    super("run log record exceeds the translation limit");
  }
}

/**
 * Reads complete run-log records from the store, page by page. A trailing
 * record that is still being written is left for the next call.
 */
export class RunLogRecordReader {
  private pageBytes = STREAM_JSON_READ_PAGE_BYTES;
  /** Offset of the next unread complete record. */
  offset: number;
  /** Bytes read from the store so far. */
  bytesRead = 0;

  constructor(
    private readonly store: Pick<RunLogStore, "read">,
    private readonly handle: RunLogHandle | null,
    offset = 0,
  ) {
    this.offset = offset;
  }

  /** The next records; `eof` when no further complete record exists yet. */
  async next(): Promise<{ records: RunLogRecord[]; eof: boolean }> {
    if (!this.handle) return { records: [], eof: true };
    for (;;) {
      const result = await this.store.read(this.handle, { offset: this.offset, limitBytes: this.pageBytes });
      const content = result.content;
      if (content.length === 0) return { records: [], eof: true };
      this.bytesRead += utf8ByteLength(content);
      const page = parseRunLogRecords(content, this.offset);
      const reachedEnd = result.nextOffset === undefined;
      if (page.consumedBytes === 0) {
        // One record spans the whole page: either it is still being written
        // (at the end of the log) or it is larger than the page.
        if (reachedEnd) return { records: [], eof: true };
        if (this.pageBytes >= STREAM_JSON_MAX_RECORD_BYTES) throw new RunLogRecordTooLargeError(this.offset);
        this.pageBytes = Math.min(STREAM_JSON_MAX_RECORD_BYTES, this.pageBytes * 2);
        continue;
      }
      this.offset += page.consumedBytes;
      this.pageBytes = STREAM_JSON_READ_PAGE_BYTES;
      return { records: page.records, eof: reachedEnd && utf8ByteLength(content) === page.consumedBytes };
    }
  }

  /** The first record of the log, without moving the reader. */
  async first(): Promise<RunLogRecord | null> {
    if (!this.handle) return null;
    const probe = new RunLogRecordReader(this.store, this.handle, 0);
    for (;;) {
      const { records, eof } = await probe.next();
      if (records.length > 0) return records[0]!;
      if (eof) return null;
    }
  }
}

export function runLogHandle(meta: Pick<RunStreamJsonMeta, "logStore" | "logRef">): RunLogHandle | null {
  if (!meta.logStore || !meta.logRef) return null;
  return { store: meta.logStore as RunLogHandle["store"], logRef: meta.logRef };
}

// ---------------------------------------------------------------------------
// Log API paging
// ---------------------------------------------------------------------------

export interface RunStreamJsonPageQuery {
  after?: string | null;
  before?: string | null;
  tail?: boolean;
  limitBytes?: number;
}

export function readStreamJsonLimitBytes(value: unknown): number {
  const parsed = Number(value ?? STREAM_JSON_PAGE_LIMIT_BYTES);
  if (!Number.isFinite(parsed)) return STREAM_JSON_PAGE_LIMIT_BYTES;
  return Math.max(1, Math.min(STREAM_JSON_PAGE_LIMIT_BYTES, Math.trunc(parsed)));
}

let activeReplays = 0;
const replayWaiters: Array<() => void> = [];

async function withReplaySlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeReplays >= STREAM_JSON_MAX_CONCURRENT_REPLAYS) {
    await new Promise<void>((resolve) => replayWaiters.push(resolve));
  } else {
    activeReplays += 1;
  }
  try {
    return await work();
  } finally {
    const next = replayWaiters.shift();
    // Hand the slot straight to the next waiter; otherwise free it.
    if (next) next();
    else activeReplays -= 1;
  }
}

function toWireItem(item: StreamJsonItem): HeartbeatRunStreamJsonItem {
  return {
    cursor: item.cursor,
    prev: item.prev,
    offset: item.offset,
    k: item.k,
    lines: item.lines,
    seq: item.seq,
    ts: item.ts,
    stream: item.stream,
    chunk: item.chunk,
  };
}

/**
 * Translates a run's log from the start and returns one page of items.
 * `after` pages forward (items strictly after the cursor); `before` and
 * `tail` return the newest items before the cursor or the end. `nextCursor`
 * continues in the request's direction: for `after` it is the newest item's
 * cursor (the request cursor while caught up), for `before` and `tail` the
 * oldest item's cursor, or null once the page starts at the beginning of the
 * output. A cursor from another translation (translator version or source
 * id) sets `reset` and starts over: from the start for `after`, from the end
 * for `before`.
 */
export async function readRunStreamJsonPage(
  deps: {
    store: Pick<RunLogStore, "read">;
    redactString: (value: string) => string;
    sourceLimitBytes?: number;
  },
  meta: RunStreamJsonMeta,
  query: RunStreamJsonPageQuery,
): Promise<HeartbeatRunStreamJsonPage> {
  const after = query.after ?? null;
  const before = query.before ?? null;
  if ([after !== null, before !== null, query.tail === true].filter(Boolean).length > 1) {
    throw badRequest("Use only one of after, before and tail");
  }
  const afterCursor = after !== null ? parseStreamJsonCursor(after) : null;
  const beforeCursor = before !== null ? parseStreamJsonCursor(before) : null;
  if ((after !== null && !afterCursor) || (before !== null && !beforeCursor)) {
    throw badRequest("Invalid stream-json cursor");
  }
  const limitBytes = readStreamJsonLimitBytes(query.limitBytes);
  const sourceLimitBytes = deps.sourceLimitBytes ?? STREAM_JSON_SOURCE_LIMIT_BYTES;

  return withReplaySlot(async () => {
    const translator = resolveStreamJsonTranslator(meta.adapterType);
    const tag = streamJsonTranslatorTag(translator);
    const reader = new RunLogRecordReader(deps.store, runLogHandle(meta));
    const first = await reader.first();
    const sid = computeStreamJsonSid(meta.id, first?.raw ?? null);

    let mode: "after" | "before" | "tail" = beforeCursor ? "before" : query.tail ? "tail" : "after";
    let position: { offset: number; k: number } | null = afterCursor ?? beforeCursor;
    let reset = false;
    const cursor = afterCursor ?? beforeCursor;
    if (cursor && (cursor.tag !== tag || cursor.sid !== sid)) {
      reset = true;
      position = null;
      if (mode === "before") mode = "tail";
    }

    const translation = new StreamJsonRunTranslation({
      runId: meta.id,
      adapterType: meta.adapterType ?? "unknown",
      sid,
      translator,
      redactString: deps.redactString,
      onTranslatorError: logTranslatorError({ runId: meta.id, translator: tag }),
    });
    const outcome = buildStreamJsonRunOutcome(meta, deps.redactString);
    if (outcome) translation.setOutcome(outcome);

    const selected: StreamJsonItem[] = [];
    let selectedBytes = 0;
    let moreAfterSelection = false;
    // `before`/`tail`: items older than the window were dropped from it.
    let olderBeforeSelection = false;
    let done = false;

    const take = (items: StreamJsonItem[]) => {
      for (const item of items) {
        if (done) return;
        const bytes = utf8ByteLength(item.chunk);
        if (mode === "after") {
          if (position && compareStreamJsonPositions(item, position) <= 0) continue;
          if (selected.length > 0 && selectedBytes >= limitBytes) {
            moreAfterSelection = true;
            done = true;
            return;
          }
          selected.push(item);
          selectedBytes += bytes;
          continue;
        }
        if (mode === "before" && position && compareStreamJsonPositions(item, position) >= 0) {
          moreAfterSelection = true;
          done = true;
          return;
        }
        // Keep a window of the newest items within the byte limit.
        selected.push(item);
        selectedBytes += bytes;
        while (selected.length > 1 && selectedBytes > limitBytes) {
          selectedBytes -= utf8ByteLength(selected.shift()!.chunk);
          olderBeforeSelection = true;
        }
      }
    };

    let reachedEnd = false;
    while (!done) {
      const { records, eof } = await reader.next();
      if (reader.bytesRead > sourceLimitBytes) {
        throw payloadTooLarge("Run log is too large to translate; read it with the raw format", {
          code: "log_too_large_for_translation",
        });
      }
      for (const record of records) {
        take(translation.push(record));
        if (done) break;
      }
      if (eof && !done) {
        take(translation.end(reader.offset));
        reachedEnd = true;
        break;
      }
    }

    // Forward pages continue after their newest item (or keep the request
    // cursor while caught up); backward pages continue before their oldest
    // item, so `before=nextCursor` always moves further back.
    const nextCursor =
      mode === "after"
        ? (selected.at(-1)?.cursor ?? (reset ? null : after))
        : olderBeforeSelection
          ? selected[0]!.cursor
          : null;
    return {
      runId: meta.id,
      format: STREAM_JSON_FORMAT,
      translator: tag,
      sid,
      items: selected.map(toWireItem),
      nextCursor,
      complete: outcome !== null && translation.finished && reachedEnd && !moreAfterSelection,
      runStatus: meta.status,
      reset,
    };
  });
}
