/**
 * Idle reaper for reusable sandboxes.
 *
 * A reusable Sandbox CR outlives its runs. This module deletes the ones nobody
 * will resume:
 *   - idle for longer than their idle TTL,
 *   - busy for longer than stale-busy + TTL (the run that held it never
 *     released it, e.g. the host crashed before recording the lease),
 *   - the least recently used idle ones when a namespace is over its cap.
 *
 * State lives only in Sandbox CR annotations (see reuse.ts), so the reaper
 * survives worker and host restarts. The only in-memory part is the registry of
 * (connection, namespace) pairs to sweep. It is filled from two sides:
 *   - every RPC for a reusable lease, or with reuse on, registers its namespace
 *     (with the configured cap);
 *   - every RPC that carries a cluster connection, whatever its config, lists
 *     reusable Sandbox CRs cluster-wide (at most every DISCOVERY_INTERVAL_MS
 *     per connection) and registers each namespace it finds, without a cap.
 * So after a restart, the first RPC on a connection finds idle sandboxes in
 * every namespace again, including ones whose environment turned reuse off.
 * A registration without a cap whose namespace holds no reusable sandbox any
 * more is dropped by its next sweep.
 *
 * Deletes are compare-and-swap: the CR delete carries
 * `preconditions.resourceVersion` = the version the decision was made on. A
 * resume marks the CR busy with a patch, which bumps the resourceVersion, so
 *   - if the resume patch lands first, the delete fails with 409 and is skipped;
 *   - if the delete lands first, the resume patch sees 404 or a
 *     deletionTimestamp and reports the lease expired.
 * A sandbox handed to a run is therefore never reaped for being idle, however
 * many reapers (workers, hosts) run concurrently.
 */

import { createHash } from "node:crypto";
import type { KubeClients } from "./kube-client.js";
import {
  evictKubeConnection,
  getKubeConnection,
  isKubeAuthError,
  type KubeConnectionInput,
} from "./kube-client-cache.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";
import {
  REUSE_LABEL_SELECTOR,
  reapDecision,
  readReusableSandboxState,
  type ReusableSandboxState,
} from "./reuse.js";
import { SANDBOX_GROUP, SANDBOX_PLURAL, SANDBOX_VERSION } from "./sandbox-cr-orchestrator.js";

export const REAPER_INTERVAL_MS = 5 * 60_000;
const REAPER_JITTER_MS = 30_000;
/** Minimum spacing of RPC-triggered sweeps per namespace. */
export const RPC_SWEEP_THROTTLE_MS = 60_000;
/** An acquire waits at most this long for its sweep before creating the sandbox. */
export const ACQUIRE_SWEEP_BUDGET_MS = 5_000;
/** An acquire waits at most this long for another acquire in the same namespace. */
export const ACQUIRE_SLOT_WAIT_MS = 15_000;
/** Minimum spacing of cluster-wide discovery lists per connection. */
export const DISCOVERY_INTERVAL_MS = 30 * 60_000;
const MAX_REGISTRATIONS = 256;

export type ReapReason = "idle_expired" | "stale_busy" | "over_capacity";

export interface SweepResult {
  reaped: Array<{ name: string; reason: ReapReason }>;
  /** CAS conflicts: the CR changed after it was read (e.g. a concurrent resume). */
  skipped: string[];
  /** Reusable sandboxes left in the namespace after the sweep. */
  remaining: number;
}

export interface ReuseNamespaceRegistration {
  key: string;
  connection: KubeConnectionInput;
  namespace: string;
  /** Cap on reusable sandboxes; null when only TTLs are enforced (no reuse config seen). */
  maxSandboxes: number | null;
  lastSweepAt: number;
  inFlight: Promise<SweepResult | null> | null;
  /** Whether the in-flight sweep reserves a slot for an acquire. */
  inFlightReserves: boolean;
  /** Tail of the acquire queue (see withReuseSlot). */
  slotTail: Promise<void>;
}

const registrations = new Map<string, ReuseNamespaceRegistration>();
/** Connection key -> time of its last cluster-wide discovery. */
const discoveries = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let now: () => number = Date.now;

function connectionKey(connection: KubeConnectionInput): string {
  return createHash("sha256")
    .update(JSON.stringify([connection.inCluster === true, connection.kubeconfig ?? ""]))
    .digest("hex");
}

function registrationKey(connection: KubeConnectionInput, namespace: string): string {
  return createHash("sha256")
    .update(JSON.stringify([connection.inCluster === true, connection.kubeconfig ?? "", namespace]))
    .digest("hex");
}

function isConflict(err: unknown): boolean {
  const record = err as { code?: unknown; statusCode?: unknown } | null;
  return (record?.code ?? record?.statusCode) === 409;
}

async function ignoreErrors(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Best effort: every object below is also owned by the Sandbox CR and is
    // garbage-collected with it.
  }
}

/**
 * Delete one reusable sandbox if it is still at `state.resourceVersion`.
 * Returns false when the precondition failed (the CR changed since it was read).
 */
export async function deleteReusableSandboxIfUnchanged(
  clients: KubeClients,
  namespace: string,
  state: ReusableSandboxState,
): Promise<boolean> {
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace,
      plural: SANDBOX_PLURAL,
      name: state.name,
      propagationPolicy: "Foreground",
      body: state.resourceVersion
        ? { preconditions: { resourceVersion: state.resourceVersion } }
        : undefined,
    });
  } catch (err) {
    if (isConflict(err)) return false;
    if (!isKubeNotFoundError(err)) throw err;
  }
  // The CR is gone or going; remove what it owned explicitly too.
  await ignoreErrors(
    clients.core.deleteNamespacedPod({ namespace, name: state.podName, gracePeriodSeconds: 5 }),
  );
  await ignoreErrors(clients.core.deleteNamespacedSecret({ namespace, name: `${state.name}-env` }));
  await ignoreErrors(
    clients.networking.deleteNamespacedNetworkPolicy({ namespace, name: `${state.name}-egress` }),
  );
  await ignoreErrors(
    clients.custom.deleteNamespacedCustomObject({
      group: "cilium.io",
      version: "v2",
      namespace,
      plural: "ciliumnetworkpolicies",
      name: `${state.name}-egress`,
    }),
  );
  return true;
}

/**
 * One pass over a namespace. With `reserveSlot` (used right before an acquire
 * creates a new sandbox) the cap is enforced one lower, so the new sandbox
 * fits. Busy sandboxes count toward the cap but are never evicted for it.
 */
export async function sweepReusableSandboxes(
  clients: KubeClients,
  input: { namespace: string; maxSandboxes: number | null; reserveSlot?: boolean; nowMs?: number },
): Promise<SweepResult> {
  const nowMs = input.nowMs ?? now();
  const result: SweepResult = { reaped: [], skipped: [], remaining: 0 };
  let listed: { items?: unknown[] };
  try {
    listed = (await clients.custom.listNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: input.namespace,
      plural: SANDBOX_PLURAL,
      labelSelector: REUSE_LABEL_SELECTOR,
    })) as { items?: unknown[] };
  } catch (err) {
    // No tenant namespace (or no Sandbox CRD) yet: nothing to reap.
    if (isKubeNotFoundError(err)) return result;
    throw err;
  }
  const live = (listed.items ?? [])
    .map((item) => readReusableSandboxState(item))
    .filter((state): state is ReusableSandboxState => state !== null && !state.deleting);

  const remaining: ReusableSandboxState[] = [];
  for (const state of live) {
    const decision = reapDecision(state, nowMs);
    if (!decision.reap) {
      remaining.push(state);
      continue;
    }
    if (await deleteReusableSandboxIfUnchanged(clients, input.namespace, state)) {
      result.reaped.push({ name: state.name, reason: decision.reason });
    } else {
      result.skipped.push(state.name);
      remaining.push(state);
    }
  }

  // Without a cap (a namespace found by discovery, no reuse config seen yet)
  // only the TTL rules above apply.
  const limit =
    input.maxSandboxes === null ? Number.POSITIVE_INFINITY : Math.max(0, input.maxSandboxes - (input.reserveSlot ? 1 : 0));
  let count = remaining.length;
  if (count > limit) {
    // Least recently used idle sandboxes first.
    const idle = remaining
      .filter((state) => state.leaseState === "idle")
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const state of idle) {
      if (count <= limit) break;
      if (await deleteReusableSandboxIfUnchanged(clients, input.namespace, state)) {
        result.reaped.push({ name: state.name, reason: "over_capacity" });
        count -= 1;
      } else {
        result.skipped.push(state.name);
      }
    }
  }
  for (const reaped of result.reaped) {
    console.info(
      `[plugin-kubernetes] removed reusable sandbox ${input.namespace}/${reaped.name} (${reaped.reason})`,
    );
  }
  result.remaining = count;
  return result;
}

async function sweepRegistration(registration: ReuseNamespaceRegistration, reserveSlot: boolean): Promise<SweepResult | null> {
  registration.lastSweepAt = now();
  try {
    const { clients } = getKubeConnection(registration.connection);
    const result = await sweepReusableSandboxes(clients, {
      namespace: registration.namespace,
      maxSandboxes: registration.maxSandboxes,
      reserveSlot,
    });
    if (result.remaining === 0 && registration.maxSandboxes === null && !reserveSlot) {
      // Found by discovery (or by an RPC with reuse off) and now empty: stop
      // sweeping it. Discovery or the next reuse RPC registers it again.
      if (registrations.get(registration.key) === registration) registrations.delete(registration.key);
    }
    return result;
  } catch (err) {
    if (isKubeAuthError(err)) {
      // A rotated or revoked credential: stop sweeping with it. The next RPC
      // registers the namespace again with the credential the host resolves.
      evictKubeConnection(registration.connection);
      registrations.delete(registration.key);
    }
    console.warn(
      `[plugin-kubernetes] reusable sandbox sweep of ${registration.namespace} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function runSweep(registration: ReuseNamespaceRegistration, reserveSlot: boolean): Promise<SweepResult | null> {
  if (registration.inFlight) {
    if (!reserveSlot || registration.inFlightReserves) return registration.inFlight;
    // A running sweep that does not reserve a slot may leave the namespace at
    // the cap: run a reserving one right after it instead of joining it.
    return registration.inFlight.then(() => runSweep(registration, true));
  }
  const inFlight = sweepRegistration(registration, reserveSlot).finally(() => {
    registration.inFlight = null;
    registration.inFlightReserves = false;
  });
  registration.inFlight = inFlight;
  registration.inFlightReserves = reserveSlot;
  return inFlight;
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Jitter so several workers/hosts do not sweep in lockstep.
    const delay = Math.floor(Math.random() * REAPER_JITTER_MS);
    const handle = setTimeout(() => {
      for (const registration of [...registrations.values()]) {
        void runSweep(registration, false);
      }
    }, delay);
    handle.unref?.();
  }, REAPER_INTERVAL_MS);
  // Never keep the worker process alive just for the reaper.
  timer.unref?.();
}

/**
 * Remember a (connection, namespace) pair for the periodic sweep. Every RPC on
 * a reusable lease calls this, so the latest cap and credentials win. Without
 * `maxSandboxes` an existing registration keeps its cap and a new one gets
 * none (TTL rules only).
 */
export function registerReuseNamespace(input: {
  connection: KubeConnectionInput;
  namespace: string;
  maxSandboxes?: number | null;
}): ReuseNamespaceRegistration {
  const key = registrationKey(input.connection, input.namespace);
  let registration = registrations.get(key);
  if (registration) {
    if (input.maxSandboxes !== undefined) registration.maxSandboxes = input.maxSandboxes;
    // Re-insert so the Map keeps least recently registered first.
    registrations.delete(key);
    registrations.set(key, registration);
  } else {
    registration = {
      key,
      connection: { inCluster: input.connection.inCluster === true, kubeconfig: input.connection.kubeconfig },
      namespace: input.namespace,
      maxSandboxes: input.maxSandboxes ?? null,
      lastSweepAt: 0,
      inFlight: null,
      inFlightReserves: false,
      slotTail: Promise.resolve(),
    };
    registrations.set(key, registration);
    while (registrations.size > MAX_REGISTRATIONS) {
      const oldest = registrations.keys().next().value;
      if (oldest === undefined) break;
      registrations.delete(oldest);
    }
  }
  ensureTimer();
  return registration;
}

/**
 * RPC-triggered sweep, at most once per RPC_SWEEP_THROTTLE_MS per namespace.
 * A sweep that reserves a slot for an acquire is never throttled: it is what
 * keeps the namespace under its cap. `waitMs` bounds how long the caller
 * waits; the sweep itself keeps running.
 */
export async function maybeSweepReuseNamespace(
  registration: ReuseNamespaceRegistration,
  options: { reserveSlot?: boolean; waitMs?: number } = {},
): Promise<void> {
  const reserveSlot = options.reserveSlot === true;
  if (!reserveSlot && !registration.inFlight && now() - registration.lastSweepAt < RPC_SWEEP_THROTTLE_MS) return;
  const sweep = runSweep(registration, reserveSlot);
  const waitMs = options.waitMs ?? 0;
  if (waitMs <= 0) return;
  let handle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    sweep,
    new Promise<void>((resolve) => {
      handle = setTimeout(resolve, waitMs);
      handle.unref?.();
    }),
  ]);
  if (handle) clearTimeout(handle);
}

/**
 * Run `work` (a reserving sweep plus the create of a new sandbox) for one
 * namespace at a time within this worker, so concurrent acquires each see the
 * sandboxes the previous one created and the cap holds. A caller waits for the
 * one ahead of it at most `maxWaitMs`, then goes ahead anyway: a stuck API call
 * must not block every other acquire in the namespace.
 */
export async function withReuseSlot<T>(
  registration: ReuseNamespaceRegistration,
  work: () => Promise<T>,
  maxWaitMs: number = ACQUIRE_SLOT_WAIT_MS,
): Promise<T> {
  const previous = registration.slotTail;
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  registration.slotTail = previous.then(() => mine);
  let handle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    previous,
    new Promise<void>((resolve) => {
      handle = setTimeout(resolve, maxWaitMs);
      handle.unref?.();
    }),
  ]);
  if (handle) clearTimeout(handle);
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * List reusable Sandbox CRs across the cluster and register every namespace
 * that holds one, at most once per DISCOVERY_INTERVAL_MS per connection. Runs
 * in the background; failures (for example a credential that may only list
 * its own namespaces) are logged when `reportErrors` is set and otherwise
 * ignored, and never evict the connection.
 */
export function discoverReuseNamespaces(
  connection: KubeConnectionInput,
  options: { reportErrors?: boolean } = {},
): Promise<void> | null {
  const key = connectionKey(connection);
  const last = discoveries.get(key);
  if (last !== undefined && now() - last < DISCOVERY_INTERVAL_MS) return null;
  discoveries.set(key, now());
  // Keep the discovery map bounded like the registrations.
  while (discoveries.size > MAX_REGISTRATIONS) {
    const oldest = discoveries.keys().next().value;
    if (oldest === undefined) break;
    discoveries.delete(oldest);
  }
  return (async () => {
    try {
      const { clients } = getKubeConnection(connection);
      const listed = (await clients.custom.listClusterCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        plural: SANDBOX_PLURAL,
        labelSelector: REUSE_LABEL_SELECTOR,
      })) as { items?: Array<{ metadata?: { namespace?: unknown } }> };
      const namespaces = new Set<string>();
      for (const item of listed.items ?? []) {
        const namespace = item?.metadata?.namespace;
        if (typeof namespace === "string" && namespace.length > 0) namespaces.add(namespace);
      }
      for (const namespace of namespaces) registerReuseNamespace({ connection, namespace });
    } catch (err) {
      if (options.reportErrors) {
        console.warn(
          `[plugin-kubernetes] could not list reusable sandboxes cluster-wide (${err instanceof Error ? err.message : String(err)}); idle sandboxes are swept only in namespaces this worker serves`,
        );
      }
    }
  })();
}

/** Test hooks. */
export function resetIdleReaper(options: { now?: () => number } = {}): void {
  if (timer) clearInterval(timer);
  timer = null;
  registrations.clear();
  discoveries.clear();
  now = options.now ?? Date.now;
}

export function idleReaperState(): {
  registrations: number;
  timerActive: boolean;
  namespaces: Array<{ namespace: string; maxSandboxes: number | null }>;
} {
  return {
    registrations: registrations.size,
    timerActive: timer !== null,
    namespaces: [...registrations.values()].map((registration) => ({
      namespace: registration.namespace,
      maxSandboxes: registration.maxSandboxes,
    })),
  };
}

/** Run the periodic sweep once over every registration (what the timer does). */
export async function sweepAllRegisteredNamespaces(): Promise<void> {
  await Promise.all([...registrations.values()].map((registration) => runSweep(registration, false)));
}
