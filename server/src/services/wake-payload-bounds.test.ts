import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES,
  fitPaperclipWakePayloadToHardCap,
  paperclipWakePayloadBytes,
} from "./wake-payload-bounds.js";

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
});
