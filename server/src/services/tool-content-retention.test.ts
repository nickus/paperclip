import { describe, expect, it } from "vitest";
import {
  instanceDefaultToolContentRetention,
  isUnretainedSummary,
  resolveConnectionContentRetention,
  retainRedactionPlan,
  retainToolAuditDetails,
  retainToolContentSummary,
  retainToolErrorMessage,
  TOOL_CONTENT_RETENTION_DEFAULT_ENV,
} from "./tool-content-retention.js";

const summary = {
  summary: '{"body":"private text"}',
  sizeBytes: 23,
  sha256: "a".repeat(64),
  redactedFields: ["token"],
};

describe("tool content retention", () => {
  it("resolves a connection's setting before the instance default", () => {
    const noneDefault = { [TOOL_CONTENT_RETENTION_DEFAULT_ENV]: "none" };
    expect(resolveConnectionContentRetention({}, {})).toBe("summary");
    expect(resolveConnectionContentRetention({ contentRetention: "none" }, {})).toBe("none");
    expect(resolveConnectionContentRetention({}, noneDefault)).toBe("none");
    expect(resolveConnectionContentRetention({ contentRetention: "summary" }, noneDefault)).toBe("summary");
  });

  it("fails closed on an unrecognized instance default", () => {
    expect(instanceDefaultToolContentRetention({})).toBe("summary");
    expect(instanceDefaultToolContentRetention({ [TOOL_CONTENT_RETENTION_DEFAULT_ENV]: " " })).toBe("summary");
    expect(instanceDefaultToolContentRetention({ [TOOL_CONTENT_RETENTION_DEFAULT_ENV]: "summary" })).toBe("summary");
    expect(instanceDefaultToolContentRetention({ [TOOL_CONTENT_RETENTION_DEFAULT_ENV]: "off" })).toBe("none");
  });

  it("keeps only the hash and size of a summary that may not be stored", () => {
    expect(retainToolContentSummary(summary, "summary")).toBe(summary);
    const retained = retainToolContentSummary(summary, "none");
    expect(retained).toEqual({
      summary: "",
      sizeBytes: 23,
      sha256: "a".repeat(64),
      redactedFields: [],
      contentRetention: "none",
    });
    expect(isUnretainedSummary(retained)).toBe(true);
    expect(isUnretainedSummary(summary)).toBe(false);
    // Applying it twice changes nothing.
    expect(retainToolContentSummary(retained, "none")).toEqual(retained);
    expect(retainToolContentSummary(null, "none")).toBeNull();
    expect(retainRedactionPlan({ redactedFieldCount: 1, redactedFields: ["token"] }, "none"))
      .toEqual({ redactedFieldCount: 1, redactedFields: [] });
  });

  it("replaces stored error text but keeps the error code", () => {
    expect(retainToolErrorMessage("provider said: private text", "tool_error", "summary"))
      .toBe("provider said: private text");
    const stored = retainToolErrorMessage("provider said: private text", "tool_error", "none");
    expect(stored).not.toContain("private text");
    expect(stored).toContain("tool_error");
    expect(retainToolErrorMessage(null, "tool_error", "none")).toBeNull();
  });

  it("scrubs call content from audit details and leaves metadata", () => {
    const details = {
      invocationId: "invocation-1",
      reasonCode: "tool_error",
      durationMs: 12,
      result: { hasContent: true, contentLength: 12 },
      argumentsSummary: summary,
      resultSummary: summary,
      error: "provider said: private text",
    };
    expect(retainToolAuditDetails(details, "summary")).toBe(details);
    const retained = retainToolAuditDetails(details, "none");
    expect(JSON.stringify(retained)).not.toContain("private text");
    expect(retained).toMatchObject({
      invocationId: "invocation-1",
      reasonCode: "tool_error",
      durationMs: 12,
      result: { hasContent: true, contentLength: 12 },
      contentRetention: "none",
      argumentsSummary: { summary: "", sha256: "a".repeat(64), sizeBytes: 23 },
      resultSummary: { summary: "", sha256: "a".repeat(64), sizeBytes: 23 },
    });
  });
});
