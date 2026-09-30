import { cancellableSandboxStartup } from "./acpx-engine/startup-cancellation.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";

export interface SandboxCancellationOptions {
  /** Error message of the result returned for a confirmed stop. */
  cancelledMessage?: string;
}

function isCancellableSandboxInvocation(ctx: AdapterExecutionContext): boolean {
  const target = ctx.executionTarget;
  return Boolean(
    ctx.signal &&
      ctx.stopRemoteStartup &&
      target?.kind === "remote" &&
      target.transport === "sandbox" &&
      target.runner,
  );
}

/**
 * Run an adapter invocation on a sandbox target so that cancelling the run
 * stops the work inside the sandbox.
 *
 * Commands started through the sandbox runner have no host child process that
 * the host could signal, and closing the command stream does not end them. This
 * wrapper registers for cancellation (`onCancellationReady`) before any
 * sandbox command runs. On abort it calls the host-owned `stopRemoteStartup`,
 * which resolves only once the provider has verified that the sandbox stopped.
 * Until then it keeps ownership of every outstanding runner call. After the
 * stop, the invocation settles as cancelled and acknowledged.
 *
 * An invocation that calls `onCancellationReady` itself takes over its own
 * cancellation from that point, for example to cancel a turn through its
 * agent protocol: the wrapper then stops guarding and never stops the sandbox
 * for it. Opting in therefore removes this automatic stop. Only an invocation
 * that independently stops its sandbox work when `signal` aborts (for example
 * by calling `stopRemoteStartup`) may call it; one that does not leaves its
 * commands running after the run is cancelled. `stopRemoteStartup` is shared,
 * so a stop already in progress is joined instead of being started a second
 * time.
 *
 * Invocations on other targets, or without a stop handle, run unchanged.
 */
export async function executeWithSandboxCancellation(
  ctx: AdapterExecutionContext,
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
  options: SandboxCancellationOptions = {},
): Promise<AdapterExecutionResult> {
  if (!isCancellableSandboxInvocation(ctx)) return execute(ctx);
  const signal = ctx.signal!;
  const hostStop = ctx.stopRemoteStartup!;

  // One provider stop per invocation. A failed attempt may be retried.
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      const attempt = Promise.resolve().then(hostStop);
      stopping = attempt;
      attempt.catch(() => {
        if (stopping === attempt) stopping = undefined;
      });
    }
    return stopping;
  };
  const cancelled = (result?: AdapterExecutionResult): AdapterExecutionResult => ({
    exitCode: null,
    signal: null,
    timedOut: false,
    ...result,
    errorCode: "cancelled",
    errorMessage: options.cancelledMessage ?? "Sandbox execution was cancelled",
    resultJson: {
      ...result?.resultJson,
      executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() },
    },
  });

  // Register before the first sandbox command, so a Stop can always reach it.
  await ctx.onCancellationReady?.();
  if (signal.aborted) {
    // The host may already hold a lease, so stop it even before any command.
    await stop();
    return { ...cancelled(), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
  }

  const cancellation = cancellableSandboxStartup({ ...ctx, stopRemoteStartup: stop });
  let selfManaged = false;
  const context: AdapterExecutionContext = {
    ...cancellation.context,
    stopRemoteStartup: stop,
    // Already registered above; opting in only hands cancellation over.
    onCancellationReady: async () => {
      if (selfManaged) return;
      selfManaged = true;
      cancellation.handOff();
    },
  };
  let result: AdapterExecutionResult | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await execute(context);
  } catch (error) {
    failure = error;
    failed = true;
  }
  try {
    // Waits for a stop that already started; without a confirmed stop it
    // also waits for every runner call it abandoned.
    await cancellation.finish();
  } catch (error) {
    failure = error;
    failed = true;
  }
  if (cancellation.stopAcknowledged()) return cancelled(result);
  if (failed) throw failure;
  return result!;
}
