/**
 * Process-local cache of resolved runtime secret values for environment
 * driver configs (e.g. a sandbox provider's `kubeconfig` secret ref).
 *
 * Why: a plugin-backed sandbox lease re-resolves its provider config on EVERY
 * plugin RPC (execute, file sync, capability resolution, release, ...). A full
 * `secretService.resolveSecretValue` does ~5 selects, a provider decrypt, an
 * UPDATE of `last_resolved_at` and an INSERT into `secret_access_events`; with
 * a few sandboxed agents running that was many system reads per second of the
 * same kubeconfig secret.
 *
 * Safety model:
 * - Entries are keyed by company + consumer (environment) + config path +
 *   secret id + run context, so a hit is only ever served for the exact
 *   binding and run attribution the value was originally authorized for.
 * - Every hit is revalidated against a cheap DB fingerprint (latest version,
 *   version value hash / provider ref, binding id + updatedAt, secret status),
 *   so a rotation, deletion, disable, version revoke or binding removal takes
 *   effect on the very next call, on every server instance.
 * - A bounded TTL still forces a full, audited resolution periodically (and
 *   picks up out-of-band changes such as an external provider value changing
 *   under the same version).
 * - Callers invalidate a consumer's entries when the downstream system reports
 *   an auth failure (401/403), so a rotated credential never stays stuck.
 */

export const RUNTIME_SECRET_CACHE_TTL_MS = 5 * 60_000;
// Hard bound on entries; oldest entries are evicted first (Map keeps insertion order).
const RUNTIME_SECRET_CACHE_MAX_ENTRIES = 1_000;

export interface RuntimeSecretCacheKeyInput {
  companyId: string;
  consumerId: string;
  configPath: string;
  secretId: string;
  version: number | "latest";
  issueId?: string | null;
  heartbeatRunId?: string | null;
}

interface RuntimeSecretCacheEntry {
  value: string;
  // DB fingerprint the value was resolved under; a mismatch means "re-resolve".
  fingerprint: string;
  expiresAt: number;
  consumerId: string;
  secretId: string;
}

function cacheKey(input: RuntimeSecretCacheKeyInput): string {
  // JSON keeps the tuple unambiguous even if an id ever contains a separator.
  return JSON.stringify([
    input.companyId,
    input.consumerId,
    input.configPath,
    input.secretId,
    input.version,
    input.issueId ?? null,
    input.heartbeatRunId ?? null,
  ]);
}

export function createRuntimeSecretValueCache(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}) {
  const ttlMs = options.ttlMs ?? RUNTIME_SECRET_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? RUNTIME_SECRET_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now()); // late-bound so tests can fake the clock
  const entries = new Map<string, RuntimeSecretCacheEntry>();

  return {
    /** Cached value when fresh AND still matching the current DB fingerprint. */
    get(input: RuntimeSecretCacheKeyInput, fingerprint: string): string | null {
      const key = cacheKey(input);
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now() || entry.fingerprint !== fingerprint) {
        entries.delete(key); // stale: TTL elapsed or the secret/binding changed
        return null;
      }
      return entry.value;
    },

    set(input: RuntimeSecretCacheKeyInput, fingerprint: string, value: string): void {
      const key = cacheKey(input);
      entries.delete(key); // re-insert so the entry moves to the "newest" end
      entries.set(key, {
        value,
        fingerprint,
        expiresAt: now() + ttlMs,
        consumerId: input.consumerId,
        secretId: input.secretId,
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    /** Drop every cached value for one consumer (e.g. after a 401/403 from its provider). */
    invalidateConsumer(consumerId: string): void {
      for (const [key, entry] of entries) {
        if (entry.consumerId === consumerId) entries.delete(key);
      }
    },

    invalidateSecret(secretId: string): void {
      for (const [key, entry] of entries) {
        if (entry.secretId === secretId) entries.delete(key);
      }
    },

    clear(): void {
      entries.clear();
    },

    size(): number {
      return entries.size;
    },
  };
}

export type RuntimeSecretValueCache = ReturnType<typeof createRuntimeSecretValueCache>;

// The shared process-wide instance used by environment config resolution.
export const environmentRuntimeSecretCache = createRuntimeSecretValueCache();

/**
 * Status-shaped 401/403 text for errors whose structured status did not survive
 * (a plugin error crosses the worker RPC as a message, and providers re-wrap):
 * client-node's `HTTP-Code: 401`, ws's `Unexpected server response: 401`,
 * `status code 401` / `HTTP 401` / `401 Unauthorized` style HTTP errors. A bare
 * `401` or a lone "forbidden" is NOT enough: provider messages embed pod names,
 * command tokens and paths that must not read as a credential rejection.
 */
const CREDENTIAL_REJECTION_MESSAGE =
  /\bHTTP-Code: 40[13]\b|\bUnexpected server response: 40[13]\b|\bstatus(?: code)?[ :=]+40[13]\b|\bHTTP(?:\/[\d.]+)? 40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b/i;

/**
 * True when an error from a provider call looks like a credential rejection
 * (HTTP 401/403). Used to evict cached secrets so the next call re-resolves the
 * (possibly rotated) credential. A false positive only costs one extra audited
 * read; a false negative leaves an externally changed value cached until the TTL.
 */
export function isCredentialRejectionError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") return CREDENTIAL_REJECTION_MESSAGE.test(error);
  if (typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  // Structured status first; a plugin's numeric error code (e.g. a Kubernetes
  // ApiException's 401) is forwarded as the JSON-RPC error code.
  const status = record.statusCode ?? record.status ?? record.code;
  if (status === 401 || status === 403) return true;
  return typeof record.message === "string" && CREDENTIAL_REJECTION_MESSAGE.test(record.message);
}
