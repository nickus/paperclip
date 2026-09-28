import { describe, expect, it } from "vitest";
import {
  assessInertLegacyRunRow,
  describeInertRunEvidence,
  INERT_RUN_AUTO_RECONCILE_ENV,
  isInertRunAutoReconcileEnabled,
} from "./inert-legacy-execution.js";

const inert = {
  id: "run-1",
  runtimeMode: "legacy",
  status: "cancelled",
  executionStage: "preparing",
  finishedAt: new Date("2026-09-01T10:01:00.000Z"),
  processPid: null,
  processGroupId: null,
  processStartedAt: null,
  exitCode: null,
  signal: null,
  externalRunId: null,
  sessionIdAfter: null,
  lastOutputAt: null,
  lastOutputSeq: 0,
  lastOutputBytes: null,
  stdoutExcerpt: null,
  stderrExcerpt: null,
  usageJson: null,
  scheduledRetryAttempt: 0,
  scheduledRetryReason: null,
  contextSnapshot: { issueId: "issue-1" },
};

describe("assessInertLegacyRunRow", () => {
  it("accepts a legacy run stopped before adapter dispatch", () => {
    expect(assessInertLegacyRunRow(inert)).toEqual({ inert: true });
    expect(assessInertLegacyRunRow({ ...inert, status: "failed" })).toEqual({ inert: true });
    expect(assessInertLegacyRunRow({ ...inert, usageJson: { inputTokens: 0, costUsd: 0 } })).toEqual({ inert: true });
  });

  it.each([
    ["native runtime", { runtimeMode: "native" }, "runtime_not_legacy"],
    ["timed out", { status: "timed_out" }, "status_not_eligible"],
    ["still running", { status: "running" }, "status_not_eligible"],
    ["not finished", { finishedAt: null }, "not_finished"],
    ["dispatched", { executionStage: "dispatching" }, "adapter_dispatch_not_excluded"],
    ["unknown stage", { executionStage: null }, "adapter_dispatch_not_excluded"],
    ["pid", { processPid: 42 }, "process_recorded"],
    ["process group", { processGroupId: 42 }, "process_recorded"],
    ["process start", { processStartedAt: new Date() }, "process_recorded"],
    ["exit code", { exitCode: 1 }, "process_exit_recorded"],
    ["signal", { signal: "SIGTERM" }, "process_exit_recorded"],
    ["remote run", { externalRunId: "remote-1" }, "external_run_recorded"],
    ["provider session", { sessionIdAfter: "session-1" }, "provider_session_recorded"],
    ["output sequence", { lastOutputSeq: 1 }, "output_recorded"],
    ["output time", { lastOutputAt: new Date() }, "output_recorded"],
    ["output bytes", { lastOutputBytes: 12 }, "output_recorded"],
    ["stdout", { stdoutExcerpt: "{\"type\":\"init\"}" }, "output_recorded"],
    ["stderr", { stderrExcerpt: "boom" }, "output_recorded"],
    ["token usage", { usageJson: { usage: { inputTokens: 12 } } }, "usage_recorded"],
    ["consumed retries", { scheduledRetryAttempt: 2 }, "retry_budget_consumed"],
    ["reconciled continuation", { contextSnapshot: { source: "execution.reconciled" } }, "continuation_of_reconciled_run"],
  ] as const)("refuses a run with %s", (_label, patch, reason) => {
    expect(assessInertLegacyRunRow({ ...inert, ...patch } as typeof inert)).toEqual({ inert: false, reason });
  });
});

describe("isInertRunAutoReconcileEnabled", () => {
  it("defaults on and honours the kill switch", () => {
    expect(isInertRunAutoReconcileEnabled({})).toBe(true);
    expect(isInertRunAutoReconcileEnabled({ [INERT_RUN_AUTO_RECONCILE_ENV]: "1" })).toBe(true);
    for (const off of ["0", "false", "off", "no", " OFF "]) {
      expect(isInertRunAutoReconcileEnabled({ [INERT_RUN_AUTO_RECONCILE_ENV]: off })).toBe(false);
    }
  });
});

describe("describeInertRunEvidence", () => {
  it("states what was checked", () => {
    const text = describeInertRunEvidence({
      policy: "inert_legacy_run_v1",
      runId: "run-1",
      executionStage: "preparing",
      status: "cancelled",
      errorCode: "agent_paused",
      runEventTypes: ["lifecycle"],
      environmentLeases: [{ id: "lease-1", status: "released", provider: "kubernetes" }],
    });
    expect(text).toContain("before adapter dispatch");
    expect(text).toContain("agent_paused");
    expect(text).toContain("1 environment lease(s) released");
  });
});
