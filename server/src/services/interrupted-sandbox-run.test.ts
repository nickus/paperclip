import { describe, expect, it } from "vitest";
import { runWasInterrupted } from "./interrupted-sandbox-run.js";

describe("runWasInterrupted", () => {
  it("covers runs ended from outside their turn", () => {
    expect(runWasInterrupted({ status: "cancelled", errorCode: null })).toBe(true);
    expect(runWasInterrupted({ status: "timed_out", errorCode: null })).toBe(true);
    expect(runWasInterrupted({ status: "interrupted", errorCode: "server_shutdown_interrupted" })).toBe(true);
    expect(runWasInterrupted({ status: "failed", errorCode: "process_lost" })).toBe(true);
  });

  it("leaves out runs that finished their turn", () => {
    expect(runWasInterrupted({ status: "succeeded", errorCode: null })).toBe(false);
    expect(runWasInterrupted({ status: "failed", errorCode: "adapter_failed" })).toBe(false);
    expect(runWasInterrupted({ status: "failed", errorCode: null })).toBe(false);
  });
});
