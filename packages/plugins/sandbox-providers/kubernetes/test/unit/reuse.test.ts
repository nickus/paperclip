import { describe, it, expect } from "vitest";
import {
  DEFAULT_REUSE_IDLE_TTL_SEC,
  REUSE_ANNOTATIONS,
  annotationsJsonPatch,
  buildIdleAnnotations,
  buildReuseLabels,
  computeReuseKey,
  computeReuseSpecHash,
  maxReusableSandboxesInQuota,
  parseCpuMillis,
  parseMemoryBytes,
  reapDecision,
  readReusableSandboxState,
  readReuseStamp,
  resolveReuseIdleTtlSec,
  resolveReuseResources,
  resolveReuseSettings,
  stableStringify,
  type ReusableSandboxState,
} from "../../src/reuse.js";
import { kubernetesProviderConfigSchema } from "../../src/types.js";

const KEY_INPUT = {
  companyId: "company-1",
  environmentId: "env-1",
  executionWorkspaceId: "workspace-1",
  agentId: "agent-1",
  runAdapterType: "opencode_local",
};

describe("reuse settings", () => {
  it("is enabled only with reuseLease on the sandbox-cr backend", () => {
    const on = kubernetesProviderConfigSchema.parse({ inCluster: true, reuseLease: true });
    const off = kubernetesProviderConfigSchema.parse({ inCluster: true });
    const job = kubernetesProviderConfigSchema.parse({ inCluster: true, reuseLease: true, backend: "job" });
    expect(resolveReuseSettings(on).enabled).toBe(true);
    expect(resolveReuseSettings(off).enabled).toBe(false);
    expect(resolveReuseSettings(job).enabled).toBe(false);
    expect(resolveReuseSettings(on).maxSandboxes).toBe(8);
    expect(resolveReuseSettings(on).staleBusySec).toBe(3600);
  });

  it("keeps reuseLease and the reuse fields through config parsing", () => {
    const parsed = kubernetesProviderConfigSchema.parse({
      inCluster: true,
      reuseLease: true,
      runnerIdleTimeoutMs: 86_400_000,
      reuseIdleTtlSec: 3600,
      reuseMaxSandboxes: 4,
      reuseResources: { requests: { cpu: "200m" } },
    });
    expect(parsed).toMatchObject({
      reuseLease: true,
      runnerIdleTimeoutMs: 86_400_000,
      reuseIdleTtlSec: 3600,
      reuseMaxSandboxes: 4,
      reuseResources: { requests: { cpu: "200m" } },
    });
  });

  it("derives the idle TTL from reuseIdleTtlSec, then runnerIdleTimeoutMs, then 24h", () => {
    expect(resolveReuseIdleTtlSec({})).toBe(DEFAULT_REUSE_IDLE_TTL_SEC);
    expect(resolveReuseIdleTtlSec({ runnerIdleTimeoutMs: 7_200_000 })).toBe(7200);
    expect(resolveReuseIdleTtlSec({ runnerIdleTimeoutMs: 7_200_000, reuseIdleTtlSec: 600 })).toBe(600);
    // Clamped to at least a minute.
    expect(resolveReuseIdleTtlSec({ runnerIdleTimeoutMs: 1_000 })).toBe(60);
  });

  it("requests little and keeps the regular limits, merging partial overrides per field", () => {
    expect(resolveReuseResources({})).toEqual({
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "2", memory: "4Gi" },
    });
    expect(
      resolveReuseResources({
        defaultResources: { limits: { memory: "6Gi" } },
        reuseResources: { requests: { memory: "512Mi" }, limits: { cpu: "3" } },
      }),
    ).toEqual({
      requests: { cpu: "100m", memory: "512Mi" },
      limits: { cpu: "3", memory: "6Gi" },
    });
  });
});

describe("reuse key and labels", () => {
  it("is a stable sha256 over the whole scope", () => {
    const key = computeReuseKey(KEY_INPUT);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(computeReuseKey({ ...KEY_INPUT })).toBe(key);
    for (const field of Object.keys(KEY_INPUT) as Array<keyof typeof KEY_INPUT>) {
      expect(computeReuseKey({ ...KEY_INPUT, [field]: "other" })).not.toBe(key);
    }
  });

  it("labels the sandbox with a 40-character key prefix and omits invalid label values", () => {
    const key = computeReuseKey(KEY_INPUT);
    expect(buildReuseLabels({ reuseKey: key, executionWorkspaceId: "workspace-1", issueId: "issue-1" })).toEqual({
      "paperclip.io/reuse": "true",
      "paperclip.io/reuse-key": key.slice(0, 40),
      "paperclip.io/execution-workspace-id": "workspace-1",
      "paperclip.io/issue-id": "issue-1",
    });
    const labels = buildReuseLabels({ reuseKey: key, executionWorkspaceId: "bad value!", issueId: null });
    expect(labels).not.toHaveProperty("paperclip.io/execution-workspace-id");
    expect(labels).not.toHaveProperty("paperclip.io/issue-id");
  });
});

describe("spec hash", () => {
  const podTemplateSpec = {
    containers: [
      {
        name: "agent",
        image: "registry.example/agent:1",
        resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "2", memory: "4Gi" } },
      },
    ],
    runtimeClassName: "kata",
    imagePullSecrets: [{ name: "pull" }],
  };
  const base = {
    namespace: "paperclip-acme",
    backend: "sandbox-cr",
    podTemplateSpec,
    adapterEnv: { OPENAI_API_KEY: "k1", PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS: "a.example" },
  };

  it("does not depend on key order or per-lease env entries", () => {
    const hash = computeSpecHash(base);
    expect(
      computeSpecHash({
        ...base,
        podTemplateSpec: JSON.parse(stableStringify(podTemplateSpec)) as unknown,
        adapterEnv: {
          PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS: "b.example",
          BOOTSTRAP_TOKEN: "per-lease",
          OPENAI_API_KEY: "k1",
        },
      }),
    ).toBe(hash);
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("changes with the image, resources, runtime class, pull secrets and adapter env", () => {
    const hash = computeSpecHash(base);
    const container = podTemplateSpec.containers[0]!;
    const variants: unknown[] = [
      { ...podTemplateSpec, containers: [{ ...container, image: "registry.example/agent:2" }] },
      {
        ...podTemplateSpec,
        containers: [{ ...container, resources: { ...container.resources, limits: { cpu: "4", memory: "4Gi" } } }],
      },
      { ...podTemplateSpec, runtimeClassName: "gvisor" },
      { ...podTemplateSpec, imagePullSecrets: [{ name: "other" }] },
    ];
    for (const variant of variants) {
      expect(computeSpecHash({ ...base, podTemplateSpec: variant })).not.toBe(hash);
    }
    expect(computeSpecHash({ ...base, adapterEnv: { OPENAI_API_KEY: "rotated" } })).not.toBe(hash);
    expect(computeSpecHash({ ...base, namespace: "paperclip-other" })).not.toBe(hash);
  });

  function computeSpecHash(input: typeof base | Record<string, unknown>): string {
    return computeReuseSpecHash(input as typeof base);
  }
});

describe("sandbox state and TTL rules", () => {
  const T0 = Date.parse("2026-01-01T00:00:00.000Z");

  function sandbox(annotations: Record<string, string>, extra: Record<string, unknown> = {}): unknown {
    return {
      metadata: {
        name: "pc-1",
        resourceVersion: "42",
        creationTimestamp: new Date(T0).toISOString(),
        annotations,
        ...extra,
      },
      status: { podName: "pc-1" },
    };
  }

  it("reads the annotations the reaper needs", () => {
    const state = readReusableSandboxState(
      sandbox({
        [REUSE_ANNOTATIONS.leaseState]: "idle",
        [REUSE_ANNOTATIONS.lastUsedAt]: new Date(T0 + 1000).toISOString(),
        [REUSE_ANNOTATIONS.idleTtlSeconds]: "600",
        [REUSE_ANNOTATIONS.podUid]: "uid-1",
      }),
    )!;
    expect(state).toMatchObject({
      name: "pc-1",
      resourceVersion: "42",
      leaseState: "idle",
      lastUsedAt: T0 + 1000,
      idleTtlSec: 600,
      staleBusySec: 3600,
      podName: "pc-1",
      podUid: "uid-1",
      deleting: false,
    });
  });

  it("reaps an idle sandbox only after its TTL", () => {
    const state = readReusableSandboxState(
      sandbox({ [REUSE_ANNOTATIONS.leaseState]: "idle", [REUSE_ANNOTATIONS.lastUsedAt]: new Date(T0).toISOString(), [REUSE_ANNOTATIONS.idleTtlSeconds]: "600" }),
    )!;
    expect(reapDecision(state, T0 + 600_000)).toEqual({ reap: false });
    expect(reapDecision(state, T0 + 600_001)).toEqual({ reap: true, reason: "idle_expired" });
  });

  it("reaps a busy sandbox only after stale-busy plus TTL", () => {
    const state = readReusableSandboxState(
      sandbox({
        [REUSE_ANNOTATIONS.leaseState]: "busy",
        [REUSE_ANNOTATIONS.busySince]: new Date(T0).toISOString(),
        [REUSE_ANNOTATIONS.idleTtlSeconds]: "600",
        [REUSE_ANNOTATIONS.staleBusySeconds]: "3600",
      }),
    )!;
    expect(reapDecision(state, T0 + 4_200_000)).toEqual({ reap: false });
    expect(reapDecision(state, T0 + 4_200_001)).toEqual({ reap: true, reason: "stale_busy" });
  });

  it("treats missing annotations as busy since creation with default lifetimes", () => {
    const state = readReusableSandboxState(sandbox({}))!;
    expect(state.leaseState).toBe("unknown");
    expect(state.busySince).toBe(T0);
    expect(reapDecision(state, T0 + (3600 + DEFAULT_REUSE_IDLE_TTL_SEC) * 1000)).toEqual({ reap: false });
    expect(reapDecision(state, T0 + (3600 + DEFAULT_REUSE_IDLE_TTL_SEC) * 1000 + 1)).toEqual({
      reap: true,
      reason: "stale_busy",
    });
  });

  it("never reaps a sandbox that is already being deleted", () => {
    const state = readReusableSandboxState(
      sandbox({ [REUSE_ANNOTATIONS.leaseState]: "idle" }, { deletionTimestamp: new Date(T0).toISOString() }),
    ) as ReusableSandboxState;
    expect(state.deleting).toBe(true);
    expect(reapDecision(state, T0 + 10 * 86_400_000)).toEqual({ reap: false });
  });

  it("writes idle annotations with the pod uid and an informational expiry", () => {
    expect(buildIdleAnnotations({ now: new Date(T0), idleTtlSec: 60, podUid: "uid-9" })).toEqual({
      [REUSE_ANNOTATIONS.leaseState]: "idle",
      [REUSE_ANNOTATIONS.lastUsedAt]: new Date(T0).toISOString(),
      [REUSE_ANNOTATIONS.idleTtlSeconds]: "60",
      [REUSE_ANNOTATIONS.idleExpiresAt]: new Date(T0 + 60_000).toISOString(),
      [REUSE_ANNOTATIONS.podUid]: "uid-9",
    });
  });

  it("escapes annotation keys in the JSON patch path", () => {
    expect(annotationsJsonPatch({ "paperclip.io/lease-state": "busy" })).toEqual([
      { op: "add", path: "/metadata/annotations/paperclip.io~1lease-state", value: "busy" },
    ]);
  });
});

describe("reuse stamp", () => {
  it("reads a complete stamp and rejects anything else", () => {
    expect(readReuseStamp(null)).toBeNull();
    expect(readReuseStamp({ kubernetesReuse: { key: "k" } })).toBeNull();
    expect(
      readReuseStamp({
        kubernetesReuse: { version: 1, key: "k", specHash: "h", runAdapterType: "opencode_local", idleTtlSec: 60, podUid: null },
      }),
    ).toEqual({ version: 1, key: "k", specHash: "h", runAdapterType: "opencode_local", idleTtlSec: 60, podUid: null });
  });
});

describe("quota arithmetic", () => {
  it("parses common quantities", () => {
    expect(parseCpuMillis("2")).toBe(2000);
    expect(parseCpuMillis("100m")).toBe(100);
    expect(parseMemoryBytes("4Gi")).toBe(4 * 1024 ** 3);
    expect(parseMemoryBytes("256Mi")).toBe(256 * 1024 ** 2);
    expect(parseMemoryBytes("lots")).toBeNull();
  });

  it("fits 10 default reusable sandboxes in the default tenant quota", () => {
    // min(pods 20, limits 20/2, 40Gi/4Gi, requests 10/0.1, 20Gi/256Mi) = min(20, 10, 10, 100, 80)
    expect(
      maxReusableSandboxesInQuota(
        { pods: "20", requestsCpu: "10", requestsMemory: "20Gi", limitsCpu: "20", limitsMemory: "40Gi" },
        resolveReuseResources({}),
      ),
    ).toBe(10);
  });
});
