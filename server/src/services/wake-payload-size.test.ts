import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { PROCESS_SINGLE_STRING_MAX_BYTES } from "@paperclipai/adapter-utils/env-payload";
import {
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { documentAnnotationService } from "./document-annotations.js";
import { documentService } from "./documents.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_CONTINUATION_TARGET_BYTES,
  executionContinuationBytes,
} from "./execution-continuation-bounds.js";
import {
  attachExecutionContinuationToWakePayload,
  buildPaperclipWakePayload,
} from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

(support.supported ? describe : describe.skip)("wake payload size on a long-lived issue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  const interactionId = randomUUID();
  const commentIds: string[] = [];
  let fullHistoryBytes = 0;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-wake-payload-size-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Payload size", issuePrefix: "PSZ" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      adapterType: "claude_local",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PSZ-1",
      title: "Long-lived task",
      description: "Build the feature. ".repeat(400),
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    // 150 comments: requests from the board and long progress reports.
    const rows = Array.from({ length: 150 }, (_, index) => {
      const id = randomUUID();
      commentIds.push(id);
      const fromUser = index % 4 === 0;
      const body = fromUser
        ? `Request ${index}: ${"please adjust the behavior and report back ".repeat(index === 100 ? 900 : 12)}`
        : `Progress ${index}: ${"implemented, tested and documented the change ".repeat(60)}`;
      fullHistoryBytes += Buffer.byteLength(body);
      return {
        id,
        companyId,
        issueId,
        authorType: fromUser ? ("user" as const) : ("agent" as const),
        authorUserId: fromUser ? "board-user" : null,
        authorAgentId: fromUser ? null : agentId,
        body,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
      };
    });
    await db.insert(issueComments).values(rows);

    // 40 documents, each with an open review thread.
    const docs = documentService(db);
    const annotations = documentAnnotationService(db);
    for (let index = 0; index < 40; index += 1) {
      const created = await docs.upsertIssueDocument({
        issueId,
        key: `design-${index}`,
        title: `Design ${index}`,
        format: "markdown",
        body: `Alpha selected text omega\n\n${"Section text for the design document. ".repeat(500)}`,
      });
      await annotations.createThread(
        issueId,
        `design-${index}`,
        {
          baseRevisionId: created.document.latestRevisionId!,
          baseRevisionNumber: created.document.latestRevisionNumber,
          selector: {
            quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
            position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
          },
          body: `Review note ${index}: ${"clarify this part ".repeat(80)}`,
        },
        { actorType: "user", actorId: "board-user", userId: "board-user" },
      );
    }

    // A large answered question card and many prior runs with document receipts.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "answered",
      sourceRunId: runId,
      payload: { version: 1, questions: [] },
      result: {
        version: 1,
        answers: Array.from({ length: 60 }, (_, index) => ({
          questionId: `q${index}`,
          selectedOptionIds: [`option-${index}`],
          otherText: "A detailed free-text answer. ".repeat(60),
        })),
        summaryMarkdown: "## Answers\n" + "- chosen option and its rationale\n".repeat(1_500),
      },
    } as unknown as typeof issueThreadInteractions.$inferInsert);
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 40 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId },
        resultJson: {
          apiToolReceipts: {
            [`receipt-${index}`]: {
              state: "completed",
              operationId: "save_document",
              result: { key: `design-${index}`, body: "Document body echoed back. ".repeat(700) },
            },
          },
        },
        createdAt: new Date(Date.UTC(2026, 8, 2, 0, index)),
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("keeps the continuation and the wake payload bounded and never duplicates the history", async () => {
    const latestUserComment = commentIds[148]!;
    const continuation = await buildExecutionContinuation({
      db,
      companyId,
      issueId,
      agentId,
      runId,
      context: { interactionId, wakeReason: "interaction_resolved", commentId: latestUserComment },
      summary: "Continuation summary. ".repeat(3_000),
      exposeLowTrustRaw: false,
    });
    expect(fullHistoryBytes).toBeGreaterThan(300 * 1024);
    expect(executionContinuationBytes(continuation)).toBeLessThanOrEqual(EXECUTION_CONTINUATION_TARGET_BYTES);
    expect(continuation.coverage.kind).toBe("recent_task_history");
    expect(continuation.coverage.totalMessageCount).toBe(150);
    expect(continuation.messages.map((row) => row.id)).toContain(latestUserComment);
    expect(continuation.interactionOutcomes.map((row) => row.id)).toContain(interactionId);

    const contextSnapshot = {
      issueId,
      wakeReason: "issue_commented",
      wakeCommentIds: commentIds.slice(-3),
      interactionId,
      interactionKind: "ask_user_questions",
      interactionStatus: "answered",
      executionContinuation: continuation,
    };
    const wake = await buildPaperclipWakePayload({ db, companyId, agentId, runId, contextSnapshot });
    expect(wake).not.toBeNull();
    // The run snapshot carries the continuation once, next to the wake payload.
    expect(wake!.executionContinuation).toBeNull();
    expect(bytes(wake)).toBeLessThanOrEqual(32 * 1024);
    expect(wake!.documentReviewContext?.truncated).toBe(true);
    expect(wake!.documentReviewContext?.omittedDocumentCount).toBeGreaterThan(0);
    expect(bytes({ ...contextSnapshot, paperclipWake: wake })).toBeLessThanOrEqual(64 * 1024);

    // The adapter-facing copy gets the continuation for the prompt.
    const adapterWake = await attachExecutionContinuationToWakePayload({
      db,
      companyId,
      issueId,
      wakePayload: wake,
      executionContinuation: continuation,
    });
    expect((adapterWake as { executionContinuation: unknown }).executionContinuation).toEqual(continuation);
    // The whole adapter-facing payload (wake plus continuation) stays bounded.
    expect(Buffer.byteLength(stringifyPaperclipWakePayload(adapterWake)!)).toBeLessThanOrEqual(64 * 1024);
    const prompt = renderPaperclipWakePrompt(adapterWake, { resumedSession: false });
    // Well below what a prompt passed as a command-line argument may carry.
    expect(Buffer.byteLength(prompt)).toBeLessThan(PROCESS_SINGLE_STRING_MAX_BYTES);
    expect(prompt).toContain("Request 148:");
    expect(prompt).toContain("`coverage.omittedMessageCount` older messages are not included");

    // The wake payload and the continuation each have their own cap; the
    // adapter-facing copy of both together has the wake payload's cap too.
    // A wake payload right under its own cap makes room by dropping review
    // detail, and the continuation stays whole.
    const reviewPadding = 64 * 1024 - bytes(wake) - 1_024;
    const fullWake = {
      ...wake!,
      planReviewContext: {
        threads: [{ id: "thread-1", comments: [{ id: "review-1", body: "r".repeat(reviewPadding) }] }],
        truncated: false,
      },
    };
    expect(bytes(fullWake)).toBeLessThanOrEqual(64 * 1024);
    expect(bytes({ ...fullWake, executionContinuation: continuation })).toBeGreaterThan(64 * 1024);
    const combined = (await attachExecutionContinuationToWakePayload({
      db,
      companyId,
      issueId,
      wakePayload: fullWake,
      executionContinuation: continuation,
    })) as Record<string, unknown>;
    expect(bytes(combined)).toBeLessThanOrEqual(64 * 1024);
    expect(combined).toMatchObject({
      truncated: true,
      fallbackFetchNeeded: true,
      planReviewContext: { threads: [], truncated: true },
    });
    expect(combined.executionContinuation).toEqual(continuation);
    expect(renderPaperclipWakePrompt(combined, { resumedSession: false })).toContain("Request 148:");
  });
});
