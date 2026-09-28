/**
 * The periodic sweeps that hand work back after execution recovery holds
 * (reconciled continuations, wakes a closed hold kept back, deferred wakes
 * promoted after a hold) can find a backlog all at once, for example on the
 * first start after many holds closed, or after a mass agent pause. A shared
 * budget paces the wakes those sweeps start: at most `limit` per window,
 * across all of them. A candidate over the budget waits for a later pass;
 * nothing is dropped. Paths that end a hold directly (an operator's request)
 * are not paced.
 *
 * PAPERCLIP_EXECUTION_HOLD_SWEEP_WAKE_LIMIT sets the limit per sweep interval
 * (a positive integer).
 */
export const EXECUTION_HOLD_SWEEP_WAKE_LIMIT_ENV = "PAPERCLIP_EXECUTION_HOLD_SWEEP_WAKE_LIMIT";
export const DEFAULT_EXECUTION_HOLD_SWEEP_WAKE_LIMIT = 3;

export type ExecutionHoldWakeBudget = {
  /** True while another wake may start in the current window. */
  available(): boolean;
  /** Counts one wake against the current window. */
  spend(): void;
};

export function executionHoldSweepWakeLimit(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[EXECUTION_HOLD_SWEEP_WAKE_LIMIT_ENV]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  // Anything but a positive integer keeps the conservative default.
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_EXECUTION_HOLD_SWEEP_WAKE_LIMIT;
}

export function createExecutionHoldWakeBudget(input: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): ExecutionHoldWakeBudget {
  const now = input.now ?? Date.now;
  let windowStartedAt = Number.NEGATIVE_INFINITY;
  let spent = 0;
  const roll = () => {
    const at = now();
    // A fixed window opened by the first wake after the previous one expired.
    if (at - windowStartedAt >= input.windowMs) {
      windowStartedAt = at;
      spent = 0;
    }
  };
  return {
    available() {
      roll();
      return spent < input.limit;
    },
    spend() {
      roll();
      spent += 1;
    },
  };
}

/** Counts every call of a wake-like function against the budget, if any. */
export function withWakeBudget<Args extends unknown[], Result>(
  budget: ExecutionHoldWakeBudget | undefined,
  fn: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  if (!budget) return fn;
  return (...args: Args) => {
    budget.spend();
    return fn(...args);
  };
}
