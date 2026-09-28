import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_POD_READY_TIMEOUT_SEC,
  resolvePodReadyTimeoutMs,
  summarizeRecentPodEvents,
} from "../../src/pod-ready-deadline.js";

describe("resolvePodReadyTimeoutMs", () => {
  it("defaults to 600s when podReadyTimeoutSec is unset and the run budget is larger", () => {
    expect(resolvePodReadyTimeoutMs({}, 3600_000)).toBe(DEFAULT_POD_READY_TIMEOUT_SEC * 1000);
  });

  it("never waits longer than the run budget even when podReadyTimeoutSec is larger", () => {
    expect(resolvePodReadyTimeoutMs({ podReadyTimeoutSec: 900 }, 60_000)).toBe(60_000);
  });

  it("honors a configured podReadyTimeoutSec below the default when the run budget allows it", () => {
    expect(resolvePodReadyTimeoutMs({ podReadyTimeoutSec: 30 }, 3600_000)).toBe(30_000);
  });

  it("clamps a negative run budget to zero instead of returning a negative timeout", () => {
    expect(resolvePodReadyTimeoutMs({}, -1)).toBe(0);
  });
});

function fakeCoreClient(items: Array<Record<string, unknown>>) {
  return { core: { listNamespacedEvent: vi.fn().mockResolvedValue({ items }) } };
}

describe("summarizeRecentPodEvents", () => {
  it("returns an empty summary when no pod name is known", async () => {
    const clients = fakeCoreClient([]);
    const result = await summarizeRecentPodEvents(clients as never, "ns", null);
    expect(result).toEqual({ summary: "", events: [] });
    expect(clients.core.listNamespacedEvent).not.toHaveBeenCalled();
  });

  it("fetches events scoped to the pod and renders a compact summary", async () => {
    const clients = fakeCoreClient([
      {
        reason: "FailedScheduling",
        message: "0/3 nodes are available: 3 Insufficient cpu.",
        lastTimestamp: "2026-01-01T00:00:01.000Z",
      },
      {
        reason: "ImagePullBackOff",
        message: 'Back-off pulling image "ghcr.io/acme/agent:latest"',
        lastTimestamp: "2026-01-01T00:00:02.000Z",
      },
    ]);
    const result = await summarizeRecentPodEvents(clients as never, "paperclip-acme", "pc-abc-pod");
    expect(clients.core.listNamespacedEvent).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      fieldSelector: "involvedObject.name=pc-abc-pod",
    });
    expect(result.summary).toBe(
      'FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu.; ImagePullBackOff: Back-off pulling image "ghcr.io/acme/agent:latest"',
    );
    expect(result.events).toHaveLength(2);
  });

  it("orders events oldest-first and keeps only the most recent handful", async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      reason: `Reason${i}`,
      message: `msg${i}`,
      lastTimestamp: `2026-01-01T00:00:0${i}.000Z`,
    }));
    const clients = fakeCoreClient(items);
    const result = await summarizeRecentPodEvents(clients as never, "ns", "pod-1");
    // Only the 5 most recent (Reason3..Reason7) survive, oldest of THOSE first.
    expect(result.events.map((e) => e.reason)).toEqual([
      "Reason3",
      "Reason4",
      "Reason5",
      "Reason6",
      "Reason7",
    ]);
  });

  it("drops events with no reason and truncates an overlong message", async () => {
    const longMessage = "x".repeat(300);
    const clients = fakeCoreClient([
      { reason: "", message: "should be dropped" },
      { reason: "FailedMount", message: longMessage },
    ]);
    const result = await summarizeRecentPodEvents(clients as never, "ns", "pod-1");
    expect(result.events).toHaveLength(1);
    expect(result.events[0].reason).toBe("FailedMount");
    expect(result.events[0].message.endsWith("...")).toBe(true);
    expect(result.events[0].message.length).toBeLessThan(longMessage.length);
  });

  it("degrades to an empty summary (never throws) when the events API call fails", async () => {
    const clients = { core: { listNamespacedEvent: vi.fn().mockRejectedValue(new Error("RBAC denied")) } };
    const result = await summarizeRecentPodEvents(clients as never, "ns", "pod-1");
    expect(result).toEqual({ summary: "", events: [] });
  });
});
