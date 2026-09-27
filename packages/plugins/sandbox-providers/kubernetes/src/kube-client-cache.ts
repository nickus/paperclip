import { createHash } from "node:crypto";
import type { KubeConfig } from "@kubernetes/client-node";
import { createKubeConfig, makeKubeClients, type KubeClients } from "./kube-client.js";

/**
 * Worker-lifetime cache of parsed KubeConfig + API clients.
 *
 * Every provider RPC (execute, sync, resume, release, ...) receives the
 * resolved provider config and used to parse the kubeconfig YAML and build five
 * API clients from scratch — once per exec, and a chunked upload is dozens of
 * execs. Entries are keyed by a SHA-256 of the connection inputs, so a rotated
 * kubeconfig (different text) never reuses the old client; a bounded TTL
 * re-reads in-cluster credentials periodically, and callers evict on 401/403 so
 * a credential the API server has started rejecting is dropped immediately.
 */

export const KUBE_CLIENT_CACHE_TTL_MS = 5 * 60_000;
// A worker serves a handful of environments; keep the map tiny and bounded.
const KUBE_CLIENT_CACHE_MAX_ENTRIES = 16;

export interface KubeConnectionInput {
  inCluster?: boolean;
  kubeconfig?: string;
}

export interface CachedKubeConnection {
  kc: KubeConfig;
  clients: KubeClients;
}

interface CacheEntry extends CachedKubeConnection {
  expiresAt: number;
}

const entries = new Map<string, CacheEntry>();
let now: () => number = Date.now;

function connectionKey(input: KubeConnectionInput): string {
  // Hash instead of storing the raw kubeconfig text as a Map key.
  return createHash("sha256")
    .update(JSON.stringify([input.inCluster === true, input.kubeconfig ?? ""]))
    .digest("hex");
}

/** Return a cached KubeConfig + clients for these connection inputs, building them on a miss. */
export function getKubeConnection(input: KubeConnectionInput): CachedKubeConnection {
  const key = connectionKey(input);
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now()) {
    return { kc: hit.kc, clients: hit.clients };
  }
  entries.delete(key);
  // Build outside the map so a throwing (invalid) kubeconfig is never cached.
  const kc = createKubeConfig({ inCluster: input.inCluster, kubeconfig: input.kubeconfig });
  const clients = makeKubeClients(kc);
  entries.set(key, { kc, clients, expiresAt: now() + KUBE_CLIENT_CACHE_TTL_MS });
  while (entries.size > KUBE_CLIENT_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value; // Map iterates in insertion order
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return { kc, clients };
}

/** Drop the cached connection for these inputs (next call rebuilds it). */
export function evictKubeConnection(input: KubeConnectionInput): void {
  entries.delete(connectionKey(input));
}

/**
 * Message shapes that carry a 401/403 when no structured status survives:
 * - `HTTP-Code: 401` — the text of client-node's ApiException (kept when a
 *   caller re-wraps it in a plain Error);
 * - `Unexpected server response: 401` — ws's rejected exec/attach upgrade.
 * Deliberately NOT a bare `401`/`forbidden` match: exec watchdog errors embed
 * the pod name and the command's first token, which must never look like a
 * credential rejection.
 */
const KUBE_AUTH_ERROR_MESSAGE = /\bHTTP-Code: 40[13]\b|\bUnexpected server response: 40[13]\b/;

/**
 * True for Kubernetes credential rejections: an ApiException / HTTP error with
 * code 401/403, or a WebSocket exec upgrade rejected with 401/403. The latter
 * reaches us as a ws `ErrorEvent` (not an Error instance) carrying `message`
 * and the underlying `error`, so both are inspected.
 */
export function isKubeAuthError(err: unknown): boolean {
  return matchesKubeAuthError(err, 0);
}

function matchesKubeAuthError(err: unknown, depth: number): boolean {
  if (typeof err === "string") return KUBE_AUTH_ERROR_MESSAGE.test(err);
  if (!err || typeof err !== "object" || depth > 3) return false; // bounded walk over wrappers
  const record = err as {
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
    error?: unknown;
    cause?: unknown;
  };
  // Structured status first (ApiException.code, HTTP-style statusCode/status).
  const code = record.code ?? record.statusCode ?? record.status;
  if (code === 401 || code === 403) return true;
  if (typeof record.message === "string" && KUBE_AUTH_ERROR_MESSAGE.test(record.message)) return true;
  // ws ErrorEvent.error / Error.cause wrap the original rejection.
  return matchesKubeAuthError(record.error, depth + 1) || matchesKubeAuthError(record.cause, depth + 1);
}

/** Evict the cached connection when `err` is a credential rejection. */
export function evictKubeConnectionOnAuthError(input: KubeConnectionInput, err: unknown): void {
  if (isKubeAuthError(err)) evictKubeConnection(input);
}

/**
 * Run `fn` and evict the cached connection if it throws a credential rejection,
 * so the next RPC (which carries the freshly resolved kubeconfig) rebuilds it.
 */
export async function withKubeAuthEviction<T>(
  input: KubeConnectionInput,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    evictKubeConnectionOnAuthError(input, err);
    throw err;
  }
}

/** Test hooks: clear the cache and/or inject a clock. */
export function resetKubeConnectionCache(options: { now?: () => number } = {}): void {
  entries.clear();
  now = options.now ?? Date.now;
}

export function kubeConnectionCacheSize(): number {
  return entries.size;
}
