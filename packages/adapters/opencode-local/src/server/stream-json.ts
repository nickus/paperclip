import {
  STREAM_JSON_CONTRACT,
  type StreamJsonOps,
  type StreamJsonRunOutcome,
  type StreamJsonTranslator,
  type StreamJsonUsage,
} from "@paperclipai/adapter-utils/stream-json";

// How many part ids are remembered to drop re-printed parts (see below).
const MAX_TRACKED_PARTS = 4096;
// Bounds on the error texts kept for the result.
const MAX_ERRORS = 64;
const MAX_ERROR_CHARS = 4096;

// AI SDK finish reasons (as opencode reports them) in Claude's vocabulary.
const CLAUDE_STOP_REASONS: Record<string, string> = {
  stop: "end_turn",
  "tool-calls": "tool_use",
  length: "max_tokens",
  "content-filter": "refusal",
};

const STOP_NOTICES: Record<string, string> = {
  length: "the model stopped at its output token limit",
  "content-filter": "the model's output was stopped by a content filter",
};

const KNOWN_EVENTS = new Set(["step_start", "step_finish", "text", "reasoning", "tool_use", "error"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The readable text of an opencode error value (same precedence as `parseOpenCodeJsonl`). */
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const message =
    asString(rec.message).trim() ||
    asString(asRecord(rec.data)?.message).trim() ||
    asString(rec.name).trim() ||
    asString(rec.code).trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

interface RunTotals extends StreamJsonUsage {
  costUsd: number;
}

/**
 * Stream-json translator for opencode_local.
 *
 * `opencode run --format json` prints one JSON event per line,
 * `{ type, timestamp, sessionID, part }`, for `step_start`, `reasoning`,
 * `text`, `tool_use` and `step_finish`, plus `{ type: "error", error }` for a
 * session error. Parts are printed once they are complete (a tool part once
 * its call completed or failed), so text and reasoning become whole blocks
 * and a tool call becomes a `tool_use` followed by its `tool_result`.
 *
 * - Each step (one model request) is one assistant message: its lines share
 *   a `message.id`, also across the tool results printed in between.
 * - opencode prints no init line: the first event of a session emits
 *   `system/init`, and a later event with another session id (a fresh
 *   session after a failed resume) emits a second one.
 * - opencode prints no result line either: `finish` reports one from the
 *   step totals (`step_finish` tokens and cost) and the run outcome. Token
 *   counts follow opencode's usage record: `input` already excludes cache
 *   reads and writes, and output is `output + reasoning`, as in
 *   `parseOpenCodeJsonl`; cache writes are kept as well.
 * - A part printed again with the same id (opencode re-prints a finished
 *   tool part when it is updated later, e.g. by compaction) is dropped.
 */
export const openCodeStreamJsonTranslator: StreamJsonTranslator = {
  contract: STREAM_JSON_CONTRACT,
  id: "opencode_local",
  version: 1,
  create() {
    let sessionId: string | null = null;
    let stepsStarted = 0;
    let stepsFinished = 0;
    let stepMessageId = "";
    let lastReason: string | null = null;
    let sawStepUsage = false;
    let apiErrorCount = 0;
    let anonymousToolCount = 0;
    const totals: RunTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    const errors: string[] = [];
    // Part id -> "open" (tool_use emitted, result pending) or "done". Insertion order is LRU order.
    const parts = new Map<string, "open" | "done">();

    const trackPart = (key: string, state: "open" | "done") => {
      parts.delete(key);
      parts.set(key, state);
      if (parts.size > MAX_TRACKED_PARTS) parts.delete(parts.keys().next().value as string);
    };

    const recordError = (text: string) => {
      if (errors.length < MAX_ERRORS) errors.push(text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text);
    };

    // Lines of one step share one message; the key also separates steps of
    // one opencode message (older opencode versions run several steps per message).
    const enterMessage = (ops: StreamJsonOps, part: Record<string, unknown> | null) => {
      ops.message(`${stepsStarted}:${asString(part?.messageID) || stepMessageId}`);
    };

    const translateToolPart = (part: Record<string, unknown>, ops: StreamJsonOps) => {
      const state = asRecord(part.state);
      const status = asString(state?.status);
      // A pending call is still streaming its arguments; wait for running or the end.
      if (status === "pending") return;
      const callId = asString(part.callID);
      const partKey = asString(part.id) || callId;
      const tracked = partKey ? parts.get(partKey) : undefined;
      if (tracked === "done") return;
      const name = asString(part.tool) || "unknown";
      // Without any id the host hashes a per-call key, so the result still finds its tool_use.
      const sourceId = callId || partKey || `\u0000opencode-tool:${(anonymousToolCount += 1)}`;
      enterMessage(ops, part);
      if (tracked !== "open") ops.toolUse({ sourceId, name, input: state?.input ?? {} });
      if (status !== "completed" && status !== "error") {
        if (partKey) trackPart(partKey, "open");
        return;
      }
      const title = asString(state?.title) || asString(part.title);
      const metadata = asRecord(state?.metadata);
      ops.toolResult({
        sourceId,
        // Same precedence as the opencode UI parser; its "status:" header goes to tool_use_result.
        content: asString(state?.output) || asString(state?.error) || title || `${name} ${status}`,
        isError: status === "error",
        structured: { status, ...(title ? { title } : {}), ...(metadata ? { metadata } : {}) },
      });
      if (partKey) trackPart(partKey, "done");
    };

    return {
      line(line, meta, ops) {
        const event = asRecord(meta.json);
        const type = event ? asString(event.type) : "";
        if (!event || !KNOWN_EVENTS.has(type)) {
          ops.raw(line);
          return;
        }
        const part = asRecord(event.part);

        const eventSession = asString(event.sessionID) || asString(part?.sessionID);
        if (eventSession && eventSession !== sessionId) {
          sessionId = eventSession;
          ops.init({ sessionId });
        }

        switch (type) {
          case "step_start": {
            stepsStarted += 1;
            stepMessageId = asString(part?.messageID);
            // A step that never finishes (the run ended inside it) reports no stop reason.
            lastReason = null;
            enterMessage(ops, part);
            return;
          }
          case "text":
          case "reasoning": {
            const text = asString(part?.text);
            if (text.trim().length === 0) return;
            const partKey = asString(part?.id);
            if (partKey && parts.has(partKey)) return;
            enterMessage(ops, part);
            ops.block({ kind: type === "reasoning" ? "thinking" : "text", text });
            if (partKey) trackPart(partKey, "done");
            return;
          }
          case "tool_use": {
            if (part) translateToolPart(part, ops);
            else ops.raw(line);
            return;
          }
          case "step_finish": {
            stepsFinished += 1;
            const tokens = asRecord(part?.tokens);
            const cache = asRecord(tokens?.cache);
            const usage: StreamJsonUsage = {
              input: asCount(tokens?.input),
              output: asCount(tokens?.output) + asCount(tokens?.reasoning),
              cacheRead: asCount(cache?.read),
              cacheWrite: asCount(cache?.write),
            };
            totals.input += usage.input;
            totals.output += usage.output;
            totals.cacheRead += usage.cacheRead;
            totals.cacheWrite += usage.cacheWrite;
            totals.costUsd += asCount(part?.cost);
            sawStepUsage = true;
            enterMessage(ops, part);
            ops.usage(usage);
            const reason = asString(part?.reason);
            if (reason) lastReason = reason;
            const stopNotice = STOP_NOTICES[reason];
            if (stopNotice) ops.notice("warn", stopNotice);
            return;
          }
          case "error": {
            const error = event.error ?? event.message;
            const text = errorText(error).trim() || line;
            recordError(text);
            const errorRecord = asRecord(error);
            if (asString(errorRecord?.name) === "APIError") {
              // A failed model request: Claude Code's own API-error line, as its own message.
              const statusCode = asRecord(errorRecord?.data)?.statusCode;
              apiErrorCount += 1;
              ops.message(`api-error:${apiErrorCount}`);
              ops.apiError({
                message: text,
                code: typeof statusCode === "number" && Number.isFinite(statusCode) ? String(statusCode) : undefined,
              });
            } else {
              ops.notice("error", text, { recordError: true });
            }
            return;
          }
        }
      },

      finish(outcome: StreamJsonRunOutcome, ops) {
        const succeeded = outcome.status === "succeeded";
        // The run's usage record is authoritative (it is parsed from the full
        // output); it has no cache writes, so those come from the steps.
        const reported = outcome.usage;
        const usage: StreamJsonUsage | undefined = reported
          ? {
              input: asCount(reported.inputTokens),
              output: asCount(reported.outputTokens),
              cacheRead: asCount(reported.cachedInputTokens),
              cacheWrite: totals.cacheWrite,
            }
          : sawStepUsage
            ? { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite }
            : undefined;
        const runErrors = [...errors];
        const runError = outcome.error;
        if (!succeeded && runError && !runErrors.includes(runError) && runError !== runErrors.join("\n")) {
          runErrors.push(runError);
        }
        const started = outcome.startedAt ? Date.parse(outcome.startedAt) : Number.NaN;
        const finished = outcome.finishedAt ? Date.parse(outcome.finishedAt) : Number.NaN;
        ops.result({
          isError: !succeeded,
          durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0,
          numTurns: Math.max(stepsStarted, stepsFinished),
          totalCostUsd: reported?.costUsd ?? totals.costUsd,
          usage,
          model: reported?.model ?? undefined,
          sessionId: sessionId ?? reported?.sessionId ?? undefined,
          errors: runErrors,
          stopReason: lastReason ? (CLAUDE_STOP_REASONS[lastReason] ?? lastReason) : null,
        });
      },
    };
  },
};
