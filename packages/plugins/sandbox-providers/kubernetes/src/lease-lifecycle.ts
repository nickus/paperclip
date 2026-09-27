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
