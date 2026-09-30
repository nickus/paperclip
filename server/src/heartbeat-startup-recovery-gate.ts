/**
 * Startup heartbeat recovery (restart adoption, orphaned-run reaping, and the
 * first resume of queued runs) runs once, before the scheduler interval
 * starts. A task drain restored from a previous process must hold that
 * recovery as well, because the recovery starts queued runs. This gate keeps
 * the recovery until the drain ends; the first scheduler tick after that runs
 * it, and ticks skip their own work while it is pending, so the work happens
 * in the same order as a normal startup. A recovery that fails is tried again
 * on the next tick, as a failed startup recovery would stop the server rather
 * than let it schedule work.
 */
export function createHeartbeatStartupRecoveryGate(input: {
  isSchedulingSuppressed: () => Promise<boolean>;
  onError: (err: unknown) => void;
}) {
  let held: (() => Promise<void>) | null = null;
  let inFlight: Promise<void> | null = null;

  return {
    hold(recovery: () => Promise<void>): void {
      held = recovery;
    },

    /**
     * Call at the start of each scheduler tick. Once the drain has ended it
     * runs the held recovery and returns "skip": the tick must not do its own
     * work while or right after the recovery runs. It returns "proceed" when
     * nothing is held, and while the drain still holds the recovery.
     */
    async beforeTick(): Promise<"proceed" | "skip"> {
      if (inFlight) return "skip";
      if (!held) return "proceed";
      if (await input.isSchedulingSuppressed()) return "proceed";
      // Another tick may have taken the recovery during the check above.
      if (inFlight) return "skip";
      const recovery = held;
      if (!recovery) return "proceed";
      held = null;
      const running = recovery()
        .catch((err: unknown) => {
          input.onError(err);
          held ??= recovery;
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = running;
      await running;
      return "skip";
    },
  };
}
