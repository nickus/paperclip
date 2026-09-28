import { describe, expect, it } from "vitest";
import { appendWithCap } from "@paperclipai/adapter-utils/server-utils";
import {
  classifyMutatingBashCommand,
  classifyMutatingToolCall,
  computeRunOrientationMetricsFromEvents,
  deriveRunOrientationMetrics,
  isControlPlaneDenialErrorText,
  isControlPlaneToolName,
  isSkillLoadToolCall,
  NULL_RUN_ORIENTATION_METRICS,
  parseOpenCodeStdoutForOrientation,
  RUN_ORIENTATION_MAX_STDOUT_BYTES,
  type OrientationEvent,
} from "./run-orientation-metrics.js";

// Shared fixture builders so event-stream tests only spell out the fields
// they actually vary.
function toolCall(
  callId: string,
  toolName: string,
  command: string | null = null,
): OrientationEvent {
  return { kind: "tool_call", callId, toolName, command };
}

function toolResult(
  callId: string,
  toolName: string,
  opts: { isError?: boolean; errorText?: string | null; outputText?: string | null } = {},
): OrientationEvent {
  return {
    kind: "tool_result",
    callId,
    toolName,
    isError: opts.isError ?? false,
    errorText: opts.errorText ?? null,
    outputText: opts.outputText ?? null,
  };
}

function stepFinish(inputTokens: number, outputTokens: number): OrientationEvent {
  return { kind: "step_finish", inputTokens, outputTokens };
}

describe("classifyMutatingToolCall", () => {
  it("treats known file-write tools as mutations", () => {
    for (const name of ["write", "edit", "multiedit", "patch", "apply_patch", "Str_Replace"]) {
      expect(classifyMutatingToolCall(name)).toBe(true);
    }
  });

  it("treats read/search tools as non-mutations", () => {
    for (const name of ["read", "grep", "list", "glob", "bash", "webfetch"]) {
      expect(classifyMutatingToolCall(name)).toBe(false);
    }
  });

  it("treats a mutating Paperclip control-plane call as a mutation", () => {
    expect(classifyMutatingToolCall("paperclip_update_issue")).toBe(true);
    expect(classifyMutatingToolCall("paperclip_post_comment")).toBe(true);
    expect(classifyMutatingToolCall("paperclip.create_work_product")).toBe(true);
    expect(classifyMutatingToolCall("mcp__paperclip_add_comment")).toBe(true);
  });

  it("treats a read-only Paperclip control-plane call as a non-mutation", () => {
    expect(classifyMutatingToolCall("paperclip_get_issue")).toBe(false);
    expect(classifyMutatingToolCall("paperclip_list_comments")).toBe(false);
  });

  it("never treats a non-Paperclip MCP tool as a control-plane mutation", () => {
    // Same write-shaped verb, but not a Paperclip control-plane tool: this
    // classifier only recognizes the Paperclip API as a "control plane" per
    // the run-orientation definition, not arbitrary third-party connectors.
    expect(classifyMutatingToolCall("notion-create-comment")).toBe(false);
  });

  it("is case- and separator-insensitive", () => {
    expect(classifyMutatingToolCall("PAPERCLIP_UPDATE_ISSUE")).toBe(true);
    expect(classifyMutatingToolCall("paperclipUpdateIssue")).toBe(true);
  });

  it("returns false for empty or non-string-like input", () => {
    expect(classifyMutatingToolCall("")).toBe(false);
    expect(classifyMutatingToolCall("   ")).toBe(false);
  });
});

describe("classifyMutatingBashCommand", () => {
  it("treats a curl PATCH/POST against the Paperclip API URL as a mutation", () => {
    expect(
      classifyMutatingBashCommand(
        `curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/issues/abc" -d '{"status":"done"}'`,
      ),
    ).toBe(true);
    expect(
      classifyMutatingBashCommand(
        `curl -s -X POST "\${PAPERCLIP_API_URL}/api/issues/abc/comments" -d '{"body":"hi"}'`,
      ),
    ).toBe(true);
  });

  it("treats a curl call with a data body (implicit POST) against the API URL as a mutation", () => {
    expect(
      classifyMutatingBashCommand(`curl -s "$PAPERCLIP_API_URL/api/issues/abc" --data '{"status":"done"}'`),
    ).toBe(true);
  });

  it("treats invoking the repo's issue-update helper script as a mutation", () => {
    expect(
      classifyMutatingBashCommand(`scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done`),
    ).toBe(true);
  });

  it("does not treat a dry run of the helper script as a mutation", () => {
    expect(
      classifyMutatingBashCommand(
        `scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done --dry-run`,
      ),
    ).toBe(false);
  });

  it("does not treat a read-only (GET) call against the API URL as a mutation", () => {
    expect(classifyMutatingBashCommand(`curl -s "$PAPERCLIP_API_URL/api/issues/abc"`)).toBe(false);
  });

  it("does not treat a write-shaped curl call against an unrelated URL as a mutation", () => {
    expect(
      classifyMutatingBashCommand(`curl -s -X POST "https://example.com/webhook" -d '{"x":1}'`),
    ).toBe(false);
  });

  it("returns false for empty, non-string, or unrelated commands", () => {
    expect(classifyMutatingBashCommand("")).toBe(false);
    expect(classifyMutatingBashCommand(null)).toBe(false);
    expect(classifyMutatingBashCommand(undefined)).toBe(false);
    expect(classifyMutatingBashCommand("ls -la")).toBe(false);
  });
});

describe("isControlPlaneToolName", () => {
  it("recognizes the Paperclip control-plane prefixes", () => {
    expect(isControlPlaneToolName("paperclip_get_issue")).toBe(true);
    expect(isControlPlaneToolName("paperclip.get_issue")).toBe(true);
    expect(isControlPlaneToolName("mcp__paperclip_get_issue")).toBe(true);
  });

  it("rejects unrelated tool names", () => {
    expect(isControlPlaneToolName("write")).toBe(false);
    expect(isControlPlaneToolName("notion-create-comment")).toBe(false);
  });
});

describe("isSkillLoadToolCall", () => {
  it("matches the known skill-loading tool names", () => {
    expect(isSkillLoadToolCall("skill")).toBe(true);
    expect(isSkillLoadToolCall("Skill")).toBe(true);
    expect(isSkillLoadToolCall("use_skill")).toBe(true);
  });

  it("does not match unrelated tools, including ones that merely mention skills", () => {
    expect(isSkillLoadToolCall("read")).toBe(false);
    expect(isSkillLoadToolCall("skillful-formatter")).toBe(false);
  });
});

describe("isControlPlaneDenialErrorText", () => {
  it("matches the exact server denial wording", () => {
    expect(
      isControlPlaneDenialErrorText("Low-trust actors cannot use this control-plane surface"),
    ).toBe(true);
  });

  it("matches case-insensitively and as a substring of a larger body", () => {
    expect(
      isControlPlaneDenialErrorText(
        '{"error":"low-trust actors cannot use this control-plane surface"}',
      ),
    ).toBe(true);
  });

  it("does not match unrelated text that merely mentions a control plane", () => {
    // A loose "mentions control plane" pattern would also count unrelated
    // failures (e.g. from cluster-management tooling) as a Paperclip
    // denial; only the server's own exact wording should count.
    expect(isControlPlaneDenialErrorText("Kubernetes control plane is unreachable")).toBe(false);
    expect(isControlPlaneDenialErrorText("Access denied: control plane restricted")).toBe(false);
  });

  it("does not match unrelated error text", () => {
    expect(isControlPlaneDenialErrorText("file not found")).toBe(false);
    expect(isControlPlaneDenialErrorText("")).toBe(false);
  });
});

describe("computeRunOrientationMetricsFromEvents", () => {
  it("returns all-null/zero tool-call fields when there are no events", () => {
    const result = computeRunOrientationMetricsFromEvents([]);
    expect(result).toEqual({
      stepsBeforeFirstMutation: null,
      genTokensBeforeFirstMutation: null,
      skillLoads: 0,
      controlPlaneDenials: 0,
      peakContextTokens: null,
    });
  });

  it("counts read-only steps before the first mutating call, and tokens generated up to and including it", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "read"),
      toolResult("1", "read"),
      stepFinish(1000, 50),
      toolCall("2", "grep"),
      toolResult("2", "grep"),
      stepFinish(1200, 30),
      toolCall("3", "write"),
      toolResult("3", "write"),
      stepFinish(400, 15),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(2);
    // 50 + 30 generated in the two prior steps, plus 15 generated in the
    // step that produced the mutating call itself.
    expect(result.genTokensBeforeFirstMutation).toBe(95);
    expect(result.peakContextTokens).toBe(1200);
  });

  it("reports 0 steps when the very first tool call is already a confirmed mutation", () => {
    const events: OrientationEvent[] = [toolCall("1", "write"), toolResult("1", "write")];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(0);
    expect(result.genTokensBeforeFirstMutation).toBe(0);
  });

  it("leaves both first-mutation fields null when the run never mutates", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "read"),
      toolResult("1", "read"),
      stepFinish(500, 40),
      toolCall("2", "paperclip_get_issue"),
      toolResult("2", "paperclip_get_issue"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBeNull();
    expect(result.genTokensBeforeFirstMutation).toBeNull();
  });

  it("does not count a file-write call that errored as the first mutation", () => {
    // e.g. an `edit` whose anchor text was not found in the file: the tool
    // reports an error, and nothing was actually written.
    const events: OrientationEvent[] = [
      toolCall("1", "edit"),
      toolResult("1", "edit", { isError: true, errorText: "could not find anchor text" }),
      toolCall("2", "edit"),
      toolResult("2", "edit"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    // Both calls precede the confirmed mutation (call "2"): the failed
    // attempt still counts as a step, just not as *the* mutation.
    expect(result.stepsBeforeFirstMutation).toBe(1);
  });

  it("still reports the run's real first confirmed mutation when an earlier candidate never resolves", () => {
    // A run whose log ends mid-call (killed, disconnected, ...): the first
    // candidate never gets a tool_result at all, so it can't be confirmed.
    const events: OrientationEvent[] = [
      toolCall("1", "write"), // never resolved
      toolCall("2", "read"),
      toolResult("2", "read"),
      toolCall("3", "edit"),
      toolResult("3", "edit"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(2);
  });

  it("dedupes repeated status-transition lines for the same tool call", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "bash"),
      toolCall("1", "bash"),
      toolResult("1", "bash"),
      toolCall("2", "write"),
      toolResult("2", "write"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    // Only one distinct step ("1") precedes the mutating call ("2").
    expect(result.stepsBeforeFirstMutation).toBe(1);
  });

  it("counts skill loads independently of mutation status", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "skill"),
      toolResult("1", "skill"),
      toolCall("2", "skill"),
      toolResult("2", "skill"),
      toolCall("3", "write"),
      toolResult("3", "write"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.skillLoads).toBe(2);
  });

  it("classifies a bash call that mutates the Paperclip API through curl as a mutation", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "read"),
      toolResult("1", "read"),
      toolCall(
        "2",
        "bash",
        `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/abc" -d '{"status":"in_progress"}'`,
      ),
      toolResult("2", "bash", { outputText: '{"id":"abc","status":"in_progress"}' }),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(1);
  });

  it("does not classify a checkout-only (read) bash/curl call as a mutation", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "bash", `curl -s "$PAPERCLIP_API_URL/api/issues/abc"`),
      toolResult("1", "bash", { outputText: '{"id":"abc","status":"queued"}' }),
      toolCall("2", "write"),
      toolResult("2", "write"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(1);
  });

  it("does not count a bash/curl mutation attempt the control plane denied", () => {
    const events: OrientationEvent[] = [
      toolCall(
        "1",
        "bash",
        `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/abc" -d '{"status":"done"}'`,
      ),
      toolResult("1", "bash", {
        outputText:
          '{"error":"Low-trust actors cannot use this control-plane surface"}',
      }),
      toolCall("2", "write"),
      toolResult("2", "write"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    // The curl call exits 0 (the denial is just an HTTP 403 body), so
    // opencode reports it as a completed, non-error tool call — but it
    // didn't actually mutate anything, so "write" is the real first
    // mutation.
    expect(result.stepsBeforeFirstMutation).toBe(1);
    expect(result.controlPlaneDenials).toBe(1);
  });

  it("counts a control-plane denial surfaced as a normal tool error", () => {
    const events: OrientationEvent[] = [
      toolCall("1", "paperclip_update_issue"),
      toolResult("1", "paperclip_update_issue", {
        isError: true,
        errorText: "Low-trust actors cannot use this control-plane surface",
      }),
      toolCall("2", "bash", "echo hi"),
      toolResult("2", "bash", { isError: true, errorText: "network timeout" }),
      toolCall("3", "read"),
      toolResult("3", "read"),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.controlPlaneDenials).toBe(1);
  });

  it("does not scan a non-shell tool's completed output for a denial", () => {
    // Only a shell tool's own output can hide an HTTP response body this
    // way; a read tool that happens to display this exact sentence (e.g.
    // reading this very source file) must not be counted as a denial.
    const events: OrientationEvent[] = [
      toolCall("1", "read"),
      toolResult("1", "read", {
        outputText: "// Low-trust actors cannot use this control-plane surface",
      }),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.controlPlaneDenials).toBe(0);
  });

  it("tracks the peak, not the sum, of per-step input tokens", () => {
    const events: OrientationEvent[] = [
      stepFinish(500, 10),
      stepFinish(300, 10),
      stepFinish(900, 10),
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.peakContextTokens).toBe(900);
  });
});

describe("parseOpenCodeStdoutForOrientation", () => {
  it("returns no events for empty or non-string input", () => {
    expect(parseOpenCodeStdoutForOrientation("")).toEqual([]);
    // @ts-expect-error exercising defensive runtime handling
    expect(parseOpenCodeStdoutForOrientation(null)).toEqual([]);
  });

  it("skips malformed lines without throwing", () => {
    const stdout = ['not json', '{"broken', '{"type":"text","part":{"text":"hi"}}'].join("\n");
    expect(() => parseOpenCodeStdoutForOrientation(stdout)).not.toThrow();
    expect(parseOpenCodeStdoutForOrientation(stdout)).toEqual([]);
  });

  it("extracts a tool call, its completion, and step token usage in order", () => {
    const lines = [
      JSON.stringify({
        type: "tool_use",
        part: { tool: "write", callID: "call_1", state: { status: "pending" } },
      }),
      JSON.stringify({
        type: "tool_use",
        part: { tool: "write", callID: "call_1", state: { status: "completed", output: "wrote 3 lines" } },
      }),
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 1234, output: 56, reasoning: 4, cache: { read: 10, write: 0 } } },
      }),
    ];
    const events = parseOpenCodeStdoutForOrientation(lines.join("\n"));
    expect(events).toEqual([
      { kind: "tool_call", callId: "call_1", toolName: "write", command: null },
      { kind: "tool_call", callId: "call_1", toolName: "write", command: null },
      {
        kind: "tool_result",
        callId: "call_1",
        toolName: "write",
        isError: false,
        errorText: null,
        outputText: "wrote 3 lines",
      },
      { kind: "step_finish", inputTokens: 1244, outputTokens: 60 },
    ]);
  });

  it("includes cache-write tokens in a step's input token total", () => {
    const line = JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: 12, output: 1, cache: { read: 0, write: 40000 } } },
    });
    const events = parseOpenCodeStdoutForOrientation(line);
    expect(events).toEqual([{ kind: "step_finish", inputTokens: 40012, outputTokens: 1 }]);
  });

  it("extracts a shell tool's command argument", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "bash",
        callID: "call_2",
        state: {
          status: "completed",
          input: { command: `curl -s "$PAPERCLIP_API_URL/api/issues/abc"` },
          output: '{"id":"abc"}',
        },
      },
    });
    const [callEvent] = parseOpenCodeStdoutForOrientation(line);
    expect(callEvent).toEqual({
      kind: "tool_call",
      callId: "call_2",
      toolName: "bash",
      command: `curl -s "$PAPERCLIP_API_URL/api/issues/abc"`,
    });
  });

  it("extracts a tool error with its message", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "paperclip_update_issue",
        id: "call_2",
        state: { status: "error", error: "Low-trust actors cannot use this control-plane surface" },
      },
    });
    const events = parseOpenCodeStdoutForOrientation(line);
    expect(events).toEqual([
      { kind: "tool_call", callId: "call_2", toolName: "paperclip_update_issue", command: null },
      {
        kind: "tool_result",
        callId: "call_2",
        toolName: "paperclip_update_issue",
        isError: true,
        errorText: "Low-trust actors cannot use this control-plane surface",
        outputText: null,
      },
    ]);
  });

  it("carries a completed bash call's output, where a control-plane denial would be embedded", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "bash",
        callID: "call_3",
        state: {
          status: "completed",
          input: { command: `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/abc" -d '{}'` },
          output: '{"error":"Low-trust actors cannot use this control-plane surface"}',
        },
      },
    });
    const events = parseOpenCodeStdoutForOrientation(line);
    const result = events.find((event) => event.kind === "tool_result");
    expect(result).toMatchObject({
      isError: false,
      outputText: '{"error":"Low-trust actors cannot use this control-plane surface"}',
    });
  });
});

describe("deriveRunOrientationMetrics", () => {
  it("returns the null baseline with session fields for a non-opencode adapter", () => {
    const result = deriveRunOrientationMetrics({
      adapterType: "claude_local",
      adapterResultJson: { stdout: "irrelevant for this adapter" },
      sessionResumed: true,
      sessionResumeReason: "issue_comment_mentioned",
    });
    expect(result).toEqual({
      ...NULL_RUN_ORIENTATION_METRICS,
      sessionResumed: true,
      sessionResumeReason: "issue_comment_mentioned",
    });
  });

  it("clears the resume reason when the session was not resumed", () => {
    const result = deriveRunOrientationMetrics({
      adapterType: "opencode_local",
      adapterResultJson: {},
      sessionResumed: false,
      sessionResumeReason: "issue_comment_mentioned",
    });
    expect(result.sessionResumed).toBe(false);
    expect(result.sessionResumeReason).toBeNull();
  });

  it("computes tool-call-derived fields for opencode_local from adapterResult.resultJson.stdout", () => {
    const stdout = [
      JSON.stringify({ type: "tool_use", part: { tool: "read", callID: "1", state: { status: "completed" } } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 800, output: 20 } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "write", callID: "2", state: { status: "completed" } } }),
    ].join("\n");

    const result = deriveRunOrientationMetrics({
      adapterType: "opencode_local",
      adapterResultJson: { stdout },
      sessionResumed: false,
      sessionResumeReason: null,
    });

    expect(result.stepsBeforeFirstMutation).toBe(1);
    expect(result.genTokensBeforeFirstMutation).toBe(20);
    expect(result.peakContextTokens).toBe(800);
    expect(result.skillLoads).toBe(0);
    expect(result.controlPlaneDenials).toBe(0);
    expect(result.sessionResumed).toBe(false);
  });

  it("counts a mutating Paperclip API call made through bash/curl", () => {
    const stdout = [
      JSON.stringify({ type: "tool_use", part: { tool: "read", callID: "1", state: { status: "completed" } } }),
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "bash",
          callID: "2",
          state: {
            status: "completed",
            input: { command: `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/abc" -d '{"status":"done"}'` },
            output: '{"id":"abc","status":"done"}',
          },
        },
      }),
    ].join("\n");

    const result = deriveRunOrientationMetrics({
      adapterType: "opencode_local",
      adapterResultJson: { stdout },
      sessionResumed: false,
      sessionResumeReason: null,
    });

    expect(result.stepsBeforeFirstMutation).toBe(1);
  });

  it("leaves tool-call fields null when opencode_local has no stdout to inspect", () => {
    const result = deriveRunOrientationMetrics({
      adapterType: "opencode_local",
      adapterResultJson: {},
      sessionResumed: false,
      sessionResumeReason: null,
    });
    expect(result.stepsBeforeFirstMutation).toBeNull();
    expect(result.skillLoads).toBeNull();
    expect(result.peakContextTokens).toBeNull();
  });

  it("leaves tool-call fields null when the captured stdout was tail-truncated by the adapter's own cap", () => {
    // Mirrors production: the adapter never hands this module a stream
    // longer than the cap in the first place — it appends every chunk
    // through the same `appendWithCap` that keeps only the tail once the
    // total grows past MAX_CAPTURE_BYTES. Build a stream via that same
    // function, the way the real adapter does, rather than asserting
    // against a stream shape production can never produce.
    const rawLine = `${JSON.stringify({ type: "tool_use", part: { tool: "read", callID: "1", state: { status: "completed" } } })}\n`;
    const repeats = Math.ceil((RUN_ORIENTATION_MAX_STDOUT_BYTES * 1.5) / rawLine.length);
    // One oversized chunk hits the same `combined.length > cap` branch a
    // long run's many smaller stdout chunks eventually would; the cap only
    // cares about the total, not how many appends produced it.
    const stdout = appendWithCap("", rawLine.repeat(repeats));
    // Confirms the fixture actually exercises truncation, and stays in sync
    // if the adapter-utils cap ever changes.
    expect(stdout.length).toBe(RUN_ORIENTATION_MAX_STDOUT_BYTES);

    const result = deriveRunOrientationMetrics({
      adapterType: "opencode_local",
      adapterResultJson: { stdout },
      sessionResumed: false,
      sessionResumeReason: null,
    });
    expect(result.stepsBeforeFirstMutation).toBeNull();
    expect(result.skillLoads).toBeNull();
  });

  it("never throws on an unexpected adapterResultJson shape", () => {
    expect(() =>
      deriveRunOrientationMetrics({
        adapterType: "opencode_local",
        // @ts-expect-error exercising defensive runtime handling
        adapterResultJson: "not an object",
        sessionResumed: false,
        sessionResumeReason: null,
      }),
    ).not.toThrow();
  });
});
