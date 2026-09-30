import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import {
  buildRunLogContent,
  DEFAULT_STREAM_JSON_LIMITS,
  streamJsonItemLines,
  translateRunLogContent,
  utf8ByteLength,
  type RunLogRecordInput,
  type StreamJsonRunOutcome,
} from "@paperclipai/adapter-utils/stream-json";
import { parseClaudeStdoutLine } from "../ui/parse-stdout.js";
import { claudeStreamJsonTranslator } from "./stream-json.js";

// Synthetic Claude Code stream-json, shaped like `claude --print
// --output-format stream-json --verbose` output.
const SESSION = "5b0c3d1e-0000-4000-8000-000000000001";
const usage = { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 5, cache_read_input_tokens: 67 };
const assistantMessage = (id: string, block: Record<string, unknown>) => ({
  type: "assistant",
  message: {
    id,
    type: "message",
    role: "assistant",
    model: "claude-test-model",
    content: [block],
    stop_reason: null,
    stop_sequence: null,
    usage,
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: `uuid-${id}-${String(block.type)}`,
});

const LINES = {
  init: {
    type: "system",
    subtype: "init",
    cwd: "/workspace",
    session_id: SESSION,
    tools: ["Bash", "Read"],
    mcp_servers: [],
    model: "claude-test-model",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "9.9.9",
    output_style: "default",
    uuid: "uuid-init",
  },
  thinking: assistantMessage("msg_01", { type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" }),
  toolUse: assistantMessage("msg_01", { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } }),
  toolResult: {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "a\nb", is_error: false }] },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: "uuid-result-1",
    tool_use_result: { stdout: "a\nb", stderr: "", interrupted: false },
  },
  thinkingTokens: { type: "system", subtype: "thinking_tokens", tokens: 42, session_id: SESSION, uuid: "uuid-tt" },
  rateLimit: {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", resetsAt: 1_900_000_000, rateLimitType: "five_hour" },
    uuid: "uuid-rl",
    session_id: SESSION,
  },
  taskStarted: { type: "system", subtype: "task_started", task_id: "task-1", description: "Explore", session_id: SESSION, uuid: "uuid-ts" },
  taskNotification: {
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    status: "completed",
    summary: "Explored",
    session_id: SESSION,
    uuid: "uuid-tn",
  },
  failedTool: assistantMessage("msg_02", { type: "tool_use", id: "toolu_02", name: "Read", input: { file_path: "missing" } }),
  failedToolResult: {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "not found", is_error: true }] },
    parent_tool_use_id: null,
    session_id: SESSION,
    uuid: "uuid-result-2",
  },
  apiError: {
    ...assistantMessage("msg_03", { type: "text", text: "API Error: 529 overloaded" }),
    error: "unknown",
    is_api_error_message: true,
    api_error_code: "529",
  },
  text: assistantMessage("msg_04", { type: "text", text: "All done." }),
  result: {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 4321,
    duration_api_ms: 4000,
    num_turns: 4,
    result: "All done.",
    session_id: SESSION,
    total_cost_usd: 0.0123,
    usage,
    modelUsage: { "claude-test-model": { inputTokens: 12, outputTokens: 34 } },
    permission_denials: [],
    stop_reason: "end_turn",
    terminal_reason: "completed",
    uuid: "uuid-final",
  },
};

const T0 = Date.parse("2026-02-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function record(ms: number, chunk: string, stream: "stdout" | "stderr" = "stdout"): RunLogRecordInput {
  return { stream, chunk, ts: at(ms), seq: ms + 1 };
}

function translate(records: RunLogRecordInput[], outcome?: StreamJsonRunOutcome) {
  return translateRunLogContent({
    runId: "run-claude",
    adapterType: "claude_local",
    translator: claudeStreamJsonTranslator,
    content: buildRunLogContent(records),
    outcome,
  });
}

const cancelled: StreamJsonRunOutcome = {
  status: "cancelled",
  startedAt: at(0),
  finishedAt: at(10_000),
  error: "cancelled by user",
  errorCode: "cancelled",
  usage: null,
};

describe("claudeStreamJsonTranslator", () => {
  const sourceLines = Object.values(LINES).map((line) => JSON.stringify(line));

  it("passes every Claude stream-json object line through byte for byte", () => {
    // Split the output over records the way a process pipe delivers it.
    const text = sourceLines.map((line) => `${line}\n`).join("");
    const records = [record(0, text.slice(0, 700)), record(10, text.slice(700, 2500)), record(20, text.slice(2500))];
    const { items } = translate(records, { ...cancelled, status: "succeeded", error: null });
    expect(streamJsonItemLines(items)).toEqual(sourceLines);
  });

  it.each([
    ["system/init", LINES.init],
    ["system/thinking_tokens", LINES.thinkingTokens],
    ["rate_limit_event", LINES.rateLimit],
    ["system/task_started", LINES.taskStarted],
    ["system/task_notification", LINES.taskNotification],
    ["an API-error assistant line", LINES.apiError],
    ["a thinking block with an empty text and a signature", LINES.thinking],
  ])("keeps %s unchanged", (_label, line) => {
    const source = JSON.stringify(line);
    expect(streamJsonItemLines(translate([record(0, `${source}\n`)]).items)).toEqual([source]);
  });

  it("turns host lines into notices and ACP engine lines into raw lines (for now)", () => {
    const acpx = JSON.stringify({ type: "acpx.text_delta", text: "hi", channel: "output" });
    const lines = streamJsonItemLines(
      translate([record(0, `[paperclip] Resuming session ${SESSION}\n${acpx}\nplain text\n[1,2]\n`)]).items,
    ).map((line) => JSON.parse(line));
    expect(lines.map((line) => line.subtype)).toEqual(["paperclip_notice", "paperclip_raw", "paperclip_raw", "paperclip_raw"]);
    expect(lines[1].text).toBe(acpx);
  });

  it("passes stderr through as raw text", () => {
    const { items } = translate([record(0, "some stderr\n", "stderr")]);
    expect(items).toEqual([expect.objectContaining({ stream: "stderr", chunk: "some stderr\n", lines: 1 })]);
  });

  it("repairs a line damaged by env-assignment redaction", () => {
    // The redaction ate the backslash of `\"` in a tool input.
    const damaged = JSON.stringify(LINES.toolUse).replace('"ls"', '"echo API_TOKEN=***REDACTED***" done"');
    expect(() => JSON.parse(damaged)).toThrow();
    const [line] = streamJsonItemLines(translate([record(0, `${damaged}\n`)]).items);
    expect(JSON.parse(line!).message.content[0].input.command).toBe('echo API_TOKEN=***REDACTED***" done');
  });

  it("shrinks a line over the size cap instead of cutting it into invalid JSON", () => {
    const big = { ...LINES.toolResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "x".repeat(300_000), is_error: false }] } };
    const [line] = streamJsonItemLines(translate([record(0, `${JSON.stringify(big)}\n`)]).items);
    expect(utf8ByteLength(line!)).toBeLessThanOrEqual(DEFAULT_STREAM_JSON_LIMITS.maxLineBytes);
    const parsed = JSON.parse(line!);
    expect(parsed).toMatchObject({ type: "user", uuid: "uuid-result-1", paperclip: { truncated: true } });
    expect(parsed.message.content[0].tool_use_id).toBe("toolu_01");
  });

  it("synthesizes a result only when the run ended without one", () => {
    const withResult = streamJsonItemLines(
      translate([record(0, `${JSON.stringify(LINES.text)}\n${JSON.stringify(LINES.result)}\n`)], cancelled).items,
    );
    expect(withResult.filter((line) => JSON.parse(line).type === "result")).toHaveLength(1);

    const withoutResult = streamJsonItemLines(
      translate([record(0, `${JSON.stringify(LINES.init)}\n${JSON.stringify(LINES.text)}\n`)], cancelled).items,
    ).map((line) => JSON.parse(line));
    expect(withoutResult.at(-1)).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: SESSION,
      result: "",
      errors: ["cancelled by user"],
      paperclip: { synthesized: true, runStatus: "cancelled", errorCode: "cancelled" },
    });
  });

  // The Claude UI parser is the reference reader of this format. For the line
  // types it understands (init, assistant, user, result) the translated
  // output must read exactly like the source. It treats the other types as
  // opaque text, so they are covered by the byte-for-byte cases above.
  it("reads the same as the source through the Claude UI parser", () => {
    const text = [...sourceLines, "[paperclip] host line"].map((line) => `${line}\n`).join("");
    const { items } = translate([record(0, text)]);
    const summarize = (entries: TranscriptEntry[]): unknown[][] =>
      entries.flatMap((entry): unknown[][] => {
        switch (entry.kind) {
          case "init":
            return [["init", entry.sessionId, entry.model]];
          case "assistant":
          case "thinking":
            return [[entry.kind, entry.text.replace(/\s+/g, " ")]];
          case "tool_call":
            return [["tool_call", entry.toolUseId, entry.name]];
          case "tool_result":
            return [["tool_result", entry.toolUseId, entry.isError]];
          case "result":
            return [["result", entry.inputTokens, entry.outputTokens, entry.cachedTokens, entry.costUsd, entry.isError]];
          default:
            return [];
        }
      });
    const source = summarize(text.split("\n").filter(Boolean).flatMap((line) => parseClaudeStdoutLine(line, "t")));
    const translated = summarize(streamJsonItemLines(items).flatMap((line) => parseClaudeStdoutLine(line, "t")));
    expect(source.length).toBeGreaterThan(5);
    expect(translated).toEqual(source);
  });
});
