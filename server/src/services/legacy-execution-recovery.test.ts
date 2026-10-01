import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("exempts a model-endpoint outage from reconciliation on the error code alone, for any adapter", () => {
  // Deliberately no executionRecovery evidence here: a third-party adapter
  // plugin that reports this error code should not need to know about the
  // bootstrap-evidence shape to get the deferred-backoff retry below instead
  // of a stranded-issue hold.
  const run = {
    runtimeMode: "legacy", status: "failed", errorCode: "model_endpoint_unreachable",
    scheduledRetryAttempt: 12, resultJson: {},
  };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  // Holds even after many outage retries, unlike the generic
  // executionFailureRetryCount >= 2 budget other error codes fall back to.
  expect(legacyExecutionNeedsReconciliation({ ...run, scheduledRetryAttempt: 50 })).toBe(false);
  // Also exempt when an adapter does supply the bootstrap evidence.
  expect(legacyExecutionNeedsReconciliation({
    ...run,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
  })).toBe(false);
  // A different error code gets no special treatment from this exemption.
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "adapter_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});

it("takes a productive hard-cap stop as a checkpoint but keeps the hold for other timeouts", () => {
  const capped = { runtimeMode: "legacy", status: "timed_out", errorCode: "time_cap_checkpoint",
    resultJson: { stopReason: "time_cap_checkpoint" } };
  expect(legacyExecutionNeedsReconciliation(capped)).toBe(false);
  // Continuations do not spend the failure budget, so a chain stays a checkpoint.
  expect(legacyExecutionNeedsReconciliation({ ...capped, scheduledRetryReason: "time_cap_continuation", scheduledRetryAttempt: 3 })).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...capped, errorCode: "timeout", resultJson: { stopReason: "timeout" } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...capped, errorCode: "idle_timeout", resultJson: { stopReason: "idle_timeout" } })).toBe(true);
  // A workspace that could not be restored safely still needs a person.
  expect(legacyExecutionNeedsReconciliation({ ...capped, resultJson: {
    stopReason: "time_cap_checkpoint", workspaceRestoreFailure: "restore_unsafe_archive",
  } })).toBe(true);
});
