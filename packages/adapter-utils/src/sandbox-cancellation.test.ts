import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { executeWithSandboxCancellation } from "./sandbox-cancellation.js";
import type { RunProcessResult } from "./server-utils.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const commandResult: RunProcessResult = {
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null,
};
const turnResult: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, summary: "done" };

function fixture(stop: () => Promise<void> = async () => {}) {
  const controller = new AbortController();
  const runnerExecute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async () => commandResult);
  const order: string[] = [];
  const ctx = {
    runId: "run-1",
    signal: controller.signal,
    stopRemoteStartup: vi.fn(stop),
    onCancellationReady: vi.fn(async () => { order.push("ready"); }),
    executionTarget: {
      kind: "remote", transport: "sandbox", providerKey: "test-provider", remoteCwd: "/workspace",
      runner: { execute: runnerExecute },
    },
  } as unknown as AdapterExecutionContext;
  const runnerOf = (context: AdapterExecutionContext) =>
    (context.executionTarget as { runner: CommandManagedRuntimeRunner }).runner;
  // An adapter that knows nothing about cancellation: it runs one sandbox
  // command and reports success when the command returns.
  const plainAdapter = vi.fn(async (context: AdapterExecutionContext) => {
    order.push("command");
    await runnerOf(context).execute({ command: "agent" });
    return turnResult;
  });
  return { controller, ctx, runnerExecute, runnerOf, plainAdapter, order };
}

describe("executeWithSandboxCancellation", () => {
  it("registers for cancellation before the first sandbox command", async () => {
    const f = fixture();
    await expect(executeWithSandboxCancellation(f.ctx, f.plainAdapter)).resolves.toEqual(turnResult);
    expect(f.order).toEqual(["ready", "command"]);
    expect(f.runnerExecute).toHaveBeenCalledOnce();
    expect(f.ctx.stopRemoteStartup).not.toHaveBeenCalled();
  });

  it("stops the sandbox once and settles as cancelled when the command never returns", async () => {
    const f = fixture();
    f.runnerExecute.mockImplementation(() => new Promise(() => {}));
    let commandError: unknown;
    const adapter = vi.fn(async (context: AdapterExecutionContext) => {
      try {
        await f.runnerOf(context).execute({ command: "agent" });
      } catch (error) {
        commandError = error;
        throw error;
      }
      return turnResult;
    });
    const execution = executeWithSandboxCancellation(f.ctx, adapter, { cancelledMessage: "Stopped by test" });
    await vi.waitFor(() => expect(f.runnerExecute).toHaveBeenCalledOnce());
    f.controller.abort(new Error("Cancelled by operator"));
    const result = await execution;
    expect(result).toMatchObject({
      exitCode: null,
      errorCode: "cancelled",
      errorMessage: "Stopped by test",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(result.executionRecovery).toBeUndefined();
    expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce();
    expect(commandError).toEqual(new Error("Cancelled by operator"));
  });

  it("never starts the adapter when the run was stopped before registration finished", async () => {
    const f = fixture();
    f.ctx.onCancellationReady = vi.fn(async () => { f.controller.abort(); });
    expect(await executeWithSandboxCancellation(f.ctx, f.plainAdapter)).toMatchObject({
      errorCode: "cancelled",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(f.plainAdapter).not.toHaveBeenCalled();
    expect(f.runnerExecute).not.toHaveBeenCalled();
    expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce();
  });

  it("keeps ownership of the command and does not acknowledge when the stop cannot be verified", async () => {
    const f = fixture(async () => { throw new Error("stop unverified"); });
    const command = deferred<RunProcessResult>();
    f.runnerExecute.mockReturnValue(command.promise);
    let settled = false;
    const execution = executeWithSandboxCancellation(f.ctx, f.plainAdapter)
      .catch((error: unknown) => error)
      .finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.runnerExecute).toHaveBeenCalledOnce());
    f.controller.abort();
    await vi.waitFor(() => expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    command.resolve(commandResult);
    expect(await execution).toEqual(new Error("stop unverified"));
  });

  it("stands aside for an adapter that handles its own cancellation", async () => {
    const f = fixture();
    const turn = deferred<void>();
    const selfCancelled: AdapterExecutionResult = {
      exitCode: null, signal: null, timedOut: false, errorCode: "cancelled",
      errorMessage: "Turn cancelled through the agent protocol",
      resultJson: { executionCancellation: { state: "acknowledged", forced: false } },
    };
    const adapter = vi.fn(async (context: AdapterExecutionContext) => {
      await context.onCancellationReady?.();
      await f.runnerOf(context).execute({ command: "agent" });
      context.signal?.addEventListener("abort", () => turn.resolve(), { once: true });
      await turn.promise;
      // A command after the abort still reaches the sandbox: the adapter owns it.
      await f.runnerOf(context).execute({ command: "agent-cancel" });
      return selfCancelled;
    });
    const execution = executeWithSandboxCancellation(f.ctx, adapter);
    await vi.waitFor(() => expect(f.runnerExecute).toHaveBeenCalledOnce());
    f.controller.abort();
    expect(await execution).toBe(selfCancelled);
    expect(f.runnerExecute).toHaveBeenCalledTimes(2);
    expect(f.ctx.stopRemoteStartup).not.toHaveBeenCalled();
    // Registration happened once, before the adapter ran.
    expect(f.ctx.onCancellationReady).toHaveBeenCalledOnce();
  });

  it("does not stop twice when the adapter opts in after the stop started", async () => {
    const receipt = deferred<void>();
    const f = fixture(() => receipt.promise);
    const beforeOptIn = deferred<void>();
    const adapter = vi.fn(async (context: AdapterExecutionContext) => {
      await beforeOptIn.promise;
      await context.onCancellationReady?.();
      if (context.signal?.aborted) {
        await context.stopRemoteStartup?.();
        return { exitCode: null, signal: null, timedOut: false, errorCode: "cancelled" } as AdapterExecutionResult;
      }
      return turnResult;
    });
    const execution = executeWithSandboxCancellation(f.ctx, adapter);
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledOnce());
    f.controller.abort();
    await vi.waitFor(() => expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce());
    beforeOptIn.resolve();
    receipt.resolve();
    expect(await execution).toMatchObject({
      errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(f.ctx.stopRemoteStartup).toHaveBeenCalledOnce();
  });

  it("runs invocations on other targets unchanged", async () => {
    const f = fixture();
    const local = { ...f.ctx, executionTarget: { kind: "local" } } as unknown as AdapterExecutionContext;
    const adapter = vi.fn(async (context: AdapterExecutionContext) => {
      expect(context).toBe(local);
      return turnResult;
    });
    await expect(executeWithSandboxCancellation(local, adapter)).resolves.toBe(turnResult);
    f.controller.abort();
    expect(f.ctx.onCancellationReady).not.toHaveBeenCalled();
    expect(f.ctx.stopRemoteStartup).not.toHaveBeenCalled();
  });

  it("does not stop the sandbox after a completed invocation", async () => {
    const f = fixture();
    await expect(executeWithSandboxCancellation(f.ctx, f.plainAdapter)).resolves.toEqual(turnResult);
    f.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.ctx.stopRemoteStartup).not.toHaveBeenCalled();
  });
});
