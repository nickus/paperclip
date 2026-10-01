import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { PAPERCLIP_RUN_BRIEF_TEAM_MAX_MEMBERS } from "@paperclipai/adapter-utils/wake-run-brief";
import {
  PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES,
  fitPaperclipWakePayloadToHardCap,
  paperclipWakePayloadBytes,
} from "./wake-payload-bounds.js";

// A full roster with oversized free-text fields.
const fullTeam = () => ({
  companyId: "0e5c1c9e-2f4b-4c3d-8e7f-1a2b3c4d5e6f",
  total: 64,
  members: Array.from({ length: PAPERCLIP_RUN_BRIEF_TEAM_MAX_MEMBERS }, (_, index) => ({
    id: `7d1e2f3a-4b5c-4d6e-8f7a-${String(index).padStart(12, "0")}`,
    name: "n".repeat(200),
    role: "engineer",
    title: "t".repeat(200),
    status: "pending_approval",
    reportsTo: "r".repeat(200),
    you: index === 0,
  })),
});
const briefWithTeam = () => ({
  version: 1,
  issueId: "issue-1",
  issueIdentifier: "PAP-1",
  authority: "execute",
  environment: null,
  blockerCount: 0,
  blockers: [],
  pendingInteractionCount: 0,
  pendingInteractions: [],
  priorRuns: [],
  team: fullTeam(),
});

const thread = (index: number) => ({
  id: `thread-${index}`,
  selectedText: "s".repeat(500),
  prefixText: "p".repeat(500),
  suffixText: "x".repeat(500),
  comments: [{ id: `comment-${index}`, body: "b".repeat(1_200) }],
});

describe("fitPaperclipWakePayloadToHardCap", () => {
  it("returns a payload under the cap unchanged", () => {
    const payload = { reason: "issue_commented", comments: [{ id: "c1", body: "hello" }], truncated: false };
    expect(fitPaperclipWakePayloadToHardCap(payload)).toBe(payload);
  });

  it("drops review detail and shortens bodies until the payload fits, with markers", () => {
    const payload = {
      reason: "issue_commented",
      issue: { id: "issue-1", description: "d".repeat(12_000), descriptionTruncated: false },
      comments: Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, body: "c".repeat(4_000), bodyTruncated: false })),
      planReviewContext: { threads: Array.from({ length: 20 }, (_, index) => thread(index)), truncated: false },
      documentReviewContext: {
        documents: Array.from({ length: 20 }, (_, index) => ({ documentKey: `doc-${index}`, threads: [thread(index)] })),
        truncated: false,
      },
      truncated: false,
      fallbackFetchNeeded: false,
    };
    expect(paperclipWakePayloadBytes(payload)).toBeGreaterThan(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    const fitted = fitPaperclipWakePayloadToHardCap(payload);
    expect(paperclipWakePayloadBytes(fitted)).toBeLessThanOrEqual(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    expect(fitted).toMatchObject({
      truncated: true,
      fallbackFetchNeeded: true,
      documentReviewContext: { documents: [], omittedDocumentCount: 20, truncated: true },
    });
    // The newest comment batch and the brief survive when dropping review detail was enough.
    expect(fitted.comments[0]!.body).toHaveLength(4_000);
    expect(fitted.issue.description).toHaveLength(12_000);
  });

  it("shortens comment bodies and the brief as a last resort", () => {
    const payload = {
      issue: { description: "d".repeat(40_000) },
      comments: Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, body: "c".repeat(4_000) })),
    };
    const fitted = fitPaperclipWakePayloadToHardCap(payload);
    expect(paperclipWakePayloadBytes(fitted)).toBeLessThanOrEqual(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    expect(fitted.comments[0]).toMatchObject({ bodyTruncated: true });
    expect(fitted.comments[0]!.body).toHaveLength(1_000);
    expect(fitted.issue).toMatchObject({ descriptionTruncated: true });
  });

  it("shortens an attached continuation's message bodies last, keeping each full length", () => {
    const message = (index: number, body: string, extra: Record<string, unknown> = {}) => ({
      id: `m${index}`,
      authorType: "user",
      authorId: "u1",
      body,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deleted: false,
      sourceTrust: null,
      ...extra,
    });
    const messages = [
      // Already cut by the continuation's own bounds: its full length stays.
      message(0, "a".repeat(8_000), { bodyTruncated: true, bodyChars: 20_000 }),
      ...Array.from({ length: 12 }, (_, index) => message(index + 1, "m".repeat(6_000))),
    ];
    const payload = {
      reason: "issue_commented",
      comments: [{ id: "c1", body: "short" }],
      executionContinuation: {
        version: 1,
        messages,
        resumeDelta: { baseRunId: "run-0", messages: messages.slice(-2) },
        completedWork: "w".repeat(5_000),
        coverage: { kind: "recent_task_history", omittedMessageCount: 40 },
      },
    };
    expect(paperclipWakePayloadBytes(payload)).toBeGreaterThan(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    const fitted = fitPaperclipWakePayloadToHardCap(payload);
    expect(paperclipWakePayloadBytes(fitted)).toBeLessThanOrEqual(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    expect(fitted).toMatchObject({ truncated: true, fallbackFetchNeeded: true });
    const continuation = fitted.executionContinuation;
    expect(continuation.messages.map((row) => row.id)).toEqual(messages.map((row) => row.id));
    expect(continuation.messages[0]).toMatchObject({ bodyTruncated: true, bodyChars: 20_000 });
    expect(continuation.messages[1]).toMatchObject({ bodyTruncated: true, bodyChars: 6_000 });
    expect(continuation.messages[1]!.body).toHaveLength(500);
    expect(continuation.resumeDelta.messages[1]).toMatchObject({ bodyTruncated: true, bodyChars: 6_000 });
    expect(continuation.completedWork).toMatch(/^w{1000}\n\[truncated: 4000 more characters\]$/);
    expect(continuation.coverage).toEqual(payload.executionContinuation.coverage);
    expect(fitted.comments[0]!.body).toBe("short");
  });

  it("drops the team roster before shortening comments, keeping its count", () => {
    const payload = {
      reason: "issue_commented",
      issue: { id: "issue-1", identifier: "PAP-1", title: "Roster", status: "in_progress", priority: "medium", workMode: "standard" },
      commentIds: Array.from({ length: 15 }, (_, index) => `c${index}`),
      comments: Array.from({ length: 15 }, (_, index) => ({ id: `c${index}`, body: "c".repeat(4_000) })),
      runBrief: briefWithTeam(),
      truncated: false,
      fallbackFetchNeeded: false,
    };
    expect(paperclipWakePayloadBytes(payload)).toBeGreaterThan(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    const fitted = fitPaperclipWakePayloadToHardCap(payload);
    expect(paperclipWakePayloadBytes(fitted)).toBeLessThanOrEqual(PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES);
    expect(fitted.runBrief.team).toEqual({ ...fullTeam(), members: [] });
    expect(fitted.comments[0]!.body).toHaveLength(4_000);
    expect(fitted).toMatchObject({ truncated: true, fallbackFetchNeeded: true });
    // The rendered brief still says how many agents there are and where to list them.
    expect(renderPaperclipWakePrompt(fitted)).toContain(
      "- 64 agents not listed: GET /api/companies/0e5c1c9e-2f4b-4c3d-8e7f-1a2b3c4d5e6f/agents",
    );
  });
});
