import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";

export class JobTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(`Job ${namespace}/${name} did not complete within ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

export class JobPodNotReadyError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(`Job ${namespace}/${name}'s pod did not start running within ${timeoutMs}ms`);
    this.name = "JobPodNotReadyError";
  }
}

export async function createJob(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.batch.createNamespacedJob({ namespace, body: manifest as never });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("Job created without a UID");
  return { uid };
}

export type JobStatus = SandboxStatus;

export async function getJobStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<JobStatus> {
  const result = await clients.batch.readNamespacedJobStatus({ namespace, name });
  const body = (result as Record<string, unknown>) ?? {};
  const status = (body.status as Record<string, unknown>) ?? {};
  const active = (status.active as number) ?? 0;
  const succeeded = (status.succeeded as number) ?? 0;
  const failed = (status.failed as number) ?? 0;
  const conditions = (status.conditions as { type: string; status: string; reason?: string; message?: string }[]) ?? [];
  const completed = conditions.find((c) => c.type === "Complete" && c.status === "True");
  const failedCond = conditions.find((c) => c.type === "Failed" && c.status === "True");
  if (failedCond || failed > 0) {
    return { phase: "Failed", complete: false, active, succeeded, failed, reason: failedCond?.reason, message: failedCond?.message };
  }
  if (completed || succeeded > 0) {
    return { phase: "Succeeded", complete: true, active, succeeded, failed };
  }
  if (active > 0) {
    return { phase: "Running", complete: false, active, succeeded, failed };
  }
  return { phase: "Pending", complete: false, active, succeeded, failed };
}

export async function findPodForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<string | null> {
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const items = ((result as { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] }).items) ?? [];
  const running = items.find((p) => p.status?.phase === "Running");
  return (running ?? items[0])?.metadata?.name ?? null;
}

/**
 * Unlike findPodForJob (which falls back to ANY pod so log streaming has
 * something to read), this returns a name only when a pod backing the Job
 * has actually reached Running — used by waitForJobPodRunning below, which
 * needs to tell "still Pending/scheduling" from "containers started".
 */
async function findRunningPodNameForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<string | null> {
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  const items = ((result as { items?: { metadata?: { name?: string }; status?: { phase?: string } }[] }).items) ?? [];
  return items.find((p) => p.status?.phase === "Running")?.metadata?.name ?? null;
}

export async function streamPodLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // V1 limitation: readNamespacedPodLog returns combined stdout (the kubectl-style
  // log view). stderr is not separately exposed via this API path — agent
  // containers that need stderr/stdout separation should use a sidecar log
  // scraper or wrap their CLI to emit structured output on stdout. We always
  // emit chunks as "stdout"; the "stderr" callback slot in SandboxOrchestrator
  // is unused by the Job-backed implementation.
  const result = await clients.core.readNamespacedPodLog({ namespace, name: podName });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteJob(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<void> {
  await clients.batch.deleteNamespacedJob({
    namespace,
    name,
    propagationPolicy: "Foreground",
  });
}

export async function waitForJobCompletion(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 120_000, pollMs: 2000 },
): Promise<JobStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  while (Date.now() < deadline) {
    const status = await getJobStatus(clients, namespace, name);
    if (status.phase === "Succeeded" || status.phase === "Failed") return status;
    await sleep(pollMs);
  }
  throw new JobTimeoutError(namespace, name, opts.timeoutMs);
}

export interface JobPodRunningResult {
  /**
   * The Job's pod, once observed Running. Also set (from a best-effort
   * lookup) when the Job already reached Succeeded/Failed before its pod was
   * ever observed Running — e.g. a near-instant command — since there is
   * nothing left to wait for in that case either.
   */
  podName: string | null;
  jobStatus: JobStatus;
}

/**
 * Wait for the Job's pod to actually start running (scheduled, image pulled,
 * containers started) — bounded separately from, and independently of,
 * waitForJobCompletion. This is the Job backend's equivalent of the
 * sandbox-cr backend's "wait for the Sandbox pod to become Ready" step (see
 * sandbox-cr-orchestrator.ts's waitForSandboxReady): it answers "has
 * scheduling finished; is work happening", not "has the work finished".
 *
 * `getJobStatus`'s own "Running" phase is not enough for this: the Job API's
 * `.status.active` counts pods that are merely Pending as well as pods that
 * are actually Running, so it cannot tell "still scheduling/pulling" from
 * "containers started". This checks the pod's own `status.phase` instead.
 */
export async function waitForJobPodRunning(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 120_000, pollMs: 2000 },
): Promise<JobPodRunningResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  while (Date.now() < deadline) {
    const status = await getJobStatus(clients, namespace, name);
    if (status.phase === "Succeeded" || status.phase === "Failed") {
      const podName = await findPodForJob(clients, namespace, name).catch(() => null);
      return { podName, jobStatus: status };
    }
    const podName = await findRunningPodNameForJob(clients, namespace, name);
    if (podName) return { podName, jobStatus: status };
    await sleep(pollMs);
  }
  throw new JobPodNotReadyError(namespace, name, opts.timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job-backed conformance to SandboxOrchestrator. Plugin.ts imports THIS value
 * (the swap point) — to use a different backend, swap this import for another
 * module exposing a SandboxOrchestrator-shaped default export.
 */
export const jobOrchestrator: SandboxOrchestrator = {
  claim: createJob,
  getStatus: getJobStatus,
  findPod: findPodForJob,
  streamLogs: streamPodLogs,
  release: deleteJob,
  waitForCompletion: waitForJobCompletion,
};
