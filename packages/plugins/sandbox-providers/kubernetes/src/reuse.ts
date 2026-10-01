/**
 * Reusable sandbox helpers: reuse keys, the pod spec hash, the idle/busy state
 * kept in Sandbox CR annotations, and the idle lifetime.
 *
 * A reusable lease keeps one long-lived Sandbox CR per reuse scope (company,
 * environment, execution workspace, agent, adapter). The host resumes it on the
 * next run for the same scope, so the harness session store and the pod
 * filesystem survive between runs. All state the idle reaper needs lives on the
 * Sandbox CR itself (labels + annotations), so it survives plugin and host
 * restarts without any local storage.
 *
 * Everything in this module is pure; the Kubernetes calls live in
 * lease-lifecycle.ts and idle-reaper.ts.
 */

import { createHash } from "node:crypto";
import type { KubernetesProviderConfig, KubernetesReuseLeaseStamp } from "./types.js";

/** Bump when the reuse stamp or the spec-hash inputs change shape. */
export const REUSE_SPEC_VERSION = 1;

/**
 * Working directory of a reusable sandbox. `/workspace` is the largest emptyDir
 * in the pod (8Gi) and the root native file sync confines itself to; `/tmp`
 * stays free as scratch space that also persists between runs.
 */
export const REUSE_REMOTE_CWD = "/workspace";

export const DEFAULT_REUSE_IDLE_TTL_SEC = 86_400;
export const MIN_REUSE_IDLE_TTL_SEC = 60;
export const MAX_REUSE_IDLE_TTL_SEC = 604_800;
export const DEFAULT_REUSE_MAX_SANDBOXES = 8;
/**
 * Default requests of a reusable sandbox (LimitRange min is 100m/128Mi). A pod
 * cannot change its requests in place here, so these apply for the pod's whole
 * life: while it idles AND while a run uses it. Low requests let many idle
 * sandboxes fit on a node and under a requests quota; the cost is a smaller
 * CPU share under contention and an earlier place in the kubelet's eviction
 * order under node memory pressure during a run. Set `reuseResources.requests`
 * to the regular values to trade idle density for that.
 */
export const DEFAULT_REUSE_REQUESTS = { cpu: "100m", memory: "256Mi" } as const;
/** Same limits a regular sandbox gets (see sandbox-cr-builder.ts). */
export const DEFAULT_SANDBOX_LIMITS = { cpu: "2", memory: "4Gi" } as const;
/**
 * Lower bound of the stale-busy window. A run refreshes busy-since every
 * REUSE_BUSY_REFRESH_MS while it executes, so the window must stay well above
 * that interval whatever `podActivityDeadlineSec` is set to.
 */
export const MIN_REUSE_STALE_BUSY_SEC = 1_800;
/** How often a running command re-marks its sandbox busy (see plugin.ts). */
export const REUSE_BUSY_REFRESH_MS = 5 * 60_000;
/**
 * Consecutive failed runs after which a sandbox is removed at release instead
 * of kept, so a sandbox whose own state breaks every run gets a clean start.
 */
export const REUSE_MAX_CONSECUTIVE_FAILURES = 3;

export const MANAGED_BY_LABEL = "paperclip.io/managed-by";
export const MANAGED_BY_VALUE = "paperclip-k8s-plugin";

export const REUSE_LABELS = {
  reuse: "paperclip.io/reuse",
  reuseKey: "paperclip.io/reuse-key",
  executionWorkspaceId: "paperclip.io/execution-workspace-id",
  issueId: "paperclip.io/issue-id",
} as const;

export const REUSE_ANNOTATIONS = {
  specVersion: "paperclip.io/reuse-spec-version",
  specHash: "paperclip.io/spec-hash",
  reuseKey: "paperclip.io/reuse-key",
  leaseState: "paperclip.io/lease-state",
  busySince: "paperclip.io/busy-since",
  lastUsedAt: "paperclip.io/last-used-at",
  idleTtlSeconds: "paperclip.io/idle-ttl-seconds",
  staleBusySeconds: "paperclip.io/stale-busy-seconds",
  idleExpiresAt: "paperclip.io/idle-expires-at",
  podUid: "paperclip.io/pod-uid",
  consecutiveFailures: "paperclip.io/consecutive-failures",
} as const;

/** Label selector matching every reusable Sandbox CR this plugin created. */
export const REUSE_LABEL_SELECTOR = `${REUSE_LABELS.reuse}=true,${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;

/** Env keys that differ per lease and must not change the spec hash. */
const PER_LEASE_ENV_KEYS = new Set(["BOOTSTRAP_TOKEN"]);
const PER_LEASE_ENV_PREFIX = "PAPERCLIP_NETWORK_EGRESS_";

export interface ReuseResources {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

export interface ReuseSettings {
  /** Reuse is on AND the backend supports it (sandbox-cr only). */
  enabled: boolean;
  idleTtlSec: number;
  maxSandboxes: number;
  /** Seconds a sandbox may stay busy before the reaper treats it as abandoned (plus the idle TTL). */
  staleBusySec: number;
  resources: ReuseResources;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Idle lifetime: `reuseIdleTtlSec` when set, else the host's
 * `runnerIdleTimeoutMs`, else 24h. Clamped to [60s, 7d].
 */
export function resolveReuseIdleTtlSec(
  config: Pick<KubernetesProviderConfig, "reuseIdleTtlSec" | "runnerIdleTimeoutMs">,
): number {
  if (typeof config.reuseIdleTtlSec === "number") {
    return clampInt(config.reuseIdleTtlSec, MIN_REUSE_IDLE_TTL_SEC, MAX_REUSE_IDLE_TTL_SEC);
  }
  if (typeof config.runnerIdleTimeoutMs === "number" && config.runnerIdleTimeoutMs > 0) {
    return clampInt(
      Math.ceil(config.runnerIdleTimeoutMs / 1000),
      MIN_REUSE_IDLE_TTL_SEC,
      MAX_REUSE_IDLE_TTL_SEC,
    );
  }
  return DEFAULT_REUSE_IDLE_TTL_SEC;
}

/** Requests/limits for a reusable sandbox; partial overrides merge per field. */
export function resolveReuseResources(
  config: Pick<KubernetesProviderConfig, "reuseResources" | "defaultResources">,
): ReuseResources {
  const requests = config.reuseResources?.requests ?? {};
  const limits = config.reuseResources?.limits ?? {};
  const baseLimits = config.defaultResources?.limits ?? {};
  return {
    requests: {
      cpu: requests.cpu ?? DEFAULT_REUSE_REQUESTS.cpu,
      memory: requests.memory ?? DEFAULT_REUSE_REQUESTS.memory,
    },
    limits: {
      cpu: limits.cpu ?? baseLimits.cpu ?? DEFAULT_SANDBOX_LIMITS.cpu,
      memory: limits.memory ?? baseLimits.memory ?? DEFAULT_SANDBOX_LIMITS.memory,
    },
  };
}

export function resolveReuseSettings(config: KubernetesProviderConfig): ReuseSettings {
  return {
    enabled: config.reuseLease === true && config.backend === "sandbox-cr",
    idleTtlSec: resolveReuseIdleTtlSec(config),
    maxSandboxes: config.reuseMaxSandboxes ?? DEFAULT_REUSE_MAX_SANDBOXES,
    staleBusySec: Math.max(config.podActivityDeadlineSec, MIN_REUSE_STALE_BUSY_SEC),
    resources: resolveReuseResources(config),
  };
}

export interface ReuseKeyInput {
  companyId: string;
  environmentId: string;
  /**
   * The scope key is the execution workspace when the issue has a project, or
   * (when it has none, e.g. a chat task) the issue itself: the host falls
   * back to the issue the same way (see `buildReusableSandboxLeaseScope` in
   * the server's environment-runtime). Exactly one of the two is used; when
   * `executionWorkspaceId` is set, `projectlessIssueId` is ignored, matching
   * the host's own precedence.
   */
  executionWorkspaceId: string | null;
  projectlessIssueId?: string | null;
  agentId: string;
  runAdapterType: string;
}

/**
 * SHA-256 over the reuse scope; the host decides reuse with the same scope.
 * The scope key stays exactly the bare execution-workspace id when there is
 * one, so this keeps hashing an existing project-workspace sandbox's key the
 * same way it always has (no spurious rebuild on upgrade); a projectless
 * scope hashes a tagged issue id instead, which cannot collide with a real
 * execution-workspace id.
 */
export function computeReuseKey(input: ReuseKeyInput): string {
  const scopeKey = input.executionWorkspaceId ?? `issue:${input.projectlessIssueId ?? ""}`;
  return createHash("sha256")
    .update([input.companyId, input.environmentId, scopeKey, input.agentId, input.runAdapterType].join("|"))
    .digest("hex");
}

/** Label values are capped at 63 characters; 40 hex characters are plenty to select by. */
export function reuseKeyLabelValue(key: string): string {
  return key.slice(0, 40);
}

const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

/** The value when it is a valid Kubernetes label value, else null (the label is then omitted). */
export function labelSafe(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 63) return null;
  return LABEL_VALUE.test(value) ? value : null;
}

/** JSON.stringify with sorted object keys, so equal values always hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Digest of the adapter env without the per-lease entries (bootstrap token, egress grant). */
export function adapterEnvDigest(adapterEnv: Record<string, string>): string {
  const stable: Record<string, string> = {};
  for (const [key, value] of Object.entries(adapterEnv)) {
    if (PER_LEASE_ENV_KEYS.has(key) || key.startsWith(PER_LEASE_ENV_PREFIX)) continue;
    stable[key] = value;
  }
  return sha256(stableStringify(stable));
}

export interface ReuseSpecHashInput {
  namespace: string;
  backend: string;
  /**
   * The rendered pod template spec, built with placeholder names and no labels
   * (image, command, env, resources, runtimeClass, pull secrets, security
   * context, volumes).
   */
  podTemplateSpec: unknown;
  /** Adapter env as written to the per-lease Secret. */
  adapterEnv: Record<string, string>;
}

/**
 * Hash of everything that shapes the sandbox pod. A sandbox is resumed only
 * while the current config still renders the same hash, so a pod built from an
 * old image, resources or adapter credentials is never reused.
 */
export function computeReuseSpecHash(input: ReuseSpecHashInput): string {
  return sha256(
    stableStringify({
      version: REUSE_SPEC_VERSION,
      backend: input.backend,
      namespace: input.namespace,
      podTemplateSpec: input.podTemplateSpec,
      adapterEnvDigest: adapterEnvDigest(input.adapterEnv),
    }),
  );
}

export function buildReuseLabels(input: {
  reuseKey: string;
  executionWorkspaceId: string | null;
  issueId?: string | null;
}): Record<string, string> {
  const labels: Record<string, string> = {
    [REUSE_LABELS.reuse]: "true",
    [REUSE_LABELS.reuseKey]: reuseKeyLabelValue(input.reuseKey),
  };
  const workspace = labelSafe(input.executionWorkspaceId);
  if (workspace) labels[REUSE_LABELS.executionWorkspaceId] = workspace;
  const issue = labelSafe(input.issueId);
  if (issue) labels[REUSE_LABELS.issueId] = issue;
  return labels;
}

/** Annotations of a freshly created reusable sandbox: busy from the start. */
export function buildInitialReuseAnnotations(input: {
  specHash: string;
  reuseKey: string;
  idleTtlSec: number;
  staleBusySec: number;
  now: Date;
}): Record<string, string> {
  return {
    [REUSE_ANNOTATIONS.specVersion]: String(REUSE_SPEC_VERSION),
    [REUSE_ANNOTATIONS.specHash]: input.specHash,
    [REUSE_ANNOTATIONS.reuseKey]: input.reuseKey,
    [REUSE_ANNOTATIONS.leaseState]: "busy",
    [REUSE_ANNOTATIONS.busySince]: input.now.toISOString(),
    [REUSE_ANNOTATIONS.lastUsedAt]: input.now.toISOString(),
    [REUSE_ANNOTATIONS.idleTtlSeconds]: String(input.idleTtlSec),
    [REUSE_ANNOTATIONS.staleBusySeconds]: String(input.staleBusySec),
  };
}

/** Annotations written when a run resumes the sandbox. */
export function buildBusyAnnotations(input: {
  now: Date;
  idleTtlSec: number;
  staleBusySec: number;
}): Record<string, string> {
  return {
    [REUSE_ANNOTATIONS.leaseState]: "busy",
    [REUSE_ANNOTATIONS.busySince]: input.now.toISOString(),
    [REUSE_ANNOTATIONS.idleTtlSeconds]: String(input.idleTtlSec),
    [REUSE_ANNOTATIONS.staleBusySeconds]: String(input.staleBusySec),
  };
}

/** Annotations written when a run releases the sandbox and it starts idling. */
export function buildIdleAnnotations(input: {
  now: Date;
  idleTtlSec: number;
  podUid: string;
  /** Failed runs in a row, this one included; 0 after a run that did not fail. */
  consecutiveFailures?: number;
}): Record<string, string> {
  return {
    [REUSE_ANNOTATIONS.leaseState]: "idle",
    [REUSE_ANNOTATIONS.consecutiveFailures]: String(input.consecutiveFailures ?? 0),
    [REUSE_ANNOTATIONS.lastUsedAt]: input.now.toISOString(),
    [REUSE_ANNOTATIONS.idleTtlSeconds]: String(input.idleTtlSec),
    // Informational only: the reaper always recomputes from last-used-at.
    [REUSE_ANNOTATIONS.idleExpiresAt]: new Date(
      input.now.getTime() + input.idleTtlSec * 1000,
    ).toISOString(),
    [REUSE_ANNOTATIONS.podUid]: input.podUid,
  };
}

/** RFC 6902 JSON Pointer escaping ("~" -> "~0", "/" -> "~1"). */
function jsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * JSON Patch (the client's default patch content type for custom objects) that
 * sets the given annotations. Reusable Sandbox CRs are always created with an
 * annotations map, so `add` on each key is well defined (it replaces).
 */
export function annotationsJsonPatch(
  annotations: Record<string, string>,
): Array<{ op: "add"; path: string; value: string }> {
  return Object.entries(annotations).map(([key, value]) => ({
    op: "add" as const,
    path: annotationPath(key),
    value,
  }));
}

export function annotationPath(key: string): string {
  return `/metadata/annotations/${jsonPointerToken(key)}`;
}

export function labelPath(key: string): string {
  return `/metadata/labels/${jsonPointerToken(key)}`;
}

/**
 * JSON Patch that hands a stopped sandbox that is not kept between runs to the
 * idle reaper. The reuse labels let the reaper's selector find it, and the idle
 * annotations give it an idle lifetime, after which the reaper removes it. It
 * gets no reuse key, so no run takes it as a task's kept sandbox, and the
 * removal of a task's idle sandboxes (keyed by reuse key) never touches it.
 * `metadata` is the CR's metadata as read: a missing labels or annotations map
 * is added whole, since JSON Patch cannot add a key to a map that is not there.
 */
export function stoppedSandboxReaperJsonPatch(input: {
  metadata: { labels?: unknown; annotations?: unknown } | undefined;
  idleAnnotations: Record<string, string>;
}): Array<{ op: "add"; path: string; value: string | Record<string, string> }> {
  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [REUSE_LABELS.reuse]: "true" };
  const hasMap = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return [
    ...(hasMap(input.metadata?.labels)
      ? Object.entries(labels).map(([key, value]) => ({ op: "add" as const, path: labelPath(key), value }))
      : [{ op: "add" as const, path: "/metadata/labels", value: labels }]),
    ...(hasMap(input.metadata?.annotations)
      ? annotationsJsonPatch(input.idleAnnotations)
      : [{ op: "add" as const, path: "/metadata/annotations", value: { ...input.idleAnnotations } }]),
  ];
}

/**
 * JSON Patch that moves busy-since forward only while the sandbox is still
 * busy: the `test` op fails (HTTP 422) once a release marked it idle, so a late
 * refresh never overwrites a newer state.
 */
export function busyRefreshJsonPatch(now: Date): Array<{ op: "test" | "add"; path: string; value: string }> {
  return [
    { op: "test", path: annotationPath(REUSE_ANNOTATIONS.leaseState), value: "busy" },
    { op: "add", path: annotationPath(REUSE_ANNOTATIONS.busySince), value: now.toISOString() },
  ];
}

export interface ReusableSandboxState {
  name: string;
  resourceVersion: string | null;
  deleting: boolean;
  leaseState: "busy" | "idle" | "unknown";
  /** ms since epoch; falls back to the creation time. */
  lastUsedAt: number;
  /** ms since epoch; falls back to the creation time. */
  busySince: number;
  idleTtlSec: number;
  staleBusySec: number;
  podName: string;
  reuseKey: string | null;
  specHash: string | null;
  podUid: string | null;
  /** Failed runs in a row recorded at the last release (0 when absent). */
  consecutiveFailures: number;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

/** Read the reuse state of a Sandbox CR (as returned by the API); null when it has no name. */
export function readReusableSandboxState(cr: unknown): ReusableSandboxState | null {
  if (!cr || typeof cr !== "object") return null;
  const record = cr as {
    metadata?: {
      name?: unknown;
      resourceVersion?: unknown;
      deletionTimestamp?: unknown;
      creationTimestamp?: unknown;
      annotations?: Record<string, unknown>;
    };
    status?: { podName?: unknown };
  };
  const name = typeof record.metadata?.name === "string" ? record.metadata.name : null;
  if (!name) return null;
  const annotations = record.metadata?.annotations ?? {};
  // A Date when the client deserialized it, a string in tests / raw JSON.
  const created = record.metadata?.creationTimestamp;
  const createdAt =
    created instanceof Date ? created.getTime() : parseTime(created) ?? 0;
  const state = annotations[REUSE_ANNOTATIONS.leaseState];
  const podName =
    typeof record.status?.podName === "string" && record.status.podName.length > 0
      ? record.status.podName
      : name;
  return {
    name,
    resourceVersion:
      typeof record.metadata?.resourceVersion === "string" ? record.metadata.resourceVersion : null,
    deleting: Boolean(record.metadata?.deletionTimestamp),
    leaseState: state === "busy" || state === "idle" ? state : "unknown",
    lastUsedAt: parseTime(annotations[REUSE_ANNOTATIONS.lastUsedAt]) ?? createdAt,
    busySince: parseTime(annotations[REUSE_ANNOTATIONS.busySince]) ?? createdAt,
    idleTtlSec: parsePositiveInt(annotations[REUSE_ANNOTATIONS.idleTtlSeconds]) ?? DEFAULT_REUSE_IDLE_TTL_SEC,
    staleBusySec: parsePositiveInt(annotations[REUSE_ANNOTATIONS.staleBusySeconds]) ?? 3600,
    podName,
    reuseKey: typeof annotations[REUSE_ANNOTATIONS.reuseKey] === "string"
      ? (annotations[REUSE_ANNOTATIONS.reuseKey] as string)
      : null,
    specHash: typeof annotations[REUSE_ANNOTATIONS.specHash] === "string"
      ? (annotations[REUSE_ANNOTATIONS.specHash] as string)
      : null,
    podUid: typeof annotations[REUSE_ANNOTATIONS.podUid] === "string" && annotations[REUSE_ANNOTATIONS.podUid]
      ? (annotations[REUSE_ANNOTATIONS.podUid] as string)
      : null,
    consecutiveFailures: parsePositiveInt(annotations[REUSE_ANNOTATIONS.consecutiveFailures]) ?? 0,
  };
}

export type ReapDecision =
  | { reap: true; reason: "idle_expired" | "stale_busy" }
  | { reap: false };

/**
 * TTL rules, with t = now, L = last-used-at, B = busy-since, T = idle TTL and
 * D = stale-busy seconds:
 *   idle and t > L + T        -> reap (idle too long)
 *   busy and t > B + D + T    -> reap (abandoned: its run never released it)
 * A sandbox with no recognizable state is treated as busy since its creation.
 */
export function reapDecision(state: ReusableSandboxState, nowMs: number): ReapDecision {
  if (state.deleting) return { reap: false };
  const ttlMs = state.idleTtlSec * 1000;
  if (state.leaseState === "idle") {
    return nowMs > state.lastUsedAt + ttlMs ? { reap: true, reason: "idle_expired" } : { reap: false };
  }
  return nowMs > state.busySince + state.staleBusySec * 1000 + ttlMs
    ? { reap: true, reason: "stale_busy" }
    : { reap: false };
}

/** The reuse stamp from lease metadata, or null for an ordinary (non-reusable) lease. */
export function readReuseStamp(metadata: Record<string, unknown> | null | undefined): KubernetesReuseLeaseStamp | null {
  const raw = metadata?.kubernetesReuse;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    typeof record.specHash !== "string" ||
    typeof record.runAdapterType !== "string"
  ) {
    return null;
  }
  return {
    version: typeof record.version === "number" ? record.version : REUSE_SPEC_VERSION,
    key: record.key,
    specHash: record.specHash,
    runAdapterType: record.runAdapterType,
    idleTtlSec: typeof record.idleTtlSec === "number" ? record.idleTtlSec : DEFAULT_REUSE_IDLE_TTL_SEC,
    podUid: typeof record.podUid === "string" && record.podUid.length > 0 ? record.podUid : null,
  };
}

// ── Quota arithmetic (README + validateConfig warning) ─────────────────────

/** Parse a CPU quantity ("2", "500m", "1.5") into millicores; null when unrecognized. */
export function parseCpuMillis(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseFloat(match[1]!);
  return match[2] === "m" ? amount : amount * 1000;
}

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** Parse a memory quantity ("4Gi", "256Mi", "1G") into bytes; null when unrecognized. */
export function parseMemoryBytes(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kKMGT]i?|)$/.exec(value.trim());
  if (!match) return null;
  const unit = MEMORY_UNITS[match[2]!];
  if (unit === undefined) return null;
  return Number.parseFloat(match[1]!) * unit;
}

export interface TenantQuota {
  pods: string;
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
}

/**
 * How many reusable sandboxes fit in the tenant quota:
 *   min(pods, ⌊limits.cpu/Lcpu⌋, ⌊limits.mem/Lmem⌋, ⌊req.cpu/Rcpu⌋, ⌊req.mem/Rmem⌋).
 * Null when a quantity cannot be parsed.
 */
export function maxReusableSandboxesInQuota(quota: TenantQuota, resources: ReuseResources): number | null {
  const pods = Number.parseInt(quota.pods, 10);
  const pairs: Array<[number | null, number | null]> = [
    [parseCpuMillis(quota.limitsCpu), parseCpuMillis(resources.limits.cpu)],
    [parseMemoryBytes(quota.limitsMemory), parseMemoryBytes(resources.limits.memory)],
    [parseCpuMillis(quota.requestsCpu), parseCpuMillis(resources.requests.cpu)],
    [parseMemoryBytes(quota.requestsMemory), parseMemoryBytes(resources.requests.memory)],
  ];
  if (!Number.isFinite(pods)) return null;
  let max = pods;
  for (const [total, perPod] of pairs) {
    if (total === null || perPod === null || perPod <= 0) return null;
    max = Math.min(max, Math.floor(total / perPod));
  }
  return max;
}
