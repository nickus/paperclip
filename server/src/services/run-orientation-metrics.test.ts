import { describe, expect, it } from "vitest";
import {
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

  it("matches a spaced variant case-insensitively", () => {
    expect(isControlPlaneDenialErrorText("Access denied: Control Plane restricted")).toBe(true);
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

  it("counts read-only steps before the first mutating call, and tokens generated up to it", () => {
    const events: OrientationEvent[] = [
      { kind: "tool_call", callId: "1", toolName: "read" },
      { kind: "tool_result", callId: "1", isError: false, errorText: null },
      { kind: "step_finish", inputTokens: 1000, outputTokens: 50 },
      { kind: "tool_call", callId: "2", toolName: "grep" },
      { kind: "tool_result", callId: "2", isError: false, errorText: null },
      { kind: "step_finish", inputTokens: 1200, outputTokens: 30 },
      { kind: "tool_call", callId: "3", toolName: "write" },
      { kind: "tool_result", callId: "3", isError: false, errorText: null },
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(2);
    expect(result.genTokensBeforeFirstMutation).toBe(80);
    expect(result.peakContextTokens).toBe(1200);
  });

  it("reports 0 steps and 0 tokens when the very first tool call is already a mutation", () => {
    const events: OrientationEvent[] = [
      { kind: "tool_call", callId: "1", toolName: "write" },
      { kind: "tool_result", callId: "1", isError: false, errorText: null },
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBe(0);
    expect(result.genTokensBeforeFirstMutation).toBe(0);
  });

  it("leaves both first-mutation fields null when the run never mutates", () => {
    const events: OrientationEvent[] = [
      { kind: "tool_call", callId: "1", toolName: "read" },
      { kind: "step_finish", inputTokens: 500, outputTokens: 40 },
      { kind: "tool_call", callId: "2", toolName: "paperclip_get_issue" },
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.stepsBeforeFirstMutation).toBeNull();
    expect(result.genTokensBeforeFirstMutation).toBeNull();
  });

  it("dedupes repeated status-transition lines for the same tool call", () => {
    const events: OrientationEvent[] = [
      { kind: "tool_call", callId: "1", toolName: "bash" },
      { kind: "tool_call", callId: "1", toolName: "bash" },
      { kind: "tool_result", callId: "1", isError: false, errorText: null },
      { kind: "tool_call", callId: "2", toolName: "write" },
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    // Only one distinct step ("1") precedes the mutating call ("2").
    expect(result.stepsBeforeFirstMutation).toBe(1);
  });

  it("counts skill loads independently of mutation status", () => {
    const events: OrientationEvent[] = [
      { kind: "tool_call", callId: "1", toolName: "skill" },
      { kind: "tool_call", callId: "2", toolName: "skill" },
      { kind: "tool_call", callId: "3", toolName: "write" },
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.skillLoads).toBe(2);
  });

  it("counts only control-plane-denial tool errors", () => {
    const events: OrientationEvent[] = [
      {
        kind: "tool_result",
        callId: "1",
        isError: true,
        errorText: "Low-trust actors cannot use this control-plane surface",
      },
      { kind: "tool_result", callId: "2", isError: true, errorText: "network timeout" },
      { kind: "tool_result", callId: "3", isError: false, errorText: null },
    ];
    const result = computeRunOrientationMetricsFromEvents(events);
    expect(result.controlPlaneDenials).toBe(1);
  });

  it("tracks the peak, not the sum, of per-step input tokens", () => {
    const events: OrientationEvent[] = [
      { kind: "step_finish", inputTokens: 500, outputTokens: 10 },
      { kind: "step_finish", inputTokens: 300, outputTokens: 10 },
      { kind: "step_finish", inputTokens: 900, outputTokens: 10 },
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
        part: { tool: "write", callID: "call_1", state: { status: "completed" } },
      }),
      JSON.stringify({
        type: "step_finish",
        part: { tokens: { input: 1234, output: 56, reasoning: 4, cache: { read: 10 } } },
      }),
    ];
    const events = parseOpenCodeStdoutForOrientation(lines.join("\n"));
    expect(events).toEqual([
      { kind: "tool_call", callId: "call_1", toolName: "write" },
      { kind: "tool_call", callId: "call_1", toolName: "write" },
      { kind: "tool_result", callId: "call_1", isError: false, errorText: null },
      { kind: "step_finish", inputTokens: 1244, outputTokens: 60 },
    ]);
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
      { kind: "tool_call", callId: "call_2", toolName: "paperclip_update_issue" },
      {
        kind: "tool_result",
        callId: "call_2",
        isError: true,
        errorText: "Low-trust actors cannot use this control-plane surface",
      },
    ]);
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

  it("leaves tool-call fields null when the captured stdout exceeds the cheap-parsing cap", () => {
    const oversizedStdout = "x".repeat(RUN_ORIENTATION_MAX_STDOUT_BYTES + 1);
    const result = deriveRunOrientationMetrics({
      adapterType: "opencode_local",
      adapterResultJson: { stdout: oversizedStdout },
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
