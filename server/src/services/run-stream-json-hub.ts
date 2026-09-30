// Live Claude stream-json output for sockets that opt in
// (`/api/companies/:companyId/events/ws?format=claude-stream-json`).
//
// One translation per run is shared by every socket of the company. The hub
// does not translate live event payloads (they are cut to their last bytes
// and not redacted with the run's registry). On each `heartbeat.run.log`
// event it reads the new complete records from the persisted run-log file,
// the same bytes the log API replays, so live items and a later page of the
// log API are identical, cursors included.
//
// Equivalence holds on the server process that executes the run (it writes
// the local file); another process serves the log API from the object-store
// mirror, which may lag behind while the run is active.

import type {
  HeartbeatRunStreamJsonItem,
  HeartbeatRunStreamJsonPayload,
  HeartbeatRunStreamJsonResetReason,
  LiveEvent,
} from "@paperclipai/shared";
import {
  computeStreamJsonSid,
  STREAM_JSON_FORMAT,
  StreamJsonRunTranslation,
  streamJsonTranslatorTag,
  utf8ByteLength,
  type StreamJsonItem,
  type StreamJsonTranslator,
} from "@paperclipai/adapter-utils/stream-json";
import { logger } from "../middleware/logger.js";
import type { RunLogHandle, RunLogStore } from "./run-log-store.js";
import { redactRegisteredSecretValues } from "./run-secret-redaction.js";
import {
  buildStreamJsonRunOutcome,
  isTerminalRunStatus,
  logTranslatorError,
  resolveStreamJsonTranslator,
  RunLogRecordReader,
  runLogHandle,
  STREAM_JSON_SOURCE_LIMIT_BYTES,
  type RunStreamJsonMeta,
} from "./run-stream-json.js";

export interface RunStreamJsonHubOptions {
  store: Pick<RunLogStore, "read">;
  loadRunMeta(runId: string): Promise<RunStreamJsonMeta | null>;
  /** Values of the run's secret registry; published items are redacted with them. */
  registeredSecretValues(companyId: string, runId: string): Promise<string[]>;
  publish(companyId: string, payload: HeartbeatRunStreamJsonPayload): void;
  /** Process-wide company event feed (`subscribeAllCompanyLiveEvents`). */
  subscribe(listener: (event: LiveEvent) => void): () => void;
  resolveTranslator?(adapterType: string | null): StreamJsonTranslator;
  /** Redaction for re-serialized strings; refreshed at most every 30 s. */
  getStringRedactor?(): Promise<(value: string) => string>;
  now?(): number;
  /** Most runs with translation state (default 256). */
  maxRuns?: number;
  /** Most accounted translation memory, in bytes (default 64 MiB). */
  maxBytes?: number;
  /** How long state lingers after a run ends or its company's last socket leaves (default 120 s). */
  lingerMs?: number;
  sweepIntervalMs?: number;
  /** Largest total chunk size of one published event (default 256 KiB). */
  maxEventBytes?: number;
  /** Logs larger than this are not translated live (default 64 MiB, like the log API). */
  sourceLimitBytes?: number;
}

export interface RunStreamJsonHub {
  /** Called when an opted-in socket connects; the returned function releases it. */
  retainCompany(companyId: string): () => void;
  /** Resolves once no translation work is pending (for tests and shutdown). */
  whenIdle(): Promise<void>;
  dispose(): void;
  /** Runs with translation state. */
  readonly size: number;
}

interface RunState {
  meta: RunStreamJsonMeta;
  handle: RunLogHandle | null;
  tag: string;
  translation: StreamJsonRunTranslation;
  reader: RunLogRecordReader;
  firstRecordRaw: string | null;
  // Items of records with a lower sequence were history when the hub started
  // following the run; they are translated but not published.
  publishFromSeq: number;
  published: boolean;
  finishedAtMs: number | null;
  broken: boolean;
}

interface RunEntry {
  runId: string;
  companyId: string;
  minSeq: number | null;
  terminalHint: boolean;
  draining: Promise<void> | null;
  again: boolean;
  state: RunState | null;
  lastActivityMs: number;
}

const REDACTOR_TTL_MS = 30_000;

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

export function createRunStreamJsonHub(options: RunStreamJsonHubOptions): RunStreamJsonHub {
  const now = options.now ?? (() => Date.now());
  const resolveTranslator = options.resolveTranslator ?? resolveStreamJsonTranslator;
  const maxRuns = options.maxRuns ?? 256;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const lingerMs = options.lingerMs ?? 120_000;
  const maxEventBytes = options.maxEventBytes ?? 256 * 1024;
  const sourceLimitBytes = options.sourceLimitBytes ?? STREAM_JSON_SOURCE_LIMIT_BYTES;

  const runs = new Map<string, RunEntry>();
  const retainCounts = new Map<string, number>();
  const releasedAt = new Map<string, number>();
  let disposed = false;
  let redactor: (value: string) => string = (value) => value;
  let redactorLoadedAt = Number.NEGATIVE_INFINITY;

  const isRetained = (companyId: string) => (retainCounts.get(companyId) ?? 0) > 0;

  async function refreshRedactor() {
    if (!options.getStringRedactor || now() - redactorLoadedAt < REDACTOR_TTL_MS) return;
    redactorLoadedAt = now();
    try {
      redactor = await options.getStringRedactor();
    } catch (err) {
      logger.warn({ err }, "stream-json hub could not load string redaction settings");
    }
  }

  async function createState(entry: RunEntry, meta: RunStreamJsonMeta, publishFromSeq: number): Promise<RunState> {
    const translator = resolveTranslator(meta.adapterType);
    const tag = streamJsonTranslatorTag(translator);
    const handle = runLogHandle(meta);
    const reader = new RunLogRecordReader(options.store, handle);
    const first = await reader.first();
    const translation = new StreamJsonRunTranslation({
      runId: meta.id,
      adapterType: meta.adapterType ?? "unknown",
      sid: computeStreamJsonSid(meta.id, first?.raw ?? null),
      translator,
      redactString: (value) => redactor(value),
      onTranslatorError: logTranslatorError({ runId: meta.id, translator: tag }),
    });
    return {
      meta,
      handle,
      tag,
      translation,
      reader,
      firstRecordRaw: first?.raw ?? null,
      publishFromSeq,
      published: false,
      finishedAtMs: null,
      broken: false,
    };
  }

  async function sourceChanged(state: RunState): Promise<boolean> {
    if (!state.handle) return false;
    if (state.firstRecordRaw === null) {
      // The log was empty when translation started; a first record changes the sid.
      return (await new RunLogRecordReader(options.store, state.handle).first()) !== null;
    }
    const expected = `${state.firstRecordRaw}\n`;
    const result = await options.store.read(state.handle, { offset: 0, limitBytes: utf8ByteLength(expected) });
    return result.content !== expected;
  }

  function shouldPublish(state: RunState, item: StreamJsonItem): boolean {
    if (state.publishFromSeq === Number.NEGATIVE_INFINITY || item.seq === null) return true;
    if (item.seq >= state.publishFromSeq) {
      state.publishFromSeq = Number.NEGATIVE_INFINITY;
      return true;
    }
    return false;
  }

  async function publishItems(entry: RunEntry, state: RunState, items: StreamJsonItem[]) {
    if (items.length === 0 || !isRetained(entry.companyId) || disposed) return;
    let values: string[];
    try {
      values = await options.registeredSecretValues(entry.companyId, entry.runId);
    } catch (err) {
      // Fail closed like the raw live path; clients see the gap and fetch.
      logger.warn({ err, runId: entry.runId }, "withholding translated run output: registered secret values could not be resolved");
      return;
    }
    let batch: HeartbeatRunStreamJsonItem[] = [];
    let batchBytes = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const payload: HeartbeatRunStreamJsonPayload = {
        kind: "items",
        runId: entry.runId,
        agentId: state.meta.agentId,
        issueId: state.meta.issueId,
        format: STREAM_JSON_FORMAT,
        translator: state.tag,
        sid: state.translation.sid,
        items: batch,
      };
      options.publish(entry.companyId, redactRegisteredSecretValues(payload, values));
      batch = [];
      batchBytes = 0;
    };
    for (const item of items) {
      const bytes = utf8ByteLength(item.chunk);
      if (batch.length > 0 && batchBytes + bytes > maxEventBytes) flush();
      batch.push(toWireItem(item));
      batchBytes += bytes;
    }
    flush();
    state.published = true;
  }

  function publishReset(entry: RunEntry, reason: HeartbeatRunStreamJsonResetReason) {
    if (!isRetained(entry.companyId) || disposed) return;
    options.publish(entry.companyId, { kind: "reset", runId: entry.runId, reason });
  }

  /**
   * Starts the run's translation over, silently up to the current end of the
   * log, and tells clients to refetch when they may hold stale items.
   */
  async function rebuild(entry: RunEntry, reason: HeartbeatRunStreamJsonResetReason) {
    const previous = entry.state;
    const meta = (await options.loadRunMeta(entry.runId)) ?? previous?.meta;
    if (!meta) {
      runs.delete(entry.runId);
      return;
    }
    const state = await createState(entry, meta, Number.POSITIVE_INFINITY);
    const outcome = buildStreamJsonRunOutcome(meta, redactor);
    if (outcome) state.translation.setOutcome(outcome);
    for (;;) {
      const { records, eof } = await state.reader.next();
      for (const record of records) state.translation.push(record);
      if (eof) break;
    }
    if (outcome) {
      state.translation.end(state.reader.offset);
      state.finishedAtMs = now();
    }
    state.publishFromSeq = Number.NEGATIVE_INFINITY;
    state.published = previous?.published ?? false;
    entry.state = state;
    logger.debug({ runId: entry.runId, translator: state.tag, reason }, "stream-json hub restarted a run translation");
    if (previous?.published) publishReset(entry, reason);
  }

  async function drainOnce(entry: RunEntry) {
    let state = entry.state;
    if (!state) {
      const meta = await options.loadRunMeta(entry.runId);
      if (!meta || meta.companyId !== entry.companyId) {
        runs.delete(entry.runId);
        return;
      }
      state = await createState(entry, meta, entry.minSeq ?? Number.POSITIVE_INFINITY);
      entry.state = state;
      // The terminal status may have been published before the hub followed the run.
      if (isTerminalRunStatus(meta.status)) entry.terminalHint = true;
      enforceBudget();
    }
    if (state.broken) return;

    if (streamJsonTranslatorTag(resolveTranslator(state.meta.adapterType)) !== state.tag) {
      await rebuild(entry, "translator_changed");
      return;
    }
    if (await sourceChanged(state)) {
      await rebuild(entry, "source_rewritten");
      return;
    }
    if (entry.terminalHint && !state.translation.hasOutcome) {
      const meta = await options.loadRunMeta(entry.runId);
      const outcome = meta ? buildStreamJsonRunOutcome(meta, redactor) : null;
      if (meta && outcome) {
        state.meta = { ...meta, adapterType: state.meta.adapterType };
        if (state.translation.setOutcome(outcome).conflict) {
          await rebuild(entry, "reordered");
          return;
        }
      }
    }

    const items: StreamJsonItem[] = [];
    for (;;) {
      const { records, eof } = await state.reader.next();
      for (const record of records) {
        const produced = state.translation.push(record);
        if (state.translation.conflict) {
          await rebuild(entry, "reordered");
          return;
        }
        for (const item of produced) if (shouldPublish(state, item)) items.push(item);
      }
      if (state.reader.offset > sourceLimitBytes) {
        state.broken = true;
        logger.warn({ runId: entry.runId, translator: state.tag }, "run log too large to translate live; stream-json output stops");
        await publishItems(entry, state, items);
        return;
      }
      if (eof) break;
    }
    if (state.translation.hasOutcome && !state.translation.finished) {
      items.push(...state.translation.end(state.reader.offset));
      state.finishedAtMs = now();
    }
    await publishItems(entry, state, items);
  }

  async function runDrain(entry: RunEntry) {
    do {
      entry.again = false;
      await refreshRedactor();
      try {
        await drainOnce(entry);
      } catch (err) {
        // Start over on the next event; a published client sees the gap.
        logger.warn({ err, runId: entry.runId }, "stream-json hub failed to translate run output");
        entry.state = null;
        entry.minSeq = null;
      }
    } while (entry.again && !disposed && runs.get(entry.runId) === entry);
  }

  function schedule(companyId: string, runId: string, hint: { seq?: number; terminal?: boolean }) {
    if (disposed) return;
    let entry = runs.get(runId);
    if (!entry) {
      // Only live output starts tracking; a terminal status alone does not.
      if (hint.terminal || !isRetained(companyId)) return;
      entry = {
        runId,
        companyId,
        minSeq: null,
        terminalHint: false,
        draining: null,
        again: false,
        state: null,
        lastActivityMs: now(),
      };
      runs.set(runId, entry);
    }
    if (entry.companyId !== companyId) return;
    if (typeof hint.seq === "number" && !entry.state) {
      entry.minSeq = entry.minSeq === null ? hint.seq : Math.min(entry.minSeq, hint.seq);
    }
    if (hint.terminal) entry.terminalHint = true;
    entry.lastActivityMs = now();
    if (entry.draining) {
      entry.again = true;
      return;
    }
    const current = entry;
    current.draining = runDrain(current).finally(() => {
      current.draining = null;
    });
  }

  function evict(entry: RunEntry) {
    runs.delete(entry.runId);
    const state = entry.state;
    if (state?.published && state.finishedAtMs === null) publishReset(entry, "evicted");
  }

  function enforceBudget() {
    let total = 0;
    for (const entry of runs.values()) total += entry.state?.translation.approxBytes() ?? 0;
    if (runs.size <= maxRuns && total <= maxBytes) return;
    // Finished runs and runs nobody watches go first, then the least recently active.
    const candidates = [...runs.values()]
      .filter((entry) => !entry.draining)
      .sort((a, b) => {
        const rank = (entry: RunEntry) => (entry.state?.finishedAtMs !== null && entry.state ? 0 : isRetained(entry.companyId) ? 2 : 1);
        return rank(a) - rank(b) || a.lastActivityMs - b.lastActivityMs;
      });
    for (const entry of candidates) {
      if (runs.size <= maxRuns && total <= maxBytes) break;
      total -= entry.state?.translation.approxBytes() ?? 0;
      evict(entry);
    }
  }

  function sweep() {
    const current = now();
    for (const entry of [...runs.values()]) {
      if (entry.draining) continue;
      const finishedAt = entry.state?.finishedAtMs ?? null;
      const released = releasedAt.get(entry.companyId);
      if (finishedAt !== null && current - finishedAt > lingerMs) runs.delete(entry.runId);
      else if (!isRetained(entry.companyId) && (released === undefined || current - released > lingerMs)) runs.delete(entry.runId);
      else if (!entry.state) runs.delete(entry.runId);
    }
    enforceBudget();
  }

  const unsubscribe = options.subscribe((event) => {
    if (event.type !== "heartbeat.run.log" && event.type !== "heartbeat.run.status") return;
    const payload = event.payload;
    const runId = typeof payload.runId === "string" ? payload.runId : null;
    if (!runId) return;
    if (event.type === "heartbeat.run.log") {
      schedule(event.companyId, runId, { seq: typeof payload.seq === "number" ? payload.seq : undefined });
    } else if (isTerminalRunStatus(typeof payload.status === "string" ? payload.status : null)) {
      schedule(event.companyId, runId, { terminal: true });
    }
  });

  const sweepTimer = setInterval(sweep, options.sweepIntervalMs ?? 30_000);
  sweepTimer.unref?.();

  return {
    retainCompany(companyId) {
      retainCounts.set(companyId, (retainCounts.get(companyId) ?? 0) + 1);
      releasedAt.delete(companyId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (retainCounts.get(companyId) ?? 1) - 1;
        if (count > 0) {
          retainCounts.set(companyId, count);
        } else {
          retainCounts.delete(companyId);
          releasedAt.set(companyId, now());
        }
      };
    },
    async whenIdle() {
      for (;;) {
        const pending = [...runs.values()].map((entry) => entry.draining).filter((value): value is Promise<void> => value !== null);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
    dispose() {
      disposed = true;
      unsubscribe();
      clearInterval(sweepTimer);
      runs.clear();
    },
    get size() {
      return runs.size;
    },
  };
}
