import { describe, expect, it } from "vitest";
import {
  agentFailureFingerprint,
  describeAgentFailureBreaker,
  evaluateAgentFailureBreaker,
  type AgentFailureBreakerRun,
} from "./agent-failure-breaker.js";

let sequence = 0;
function run(overrides: Partial<AgentFailureBreakerRun> = {}): AgentFailureBreakerRun {
  sequence += 1;
  return {
    id: `run-${sequence}`,
    status: "failed",
    errorCode: "setup_failed",
    error: "Secret is not active",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 60 - sequence)),
    ...overrides,
  };
}

describe("agentFailureFingerprint", () => {
  it("treats the same failure on different runs as one kind", () => {
    expect(
      agentFailureFingerprint(run({
        errorCode: "adapter_failed",
        error: "Lease 3f2a9c1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f failed after 1200 ms (exit 1)\nstack...",
      })),
    ).toBe(
      agentFailureFingerprint(run({
        errorCode: "adapter_failed",
        error: "Lease 9d8c7b6a-1e2f-4a3b-8c4d-5e6f7a8b9c0d failed after 87 ms (exit 1)",
      })),
    );
  });

  it("separates different error codes and messages", () => {
    expect(agentFailureFingerprint(run())).not.toBe(
      agentFailureFingerprint(run({ error: "Could not read execution-target Git context" })),
    );
    expect(agentFailureFingerprint(run({ errorCode: "setup_failed" }))).not.toBe(
      agentFailureFingerprint(run({ errorCode: "configuration_incomplete" })),
    );
  });

  it("ignores successes and failures with their own retry handling", () => {
    expect(agentFailureFingerprint(run({ status: "succeeded", errorCode: null, error: null }))).toBeNull();
    expect(agentFailureFingerprint(run({ errorCode: "provider_quota" }))).toBeNull();
    expect(agentFailureFingerprint(run({ errorCode: "timeout" }))).toBeNull();
    expect(agentFailureFingerprint(run({ status: "timed_out", errorCode: "timeout" }))).toBeNull();
  });
});

describe("evaluateAgentFailureBreaker", () => {
  it("opens after three consecutive failures of the same kind", () => {
    const runs = [run(), run(), run()];
    expect(evaluateAgentFailureBreaker(runs)).toEqual({
      errorCode: "setup_failed",
      error: "Secret is not active",
      runIds: runs.map((entry) => entry.id),
      latestFailureAt: runs[0]!.createdAt,
    });
  });

  it("stays closed with fewer failures than the threshold", () => {
    expect(evaluateAgentFailureBreaker([run(), run()])).toBeNull();
  });

  it("stays closed when the newest runs failed in different ways", () => {
    expect(
      evaluateAgentFailureBreaker([
        run(),
        run({ error: "Could not read execution-target Git context" }),
        run(),
      ]),
    ).toBeNull();
  });

  it("stays closed when a run in the window succeeded", () => {
    expect(
      evaluateAgentFailureBreaker([
        run(),
        run(),
        run({ status: "succeeded", errorCode: null, error: null }),
        run(),
      ]),
    ).toBeNull();
  });

  it("names the error and how to resume in the notice", () => {
    const trip = evaluateAgentFailureBreaker([run(), run(), run()])!;
    const notice = describeAgentFailureBreaker(trip);
    expect(notice).toContain("the last 3 runs failed with the same error (setup_failed: Secret is not active)");
    expect(notice).toContain("start a run or clear the error");
  });
});
