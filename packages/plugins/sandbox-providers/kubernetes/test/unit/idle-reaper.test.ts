import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import {
  DISCOVERY_INTERVAL_MS,
  RPC_SWEEP_THROTTLE_MS,
  discoverReuseNamespaces,
  idleReaperState,
  maybeSweepReuseNamespace,
  registerReuseNamespace,
  resetIdleReaper,
  sweepAllRegisteredNamespaces,
  sweepReusableSandboxes,
  withReuseSlot,
} from "../../src/idle-reaper.js";
import { kubeConnectionCacheSize, getKubeConnection } from "../../src/kube-client-cache.js";
import { resetKubeConnectionCache } from "../../src/kube-client-cache.js";
import { REUSE_ANNOTATIONS, REUSE_LABEL_SELECTOR } from "../../src/reuse.js";

const NOW = Date.parse("2026-01-02T00:00:00.000Z");
const HOUR = 3_600_000;

function sandbox(
  name: string,
  state: "idle" | "busy" | null,
  opts: { lastUsedAt?: number; busySince?: number; ttlSec?: number; rv?: string; deleting?: boolean } = {},
) {
  const annotations: Record<string, string> = {
    [REUSE_ANNOTATIONS.idleTtlSeconds]: String(opts.ttlSec ?? 86_400),
    [REUSE_ANNOTATIONS.staleBusySeconds]: "3600",
  };
  if (state) annotations[REUSE_ANNOTATIONS.leaseState] = state;
  if (opts.lastUsedAt !== undefined) annotations[REUSE_ANNOTATIONS.lastUsedAt] = new Date(opts.lastUsedAt).toISOString();
  if (opts.busySince !== undefined) annotations[REUSE_ANNOTATIONS.busySince] = new Date(opts.busySince).toISOString();
  return {
    metadata: {
      name,
      resourceVersion: opts.rv ?? `${name}-rv`,
      creationTimestamp: new Date(NOW - 48 * HOUR).toISOString(),
      annotations,
      ...(opts.deleting ? { deletionTimestamp: new Date(NOW).toISOString() } : {}),
    },
    status: { podName: name },
  };
}

function fakeClients(items: unknown[], opts: { conflictOn?: string[] } = {}) {
  const conflict = new Set(opts.conflictOn ?? []);
  const deletedCrs: Array<{ name: string; body: unknown }> = [];
  const clients = {
    custom: {
      listNamespacedCustomObject: vi.fn(async () => ({ items })),
      deleteNamespacedCustomObject: vi.fn(async (req: { plural: string; name: string; body?: unknown }) => {
        if (req.plural !== "sandboxes") return {};
        if (conflict.has(req.name)) throw Object.assign(new Error("precondition failed"), { code: 409 });
        deletedCrs.push({ name: req.name, body: req.body });
        return {};
      }),
    },
    core: {
      deleteNamespacedPod: vi.fn(async () => ({})),
      deleteNamespacedSecret: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { code: 404 });
      }),
    },
    networking: { deleteNamespacedNetworkPolicy: vi.fn(async () => ({})) },
  };
  return { clients, deletedCrs };
}

beforeEach(() => {
  resetIdleReaper({ now: () => NOW });
  resetKubeConnectionCache();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  resetIdleReaper();
  vi.restoreAllMocks();
});

describe("sweepReusableSandboxes", () => {
  it("lists only reusable sandboxes and reaps idle ones past their TTL", async () => {
    const { clients, deletedCrs } = fakeClients([
      sandbox("pc-expired", "idle", { lastUsedAt: NOW - 25 * HOUR }),
      sandbox("pc-fresh", "idle", { lastUsedAt: NOW - HOUR }),
      sandbox("pc-short-ttl", "idle", { lastUsedAt: NOW - 2 * HOUR, ttlSec: 3600 }),
    ]);

    const result = await sweepReusableSandboxes(clients as never, { namespace: "ns", maxSandboxes: 8 });

    expect(clients.custom.listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "ns", plural: "sandboxes", labelSelector: REUSE_LABEL_SELECTOR }),
    );
    expect(result.reaped).toEqual([
      { name: "pc-expired", reason: "idle_expired" },
      { name: "pc-short-ttl", reason: "idle_expired" },
    ]);
    // Compare-and-swap: the delete is conditioned on the version the decision was made on.
    expect(deletedCrs[0]).toEqual({
      name: "pc-expired",
      body: { preconditions: { resourceVersion: "pc-expired-rv" } },
    });
    // The pod, secret (404 = fine) and egress policy are removed too.
    expect(clients.core.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "ns", name: "pc-expired" }),
    );
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({ namespace: "ns", name: "pc-expired-env" });
    expect(clients.networking.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: "ns",
      name: "pc-expired-egress",
    });
  });

  it("reaps a sandbox left busy past stale-busy plus TTL, and one with no state annotations", async () => {
    const { clients } = fakeClients([
      sandbox("pc-abandoned", "busy", { busySince: NOW - 26 * HOUR }),
      sandbox("pc-running", "busy", { busySince: NOW - 2 * HOUR }),
      // No lease-state/busy-since: busy since creation (48h ago).
      sandbox("pc-unknown", null),
    ]);

    const result = await sweepReusableSandboxes(clients as never, { namespace: "ns", maxSandboxes: 8 });

    expect(result.reaped).toEqual([
      { name: "pc-abandoned", reason: "stale_busy" },
      { name: "pc-unknown", reason: "stale_busy" },
    ]);
  });

  it("skips a sandbox whose version changed since it was read (a concurrent resume)", async () => {
    const { clients, deletedCrs } = fakeClients(
      [sandbox("pc-expired", "idle", { lastUsedAt: NOW - 25 * HOUR })],
      { conflictOn: ["pc-expired"] },
    );

    const result = await sweepReusableSandboxes(clients as never, { namespace: "ns", maxSandboxes: 8 });

    expect(result).toEqual({ reaped: [], skipped: ["pc-expired"], remaining: 1 });
    expect(deletedCrs).toEqual([]);
    expect(clients.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("evicts the least recently used idle sandboxes over the cap, never busy ones", async () => {
    const { clients } = fakeClients([
      sandbox("pc-busy-1", "busy", { busySince: NOW - HOUR }),
      sandbox("pc-idle-new", "idle", { lastUsedAt: NOW - HOUR }),
      sandbox("pc-idle-old", "idle", { lastUsedAt: NOW - 5 * HOUR }),
      sandbox("pc-idle-mid", "idle", { lastUsedAt: NOW - 3 * HOUR }),
      sandbox("pc-busy-2", "busy", { busySince: NOW - HOUR }),
      sandbox("pc-deleting", "idle", { lastUsedAt: NOW - 20 * HOUR, deleting: true }),
    ]);

    const result = await sweepReusableSandboxes(clients as never, { namespace: "ns", maxSandboxes: 3 });

    expect(result.reaped).toEqual([
      { name: "pc-idle-old", reason: "over_capacity" },
      { name: "pc-idle-mid", reason: "over_capacity" },
    ]);
  });

  it("reserves a slot for the sandbox an acquire is about to create", async () => {
    const { clients } = fakeClients([
      sandbox("pc-a", "idle", { lastUsedAt: NOW - 2 * HOUR }),
      sandbox("pc-b", "idle", { lastUsedAt: NOW - HOUR }),
    ]);

    const result = await sweepReusableSandboxes(clients as never, {
      namespace: "ns",
      maxSandboxes: 2,
      reserveSlot: true,
    });

    expect(result.reaped).toEqual([{ name: "pc-a", reason: "over_capacity" }]);
  });

  it("treats a missing namespace as nothing to do", async () => {
    const clients = {
      custom: {
        listNamespacedCustomObject: vi.fn(async () => {
          throw Object.assign(new Error("not found"), { code: 404 });
        }),
      },
    };
    await expect(sweepReusableSandboxes(clients as never, { namespace: "ns", maxSandboxes: 8 })).resolves.toEqual({
      reaped: [],
      skipped: [],
      remaining: 0,
    });
  });
});

describe("reaper registry", () => {
  it("registers namespaces once, starts one unref'd timer and sweeps every registration", async () => {
    const { clients } = fakeClients([sandbox("pc-expired", "idle", { lastUsedAt: NOW - 25 * HOUR })]);
    h.clients = clients;
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as never);

    registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns-a", maxSandboxes: 8 });
    registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns-a", maxSandboxes: 4 });
    registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns-b", maxSandboxes: 8 });

    expect(idleReaperState()).toMatchObject({
      registrations: 2,
      timerActive: true,
      namespaces: [
        { namespace: "ns-a", maxSandboxes: 4 },
        { namespace: "ns-b", maxSandboxes: 8 },
      ],
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalled();

    await sweepAllRegisteredNamespaces();
    expect(clients.custom.listNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it("throttles RPC-triggered sweeps per namespace", async () => {
    let now = NOW;
    resetIdleReaper({ now: () => now });
    const { clients } = fakeClients([]);
    h.clients = clients;
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);
    const registration = registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns", maxSandboxes: 8 });

    await maybeSweepReuseNamespace(registration, { waitMs: 1_000 });
    await maybeSweepReuseNamespace(registration, { waitMs: 1_000 });
    expect(clients.custom.listNamespacedCustomObject).toHaveBeenCalledTimes(1);

    now += RPC_SWEEP_THROTTLE_MS;
    await maybeSweepReuseNamespace(registration, { waitMs: 1_000 });
    expect(clients.custom.listNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it("never throttles a sweep that reserves a slot for an acquire", async () => {
    const { clients } = fakeClients([]);
    h.clients = clients;
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);
    const registration = registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns", maxSandboxes: 8 });

    await maybeSweepReuseNamespace(registration, { waitMs: 1_000 });
    await maybeSweepReuseNamespace(registration, { reserveSlot: true, waitMs: 1_000 });
    await maybeSweepReuseNamespace(registration, { reserveSlot: true, waitMs: 1_000 });
    expect(clients.custom.listNamespacedCustomObject).toHaveBeenCalledTimes(3);
  });

  it("runs a reserving sweep after a non-reserving one that is still in flight", async () => {
    let finishList!: () => void;
    const listed: string[] = [];
    const clients = {
      custom: {
        listNamespacedCustomObject: vi.fn(async () => {
          listed.push("list");
          if (listed.length === 1) await new Promise<void>((resolve) => { finishList = resolve; });
          return { items: [] };
        }),
      },
    };
    h.clients = clients;
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);
    const registration = registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns", maxSandboxes: 8 });

    void maybeSweepReuseNamespace(registration);
    await vi.waitFor(() => expect(listed).toHaveLength(1));
    const reserving = maybeSweepReuseNamespace(registration, { reserveSlot: true, waitMs: 5_000 });
    finishList();
    await reserving;
    expect(listed).toHaveLength(2);
  });

  it("stops sweeping a namespace without a cap once it holds no reusable sandbox", async () => {
    const { clients } = fakeClients([]);
    h.clients = clients;
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);
    registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns-found", maxSandboxes: null });
    registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns-reuse", maxSandboxes: 8 });

    await sweepAllRegisteredNamespaces();

    expect(idleReaperState().namespaces).toEqual([{ namespace: "ns-reuse", maxSandboxes: 8 }]);
  });

  it("enforces only the TTLs in a namespace without a cap", async () => {
    const { clients } = fakeClients([
      sandbox("pc-a", "idle", { lastUsedAt: NOW - HOUR }),
      sandbox("pc-b", "idle", { lastUsedAt: NOW - 2 * HOUR }),
    ]);
    const result = await sweepReusableSandboxes(clients as never, { namespace: "ns", maxSandboxes: null, reserveSlot: true });
    expect(result).toEqual({ reaped: [], skipped: [], remaining: 2 });
  });

  it("registers every namespace that holds a reusable sandbox, at most once per interval", async () => {
    let now = NOW;
    resetIdleReaper({ now: () => now });
    const listClusterCustomObject = vi.fn(async () => ({
      items: [
        { metadata: { name: "pc-1", namespace: "paperclip-a" } },
        { metadata: { name: "pc-2", namespace: "paperclip-b" } },
        { metadata: { name: "pc-3", namespace: "paperclip-a" } },
      ],
    }));
    h.clients = { custom: { listClusterCustomObject } };
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);

    await discoverReuseNamespaces({ inCluster: true });
    expect(listClusterCustomObject).toHaveBeenCalledWith(expect.objectContaining({ labelSelector: REUSE_LABEL_SELECTOR }));
    expect(idleReaperState().namespaces).toEqual([
      { namespace: "paperclip-a", maxSandboxes: null },
      { namespace: "paperclip-b", maxSandboxes: null },
    ]);
    expect(discoverReuseNamespaces({ inCluster: true })).toBeNull();
    now += DISCOVERY_INTERVAL_MS;
    await discoverReuseNamespaces({ inCluster: true });
    expect(listClusterCustomObject).toHaveBeenCalledTimes(2);
  });

  it("keeps the connection when the credential may not list cluster-wide", async () => {
    h.clients = {
      custom: {
        listClusterCustomObject: vi.fn(async () => {
          throw Object.assign(new Error("Forbidden"), { code: 403 });
        }),
      },
    };
    getKubeConnection({ inCluster: true });
    await discoverReuseNamespaces({ inCluster: true }, { reportErrors: false });
    expect(kubeConnectionCacheSize()).toBe(1);
    expect(idleReaperState().registrations).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("lets one acquire per namespace create its sandbox at a time, with a bounded wait", async () => {
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);
    const registration = registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns", maxSandboxes: 8 });
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = withReuseSlot(registration, async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      order.push("first:end");
    });
    const second = withReuseSlot(registration, async () => {
      order.push("second");
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);

    // A stuck holder does not block the next acquire forever.
    void withReuseSlot(registration, () => new Promise<void>(() => undefined));
    await expect(withReuseSlot(registration, async () => "ran", 20)).resolves.toBe("ran");
  });

  it("drops a registration whose credential is rejected", async () => {
    h.clients = {
      custom: {
        listNamespacedCustomObject: vi.fn(async () => {
          throw Object.assign(new Error("Unauthorized"), { code: 401 });
        }),
      },
    };
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: vi.fn() } as never);
    registerReuseNamespace({ connection: { inCluster: true }, namespace: "ns", maxSandboxes: 8 });

    await sweepAllRegisteredNamespaces();

    expect(idleReaperState().registrations).toBe(0);
  });
});
