import type { TranscriptEntry } from "../types.js";
import { hashId } from "./hash.js";
import type {
  StreamJsonBlockKind,
  StreamJsonLimits,
  StreamJsonNoticeLevel,
  StreamJsonOps,
  StreamJsonResult,
  StreamJsonRunOutcome,
  StreamJsonUsage,
} from "./types.js";
import { safeCutIndex } from "./utf8.js";

/** Where the encoder writes lines. Implemented by the run translation. */
export interface StreamJsonEncoderSink {
  /** A constructed line. The sink fills `uuid`, redacts string leaves and caps the size. */
  emitObject(line: Record<string, unknown>): void;
  /** A line that is already Claude stream-json; emitted unchanged unless over the size cap. */
  emitPassthrough(line: string, parsed: Record<string, unknown>): void;
  /** ISO timestamp of the record being translated (or of the finish). */
  currentTs(): string;
  /** The same time in milliseconds; drives segmenting. */
  currentTimeMs(): number;
}

interface MessageState {
  key: string;
  id: string;
  model: string | null;
  usage: StreamJsonUsage | null;
}

interface BlockState {
  key: string | null;
  kind: StreamJsonBlockKind;
  id: string;
  buf: string;
  // Record time of the first character at each index of `buf` onward.
  marks: Array<{ at: number; ts: number }>;
  seg: number;
  reconciled: boolean;
  // Full text of a text block, for the result (bounded).
  text: string;
}

interface EntryToolResult {
  sourceId: string | undefined;
  content: string;
  isError: boolean;
}

interface EntryResultTotals {
  count: number;
  text: string;
  subtype: string;
  isError: boolean;
  errors: string[];
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
}

const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SENTENCE_END_RE = /[.!?。！？]["')\]”’]*\s/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function claudeUsage(usage: StreamJsonUsage | null) {
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    cache_creation_input_tokens: usage?.cacheWrite ?? 0,
    cache_read_input_tokens: usage?.cacheRead ?? 0,
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The cut index of the preferred boundary in `text[0, limit)`, or -1 when
 * no boundary lies strictly after `minCut`. Preference: blank line, line
 * break, sentence end, whitespace.
 */
export function findSegmentBoundary(text: string, limit: number, minCut: number): number {
  const window = text.slice(0, limit);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0 && paragraph + 2 > minCut) return paragraph + 2;
  const line = window.lastIndexOf("\n");
  if (line >= 0 && line + 1 > minCut) return line + 1;
  let sentence = -1;
  SENTENCE_END_RE.lastIndex = 0;
  for (let match = SENTENCE_END_RE.exec(window); match; match = SENTENCE_END_RE.exec(window)) {
    sentence = match.index + match[0].length;
  }
  if (sentence > minCut) return sentence;
  for (let i = window.length - 1; i > minCut - 1 && i >= 0; i -= 1) {
    const code = window.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) return i + 1;
  }
  return -1;
}

/**
 * Implements the translator operations. Holds all per-run output state:
 * the session, the current message, the open block, the tool-id table and
 * what a synthesized result needs.
 */
export class StreamJsonEncoder implements StreamJsonOps {
  private sessionId: string;
  private model: string | null = null;
  private currentMessage: MessageState | null = null;
  private messageCount = 0;
  private autoMessageCounter = 0;
  private blockCounter = 0;
  private toolCounter = 0;
  private openBlock: BlockState | null = null;
  // source id -> emitted tool_use id (insertion order = LRU order)
  private readonly toolIds = new Map<string, string>();
  // source id -> times it was used for a tool_use
  private readonly toolIdUses = new Map<string, number>();
  private resultSeen = false;
  private lastText = "";
  private readonly errors: string[] = [];
  private readonly usageByMessage = new Map<string, StreamJsonUsage>();
  private entryToolResult: EntryToolResult | null = null;
  private entryResult: EntryResultTotals | null = null;
  // The line being translated and its parsed value, so passthrough() does not parse it again.
  private parsedLine: { text: string; value: unknown } | null = null;

  constructor(
    private readonly runId: string,
    private readonly adapterType: string,
    private readonly limits: StreamJsonLimits,
    private readonly sink: StreamJsonEncoderSink,
  ) {
    this.sessionId = `paperclip-run-${runId}`;
  }

  /** Rough heap footprint of the output state, for the live hub's budget. */
  approxBytes(): number {
    return (
      (this.openBlock ? this.openBlock.buf.length * 2 + this.openBlock.text.length * 2 + this.openBlock.marks.length * 16 : 0) +
      this.toolIds.size * 160 +
      this.lastText.length * 2 +
      (this.entryToolResult ? this.entryToolResult.content.length * 2 : 0) +
      this.errors.reduce((sum, error) => sum + error.length * 2, 0)
    );
  }

  get hasResult(): boolean {
    return this.resultSeen;
  }

  /** Records the parsed value of the line handed to the translator (or clears it). */
  setParsedLine(text: string | null, value?: unknown): void {
    this.parsedLine = text === null ? null : { text, value };
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  init(p: { sessionId: string; model?: string; extra?: Record<string, unknown> }): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    if (typeof p.sessionId === "string" && p.sessionId.length > 0) this.sessionId = p.sessionId;
    if (typeof p.model === "string" && p.model.length > 0) this.model = p.model;
    this.sink.emitObject({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      uuid: "",
      model: this.model ?? "unknown",
      cwd: "",
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      permissionMode: "default",
      apiKeySource: "none",
      output_style: "default",
      paperclip: { ...(asRecord(p.extra) ?? {}), adapterType: this.adapterType, translated: true },
    });
    this.currentMessage = null;
  }

  message(key: string, p?: { model?: string }): void {
    this.flushEntryToolResult();
    const model = typeof p?.model === "string" && p.model.length > 0 ? p.model : null;
    if (this.currentMessage && this.currentMessage.key === key) {
      if (model) this.currentMessage.model = model;
      return;
    }
    this.closeBlocks();
    this.openMessage(key, model);
  }

  delta(p: { blockKey: string; kind: StreamJsonBlockKind; text: string }): void {
    if (typeof p.text !== "string" || p.text.length === 0) return;
    this.flushEntryToolResult();
    const kind: StreamJsonBlockKind = p.kind === "thinking" ? "thinking" : "text";
    if (this.openBlock && (this.openBlock.key !== p.blockKey || this.openBlock.kind !== kind)) {
      this.closeBlocks();
    }
    if (!this.openBlock) this.openBlock = this.newBlock(p.blockKey, kind, false);
    this.appendToBlock(this.openBlock, p.text);
  }

  block(p: { kind: StreamJsonBlockKind; text: string; reconciled?: boolean }): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    if (typeof p.text !== "string" || p.text.length === 0) return;
    const block = this.newBlock(null, p.kind === "thinking" ? "thinking" : "text", p.reconciled === true);
    this.appendToBlock(block, p.text);
    this.openBlock = block;
    this.closeBlocks();
  }

  closeBlocks(): void {
    const block = this.openBlock;
    if (!block) return;
    this.openBlock = null;
    while (block.buf.length > this.limits.segmentHardChars) {
      this.emitSegment(block, this.hardCut(block.buf), false);
    }
    if (block.buf.length > 0) this.emitSegment(block, block.buf.length, true);
    if (block.kind === "text" && block.text.length > 0) this.lastText = block.text;
  }

  toolUse(p: { sourceId?: string; name: string; input: unknown; synthesized?: boolean }): string {
    this.flushEntryToolResult();
    this.closeBlocks();
    const id = this.assignToolId(p.sourceId);
    const input = asRecord(p.input) ?? (p.input === undefined ? {} : { arguments: p.input });
    this.emitAssistant(
      { type: "tool_use", id, name: typeof p.name === "string" && p.name.length > 0 ? p.name : "unknown", input },
      p.synthesized ? { synthesized: true } : undefined,
    );
    return id;
  }

  toolResult(p: { sourceId?: string; content: string; isError: boolean; structured?: unknown }): void {
    this.flushEntryToolResult();
    this.emitToolResult(p);
  }

  hasToolUse(sourceId: string): boolean {
    return this.toolIds.has(sourceId);
  }

  usage(p: StreamJsonUsage): void {
    const usage: StreamJsonUsage = {
      input: finiteNonNegative(p?.input),
      output: finiteNonNegative(p?.output),
      cacheRead: finiteNonNegative(p?.cacheRead),
      cacheWrite: finiteNonNegative(p?.cacheWrite),
    };
    const message = this.ensureMessage();
    message.usage = usage;
    this.usageByMessage.set(message.key, usage);
  }

  apiError(p: { message: string; code?: string }): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    const text = typeof p.message === "string" && p.message.length > 0 ? p.message : "unknown error";
    this.errors.push(text);
    this.emitAssistant(
      { type: "text", text: `API Error: ${text}` },
      undefined,
      {
        error: "unknown",
        is_api_error_message: true,
        ...(typeof p.code === "string" && p.code.length > 0 ? { api_error_code: p.code } : {}),
      },
    );
  }

  user(p: { text: string }): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    this.sink.emitObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: typeof p.text === "string" ? p.text : "" }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: "",
      timestamp: this.sink.currentTs(),
    });
    this.currentMessage = null;
  }

  notice(level: StreamJsonNoticeLevel, text: string, p?: { recordError?: boolean }): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    const safeLevel: StreamJsonNoticeLevel = level === "warn" || level === "error" ? level : "info";
    const safeText = typeof text === "string" ? text : String(text);
    if (p?.recordError) this.errors.push(safeText);
    this.sink.emitObject({
      type: "system",
      subtype: "paperclip_notice",
      level: safeLevel,
      text: safeText,
      session_id: this.sessionId,
      uuid: "",
    });
  }

  raw(line: string): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    const text = typeof line === "string" ? line : String(line);
    const cut = safeCutIndex(text, this.limits.maxRawTextChars);
    this.sink.emitObject({
      type: "system",
      subtype: "paperclip_raw",
      text: text.length > this.limits.maxRawTextChars ? text.slice(0, cut) : text,
      truncated: text.length > this.limits.maxRawTextChars,
      session_id: this.sessionId,
      uuid: "",
    });
  }

  passthrough(line: string): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    let parsed: Record<string, unknown> | null = null;
    if (this.parsedLine && this.parsedLine.text === line) {
      parsed = asRecord(this.parsedLine.value);
    } else {
      try {
        parsed = asRecord(JSON.parse(line));
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      this.raw(line);
      return;
    }
    if (parsed.type === "system" && parsed.subtype === "init") {
      if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) this.sessionId = parsed.session_id;
      if (typeof parsed.model === "string" && parsed.model.length > 0) this.model = parsed.model;
    }
    if (parsed.type === "result") this.resultSeen = true;
    this.sink.emitPassthrough(line, parsed);
  }

  entry(e: TranscriptEntry): void {
    if (!e || typeof e !== "object") return;
    if (e.kind === "tool_result") {
      const sourceId = typeof e.toolUseId === "string" && e.toolUseId.length > 0 ? e.toolUseId : undefined;
      if (e.delta) {
        // Streamed results are joined per tool call and emitted once.
        if (this.entryToolResult && this.entryToolResult.sourceId === sourceId) {
          this.entryToolResult.content += e.content;
          this.entryToolResult.isError ||= e.isError;
          return;
        }
        this.flushEntryToolResult();
        this.entryToolResult = { sourceId, content: e.content, isError: e.isError };
        return;
      }
      if (this.entryToolResult && this.entryToolResult.sourceId === sourceId) {
        const pending = this.entryToolResult;
        this.entryToolResult = null;
        this.emitToolResult({ sourceId, content: pending.content + e.content, isError: pending.isError || e.isError });
        return;
      }
      this.flushEntryToolResult();
      this.emitToolResult({ sourceId, content: e.content, isError: e.isError });
      return;
    }
    this.flushEntryToolResult();
    switch (e.kind) {
      case "init":
        this.init({ sessionId: e.sessionId, model: e.model });
        return;
      case "assistant":
      case "thinking": {
        const kind: StreamJsonBlockKind = e.kind === "thinking" ? "thinking" : "text";
        if (e.delta) {
          this.delta({ blockKey: `${e.kind}:${e.channel ?? ""}:${e.itemId ?? ""}`, kind, text: e.text });
        } else {
          this.block({ kind, text: e.text });
        }
        return;
      }
      case "user":
        this.user({ text: e.text });
        return;
      case "tool_call":
        this.toolUse({ sourceId: e.toolUseId, name: e.name, input: e.input });
        return;
      case "result":
        this.closeBlocks();
        this.accumulateEntryResult(e);
        this.currentMessage = null;
        return;
      case "stderr":
        this.notice("error", e.text);
        return;
      case "system":
        this.notice("info", e.text);
        return;
      case "stdout":
        this.raw(e.text);
        return;
      default:
        this.closeBlocks();
        this.sink.emitObject({
          type: "system",
          subtype: "paperclip_entry",
          entry: e as unknown as Record<string, unknown>,
          session_id: this.sessionId,
          uuid: "",
        });
    }
  }

  result(p: StreamJsonResult): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    this.emitResult(p, null);
  }

  // ---------------------------------------------------------------------------
  // Host-side steps
  // ---------------------------------------------------------------------------

  /** Segment check after each stdout record (see the design notes: Δ, C_soft, C_hard). */
  checkSegments(): void {
    const block = this.openBlock;
    if (!block || block.buf.length === 0) return;
    while (block.buf.length >= this.limits.segmentHardChars) {
      this.emitSegment(block, this.hardCut(block.buf), false);
    }
    if (block.buf.length === 0) return;
    const oldest = block.marks[0]?.ts ?? this.sink.currentTimeMs();
    const due = this.sink.currentTimeMs() - oldest >= this.limits.segmentMs || block.buf.length >= this.limits.segmentSoftChars;
    if (!due) return;
    const cut = findSegmentBoundary(block.buf, block.buf.length, Math.floor(block.buf.length / 2));
    if (cut > 0) this.emitSegment(block, cut, false);
  }

  /** Ends the run: closes open output and synthesizes a result when none was reported. */
  finishRun(outcome: StreamJsonRunOutcome): void {
    this.flushEntryToolResult();
    this.closeBlocks();
    if (this.resultSeen) return;
    if (this.entryResult) {
      const totals = this.entryResult;
      this.emitResult(
        {
          isError: totals.isError,
          subtype: totals.subtype,
          result: totals.text,
          totalCostUsd: totals.costUsd,
          usage: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: 0 },
          model: this.model ?? undefined,
          errors: totals.errors,
        },
        null,
      );
      return;
    }
    const succeeded = outcome.status === "succeeded";
    const usage = outcome.usage
      ? {
          input: finiteNonNegative(outcome.usage.inputTokens),
          output: finiteNonNegative(outcome.usage.outputTokens),
          cacheRead: finiteNonNegative(outcome.usage.cachedInputTokens),
          cacheWrite: 0,
        }
      : this.summedMessageUsage();
    const errors = [...this.errors];
    if (!succeeded && outcome.error) errors.push(outcome.error);
    const started = outcome.startedAt ? Date.parse(outcome.startedAt) : Number.NaN;
    const finished = outcome.finishedAt ? Date.parse(outcome.finishedAt) : Number.NaN;
    this.emitResult(
      {
        isError: !succeeded,
        durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0,
        totalCostUsd: outcome.usage?.costUsd ?? 0,
        usage,
        model: outcome.usage?.model ?? this.model ?? undefined,
        sessionId: outcome.usage?.sessionId ?? undefined,
        errors,
      },
      { synthesized: true, runStatus: outcome.status, ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) },
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private openMessage(key: string, model: string | null): MessageState {
    this.messageCount += 1;
    this.currentMessage = {
      key,
      id: `msg_pc_${hashId([this.runId, "message", key], 24)}`,
      model,
      usage: null,
    };
    return this.currentMessage;
  }

  private ensureMessage(): MessageState {
    if (this.currentMessage) return this.currentMessage;
    this.autoMessageCounter += 1;
    return this.openMessage(`\u0000auto:${this.autoMessageCounter}`, null);
  }

  private newBlock(key: string | null, kind: StreamJsonBlockKind, reconciled: boolean): BlockState {
    this.ensureMessage();
    this.blockCounter += 1;
    return { key, kind, id: `b${this.blockCounter}`, buf: "", marks: [], seg: 0, reconciled, text: "" };
  }

  private appendToBlock(block: BlockState, text: string) {
    block.marks.push({ at: block.buf.length, ts: this.sink.currentTimeMs() });
    block.buf += text;
    if (block.kind === "text" && block.text.length < this.limits.maxResultTextChars) {
      block.text += text.slice(0, this.limits.maxResultTextChars - block.text.length);
    }
  }

  private hardCut(buf: string): number {
    const limit = this.limits.segmentHardChars;
    const boundary = findSegmentBoundary(buf, limit, Math.floor(limit / 2));
    return boundary > 0 ? boundary : Math.max(1, safeCutIndex(buf, limit));
  }

  private emitSegment(block: BlockState, cut: number, last: boolean) {
    const text = block.buf.slice(0, cut);
    block.buf = block.buf.slice(cut);
    // Keep the arrival time of the first remaining character.
    let keepFrom = 0;
    for (let i = 0; i < block.marks.length; i += 1) {
      if (block.marks[i]!.at <= cut) keepFrom = i;
      else break;
    }
    block.marks = block.marks.slice(keepFrom).map((mark, index) => ({
      at: index === 0 ? 0 : mark.at - cut,
      ts: mark.ts,
    }));
    if (block.buf.length === 0) block.marks = [];
    const content =
      block.kind === "thinking"
        ? { type: "thinking", thinking: text, signature: "" }
        : { type: "text", text };
    this.emitAssistant(content, {
      block: block.id,
      seg: block.seg,
      last,
      ...(block.reconciled ? { reconciled: true } : {}),
    });
    block.seg += 1;
  }

  private emitAssistant(
    content: Record<string, unknown>,
    paperclip: Record<string, unknown> | undefined,
    extra?: Record<string, unknown>,
  ) {
    const message = this.ensureMessage();
    this.sink.emitObject({
      type: "assistant",
      message: {
        id: message.id,
        type: "message",
        role: "assistant",
        model: message.model ?? this.model ?? "unknown",
        content: [content],
        stop_reason: null,
        stop_sequence: null,
        usage: claudeUsage(message.usage),
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: "",
      timestamp: this.sink.currentTs(),
      ...(extra ?? {}),
      ...(paperclip ? { paperclip } : {}),
    });
  }

  private assignToolId(sourceId: string | undefined): string {
    this.toolCounter += 1;
    const source = typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
    let id: string;
    if (source) {
      const uses = (this.toolIdUses.get(source) ?? 0) + 1;
      this.toolIdUses.delete(source);
      this.toolIdUses.set(source, uses);
      const base = TOOL_ID_RE.test(source) ? source : `toolu_pc_${hashId([this.runId, "tool", source], 24)}`;
      id = uses === 1 ? base : `${base}_${uses}`;
      this.toolIds.delete(source);
      this.toolIds.set(source, id);
      this.trimToolTables();
    } else {
      id = `toolu_pc_${hashId([this.runId, "tool", "", this.toolCounter], 24)}`;
    }
    return id;
  }

  private trimToolTables() {
    while (this.toolIds.size > this.limits.maxToolIds) {
      const oldest = this.toolIds.keys().next().value as string;
      this.toolIds.delete(oldest);
    }
    while (this.toolIdUses.size > this.limits.maxToolIds) {
      const oldest = this.toolIdUses.keys().next().value as string;
      this.toolIdUses.delete(oldest);
    }
  }

  private emitToolResult(p: { sourceId?: string; content: string; isError: boolean; structured?: unknown }) {
    this.closeBlocks();
    const source = typeof p.sourceId === "string" && p.sourceId.length > 0 ? p.sourceId : undefined;
    let id = source ? this.toolIds.get(source) : undefined;
    if (!id) {
      // Every tool_result must follow its tool_use; synthesize one when the
      // source never reported the call (or it left the id table).
      id = this.toolUse({ sourceId: source, name: "unknown", input: {}, synthesized: true });
    }
    this.sink.emitObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: typeof p.content === "string" ? p.content : String(p.content ?? ""),
            is_error: p.isError === true,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: "",
      timestamp: this.sink.currentTs(),
      ...(p.structured !== undefined ? { tool_use_result: p.structured } : {}),
    });
    this.currentMessage = null;
  }

  private flushEntryToolResult() {
    const pending = this.entryToolResult;
    if (!pending) return;
    this.entryToolResult = null;
    this.emitToolResult(pending);
  }

  private accumulateEntryResult(e: Extract<TranscriptEntry, { kind: "result" }>) {
    const totals: EntryResultTotals = this.entryResult ?? {
      count: 0,
      text: "",
      subtype: "success",
      isError: false,
      errors: [],
      input: 0,
      output: 0,
      cacheRead: 0,
      costUsd: 0,
    };
    totals.count += 1;
    if (e.text) totals.text = e.text;
    if (e.subtype) totals.subtype = e.subtype;
    totals.isError = e.isError;
    totals.errors.push(...(Array.isArray(e.errors) ? e.errors : []));
    totals.input += finiteNonNegative(e.inputTokens);
    totals.output += finiteNonNegative(e.outputTokens);
    totals.cacheRead += finiteNonNegative(e.cachedTokens);
    totals.costUsd += finiteNonNegative(e.costUsd);
    this.entryResult = totals;
  }

  private summedMessageUsage(): StreamJsonUsage | undefined {
    if (this.usageByMessage.size === 0) return undefined;
    const sum: StreamJsonUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const usage of this.usageByMessage.values()) {
      sum.input += usage.input;
      sum.output += usage.output;
      sum.cacheRead += usage.cacheRead;
      sum.cacheWrite += usage.cacheWrite;
    }
    return sum;
  }

  private emitResult(p: StreamJsonResult, paperclip: Record<string, unknown> | null) {
    const isError = p.isError === true;
    const usage = p.usage ?? this.summedMessageUsage() ?? null;
    const cost = finiteNonNegative(p.totalCostUsd);
    const model = typeof p.model === "string" && p.model.length > 0 && p.model !== "unknown" ? p.model : null;
    this.sink.emitObject({
      type: "result",
      subtype: typeof p.subtype === "string" && p.subtype.length > 0 ? p.subtype : isError ? "error_during_execution" : "success",
      is_error: isError,
      duration_ms: finiteNonNegative(p.durationMs),
      duration_api_ms: finiteNonNegative(p.durationApiMs),
      num_turns: typeof p.numTurns === "number" && Number.isFinite(p.numTurns) ? p.numTurns : this.messageCount,
      result: typeof p.result === "string" ? p.result : this.lastText,
      stop_reason: p.stopReason ?? null,
      session_id: typeof p.sessionId === "string" && p.sessionId.length > 0 ? p.sessionId : this.sessionId,
      total_cost_usd: cost,
      usage: claudeUsage(usage),
      ...(model && usage
        ? {
            modelUsage: {
              [model]: {
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadInputTokens: usage.cacheRead,
                cacheCreationInputTokens: usage.cacheWrite,
                costUSD: cost,
              },
            },
          }
        : {}),
      permission_denials: [],
      errors: Array.isArray(p.errors) ? p.errors.filter((error) => typeof error === "string") : [],
      uuid: "",
      ...(paperclip ? { paperclip } : {}),
    });
    this.resultSeen = true;
    this.currentMessage = null;
  }
}
