import { describe, expect, it } from "vitest";
import { resolveRunOrientationSessionResumed } from "../services/heartbeat.ts";

describe("resolveRunOrientationSessionResumed", () => {
  it("is false when no previous session was offered to the adapter", () => {
    expect(
      resolveRunOrientationSessionResumed({
        offeredSessionId: null,
        offeredSessionDisplayId: null,
        resolvedSessionId: "session-a",
        resolvedSessionDisplayId: "session-a",
      }),
    ).toBe(false);
  });

  it("is true when the adapter's resulting session matches the one it was offered", () => {
    expect(
      resolveRunOrientationSessionResumed({
        offeredSessionId: "session-a",
        offeredSessionDisplayId: "session-a",
        resolvedSessionId: "session-a",
        resolvedSessionDisplayId: "session-a",
      }),
    ).toBe(true);
  });

  it("prefers the display id on both sides when present", () => {
    expect(
      resolveRunOrientationSessionResumed({
        offeredSessionId: "legacy-a",
        offeredSessionDisplayId: "display-a",
        resolvedSessionId: "legacy-a",
        resolvedSessionDisplayId: "display-a",
      }),
    ).toBe(true);
  });

  it("is false when a session was offered but the adapter reports it as unknown and starts fresh", () => {
    // The opencode_local adapter's own unknown-session retry: it reports an
    // unknown session, then runs a brand new one instead of the offered one.
    expect(
      resolveRunOrientationSessionResumed({
        offeredSessionId: "session-a",
        offeredSessionDisplayId: "session-a",
        resolvedSessionId: "session-b",
        resolvedSessionDisplayId: "session-b",
      }),
    ).toBe(false);
  });

  it("is false when a session was offered but nothing came back resolved", () => {
    expect(
      resolveRunOrientationSessionResumed({
        offeredSessionId: "session-a",
        offeredSessionDisplayId: "session-a",
        resolvedSessionId: null,
        resolvedSessionDisplayId: null,
      }),
    ).toBe(false);
  });
});
