/**
 * Resume + destroy lifecycle helpers for Kubernetes sandbox leases.
 *
 * Resume semantics: a lease is resumable only while its workload resource
 * (Sandbox CR or Job) still exists and its pod is Running/Ready (or becomes
 * Ready within a short bounded wait). Unlike Daytona — where a stopped sandbox
 * can be started again by ID — Kubernetes pods are NOT restartable: once the
 * pod backing a lease is gone or terminally failed, the lease can never be
 * revived in place. That asymmetry is intentional; the plugin reports the
 * lease as expired and the server falls back to a fresh acquireLease, which
 * provisions a new pod.
 *
 * Destroy semantics: the forced cleanup path. Deletes every resource
 * acquireLease created (Sandbox CR / Job, its pod, the per-run Secret),
 * treating 404s as success so it is idempotent and safe to call against
 * half-deleted leases.
 */

import type { KubeClients } from "./kube-client.js";
import { deleteJob, findPodForJob, getJobStatus } from "./job-orchestrator.js";
import {
  SANDBOX_GROUP,
  SANDBOX_PLURAL,
  SANDBOX_VERSION,
  deleteSandboxCr,
  findPodForSandbox,
  waitForSandboxReady,
} from "./sandbox-cr-orchestrator.js";
import { REUSE_ANNOTATIONS, annotationsJsonPatch } from "./reuse.js";

/** True when a Kubernetes API error means "resource not found" (HTTP 404). */
export function isKubeNotFoundError(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  return code === 404;
}

async function ignoreNotFound(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (!isKubeNotFoundError(err)) throw err;
  }
}

export type ResumeCheckResult =
  | { resumable: true; podName: string | null; phase: "Pending" | "Running" }
  | { resumable: false; reason: string };

export interface ResumeCheckInput {
  namespace: string;
  /** Workload resource name (Sandbox CR name or Job name) == providerLeaseId. */
  name: string;
  backend: "sandbox-cr" | "job";
  /** Bounded wait for an existing Sandbox pod to report Ready. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Check whether the workload behind a lease is still alive and exec-able.
 * Returns `resumable: false` (never throws "expected" states) when the
 * resource is gone (404), terminally failed, terminating, or doesn't become
 * Ready within the bounded wait — all of which mean the caller should fall
 * back to a fresh acquireLease.
 */
export async function checkLeaseResumable(
  clients: KubeClients,
  input: ResumeCheckInput,
): Promise<ResumeCheckResult> {
  if (input.backend === "sandbox-cr") {
    // Bounded wait for the Sandbox to report Ready. waitForSandboxReady fails
    // fast on Failed/Terminating; a timeout means the pod never came up. None
    // of those states are resumable — k8s pods cannot be restarted in place.
    try {
      await waitForSandboxReady(clients, input.namespace, input.name, {
        timeoutMs: input.readyTimeoutMs ?? 30_000,
        pollMs: input.pollMs ?? 1_000,
      });
    } catch (err) {
      if (isKubeNotFoundError(err)) {
        return { resumable: false, reason: "Sandbox CR no longer exists" };
      }
      return {
        resumable: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    let podName: string | null;
    try {
      podName = await findPodForSandbox(clients, input.namespace, input.name);
    } catch (err) {
      // CR deleted between the readiness check and the pod lookup.
      if (isKubeNotFoundError(err)) {
        return { resumable: false, reason: "Sandbox CR no longer exists" };
      }
      throw err;
    }
    if (!podName) {
      return {
        resumable: false,
        reason: "Sandbox is Ready but no backing pod was found",
      };
    }

    // Confirm the pod itself is Running and not being torn down — the CR
    // status can lag pod deletion.
    let pod: { metadata?: { deletionTimestamp?: unknown }; status?: { phase?: string } };
    try {
      pod = await clients.core.readNamespacedPod({
        namespace: input.namespace,
        name: podName,
      }) as typeof pod;
    } catch (err) {
      if (isKubeNotFoundError(err)) {
        return { resumable: false, reason: `Pod ${podName} no longer exists` };
      }
      throw err;
    }
    const podPhase = pod.status?.phase;
    const terminating = Boolean(pod.metadata?.deletionTimestamp);
    if (podPhase !== "Running" || terminating) {
      return {
        resumable: false,
        reason: `Pod ${podName} is ${terminating ? "terminating" : podPhase ?? "in an unknown phase"}`,
      };
    }
    return { resumable: true, podName, phase: "Running" };
  }

  // ── Job backend ───────────────────────────────────────────────────────────
  let status;
  try {
    status = await getJobStatus(clients, input.namespace, input.name);
  } catch (err) {
    if (isKubeNotFoundError(err)) {
      return { resumable: false, reason: "Job no longer exists" };
    }
    throw err;
  }
  if (status.phase === "Succeeded" || status.phase === "Failed") {
    // Terminal Jobs cannot be re-run in place.
    return { resumable: false, reason: `Job is ${status.phase}` };
  }
  // Pending/Running Jobs are resumable: execute() waits for completion
  // itself, so a not-yet-scheduled pod (podName null) is fine here.
  const podName = await findPodForJob(clients, input.namespace, input.name);
  return {
    resumable: true,
    podName,
    phase: status.phase === "Running" ? "Running" : "Pending",
  };
}

export interface DestroyLeaseInput {
  namespace: string;
  /** Workload resource name (Sandbox CR name or Job name) == providerLeaseId. */
  name: string;
  backend: "sandbox-cr" | "job";
  podName: string | null;
  secretName: string | null;
  /**
   * Grace period for the explicit pod delete. The lease's run is over, so the
   * teardown paths shorten the default 30s (a `sleep infinity` sandbox pod
   * never exits on SIGTERM) to let the stop be confirmed within one RPC.
   */
  podGracePeriodSeconds?: number;
}

/**
 * Forcibly delete every resource acquireLease created for this lease.
 * Workload first (its deletion cascades to the pod and, via ownerReferences,
 * the per-run Secret in the normal case); then the pod and Secret explicitly
 * so a wedged controller or broken ownerRef cannot strand them. Every delete
 * treats 404 as success — destroy is idempotent.
 */
export async function destroyLeaseResources(
  clients: KubeClients,
  input: DestroyLeaseInput,
): Promise<void> {
  if (input.backend === "sandbox-cr") {
    await ignoreNotFound(deleteSandboxCr(clients, input.namespace, input.name));
  } else {
    await ignoreNotFound(deleteJob(clients, input.namespace, input.name));
  }
  if (input.podName) {
    await ignoreNotFound(
      clients.core.deleteNamespacedPod({
        namespace: input.namespace,
        name: input.podName,
        ...(input.podGracePeriodSeconds !== undefined
          ? { gracePeriodSeconds: input.podGracePeriodSeconds }
          : {}),
      }),
    );
  }
  if (input.secretName) {
    await ignoreNotFound(
      clients.core.deleteNamespacedSecret({
        namespace: input.namespace,
        name: input.secretName,
      }),
    );
  }
}

/** Grace period the release/destroy handlers give the sandbox pod. */
export const TEARDOWN_POD_GRACE_PERIOD_SECONDS = 5;
/** Bounded wait for the API server to confirm the resources are gone. Kept
 * below the host's default 30s plugin RPC timeout. */
export const TEARDOWN_CONFIRM_TIMEOUT_MS = 20_000;

export interface ConfirmGoneInput {
  namespace: string;
  /** Workload resource name (Sandbox CR name or Job name) == providerLeaseId. */
  name: string;
  backend: "sandbox-cr" | "job";
  podName: string | null;
  timeoutMs?: number;
  pollMs?: number;
}

/** Resolve 404 to `true` (gone); any other read result means still present. */
async function isGone(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return false;
  } catch (err) {
    if (isKubeNotFoundError(err)) return true;
    throw err;
  }
}

/**
 * Poll until the API server reports the workload and its pod as gone (404).
 * Deletion uses Foreground propagation, so the workload object itself only
 * disappears after the garbage collector removed its pods; an explicit pod
 * read additionally covers a pod whose ownerReference was broken. The Job
 * backend also requires that no pod labelled for the Job remains. Returns
 * false (never throws on "still terminating") when the bounded wait expires.
 */
export async function confirmLeaseResourcesGone(
  clients: KubeClients,
  input: ConfirmGoneInput,
): Promise<boolean> {
  const deadline = Date.now() + (input.timeoutMs ?? TEARDOWN_CONFIRM_TIMEOUT_MS);
  const pollMs = input.pollMs ?? 1_000;
  for (;;) {
    const workloadGone = await isGone(() =>
      input.backend === "sandbox-cr"
        ? clients.custom.getNamespacedCustomObject({
            group: SANDBOX_GROUP,
            version: SANDBOX_VERSION,
            namespace: input.namespace,
            plural: SANDBOX_PLURAL,
            name: input.name,
          })
        : clients.batch.readNamespacedJobStatus({
            namespace: input.namespace,
            name: input.name,
          }),
    );
    const podGone = !workloadGone
      ? false
      : input.podName
        ? await isGone(() =>
            clients.core.readNamespacedPod({ namespace: input.namespace, name: input.podName! }),
          )
        : true;
    // A Job's pods carry the controller-set `job-name` label.
    const jobPodsGone = !podGone || input.backend !== "job"
      ? podGone
      : (await findPodForJob(clients, input.namespace, input.name)) === null;
    if (jobPodsGone) return true;
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Mirrors the SDK's PluginEnvironmentTerminationReceipt. */
export interface LeaseTerminationReceipt {
  providerLeaseId: string;
  state: "destroyed";
}

/**
 * Tear a lease down and confirm it. Deletes every resource acquireLease
 * created, then waits for the API server to report them gone, and only then
 * returns a termination receipt. The host treats the receipt as proof that the
 * run's remote execution has ended (it gates saved-comment continuation after
 * a Stop), so an unconfirmed teardown throws: the host then keeps the lease in
 * pending_cleanup and retries through onEnvironmentDestroyLease.
 */
export async function terminateLeaseResources(
  clients: KubeClients,
  input: Omit<DestroyLeaseInput, "podGracePeriodSeconds"> & {
    confirmTimeoutMs?: number;
    confirmPollMs?: number;
  },
): Promise<LeaseTerminationReceipt> {
  let podName = input.podName;
  if (!podName) {
    // A lease cancelled while its pod was starting may not have recorded the
    // pod name yet. Best-effort lookup; a gone workload means no pod to find.
    try {
      podName = input.backend === "sandbox-cr"
        ? await findPodForSandbox(clients, input.namespace, input.name)
        : await findPodForJob(clients, input.namespace, input.name);
    } catch (err) {
      if (!isKubeNotFoundError(err)) throw err;
    }
  }
  await destroyLeaseResources(clients, {
    namespace: input.namespace,
    name: input.name,
    backend: input.backend,
    podName,
    secretName: input.secretName,
    podGracePeriodSeconds: TEARDOWN_POD_GRACE_PERIOD_SECONDS,
  });
  const confirmed = await confirmLeaseResourcesGone(clients, {
    namespace: input.namespace,
    name: input.name,
    backend: input.backend,
    podName,
    timeoutMs: input.confirmTimeoutMs,
    pollMs: input.confirmPollMs,
  });
  if (!confirmed) {
    throw new Error(
      `Kubernetes lease ${input.name} in namespace ${input.namespace} is still terminating; stop not yet confirmed.`,
    );
  }
  return { providerLeaseId: input.name, state: "destroyed" };
}

// ── Reusable sandboxes ──────────────────────────────────────────────────────
//
// A reusable lease keeps its Sandbox CR between runs (see reuse.ts). Resuming
// one must tell "the sandbox is gone or no longer usable" (return expired, the
// host then destroys the lease and provisions a fresh sandbox) apart from "the
// API could not be reached right now" (throw, the host keeps the lease and
// retries). Treating a temporary API error as "gone" would throw away the
// task's sandbox, and with it the harness session and the working tree.

/** HTTP status of a Kubernetes client error, or null for transport failures. */
function kubeStatusCode(err: unknown): number | null {
  const record = err as { code?: unknown; statusCode?: unknown; status?: unknown } | null;
  const code = record?.code ?? record?.statusCode ?? record?.status;
  return typeof code === "number" ? code : null;
}

/**
 * True for errors that say nothing about the sandbox itself: 5xx, 408, 429,
 * credential rejections (401/403, which the RPC wrapper answers by rebuilding
 * the client) and transport failures without an HTTP status.
 */
export function isTransientKubeError(err: unknown): boolean {
  const status = kubeStatusCode(err);
  if (status === null) return true;
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/**
 * Thrown by the reusable-lease paths for a temporary failure. The message
 * carries the word "network" so the host's resume retry classifies it as
 * transient; the original error stays reachable through `cause` (the RPC
 * wrapper evicts a rejected credential by walking it).
 */
export class KubernetesTransientError extends Error {
  constructor(action: string, detail: string, cause?: unknown) {
    super(`Transient Kubernetes API or network failure while ${action}; the sandbox is kept: ${detail}`);
    this.name = "KubernetesTransientError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ReuseExpiryReason =
  | "not_found"
  | "deleting"
  | "failed"
  | "spec_changed"
  | "identity_mismatch"
  | "pod_replaced"
  | "pod_unhealthy"
  | "pod_not_ready";

export type ReusableResumeCheck =
  | { resumable: true; podName: string; podUid: string }
  | { resumable: false; reason: ReuseExpiryReason; detail: string };

/** Container waiting reasons that will not fix themselves in a reused pod. */
const STUCK_CONTAINER_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "InvalidImageName",
]);

/** A pod may be not Ready this long (e.g. a node restart) before it is given up on. */
export const REUSE_NOT_READY_EXPIRY_MS = 300_000;

export interface ReusableResumeCheckInput {
  namespace: string;
  name: string;
  expectedReuseKey: string;
  /** Spec hash rendered from the CURRENT config; null when it cannot be rendered. */
  expectedSpecHash: string | null;
  expectedSpecVersion: string;
  readyTimeoutMs?: number;
  pollMs?: number;
  notReadyExpiryMs?: number;
  now?: () => number;
}

interface PodLike {
  metadata?: { uid?: string; deletionTimestamp?: unknown; creationTimestamp?: unknown };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: unknown }>;
    containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>;
  };
}

function toMillis(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function readOrTransient<T>(action: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (isKubeNotFoundError(err)) return null;
    if (isTransientKubeError(err)) throw new KubernetesTransientError(action, errorText(err), err);
    throw err;
  }
}

/**
 * Decide whether a reusable Sandbox CR can serve the next run. Read-only: it
 * never kills processes and never changes the CR (the caller marks it busy
 * afterwards), so a slow resume from a run that lost the lease race is harmless.
 *
 * Returns `resumable: false` for states that will not recover: CR gone or being
 * deleted, CR failed, a different reuse key or spec hash, the recorded pod
 * replaced, a stuck container, or a pod not Ready for longer than
 * `notReadyExpiryMs`. Throws KubernetesTransientError for temporary API errors
 * and for a pod that is only briefly not Ready.
 */
export async function checkReusableLeaseResumable(
  clients: KubeClients,
  input: ReusableResumeCheckInput,
): Promise<ReusableResumeCheck> {
  const now = input.now ?? Date.now;
  const action = `resuming sandbox ${input.namespace}/${input.name}`;
  const cr = await readOrTransient(action, () =>
    clients.custom.getNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: input.namespace,
      plural: SANDBOX_PLURAL,
      name: input.name,
    }),
  ) as Record<string, unknown> | null;
  if (!cr) return { resumable: false, reason: "not_found", detail: "Sandbox CR no longer exists" };

  const metadata = (cr.metadata ?? {}) as {
    deletionTimestamp?: unknown;
    annotations?: Record<string, unknown>;
  };
  if (metadata.deletionTimestamp) {
    return { resumable: false, reason: "deleting", detail: "Sandbox CR is being deleted" };
  }
  const status = (cr.status ?? {}) as {
    phase?: string;
    podName?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  };
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  if (
    status.phase === "Failed" ||
    conditions.some((c) => c.type === "Failed" && c.status === "True")
  ) {
    return { resumable: false, reason: "failed", detail: "Sandbox CR reports Failed" };
  }

  const annotations = metadata.annotations ?? {};
  if (annotations[REUSE_ANNOTATIONS.reuseKey] !== input.expectedReuseKey) {
    return {
      resumable: false,
      reason: "identity_mismatch",
      detail: "Sandbox reuse key does not match this lease",
    };
  }
  if (
    annotations[REUSE_ANNOTATIONS.specVersion] !== input.expectedSpecVersion ||
    input.expectedSpecHash === null ||
    annotations[REUSE_ANNOTATIONS.specHash] !== input.expectedSpecHash
  ) {
    return {
      resumable: false,
      reason: "spec_changed",
      detail: "Sandbox was created from a different image or configuration",
    };
  }
  const recordedPodUid =
    typeof annotations[REUSE_ANNOTATIONS.podUid] === "string" && annotations[REUSE_ANNOTATIONS.podUid]
      ? (annotations[REUSE_ANNOTATIONS.podUid] as string)
      : null;
  const podName =
    typeof status.podName === "string" && status.podName.length > 0 ? status.podName : input.name;

  const readyTimeoutMs = input.readyTimeoutMs ?? 30_000;
  const pollMs = input.pollMs ?? 1_000;
  const notReadyExpiryMs = input.notReadyExpiryMs ?? REUSE_NOT_READY_EXPIRY_MS;
  const deadline = now() + readyTimeoutMs;
  let notReadySince: number | null = null;
  for (;;) {
    const pod = await readOrTransient(action, () =>
      clients.core.readNamespacedPod({ namespace: input.namespace, name: podName }),
    ) as PodLike | null;
    if (!pod) {
      if (recordedPodUid) {
        // The pod whose filesystem held the task state is gone; a replacement
        // pod would start empty.
        return { resumable: false, reason: "pod_replaced", detail: `Pod ${podName} no longer exists` };
      }
    } else {
      const uid = pod.metadata?.uid ?? "";
      if (pod.metadata?.deletionTimestamp) {
        return { resumable: false, reason: "deleting", detail: `Pod ${podName} is terminating` };
      }
      if (recordedPodUid && uid !== recordedPodUid) {
        return {
          resumable: false,
          reason: "pod_replaced",
          detail: `Pod ${podName} was replaced since the sandbox was released`,
        };
      }
      const phase = pod.status?.phase;
      if (phase === "Failed" || phase === "Succeeded") {
        return { resumable: false, reason: "pod_unhealthy", detail: `Pod ${podName} is ${phase}` };
      }
      const stuck = (pod.status?.containerStatuses ?? [])
        .map((s) => s.state?.waiting?.reason)
        .find((reason): reason is string => typeof reason === "string" && STUCK_CONTAINER_REASONS.has(reason));
      if (stuck) {
        return { resumable: false, reason: "pod_unhealthy", detail: `Pod ${podName} is stuck in ${stuck}` };
      }
      const ready = (pod.status?.conditions ?? []).find((c) => c.type === "Ready");
      if (phase === "Running" && ready?.status === "True" && uid) {
        return { resumable: true, podName, podUid: uid };
      }
      notReadySince =
        toMillis(ready?.lastTransitionTime) ?? toMillis(pod.metadata?.creationTimestamp) ?? notReadySince;
    }
    if (now() + pollMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (notReadySince !== null && now() - notReadySince > notReadyExpiryMs) {
    return {
      resumable: false,
      reason: "pod_not_ready",
      detail: `Pod ${podName} has not been Ready for more than ${Math.round(notReadyExpiryMs / 1000)}s`,
    };
  }
  throw new KubernetesTransientError(
    action,
    `pod ${podName} is not Ready yet (timed out after ${readyTimeoutMs}ms; retry later)`,
  );
}

export type PatchReusableSandboxResult =
  | { ok: true; cr: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "deleting" };

/**
 * Set annotations on a reusable Sandbox CR. The API server serializes writes
 * to one object and every patch bumps its resourceVersion, which is what makes
 * the idle reaper's precondition delete safe against a concurrent resume. A CR
 * the patch finds gone or already being deleted is reported, not thrown.
 */
export async function patchReusableSandboxAnnotations(
  clients: KubeClients,
  input: { namespace: string; name: string; annotations: Record<string, string>; action: string },
): Promise<PatchReusableSandboxResult> {
  const body = annotationsJsonPatch(input.annotations);
  let result: Record<string, unknown>;
  try {
    result = await clients.custom.patchNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: input.namespace,
      plural: SANDBOX_PLURAL,
      name: input.name,
      body,
    }) as Record<string, unknown>;
  } catch (err) {
    if (isKubeNotFoundError(err)) return { ok: false, reason: "not_found" };
    if (isTransientKubeError(err)) {
      throw new KubernetesTransientError(input.action, errorText(err), err);
    }
    throw err;
  }
  const deleting = Boolean((result?.metadata as { deletionTimestamp?: unknown } | undefined)?.deletionTimestamp);
  return deleting ? { ok: false, reason: "deleting" } : { ok: true, cr: result };
}

/**
 * Delete the task-scoped egress policy of a lease. The policy is owned by the
 * workload and garbage-collected with it; the explicit delete keeps a
 * long-lived reusable sandbox from depending on the collector. 404 is success.
 */
export async function deleteScopedNetworkPolicy(
  clients: KubeClients,
  input: { namespace: string; name: string; mode: "standard" | "cilium" },
): Promise<void> {
  if (input.mode === "cilium") {
    await ignoreNotFound(
      clients.custom.deleteNamespacedCustomObject({
        group: "cilium.io",
        version: "v2",
        namespace: input.namespace,
        plural: "ciliumnetworkpolicies",
        name: input.name,
      }),
    );
    return;
  }
  await ignoreNotFound(
    clients.networking.deleteNamespacedNetworkPolicy({ namespace: input.namespace, name: input.name }),
  );
}
