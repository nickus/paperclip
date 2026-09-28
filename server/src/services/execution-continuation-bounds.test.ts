import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  EXECUTION_CONTINUATION_HARD_CAP_BYTES,
  EXECUTION_CONTINUATION_TARGET_BYTES,
  boundContinuationJsonValue,
  boundExecutionContinuation,
  continuationMessageUnchanged,
  executionContinuationBytes,
} from "./execution-continuation-bounds.js";

type Message = ExecutionContinuationEnvelope["messages"][number];

function message(index: number, overrides: Partial<Message> = {}): Message {
  const isUser = index % 5 === 0;
  return {
    id: `comment-${String(index).padStart(3, "0")}`,
    authorType: isUser ? "user" : "agent",
    authorId: isUser ? "board-user" : "agent-1",
    createdByRunId: null,
    // Agent progress reports on a long task run to a few KB each.
    body: `${isUser ? "Request" : "Progress report"} ${index}: ${"lorem ipsum dolor sit amet ".repeat(isUser ? 20 : 110)}`,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    deleted: false,
    sourceTrust: null,
    ...overrides,
  };
}

/** A long-lived task: 150 comments, 40 document writes, a large answered question card. */
function longLivedTaskEnvelope(): ExecutionContinuationEnvelope {
  const messages = Array.from({ length: 150 }, (_, index) => message(index));
  // One very long user comment in the middle of the thread.
  messages[70] = message(70, { authorType: "user", authorId: "board-user", body: "Spec: " + "details ".repeat(8_000) });
  const questionResult = {
    version: 1,
    answers: Array.from({ length: 60 }, (_, index) => ({
      questionId: `q${index}`,
      selectedOptionIds: [`option-${index}`],
      freeText: "Longer free-text answer with context. ".repeat(80),
    })),
    summaryMarkdown: "## Answers\n" + "- chosen option with rationale\n".repeat(2_000),
  };
  return {
    version: 1,
    companyId: "company-1",
    issueId: "issue-1",
    trigger: { reason: "interaction_resolved", interactionId: "question-card", sourceRunId: "run-prev" },
    originCommentIds: ["comment-005", "comment-145"],
    objective: messages[145]!.body,
    messages,
    interactionOutcomes: [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `interaction-${index}`,
        kind: "request_confirmation",
        status: "accepted",
        result: { outcome: "accepted", note: "ok ".repeat(300) },
      })),
      { id: "question-card", kind: "ask_user_questions", status: "answered", result: questionResult },
    ],
    completedActions: Array.from({ length: 40 }, (_, index) => ({
      runId: `run-${index}`,
      receiptId: `receipt-${index}`,
      operationId: "save_document",
      // Tool receipts of document writes echo the document body.
      result: { documentKey: `doc-${index}`, body: "# Document\n" + "paragraph text ".repeat(600) },
    })),
    recoveryOutcomes: [],
    completedWork: "Summary of the work so far. ".repeat(2_000),
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: "comment-149", summaryThroughCommentId: null },
  };
}

const options = (full: ExecutionContinuationEnvelope) => ({
  requiredMessageIds: new Set([...full.originCommentIds, "comment-145"]),
  triggerInteractionId: "question-card",
  resumeDelta: null,
  historyPath: "/api/issues/issue-1/comments?order=asc",
});

describe("boundExecutionContinuation", () => {
  it("keeps a long-lived task's envelope under the target size", () => {
    const full = longLivedTaskEnvelope();
    expect(executionContinuationBytes(full)).toBeGreaterThan(500 * 1024);
    const bounded = boundExecutionContinuation(full, options(full));
    expect(executionContinuationBytes(bounded)).toBeLessThanOrEqual(EXECUTION_CONTINUATION_TARGET_BYTES);

    // Originating requests and the latest request stay; the newest message is kept.
    const ids = bounded.messages.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["comment-005", "comment-145", "comment-149"]));
    expect(ids).toEqual([...ids].sort());
    // Older history is counted and linked instead of copied.
    expect(bounded.coverage).toMatchObject({
      kind: "recent_task_history",
      throughCommentId: "comment-149",
      totalMessageCount: 150,
      omittedMessageCount: 150 - bounded.messages.length,
      historyPath: "/api/issues/issue-1/comments?order=asc",
    });
    expect(bounded.coverage.omittedMessageIds!.length).toBeLessThanOrEqual(40);
    expect(bounded.coverage.omittedMessageIds).not.toContain("comment-005");
    // Every body is capped and marked when cut.
    for (const row of bounded.messages) {
      expect(row.body.length).toBeLessThanOrEqual(8_000);
      if (row.bodyTruncated) expect(row.bodyChars).toBeGreaterThan(row.body.length);
    }
    // The answered question card that triggered the wake survives, bounded.
    const card = bounded.interactionOutcomes.find((row) => row.id === "question-card");
    expect(card).toBeDefined();
    expect(JSON.stringify(card!.result).length).toBeLessThanOrEqual(6_000);
    expect(bounded.interactionOutcomes.length).toBeLessThan(full.interactionOutcomes.length);
    expect(bounded.coverage.omittedInteractionOutcomeCount).toBe(
      full.interactionOutcomes.length - bounded.interactionOutcomes.length,
    );
    // Document bodies echoed by tool receipts are not copied wholesale.
    expect(bounded.completedActions!.length).toBeLessThan(40);
    for (const action of bounded.completedActions!) {
      expect(JSON.stringify(action.result).length).toBeLessThanOrEqual(600);
    }
    expect(bounded.completedActions!.at(-1)!.receiptId).toBe("receipt-39");
    expect(bounded.completedWork!.length).toBeLessThan(7_000);
    expect(bounded.completedWork).toMatch(/\[truncated: \d+ more characters\]$/);
  });

  it("returns a small task unchanged apart from the envelope shape", () => {
    const small: ExecutionContinuationEnvelope = {
      ...longLivedTaskEnvelope(),
      messages: [message(0), message(1)],
      interactionOutcomes: [],
      completedActions: [],
      completedWork: "Done.",
      originCommentIds: ["comment-000"],
      objective: message(0).body,
      coverage: { kind: "full_task_history", throughCommentId: "comment-001", summaryThroughCommentId: null },
    };
    const bounded = boundExecutionContinuation(small, {
      ...options(small),
      requiredMessageIds: new Set(["comment-000"]),
      triggerInteractionId: null,
    });
    expect(bounded.messages).toEqual(small.messages);
    expect(bounded.coverage).toEqual(small.coverage);
    expect(bounded.completedWork).toBe("Done.");
    expect(bounded.objectiveTruncated).toBeUndefined();
  });

  it("never exceeds the hard cap, even with many huge originating requests", () => {
    const full = longLivedTaskEnvelope();
    const huge = full.messages.map((row, index) =>
      index % 2 === 0 ? { ...row, authorType: "user", body: "Please do this. ".repeat(20_000) } : row,
    );
    const adversarial: ExecutionContinuationEnvelope = {
      ...full,
      messages: huge,
      originCommentIds: huge.filter((_row, index) => index % 2 === 0).map((row) => row.id),
      objective: huge[148]!.body,
    };
    const bounded = boundExecutionContinuation(adversarial, {
      ...options(adversarial),
      requiredMessageIds: new Set(adversarial.originCommentIds),
    });
    expect(executionContinuationBytes(bounded)).toBeLessThanOrEqual(EXECUTION_CONTINUATION_HARD_CAP_BYTES);
    expect(bounded.objectiveTruncated).toBe(true);
    expect(bounded.coverage.omittedOriginCommentIdCount).toBeGreaterThan(0);
  });

  it("computes a resume delta that ignores unchanged truncated messages", () => {
    const full = longLivedTaskEnvelope();
    const delivered = boundExecutionContinuation(full, options(full));
    const longMessage = delivered.messages.find((row) => row.bodyTruncated);
    expect(longMessage).toBeDefined();
    const priorMessages = delivered.messages.map((row) => row as unknown as Record<string, unknown>);
    const current = full.messages.find((row) => row.id === longMessage!.id)!;
    expect(priorMessages.some((prior) => continuationMessageUnchanged(prior, current))).toBe(true);
    expect(
      priorMessages.some((prior) => continuationMessageUnchanged(prior, { ...current, body: `${current.body}!` })),
    ).toBe(false);

    const newComment = message(150, { authorType: "user", authorId: "board-user", body: "One more thing." });
    const next = { ...full, messages: [...full.messages, newComment] };
    const undelivered = next.messages
      .filter((row) => !priorMessages.some((prior) => continuationMessageUnchanged(prior, row)))
      .map((row) => row.id);
    const resumed = boundExecutionContinuation(next, {
      ...options(next),
      requiredMessageIds: new Set([...next.originCommentIds, newComment.id]),
      resumeDelta: { baseRunId: "run-prev", messageIds: new Set(undelivered) },
    });
    const deltaIds = resumed.resumeDelta!.messages.map((row) => row.id);
    expect(deltaIds).toContain(newComment.id);
    expect(deltaIds).not.toContain(longMessage!.id);
    expect(executionContinuationBytes(resumed)).toBeLessThanOrEqual(EXECUTION_CONTINUATION_HARD_CAP_BYTES);
  });

  it("tells the agent where the omitted history is", () => {
    const full = longLivedTaskEnvelope();
    const bounded = boundExecutionContinuation(full, options(full));
    const prompt = renderPaperclipWakePrompt({ executionContinuation: bounded }, { resumedSession: false });
    expect(prompt).toContain("`coverage.omittedMessageCount` older messages are not included");
    expect(prompt).toContain("/api/issues/issue-1/comments?order=asc");
    expect(prompt).toContain("Request 145:");
    expect(prompt).not.toContain("complete authorized task history");
  });
});

describe("boundContinuationJsonValue", () => {
  it("keeps small values and shrinks large ones with markers", () => {
    const small = { outcome: "accepted" };
    expect(boundContinuationJsonValue(small, 100)).toBe(small);
    const large = { note: "x".repeat(10_000), items: Array.from({ length: 100 }, (_, index) => index) };
    const bounded = boundContinuationJsonValue(large, 1_000);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(bounded)).toMatch(/truncated|omitted/);
    expect(boundContinuationJsonValue(large, 0)).toEqual({ omitted: true, originalChars: JSON.stringify(large).length });
  });
});
