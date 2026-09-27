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
 * (connection, namespace) pairs to sweep, filled by every reuse RPC; after a
 * restart a namespace is swept again from its first reuse RPC on.
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
const MAX_REGISTRATIONS = 64;

export type ReapReason = "idle_expired" | "stale_busy" | "over_capacity";

export interface SweepResult {
  reaped: Array<{ name: string; reason: ReapReason }>;
  /** CAS conflicts: the CR changed after it was read (e.g. a concurrent resume). */
  skipped: string[];
}

export interface ReuseNamespaceRegistration {
  key: string;
  connection: KubeConnectionInput;
  namespace: string;
  maxSandboxes: number;
  lastSweepAt: number;
  inFlight: Promise<SweepResult | null> | null;
}

const registrations = new Map<string, ReuseNamespaceRegistration>();
let timer: ReturnType<typeof setInterval> | null = null;
let now: () => number = Date.now;

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
  input: { namespace: string; maxSandboxes: number; reserveSlot?: boolean; nowMs?: number },
): Promise<SweepResult> {
  const nowMs = input.nowMs ?? now();
  const result: SweepResult = { reaped: [], skipped: [] };
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

  const limit = Math.max(0, input.maxSandboxes - (input.reserveSlot ? 1 : 0));
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
  return result;
}

async function sweepRegistration(registration: ReuseNamespaceRegistration, reserveSlot: boolean): Promise<SweepResult | null> {
  registration.lastSweepAt = now();
  try {
    const { clients } = getKubeConnection(registration.connection);
    return await sweepReusableSandboxes(clients, {
      namespace: registration.namespace,
      maxSandboxes: registration.maxSandboxes,
      reserveSlot,
    });
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
  if (registration.inFlight) return registration.inFlight;
  const inFlight = sweepRegistration(registration, reserveSlot).finally(() => {
    registration.inFlight = null;
  });
  registration.inFlight = inFlight;
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
 * a reusable lease calls this, so the latest cap and credentials win.
 */
export function registerReuseNamespace(input: {
  connection: KubeConnectionInput;
  namespace: string;
  maxSandboxes: number;
}): ReuseNamespaceRegistration {
  const key = registrationKey(input.connection, input.namespace);
  let registration = registrations.get(key);
  if (registration) {
    registration.maxSandboxes = input.maxSandboxes;
    // Re-insert so the Map keeps least recently registered first.
    registrations.delete(key);
    registrations.set(key, registration);
  } else {
    registration = {
      key,
      connection: { inCluster: input.connection.inCluster === true, kubeconfig: input.connection.kubeconfig },
      namespace: input.namespace,
      maxSandboxes: input.maxSandboxes,
      lastSweepAt: 0,
      inFlight: null,
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
 * `waitMs` bounds how long the caller waits; the sweep itself keeps running.
 */
export async function maybeSweepReuseNamespace(
  registration: ReuseNamespaceRegistration,
  options: { reserveSlot?: boolean; waitMs?: number } = {},
): Promise<void> {
  if (!registration.inFlight && now() - registration.lastSweepAt < RPC_SWEEP_THROTTLE_MS) return;
  const sweep = runSweep(registration, options.reserveSlot === true);
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

/** Test hooks. */
export function resetIdleReaper(options: { now?: () => number } = {}): void {
  if (timer) clearInterval(timer);
  timer = null;
  registrations.clear();
  now = options.now ?? Date.now;
}

export function idleReaperState(): { registrations: number; timerActive: boolean } {
  return { registrations: registrations.size, timerActive: timer !== null };
}

/** Run the periodic sweep once over every registration (what the timer does). */
export async function sweepAllRegisteredNamespaces(): Promise<void> {
  await Promise.all([...registrations.values()].map((registration) => runSweep(registration, false)));
}
