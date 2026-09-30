// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { readResumeReconciliationConfirmation, TaskTreeControlDialog } from "./TaskTreeControls";

const confirmation =
  "The stopped run's process has exited. Continuing starts a new run that reviews the recorded work.";

describe("resuming held work", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onRetry = vi.fn();
  const onConfirmReconciliation = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(reconciliationConfirmation: string | null) {
    await act(async () => root.render(
      <TaskTreeControlDialog
        open
        onOpenChange={() => {}}
        mode="resume"
        scope="leaf"
        affectedCount={1}
        affectedAgentCount={1}
        loading={false}
        error="Cannot wake TASK-1: Automatic recovery stopped."
        pending={false}
        valid
        reconciliationConfirmation={reconciliationConfirmation}
        onConfirmReconciliation={onConfirmReconciliation}
        wakeAgents
        onWakeAgentsChange={() => {}}
        onRetry={onRetry}
        onApply={() => {}}
      />,
    ));
  }

  function button(label: string) {
    return [...document.body.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  }

  it("offers to continue from the recorded work when a hold blocks the wake", async () => {
    await render(confirmation);
    expect(document.body.textContent).toContain(confirmation);
    expect(button("Retry preview")).toBeUndefined();
    await act(async () => button("Continue from recorded work")!.click());
    expect(onConfirmReconciliation).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain error for other failures", async () => {
    await render(null);
    expect(button("Continue from recorded work")).toBeUndefined();
    expect(button("Retry preview")).toBeDefined();
  });

  it("reads the confirmation only from a reconciliation-required conflict", () => {
    const body = { error: "Cannot wake TASK-1", code: "execution_reconciliation_required", details: { confirmation } };
    expect(readResumeReconciliationConfirmation(new ApiError("Cannot wake TASK-1", 409, body))).toBe(confirmation);
    expect(readResumeReconciliationConfirmation(new ApiError("Cannot wake TASK-1", 409, { error: "Cannot wake TASK-1" })))
      .toBeNull();
    expect(readResumeReconciliationConfirmation(new ApiError("Denied", 403, body))).toBeNull();
    expect(readResumeReconciliationConfirmation(new Error("offline"))).toBeNull();
  });
});
