import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import {
  buildRunLogContent,
  describeInvalidStreamJsonTranslator,
  streamJsonItemLines,
  translateRunLogContent,
  type RunLogRecordInput,
  type StreamJsonRunOutcome,
} from "@paperclipai/adapter-utils/stream-json";
import { parseOpenCodeStdoutLine } from "../ui/parse-stdout.js";
import { openCodeStreamJsonTranslator } from "./stream-json.js";

// Synthetic events shaped like `opencode run --format json` output: one
// `{ type, timestamp, sessionID, part }` object per line, printed when a part
// is complete.
const RUN_ID = "run-opencode";
const SESSION = "ses_1a2b3c4d5e6fTESTSESSION01";
const SESSION_2 = "ses_1a2b3c4d5e6fTESTSESSION02";
const MODEL = "test-provider/test-model";

let clock = 1_900_000_000_000;
function event(type: string, fields: Record<string, unknown>, sessionID = SESSION) {
  clock += 25;
  return { type, timestamp: clock, sessionID, ...fields };
}

const ev = {
  stepStart: (messageID: string, id: string, sessionID = SESSION) =>
    event("step_start", { part: { id, sessionID, messageID, type: "step-start", snapshot: "0123456789abcdef0123456789abcdef01234567" } }, sessionID),
  text: (messageID: string, id: string, text: string, sessionID = SESSION) =>
    event("text", { part: { id, sessionID, messageID, type: "text", text, time: { start: clock, end: clock + 10 } } }, sessionID),
  reasoning: (messageID: string, id: string, text: string) =>
    event("reasoning", { part: { id, sessionID: SESSION, messageID, type: "reasoning", text, time: { start: clock, end: clock + 10 } } }),
  tool: (messageID: string, id: string, callID: string | undefined, tool: string, state: Record<string, unknown>) =>
    event("tool_use", {
      part: { id, sessionID: SESSION, messageID, type: "tool", ...(callID ? { callID } : {}), tool, state },
    }),
  stepFinish: (
    messageID: string,
    id: string,
    reason: string,
    cost: number,
    tokens: { input: number; output: number; reasoning: number; read: number; write: number },
    sessionID = SESSION,
  ) =>
    event(
      "step_finish",
      {
        part: {
          id,
          sessionID,
          messageID,
          type: "step-finish",
          reason,
          cost,
          tokens: {
            total: tokens.input + tokens.output + tokens.reasoning + tokens.read + tokens.write,
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cache: { read: tokens.read, write: tokens.write },
          },
        },
      },
      sessionID,
    ),
  error: (error: unknown) => event("error", { error }),
};

const completed = (input: Record<string, unknown>, output: string, title: string, metadata: Record<string, unknown> = {}) => ({
  status: "completed",
  input,
  output,
  title,
  metadata,
  time: { start: 1, end: 2 },
});
const failed = (input: Record<string, unknown>, error: string) => ({ status: "error", input, error, time: { start: 1, end: 2 } });

// A two-step run: the first step thinks, talks and calls two tools (one
// fails); the second step answers.
const TWO_STEP_RUN = [
  ev.stepStart("msg_01", "prt_01"),
  ev.reasoning("msg_01", "prt_02", "The user wants a listing. I should run ls."),
  ev.text("msg_01", "prt_03", "I'll list the files first."),
  ev.tool(
    "msg_01",
    "prt_04",
    "toolu_01",
    "bash",
    completed({ command: "ls", description: "List files" }, "README.md\nsrc\n", "List files", { exit: 0, description: "List files" }),
  ),
  ev.tool("msg_01", "prt_05", "toolu_02", "read", failed({ filePath: "missing.txt" }, "File not found: missing.txt")),
  ev.stepFinish("msg_01", "prt_06", "tool-calls", 0.02, { input: 700, output: 80, reasoning: 20, read: 300, write: 100 }),
  ev.stepStart("msg_02", "prt_07"),
  ev.text("msg_02", "prt_08", "Done: the repository has a README and a src directory."),
  ev.stepFinish("msg_02", "prt_09", "stop", 0.0221, { input: 800, output: 120, reasoning: 10, read: 500, write: 0 }),
];

const T0 = Date.parse("2026-03-01T09:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function record(ms: number, chunk: string, stream: "stdout" | "stderr" = "stdout"): RunLogRecordInput {
  return { stream, chunk, ts: at(ms), seq: ms + 1 };
}

function jsonl(events: unknown[]): string {
  return events.map((value) => `${JSON.stringify(value)}\n`).join("");
}

function translate(records: RunLogRecordInput[], outcome?: StreamJsonRunOutcome) {
  return translateRunLogContent({
    runId: RUN_ID,
    adapterType: "opencode_local",
    translator: openCodeStreamJsonTranslator,
    content: buildRunLogContent(records),
    outcome,
  });
}

function outputLines(records: RunLogRecordInput[], outcome?: StreamJsonRunOutcome): Array<Record<string, any>> {
  return streamJsonItemLines(translate(records, outcome).items).map((line) => JSON.parse(line));
}

function contentOf(line: Record<string, any>): Record<string, any> {
  return line.message.content[0];
}

const succeeded: StreamJsonRunOutcome = {
  status: "succeeded",
  startedAt: at(0),
  finishedAt: at(60_000),
  error: null,
  errorCode: null,
  usage: {
    inputTokens: 1500,
    cachedInputTokens: 800,
    outputTokens: 230,
    costUsd: 0.0421,
    model: MODEL,
    sessionId: SESSION,
  },
};

const cancelled: StreamJsonRunOutcome = {
  status: "cancelled",
  startedAt: at(0),
  finishedAt: at(60_000),
  error: "cancelled by user",
  errorCode: "cancelled",
  usage: null,
};

describe("openCodeStreamJsonTranslator", () => {
  it("is a valid translator", () => {
    expect(describeInvalidStreamJsonTranslator(openCodeStreamJsonTranslator)).toBeNull();
    expect(openCodeStreamJsonTranslator.id).toBe("opencode_local");
  });

  it("translates a run into init, one block per line, tool calls with their results and one result", () => {
    const lines = outputLines([record(0, jsonl(TWO_STEP_RUN))], succeeded);
    expect(lines.map((line) => [line.type, line.subtype ?? line.message?.content?.[0]?.type])).toEqual([
      ["system", "init"],
      ["assistant", "thinking"],
      ["assistant", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["assistant", "tool_use"],
      ["user", "tool_result"],
      ["assistant", "text"],
      ["result", "success"],
    ]);
    const [init, thinking, text, bash, bashResult, read, readResult, answer, result] = lines as Array<Record<string, any>>;

    expect(init).toMatchObject({
      session_id: SESSION,
      model: "unknown",
      paperclip: { adapterType: "opencode_local", translated: true },
    });
    expect(contentOf(thinking!)).toEqual({ type: "thinking", thinking: "The user wants a listing. I should run ls.", signature: "" });
    expect(contentOf(text!)).toEqual({ type: "text", text: "I'll list the files first." });

    expect(contentOf(bash!)).toEqual({ type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls", description: "List files" } });
    expect(contentOf(bashResult!)).toEqual({ type: "tool_result", tool_use_id: "toolu_01", content: "README.md\nsrc\n", is_error: false });
    expect(bashResult!.tool_use_result).toEqual({ status: "completed", title: "List files", metadata: { exit: 0, description: "List files" } });

    expect(contentOf(read!)).toMatchObject({ type: "tool_use", id: "toolu_02", name: "read", input: { filePath: "missing.txt" } });
    expect(contentOf(readResult!)).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_02",
      content: "File not found: missing.txt",
      is_error: true,
    });
    expect(readResult!.tool_use_result).toEqual({ status: "error" });

    // One message per step, also across the tool results printed in between.
    const firstStep = [thinking, text, bash, read].map((line) => line!.message.id);
    expect(new Set(firstStep).size).toBe(1);
    expect(firstStep[0]).toMatch(/^msg_pc_/);
    expect(answer!.message.id).not.toBe(firstStep[0]);
    for (const line of lines) expect(line.session_id).toBe(SESSION);

    expect(result).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 60_000,
      num_turns: 2,
      result: "Done: the repository has a README and a src directory.",
      session_id: SESSION,
      stop_reason: "end_turn",
      total_cost_usd: 0.0421,
      // The run's usage record, plus the cache writes only the steps report.
      usage: { input_tokens: 1500, output_tokens: 230, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
      modelUsage: { [MODEL]: { inputTokens: 1500, outputTokens: 230, cacheReadInputTokens: 800, cacheCreationInputTokens: 100 } },
      errors: [],
    });
    // A failed tool call is part of the transcript, not a run error.
    expect(result!.paperclip).toBeUndefined();
  });

  it("sums the steps when the run has no usage record", () => {
    const lines = outputLines([record(0, jsonl(TWO_STEP_RUN))], { ...succeeded, usage: null });
    const result = lines.at(-1)!;
    expect(result.usage).toEqual({ input_tokens: 1500, output_tokens: 230, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 });
    expect(result.total_cost_usd).toBeCloseTo(0.0421, 10);
    expect(result.modelUsage).toBeUndefined();
  });

  it("reports a run that ends inside a step, and nothing final while the run is active", () => {
    const partial = [...TWO_STEP_RUN.slice(0, 7), ev.text("msg_02", "prt_08", "Still working")];
    const active = outputLines([record(0, jsonl(partial))]);
    expect(active.filter((line) => line.type === "result")).toHaveLength(0);

    const lines = outputLines([record(0, jsonl(partial))], cancelled);
    expect(lines.filter((line) => line.type === "result")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 2,
      result: "Still working",
      session_id: SESSION,
      // The last step never finished, so it has no stop reason.
      stop_reason: null,
      errors: ["cancelled by user"],
      usage: { input_tokens: 700, output_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 },
      total_cost_usd: 0.02,
    });
  });

  it("follows a tool call from running to its end and drops parts printed again", () => {
    const running = { status: "running", input: { command: "make test" }, title: "Run tests", time: { start: 1 } };
    const done = completed({ command: "make test" }, "ok\n", "Run tests");
    const lines = outputLines([
      record(
        0,
        jsonl([
          ev.stepStart("msg_01", "prt_01"),
          // Pending parts are still streaming their arguments.
          ev.tool("msg_01", "prt_02", "call_a", "bash", { status: "pending", input: {}, raw: "{\"comm" }),
          ev.tool("msg_01", "prt_02", "call_a", "bash", running),
          ev.tool("msg_01", "prt_02", "call_a", "bash", done),
          // opencode prints a finished tool part again when it is updated later.
          ev.tool("msg_01", "prt_02", "call_a", "bash", { ...done, time: { start: 1, end: 2, compacted: 3 } }),
          ev.text("msg_01", "prt_03", "Tests pass."),
          ev.text("msg_01", "prt_03", "Tests pass."),
        ]),
      ),
    ]);
    const kinds = lines.map((line) => line.message?.content?.[0]?.type ?? line.subtype);
    expect(kinds).toEqual(["init", "tool_use", "tool_result", "text"]);
    expect(contentOf(lines[1]!)).toMatchObject({ id: "call_a", input: { command: "make test" } });
    expect(contentOf(lines[2]!)).toMatchObject({ tool_use_id: "call_a", content: "ok\n", is_error: false });
  });

  it("keeps tool ids unique and matched when calls reuse or lack ids", () => {
    const lines = outputLines([
      record(
        0,
        jsonl([
          ev.stepStart("msg_01", "prt_01"),
          ev.tool("msg_01", "prt_02", "call_0", "glob", completed({ pattern: "*.ts" }, "a.ts", "Find files")),
          ev.stepStart("msg_02", "prt_03"),
          // Some providers number calls per response, so ids repeat across steps.
          ev.tool("msg_02", "prt_04", "call_0", "glob", completed({ pattern: "*.md" }, "b.md", "Find files")),
          // No call id: the part id is used.
          ev.tool("msg_02", "prt_05", undefined, "list", completed({ path: "." }, "src", "List")),
          // No id at all: the host hashes one for both lines.
          event("tool_use", { part: { type: "tool", tool: "list", state: completed({ path: "src" }, "x.ts", "List") } }),
          // Empty output falls back to the title.
          ev.tool("msg_02", "prt_06", "call_1", "write", completed({ filePath: "out.txt", content: "hi" }, "", "Wrote out.txt")),
        ]),
      ),
    ]);
    const pairs = lines
      .filter((line) => line.type === "assistant" || line.type === "user")
      .map((line) => {
        const block = contentOf(line);
        return block.type === "tool_use" ? ["use", block.id] : ["result", block.tool_use_id, block.content];
      });
    expect(pairs.slice(0, 6)).toEqual([
      ["use", "call_0"],
      ["result", "call_0", "a.ts"],
      ["use", "call_0_2"],
      ["result", "call_0_2", "b.md"],
      ["use", "prt_05"],
      ["result", "prt_05", "src"],
    ]);
    const [anonymousUse, anonymousResult] = pairs.slice(6, 8);
    expect(anonymousUse![1]).toMatch(/^toolu_pc_/);
    expect(anonymousResult).toEqual(["result", anonymousUse![1], "x.ts"]);
    expect(pairs.slice(8)).toEqual([
      ["use", "call_1"],
      ["result", "call_1", "Wrote out.txt"],
    ]);
    expect(lines.some((line) => line.message?.content?.[0]?.name === "unknown")).toBe(false);
  });

  it("reports model API errors in Claude's API-error shape and other errors as notices", () => {
    const apiError = { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429, isRetryable: false } };
    const unknownError = { name: "UnknownError", data: { message: "tool registry failed to load" } };
    const lines = outputLines(
      [
        record(
          0,
          jsonl([
            ev.stepStart("msg_01", "prt_01"),
            ev.text("msg_01", "prt_02", "Starting."),
            ev.error(apiError),
            ev.error(unknownError),
            ev.error({ name: "ProviderAuthError" }),
          ]),
        ),
      ],
      { ...cancelled, status: "failed", error: "Rate limit exceeded\ntool registry failed to load\nProviderAuthError", errorCode: "adapter_failed" },
    );
    const [, text, api, notice, auth, result] = lines;
    expect(api).toMatchObject({
      type: "assistant",
      error: "unknown",
      is_api_error_message: true,
      api_error_code: "429",
      message: { content: [{ type: "text", text: "API Error: Rate limit exceeded" }] },
    });
    expect(api!.message.id).not.toBe(text!.message.id);
    expect(notice).toMatchObject({ type: "system", subtype: "paperclip_notice", level: "error", text: "tool registry failed to load" });
    expect(auth).toMatchObject({ subtype: "paperclip_notice", level: "error", text: "ProviderAuthError" });
    // The run error repeats the reported errors, so it is not added again.
    expect(result).toMatchObject({
      type: "result",
      is_error: true,
      subtype: "error_during_execution",
      errors: ["Rate limit exceeded", "tool registry failed to load", "ProviderAuthError"],
    });
    expect(lines).toHaveLength(6);
  });

  it("adds the run error when the output did not report it", () => {
    const lines = outputLines([record(0, jsonl([ev.stepStart("msg_01", "prt_01")]))], {
      ...cancelled,
      status: "timed_out",
      error: "Timed out after 600s",
      errorCode: "timeout",
    });
    expect(lines.at(-1)).toMatchObject({ is_error: true, errors: ["Timed out after 600s"] });
  });

  it("starts a session on its first event and again when the session changes", () => {
    const lines = outputLines(
      [
        record(0, "[paperclip] Resuming OpenCode session\n"),
        record(10, jsonl([ev.stepStart("msg_01", "prt_01"), ev.error({ name: "UnknownError", data: { message: "session broke" } })])),
        record(20, "[paperclip] OpenCode session is unavailable; retrying with a fresh session.\n"),
        record(
          30,
          jsonl([
            ev.stepStart("msg_10", "prt_10", SESSION_2),
            ev.text("msg_10", "prt_11", "Fresh start.", SESSION_2),
            ev.stepFinish("msg_10", "prt_12", "stop", 0.001, { input: 10, output: 5, reasoning: 0, read: 0, write: 0 }, SESSION_2),
          ]),
        ),
      ],
      { ...succeeded, usage: null },
    );
    expect(lines.map((line) => [line.subtype ?? line.type, line.session_id])).toEqual([
      ["paperclip_notice", `paperclip-run-${RUN_ID}`],
      ["init", SESSION],
      ["paperclip_notice", SESSION],
      ["paperclip_notice", SESSION],
      ["init", SESSION_2],
      ["assistant", SESSION_2],
      ["success", SESSION_2],
    ]);
  });

  it("gives every step its own message, also when steps share an opencode message", () => {
    const lines = outputLines([
      record(
        0,
        jsonl([
          ev.stepStart("msg_01", "prt_01"),
          ev.text("msg_01", "prt_02", "one"),
          ev.stepFinish("msg_01", "prt_03", "tool-calls", 0, { input: 1, output: 1, reasoning: 0, read: 0, write: 0 }),
          ev.stepStart("msg_01", "prt_04"),
          ev.text("msg_01", "prt_05", "two"),
          ev.text("msg_01", "prt_06", "three"),
        ]),
      ),
    ]);
    const ids = lines.filter((line) => line.type === "assistant").map((line) => line.message.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
  });

  it("notes a step that hit the output limit", () => {
    const lines = outputLines(
      [
        record(
          0,
          jsonl([
            ev.stepStart("msg_01", "prt_01"),
            ev.text("msg_01", "prt_02", "A long answer that got cut"),
            ev.stepFinish("msg_01", "prt_03", "length", 0, { input: 1, output: 1, reasoning: 0, read: 0, write: 0 }),
          ]),
        ),
      ],
      succeeded,
    );
    expect(lines.at(-2)).toMatchObject({ subtype: "paperclip_notice", level: "warn", text: "the model stopped at its output token limit" });
    expect(lines.at(-1)).toMatchObject({ type: "result", stop_reason: "max_tokens" });
  });

  it("emits unknown events and text as raw lines and host lines as notices", () => {
    const unknown = JSON.stringify(event("session_idle", { part: { type: "idle" } }));
    const noPart = JSON.stringify({ type: "tool_use", timestamp: 1 });
    const lines = outputLines([record(0, `${unknown}\nnot json\n[1,2]\n${noPart}\n[paperclip] host line\n`)]);
    expect(lines.map((line) => line.subtype)).toEqual([
      "paperclip_raw",
      "paperclip_raw",
      "paperclip_raw",
      "paperclip_raw",
      "paperclip_notice",
    ]);
    expect(lines[0]!.text).toBe(unknown);
    expect(lines[0]!.session_id).toBe(`paperclip-run-${RUN_ID}`);
    expect(lines[3]!.text).toBe(noPart);
  });

  it("splits a long text part into segments of one block", () => {
    const paragraph = `${"word ".repeat(399)}end.\n\n`;
    const long = paragraph.repeat(10);
    const lines = outputLines([record(0, jsonl([ev.stepStart("msg_01", "prt_01"), ev.text("msg_01", "prt_02", long)]))]);
    const segments = lines.filter((line) => line.type === "assistant");
    expect(segments.length).toBeGreaterThan(1);
    expect(new Set(segments.map((line) => line.paperclip.block)).size).toBe(1);
    expect(segments.map((line) => line.paperclip.seg)).toEqual(segments.map((_, index) => index));
    expect(segments.map((line) => line.paperclip.last)).toEqual(segments.map((_, index) => index === segments.length - 1));
    expect(segments.map((line) => contentOf(line).text).join("")).toBe(long);
  });

  it("repairs a line damaged by env-assignment redaction", () => {
    // The redaction ate the backslash of `\"` inside the text.
    const damaged = JSON.stringify(ev.text("msg_01", "prt_02", "PLACEHOLDER")).replace(
      "PLACEHOLDER",
      'export API_TOKEN=***REDACTED***" done',
    );
    expect(() => JSON.parse(damaged)).toThrow();
    const lines = outputLines([record(0, `${damaged}\n`)]);
    expect(lines.map((line) => line.subtype ?? line.type)).toEqual(["init", "assistant"]);
    expect(contentOf(lines[1]!).text).toBe('export API_TOKEN=***REDACTED***" done');
  });

  it("produces the same lines however the output is split into records", () => {
    const text = jsonl(TWO_STEP_RUN);
    // uuid and timestamp follow the record a line completes in; everything else must match.
    const normalize = (records: RunLogRecordInput[]) =>
      streamJsonItemLines(translate(records, succeeded).items).map((line) => {
        const { uuid: _uuid, timestamp: _timestamp, ...rest } = JSON.parse(line);
        return rest;
      });
    const whole = normalize([record(0, text)]);
    for (let cut = 1; cut < text.length; cut += 97) {
      const second = Math.min(text.length - 1, cut + 173);
      expect(
        normalize([record(0, text.slice(0, cut)), record(5, text.slice(cut, second)), record(9, text.slice(second))]),
      ).toEqual(whole);
    }
  });

  // The opencode UI parser is the reference reader of the source. The
  // translated output must carry the same text, reasoning, tool calls and
  // token totals.
  it("reads the same as the source does through the opencode UI parser", () => {
    const text = jsonl(TWO_STEP_RUN);
    const sourceEntries = text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => parseOpenCodeStdoutLine(line, "t"));
    const summarizeSource = (entries: TranscriptEntry[]): unknown[][] =>
      entries.flatMap((entry): unknown[][] => {
        switch (entry.kind) {
          case "assistant":
          case "thinking":
            return [[entry.kind, entry.text.trim()]];
          case "tool_call":
            return [["tool_call", entry.toolUseId, entry.name]];
          case "tool_result":
            return [["tool_result", entry.toolUseId, entry.isError]];
          default:
            return [];
        }
      });
    const summarizeTranslated = (lines: Array<Record<string, any>>): unknown[][] =>
      lines.flatMap((line): unknown[][] => {
        const block = line.message?.content?.[0];
        if (!block) return [];
        if (block.type === "text") return [["assistant", block.text.trim()]];
        if (block.type === "thinking") return [["thinking", block.thinking.trim()]];
        if (block.type === "tool_use") return [["tool_call", block.id, block.name]];
        if (block.type === "tool_result") return [["tool_result", block.tool_use_id, block.is_error]];
        return [];
      });

    const lines = outputLines([record(0, text)], { ...succeeded, usage: null });
    const source = summarizeSource(sourceEntries);
    expect(source.length).toBeGreaterThan(5);
    expect(summarizeTranslated(lines)).toEqual(source);

    const stepTotals = sourceEntries.reduce(
      (sum, entry) =>
        entry.kind === "result"
          ? {
              input: sum.input + entry.inputTokens,
              output: sum.output + entry.outputTokens,
              cached: sum.cached + entry.cachedTokens,
              cost: sum.cost + entry.costUsd,
            }
          : sum,
      { input: 0, output: 0, cached: 0, cost: 0 },
    );
    const result = lines.at(-1)!;
    expect(result.usage).toMatchObject({
      input_tokens: stepTotals.input,
      output_tokens: stepTotals.output,
      cache_read_input_tokens: stepTotals.cached,
    });
    expect(result.total_cost_usd).toBeCloseTo(stepTotals.cost, 10);
  });
});
