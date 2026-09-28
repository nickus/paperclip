import { describe, expect, it, vi } from "vitest";
import {
  createExecutionHoldWakeBudget,
  DEFAULT_EXECUTION_HOLD_SWEEP_WAKE_LIMIT,
  EXECUTION_HOLD_SWEEP_WAKE_LIMIT_ENV,
  executionHoldSweepWakeLimit,
  withWakeBudget,
} from "./execution-hold-wake-budget.js";

describe("execution hold sweep wake budget", () => {
  it("allows at most the limit per window, then opens a new window", () => {
    let clock = 10_000;
    const budget = createExecutionHoldWakeBudget({ limit: 2, windowMs: 15_000, now: () => clock });
    expect(budget.available()).toBe(true);
    budget.spend();
    budget.spend();
    expect(budget.available()).toBe(false);
    clock += 14_999;
    expect(budget.available()).toBe(false);
    clock += 1;
    expect(budget.available()).toBe(true);
  });

  it("counts every wrapped call, and leaves the function as is without a budget", async () => {
    const budget = createExecutionHoldWakeBudget({ limit: 1, windowMs: 1_000, now: () => 0 });
    const wake = vi.fn(async (agentId: string) => agentId);
    const budgeted = withWakeBudget(budget, wake);
    expect(await budgeted("a")).toBe("a");
    expect(budget.available()).toBe(false);
    expect(withWakeBudget(undefined, wake)).toBe(wake);
  });

  it("reads a positive integer limit and keeps the default otherwise", () => {
    expect(executionHoldSweepWakeLimit({})).toBe(DEFAULT_EXECUTION_HOLD_SWEEP_WAKE_LIMIT);
    expect(executionHoldSweepWakeLimit({ [EXECUTION_HOLD_SWEEP_WAKE_LIMIT_ENV]: "10" })).toBe(10);
    for (const value of ["0", "-3", "2.5", "many", ""]) {
      expect(executionHoldSweepWakeLimit({ [EXECUTION_HOLD_SWEEP_WAKE_LIMIT_ENV]: value }))
        .toBe(DEFAULT_EXECUTION_HOLD_SWEEP_WAKE_LIMIT);
    }
  });
});
