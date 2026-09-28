import { describe, expect, it, vi } from "vitest";
import {
  KubernetesTransientError,
  checkReusableLeaseResumable,
  isTransientKubeError,
} from "../../src/lease-lifecycle.js";
import { REUSE_ANNOTATIONS } from "../../src/reuse.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

// The host's resume retry loop classifies an error as transient by this pattern.
const HOST_TRANSIENT_PATTERN = /\b(timeout|timed out|rate limit|temporar|network|connection reset|service unavailable)\b/;

function sandboxCr(annotations: Record<string, string> = {}) {
  return {
    metadata: {
      name: "pc-1",
      annotations: {
        [REUSE_ANNOTATIONS.specVersion]: "1",
        [REUSE_ANNOTATIONS.specHash]: "hash-1",
        [REUSE_ANNOTATIONS.reuseKey]: "key-1",
        [REUSE_ANNOTATIONS.podUid]: "uid-1",
        ...annotations,
      },
    },
    status: { podName: "pc-1" },
  };
}

function pod(overrides: { ready?: boolean; uid?: string; since?: number; waiting?: string } = {}) {
  return {
    metadata: { uid: overrides.uid ?? "uid-1" },
    status: {
      phase: "Running",
      conditions: [
        {
          type: "Ready",
          status: overrides.ready === false ? "False" : "True",
          lastTransitionTime: new Date(overrides.since ?? NOW - 1000).toISOString(),
        },
      ],
      containerStatuses: overrides.waiting ? [{ state: { waiting: { reason: overrides.waiting } } }] : [],
    },
  };
}

function clients(cr: unknown, readPod: () => Promise<unknown>) {
  return {
    custom: { getNamespacedCustomObject: vi.fn(async () => cr) },
    core: { readNamespacedPod: vi.fn(readPod) },
  } as never;
}

const INPUT = {
  namespace: "ns",
  name: "pc-1",
  expectedReuseKey: "key-1",
  expectedSpecHash: "hash-1",
  expectedSpecVersion: "1",
  readyTimeoutMs: 0,
  pollMs: 1,
  now: () => NOW,
};

describe("checkReusableLeaseResumable", () => {
  it("accepts the recorded pod when it is Running and Ready", async () => {
    await expect(checkReusableLeaseResumable(clients(sandboxCr(), async () => pod()), INPUT)).resolves.toEqual({
      resumable: true,
      podName: "pc-1",
      podUid: "uid-1",
    });
  });

  it("throws a transient error for a pod that is only briefly not Ready", async () => {
    const promise = checkReusableLeaseResumable(
      clients(sandboxCr(), async () => pod({ ready: false, since: NOW - 10_000 })),
      INPUT,
    );
    await expect(promise).rejects.toBeInstanceOf(KubernetesTransientError);
    await expect(promise).rejects.toThrow(HOST_TRANSIENT_PATTERN);
  });

  it("gives up on a pod that has not been Ready for more than five minutes", async () => {
    await expect(
      checkReusableLeaseResumable(
        clients(sandboxCr(), async () => pod({ ready: false, since: NOW - 301_000 })),
        INPUT,
      ),
    ).resolves.toMatchObject({ resumable: false, reason: "pod_not_ready" });
  });

  it("treats a missing recorded pod as replaced", async () => {
    await expect(
      checkReusableLeaseResumable(
        clients(sandboxCr(), async () => {
          throw Object.assign(new Error("not found"), { code: 404 });
        }),
        INPUT,
      ),
    ).resolves.toMatchObject({ resumable: false, reason: "pod_replaced" });
  });

  it("treats a missing pod as replaced even when no pod UID was recorded, instead of retrying forever", async () => {
    const readPod = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { code: 404 });
    });
    const cr = sandboxCr({ [REUSE_ANNOTATIONS.podUid]: "" });
    await expect(
      checkReusableLeaseResumable(clients(cr, readPod), { ...INPUT, readyTimeoutMs: 30_000 }),
    ).resolves.toMatchObject({ resumable: false, reason: "pod_replaced" });
    // Decided on the first read; no polling until the ready timeout.
    expect(readPod).toHaveBeenCalledTimes(1);
  });

  it("reports a spec that cannot be rendered any more as changed", async () => {
    await expect(
      checkReusableLeaseResumable(clients(sandboxCr(), async () => pod()), { ...INPUT, expectedSpecHash: null }),
    ).resolves.toMatchObject({ resumable: false, reason: "spec_changed" });
    await expect(
      checkReusableLeaseResumable(
        clients(sandboxCr({ [REUSE_ANNOTATIONS.specVersion]: "0" }), async () => pod()),
        INPUT,
      ),
    ).resolves.toMatchObject({ resumable: false, reason: "spec_changed" });
  });

  it("wraps temporary pod read errors and keeps the original as the cause", async () => {
    const original = Object.assign(new Error("HTTP-Code: 401 Message: Unauthorized"), { code: 401 });
    const promise = checkReusableLeaseResumable(
      clients(sandboxCr(), async () => {
        throw original;
      }),
      INPUT,
    );
    await expect(promise).rejects.toThrow(HOST_TRANSIENT_PATTERN);
    await expect(promise).rejects.toMatchObject({ cause: original });
  });

  it("rethrows errors that are not temporary", async () => {
    const invalid = Object.assign(new Error("HTTP-Code: 422 Message: invalid"), { code: 422 });
    await expect(
      checkReusableLeaseResumable(
        clients(sandboxCr(), async () => {
          throw invalid;
        }),
        INPUT,
      ),
    ).rejects.toBe(invalid);
  });
});

describe("isTransientKubeError", () => {
  it("classifies API and transport failures", () => {
    for (const code of [401, 403, 408, 429, 500, 503]) {
      expect(isTransientKubeError({ code })).toBe(true);
    }
    for (const code of [400, 404, 409, 422]) {
      expect(isTransientKubeError({ code })).toBe(false);
    }
    expect(isTransientKubeError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(true);
  });
});
