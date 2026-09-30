import { describe, expect, it } from "vitest";
import { decideLegacyContinuation, harnessCheckoutOrigin, legacyDispositionEpisode, type LegacyContinuationInput } from "./legacy-continuation.js";
const input: LegacyContinuationInput = {
  run: { id: "run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "legacy" },
  issue: { id: "issue", companyId: "company", status: "in_progress", assigneeAgentId: "agent" },
  agent: { id: "agent", companyId: "company", status: "idle" },
  episode: { id: "run", attempt: 0, maxAttempts: 2 },
  gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false, activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true },
};
describe("legacy continuation authority", () => {
  it("requests agent repair for a successful process without a task disposition", () => {
    expect(decideLegacyContinuation(input)).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
  });
  it.each(["done", "cancelled", "blocked", "in_review"])("respects persisted %s disposition", status => {
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, status } }).kind).toBe("skip");
  });
  it.each(["failed", "cancelled", "interrupted", "timed_out", "running"])("does not convert a %s process into repair", status => {
    expect(decideLegacyContinuation({ ...input, run: { ...input.run, status } }).kind).toBe("skip");
  });
  it.each(["stopped", "paused", "budgetBlocked", "pendingWait", "activeExecution", "ownedLifecycle", "conversation"] as const)("preserves %s", gate => {
    expect(decideLegacyContinuation({ ...input, gates: { ...input.gates, [gate]: true } }).kind).toBe("skip");
  });
  it.each(["paused", "terminated", "pending_approval"])("does not repair with a %s agent", status => {
    expect(decideLegacyContinuation({ ...input, agent: { ...input.agent!, status } }).kind).toBe("skip");
  });
  it("rejects foreign agent and reassigned issue", () => {
    expect(decideLegacyContinuation({ ...input, agent: { ...input.agent!, id: "other" } }).kind).toBe("skip");
    expect(decideLegacyContinuation({ ...input, issue: { ...input.issue!, assigneeAgentId: "other" } }).kind).toBe("skip");
  });
  it("preserves the episode through two attempts and exhaustion", () => {
    const first = decideLegacyContinuation(input);
    const second = decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 1 } });
    expect(second).toMatchObject({ kind: "enqueue", nextAttempt: 2 });
    expect(second).not.toEqual(first);
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, attempt: 2 } }).kind).toBe("exhausted");
  });
  it("does not resurrect an exhausted pre-upgrade liveness or handoff budget", () => {
    for (const run of [
      { id: "old", continuationAttempt: 2 },
      { id: "old", contextSnapshot: { dispositionRepairAttempt: 3, dispositionRepairMaxAttempts: 5, dispositionRepairFingerprint: "old-episode" } },
      { id: "old", contextSnapshot: { wakeReason: "finish_successful_run_handoff", handoffAttempt: 1 } },
      { id: "old", contextSnapshot: { source: "issue.productive_terminal_continuation_recovery" } },
    ]) expect(decideLegacyContinuation({ ...input, episode: legacyDispositionEpisode(run) }).kind).toBe("exhausted");
  });
  it("keeps replay identity stable while a genuinely new episode gets its own identity", () => {
    expect(decideLegacyContinuation(structuredClone(input))).toEqual(decideLegacyContinuation(input));
    expect(decideLegacyContinuation({ ...input, episode: { ...input.episode, id: "new-authorized-run" } })).not.toEqual(decideLegacyContinuation(input));
  });
  it("leaves native finalization to its own authority", () => {
    expect(decideLegacyContinuation({ ...input, run: { ...input.run, runtimeMode: "native" } }).kind).toBe("skip");
  });
  describe("return to rest", () => {
    const resting: LegacyContinuationInput = { ...input, restStatus: "backlog" };
    it("returns a harness-checked-out issue to its resting status instead of requesting repair", () => {
      expect(decideLegacyContinuation(resting)).toEqual({ kind: "rest", status: "backlog" });
    });
    it("requests repair when the issue did not come from a resting status", () => {
      // No rest evidence: the agent (or someone else) set in_progress, or a
      // status was recorded after the harness checkout.
      expect(decideLegacyContinuation({ ...input, restStatus: null })).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
      expect(decideLegacyContinuation({ ...input, restStatus: undefined })).toMatchObject({ kind: "enqueue", nextAttempt: 1 });
    });
    it.each(["stopped", "paused", "budgetBlocked", "pendingWait", "activeExecution", "ownedLifecycle", "conversation"] as const)("keeps the %s gate ahead of rest", gate => {
      expect(decideLegacyContinuation({ ...resting, gates: { ...resting.gates, [gate]: true } }).kind).toBe("skip");
    });
    it("keeps agent, owner, status and run gates ahead of rest", () => {
      expect(decideLegacyContinuation({ ...resting, gates: { ...resting.gates, agentInvokable: false } }).kind).toBe("skip");
      expect(decideLegacyContinuation({ ...resting, agent: { ...resting.agent!, status: "paused" } }).kind).toBe("skip");
      expect(decideLegacyContinuation({ ...resting, issue: { ...resting.issue!, assigneeAgentId: "other" } }).kind).toBe("skip");
      expect(decideLegacyContinuation({ ...resting, issue: { ...resting.issue!, assigneeUserId: "user" } }).kind).toBe("skip");
      expect(decideLegacyContinuation({ ...resting, run: { ...resting.run, status: "failed" } }).kind).toBe("skip");
      expect(decideLegacyContinuation({ ...resting, run: { ...resting.run, runtimeMode: "native" } }).kind).toBe("skip");
      for (const status of ["done", "blocked", "in_review", "backlog"]) {
        expect(decideLegacyContinuation({ ...resting, issue: { ...resting.issue!, status } }).kind).toBe("skip");
      }
    });
    it("only rests an issue that is still in progress", () => {
      expect(decideLegacyContinuation({ ...resting, issue: { ...resting.issue!, status: "todo" } }).kind).toBe("enqueue");
    });
    it("rests instead of escalating an exhausted episode", () => {
      expect(decideLegacyContinuation({ ...resting, episode: { ...resting.episode, attempt: 2 } })).toEqual({ kind: "rest", status: "backlog" });
    });
  });
  describe("harness checkout origin", () => {
    it("records the status the checkout itself moved the issue out of", () => {
      expect(harnessCheckoutOrigin({ status: "backlog", statusVersion: 4 }, { status: "in_progress", statusVersion: 5 }))
        .toEqual({ fromStatus: "backlog", statusVersion: 5 });
    });
    it("records nothing when the checkout did not change the status", () => {
      expect(harnessCheckoutOrigin({ status: "in_progress", statusVersion: 5 }, { status: "in_progress", statusVersion: 5 })).toBeNull();
      expect(harnessCheckoutOrigin({ status: "backlog", statusVersion: 5 }, null)).toBeNull();
    });
    it("records nothing when another status change raced the checkout", () => {
      // backlog -> todo by someone else, then the checkout from todo.
      expect(harnessCheckoutOrigin({ status: "backlog", statusVersion: 4 }, { status: "in_progress", statusVersion: 6 })).toBeNull();
    });
  });
});
