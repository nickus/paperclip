import { randomBytes } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginDefinition,
} from "@paperclipai/plugin-sdk";
import {
  kubernetesProviderConfigSchema,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
  type KubernetesReuseLeaseStamp,
} from "./types.js";
import {
  evictKubeConnectionOnAuthError,
  getKubeConnection,
  isKubeAuthError,
  type KubeConnectionInput,
} from "./kube-client-cache.js";
import type { KubeClients } from "./kube-client.js";
import { getAdapterDefaults, buildAdapterEnv, resolveRunAdapterType } from "./adapter-defaults.js";
import { resolveImage } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import { buildSandboxCrManifest } from "./sandbox-cr-builder.js";
import { ensureTenant } from "./tenant-orchestrator.js";
import { createPerRunSecret } from "./secret-manager.js";
import { FastUploadInterceptor } from "./upload-interceptor.js";
import {
  jobOrchestrator,
  JobTimeoutError,
  JobPodNotReadyError,
  waitForJobPodRunning,
  type JobStatus,
} from "./job-orchestrator.js";
import {
  SANDBOX_GROUP,
  SANDBOX_PLURAL,
  SANDBOX_VERSION,
  sandboxCrOrchestrator,
  SandboxCrTimeoutError,
} from "./sandbox-cr-orchestrator.js";
import {
  execInPod,
  execInPodStreaming,
  PodExecTransportError,
  wrapCommandWithEnv,
  type ExecLivenessOptions,
} from "./pod-exec.js";
import { performSyncIn, performSyncOut, type PodStreamExec } from "./file-sync.js";
import {
  checkLeaseResumable,
  checkReusableLeaseResumable,
  deleteScopedNetworkPolicy,
  isKubeNotFoundError,
  isTransientKubeError,
  patchReusableSandboxAnnotations,
  recordReusableSandboxPodUid,
  refreshReusableSandboxBusy,
  terminateLeaseResources,
} from "./lease-lifecycle.js";
import {
  REUSE_BUSY_REFRESH_MS,
  REUSE_LABEL_SELECTOR,
  REUSE_LABELS,
  REUSE_MAX_CONSECUTIVE_FAILURES,
  REUSE_REMOTE_CWD,
  REUSE_SPEC_VERSION,
  buildBusyAnnotations,
  buildIdleAnnotations,
  buildInitialReuseAnnotations,
  buildReuseLabels,
  computeReuseKey,
  computeReuseSpecHash,
  maxReusableSandboxesInQuota,
  readReusableSandboxState,
  readReuseStamp,
  resolveReuseResources,
  resolveReuseSettings,
  reuseKeyLabelValue,
} from "./reuse.js";
import { resetSandboxProcesses } from "./process-reset.js";
import {
  ACQUIRE_SWEEP_BUDGET_MS,
  deleteReusableSandboxIfUnchanged,
  discoverReuseNamespaces,
  maybeSweepReuseNamespace,
  registerReuseNamespace,
  withReuseSlot,
  type ReuseNamespaceRegistration,
} from "./idle-reaper.js";
import { resolvePodReadyTimeoutMs, summarizeRecentPodEvents } from "./pod-ready-deadline.js";
import {
  appendNetworkEgressDenyHint,
  createScopedNetworkEgressPolicyOrReleaseWorkload,
  NETWORK_EGRESS_GRANT_PATH,
  parseScopedNetworkEgressGrant,
} from "./scoped-network-egress.js";
import {
  deriveCompanySlug,
  deriveNamespaceName,
  newRunUlidDns,
  paperclipLabels,
} from "./utils.js";

// The namespace paperclip-server itself runs in. Used when building
// NetworkPolicy manifests so the tenant namespace allows inbound traffic
// from the server pod.
const PAPERCLIP_SERVER_NAMESPACE = "paperclip";

// Name of the ServiceAccount created inside each tenant namespace by ensureTenant.
const TENANT_SERVICE_ACCOUNT = "paperclip-tenant-sa";

// Resource quota defaults applied to every tenant namespace (tunable via
// config in a future iteration).
const DEFAULT_RESOURCE_QUOTA = {
  pods: "20",
  requestsCpu: "10",
  requestsMemory: "20Gi",
  limitsCpu: "20",
  limitsMemory: "40Gi",
};

function deriveTenantNamespace(config: KubernetesProviderConfig, companyId: string): string {
  // TODO: future versions could thread companyName through AcquireLeaseParams
  // to get a friendlier slug (e.g. "acme-corp") instead of the UUID-derived one.
  const slug = config.companySlug ?? deriveCompanySlug(companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
}

function generateBootstrapToken(): string {
  // TODO: tighten once the agent runtime shim (companion images PR) lands its
  // callback auth scheme; paperclip-server's callback auth is out of scope for
  // this plugin. For now this per-run random token is stored in the per-run
  // Secret and read by the runtime image entrypoint for initial registration.
  return randomBytes(32).toString("hex");
}

// One FastUploadInterceptor instance per active lease. Scoping per lease
// prevents `releaseLease` from wiping in-flight upload buffers belonging to
// other concurrent leases — a single shared singleton would do exactly that
// on `reset()`. The Map is keyed by `providerLeaseId`; entries are lazily
// created in `onEnvironmentExecute` and removed in `onEnvironmentReleaseLease`.
const uploadInterceptorsByLease = new Map<string, FastUploadInterceptor>();

function getOrCreateUploadInterceptor(leaseId: string): FastUploadInterceptor {
  let interceptor = uploadInterceptorsByLease.get(leaseId);
  if (!interceptor) {
    interceptor = new FastUploadInterceptor();
    uploadInterceptorsByLease.set(leaseId, interceptor);
  }
  return interceptor;
}

// In-memory cache of sandbox CR names we've already observed reaching the
// Ready condition during the current plugin-worker lifetime. The k8s
// sandbox-cr lifecycle means once a Sandbox pod is Running, subsequent
// execs into it don't need another readiness poll — saves one
// `getNamespacedCustomObject` round-trip per exec, which adds up across
// dozens of sequential exec calls in a typical adapter workflow.
// On worker restart this resets, which is fine: the first exec on each
// lease then re-confirms readiness from scratch.
const readySandboxesByLease = new Set<string>();

// Sandboxes this worker released or stopped and kept. A command that still
// arrives for one of them (for example from a startup the host is cancelling)
// is refused instead of running in the kept sandbox after its processes were
// verified stopped. The next resume of the sandbox clears the entry.
const releasedLeases = new Set<string>();

// When each reusable sandbox in use was last marked busy by this worker (see
// withReusableSandboxBusy).
const busyRefreshedAt = new Map<string, number>();

// Forcibly delete every resource acquireLease created for a lease (workload,
// pod, per-run Secret; 404s are success) and confirm the stop. Shared by
// onEnvironmentReleaseLease and onEnvironmentDestroyLease.
async function teardownLease(
  params: PluginEnvironmentReleaseLeaseParams & { providerLeaseId: string },
  options: { confirmTimeoutMs?: number } = {},
): Promise<PluginEnvironmentTerminationReceipt> {
  const config = kubernetesProviderConfigSchema.parse(params.config);
  const namespace =
    typeof params.leaseMetadata?.namespace === "string"
      ? params.leaseMetadata.namespace
      : deriveTenantNamespace(config, params.companyId);
  const leaseBackend =
    typeof params.leaseMetadata?.backend === "string"
      ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
      : config.backend;
  const secretName =
    typeof params.leaseMetadata?.secretName === "string"
      ? params.leaseMetadata.secretName
      : `${params.providerLeaseId}-env`;
  const podName =
    typeof params.leaseMetadata?.podName === "string" &&
    params.leaseMetadata.podName.length > 0
      ? params.leaseMetadata.podName
      : null;

  // Clear per-lease in-memory state up front, regardless of what the cluster
  // says — the lease is dead either way. Each lease has its own interceptor,
  // so unrelated concurrent leases keep their in-flight buffers intact.
  uploadInterceptorsByLease.delete(params.providerLeaseId);
  readySandboxesByLease.delete(params.providerLeaseId);
  releasedLeases.delete(params.providerLeaseId);
  busyRefreshedAt.delete(params.providerLeaseId);

  // Reuse the parsed kubeconfig + API clients across RPCs (see kube-client-cache.ts).
  const { clients } = getKubeConnection(config);
  trackReuseNamespaces(config, namespace, readReuseStamp(params.leaseMetadata) !== null);

  // Throws (so the host keeps the lease in pending_cleanup and retries) when
  // the stop cannot be confirmed within the bounded wait.
  let receipt;
  try {
    receipt = await terminateLeaseResources(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      podName,
      secretName,
      ...(options.confirmTimeoutMs !== undefined ? { confirmTimeoutMs: options.confirmTimeoutMs } : {}),
    });
  } catch (err) {
    // A rejected credential must not stay cached for the retry that follows.
    evictKubeConnectionOnAuthError(config, err);
    throw err;
  }

  // A reusable sandbox can live for a day; remove its task-scoped egress policy
  // explicitly instead of relying on owner-reference garbage collection alone.
  // Ordinary leases keep the previous behavior (garbage collection only). Best
  // effort: the workload is already confirmed gone and the collector removes
  // the policy with it, so a failed delete must not fail the teardown.
  const scopedNetworkPolicyName = params.leaseMetadata?.scopedNetworkPolicyName;
  if (readReuseStamp(params.leaseMetadata) && typeof scopedNetworkPolicyName === "string" && scopedNetworkPolicyName) {
    try {
      await deleteScopedNetworkPolicy(clients, {
        namespace,
        name: scopedNetworkPolicyName,
        mode: config.egressMode,
      });
    } catch (err) {
      evictKubeConnectionOnAuthError(config, err);
      console.warn(
        `[plugin-kubernetes] could not delete egress policy ${namespace}/${scopedNetworkPolicyName} of a removed sandbox (garbage collection removes it with its owner): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return receipt;
}

// ── Reusable sandboxes (reuseLease) ─────────────────────────────────────────
//
// With `reuseLease` on, a lease keeps one Sandbox CR per reuse scope between
// runs (see reuse.ts for the state kept on the CR and idle-reaper.ts for its
// expiry). Lifecycle:
//
//   acquire ──> BUSY ──release or cancel (processes stopped + verified)──> IDLE ──reaper──> GONE
//                ^  |                                                        |
//                |  +── destroy / reuse off / unverified / failing runs ─────┴──────────> GONE
//                +──────────────────── resume (mark busy) ───────────────────+
//
// Resume reports the lease expired (the host then destroys it and acquires a
// fresh sandbox, which also starts a fresh harness session) when the CR is
// gone, failing or being deleted, when it was built from a different spec, or
// when its pod was replaced. Temporary API errors throw instead, so the host
// keeps the lease.

/** Placeholder names so the spec hash covers the pod shape, not per-lease names. */
const SPEC_HASH_SANDBOX_NAME = "reusable-sandbox";

/**
 * Hash of the pod a reusable sandbox for `runAdapterType` gets under `config`.
 * Built from the same manifest builder as acquire, with placeholder names and
 * no labels, plus a digest of the adapter env the per-lease Secret carries.
 */
function reusableSandboxSpecHash(
  config: KubernetesProviderConfig,
  namespace: string,
  runAdapterType: string,
): string {
  const adapterDefaults = getAdapterDefaults(runAdapterType, config.adapters);
  const image = resolveImage(
    { imageOverride: null },
    adapterDefaults,
    { imageAllowList: config.imageAllowList, imageRegistry: config.imageRegistry },
  );
  const template = buildSandboxCrManifest({
    namespace,
    sandboxName: SPEC_HASH_SANDBOX_NAME,
    adapterType: runAdapterType,
    image,
    envSecretName: `${SPEC_HASH_SANDBOX_NAME}-env`,
    serviceAccountName: TENANT_SERVICE_ACCOUNT,
    labels: {},
    resources: resolveReuseResources(config),
    runtimeClassName: config.runtimeClassName,
    imagePullSecrets: config.imagePullSecrets,
  });
  return computeReuseSpecHash({
    namespace,
    backend: config.backend,
    podTemplateSpec: (template.spec as { podTemplate: { spec: unknown } }).podTemplate.spec,
    adapterEnv: buildAdapterEnv(adapterDefaults),
  });
}

/**
 * Keep the idle reaper informed (see idle-reaper.ts). Every RPC that reaches
 * the cluster calls this:
 *   - with reuse on, the namespace is registered with the configured cap;
 *   - for a reusable lease while reuse is off (e.g. after turning it off), the
 *     namespace is registered without a cap, so its idle sandboxes still
 *     expire;
 *   - in every case the connection's cluster-wide discovery runs when due, so
 *     a restart does not leave idle sandboxes in namespaces that see no RPC.
 */
function trackReuseNamespaces(
  config: KubernetesProviderConfig,
  namespace: string,
  reusableLease: boolean,
): ReuseNamespaceRegistration | null {
  const connection = { inCluster: config.inCluster, kubeconfig: config.kubeconfig };
  const settings = resolveReuseSettings(config);
  void discoverReuseNamespaces(connection, { reportErrors: settings.enabled });
  if (settings.enabled) {
    return registerReuseNamespace({ connection, namespace, maxSandboxes: settings.maxSandboxes });
  }
  return reusableLease ? registerReuseNamespace({ connection, namespace }) : null;
}

/**
 * Run `work` (an exec or a sync on a reusable sandbox) while keeping the
 * sandbox's busy-since recent, so the reaper's stale-busy rule never removes a
 * sandbox under a long run: once when the last refresh is older than
 * REUSE_BUSY_REFRESH_MS, then every REUSE_BUSY_REFRESH_MS until `work` ends.
 */
async function withReusableSandboxBusy<T>(
  reusable: boolean,
  clients: KubeClients,
  namespace: string,
  leaseId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!reusable) return await work();
  const refresh = () => {
    busyRefreshedAt.set(leaseId, Date.now());
    void refreshReusableSandboxBusy(clients, { namespace, name: leaseId });
  };
  const last = busyRefreshedAt.get(leaseId);
  if (last === undefined || Date.now() - last >= REUSE_BUSY_REFRESH_MS) refresh();
  const handle = setInterval(refresh, REUSE_BUSY_REFRESH_MS);
  handle.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(handle);
  }
}

/** Why a command for `leaseId` must not run, or null when it may. */
function releasedLeaseRefusal(leaseId: string): string | null {
  return releasedLeases.has(leaseId)
    ? `Sandbox lease ${leaseId} was released; the command was not run.`
    : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Budget for a reusable release, below the host's default 30s plugin RPC timeout. */
const REUSE_RELEASE_BUDGET_MS = 25_000;

async function resumeReusableLease(
  params: PluginEnvironmentResumeLeaseParams,
  config: KubernetesProviderConfig,
  stamp: KubernetesReuseLeaseStamp,
): Promise<PluginEnvironmentLease> {
  const namespace =
    typeof params.leaseMetadata?.namespace === "string"
      ? params.leaseMetadata.namespace
      : deriveTenantNamespace(config, params.companyId);
  const leaseBackend =
    typeof params.leaseMetadata?.backend === "string"
      ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
      : config.backend;
  const secretName =
    typeof params.leaseMetadata?.secretName === "string"
      ? params.leaseMetadata.secretName
      : `${params.providerLeaseId}-env`;
  const expired = (reason: string, detail: string, extra: Record<string, unknown> = {}): PluginEnvironmentLease => ({
    providerLeaseId: null,
    // `expired: true` tells the host the sandbox is gone (`not_found`); any
    // other reason is recorded as a plain expiry.
    metadata: { expired: reason === "not_found", reason, detail, ...extra },
  });
  const mismatch = (detail: string): PluginEnvironmentLease =>
    expired("identity_mismatch", detail, { workspaceSentinel: { result: "mismatch", reason: detail } });

  const settings = resolveReuseSettings(config);
  // Registered even when reuse is now off, so the idle sandboxes left in the
  // namespace still expire.
  const registration = trackReuseNamespaces(config, namespace, true);
  if (!settings.enabled || leaseBackend !== "sandbox-cr" || !registration) {
    return expired("reuse_disabled", "Sandbox reuse is not enabled for this environment");
  }

  // The host matched this lease by its reuse scope; the key stamped at acquire
  // must describe the same scope.
  const scope = params.leaseMetadata?.reusableSandboxLease;
  if (
    isPlainRecord(scope) &&
    typeof scope.executionWorkspaceId === "string" &&
    typeof scope.agentId === "string" &&
    computeReuseKey({
      companyId: params.companyId,
      environmentId: params.environmentId,
      executionWorkspaceId: scope.executionWorkspaceId,
      agentId: scope.agentId,
      runAdapterType: stamp.runAdapterType,
    }) !== stamp.key
  ) {
    return mismatch("Lease reuse scope does not match the sandbox reuse key");
  }

  // A null hash (e.g. the adapter left the registry) never matches: the CR was
  // built from a spec this config can no longer render.
  let specHash: string | null;
  try {
    specHash = reusableSandboxSpecHash(config, namespace, stamp.runAdapterType);
  } catch {
    specHash = null;
  }

  const { clients } = getKubeConnection(config);
  const check = await checkReusableLeaseResumable(clients, {
    namespace,
    name: params.providerLeaseId,
    expectedReuseKey: stamp.key,
    expectedSpecHash: specHash,
    expectedSpecVersion: String(REUSE_SPEC_VERSION),
    readyTimeoutMs: resumeReadyTimeoutMs(config),
    pollMs: RESUME_READY_POLL_MS,
  });
  if (!check.resumable) {
    return check.reason === "identity_mismatch" ? mismatch(check.detail) : expired(check.reason, check.detail);
  }

  // Mark the sandbox busy last: the checks above are read-only, so a transient
  // failure there leaves an idle sandbox idle. The patch bumps the CR's
  // resourceVersion, which makes a concurrent reaper delete fail its
  // precondition; a delete that won the race shows up here as gone/deleting.
  //
  // This patch carries no precondition of its own, so it does NOT decide which
  // run gets the sandbox: two resumes of the same released lease would both
  // succeed here. The host's compare-and-swap on the lease row (the reusable
  // lease handoff in the environments service) is what lets only one run use
  // the sandbox; do not remove that check on the assumption that this patch
  // serializes resumes.
  const patched = await patchReusableSandboxAnnotations(clients, {
    namespace,
    name: params.providerLeaseId,
    annotations: buildBusyAnnotations({
      now: new Date(),
      idleTtlSec: settings.idleTtlSec,
      staleBusySec: settings.staleBusySec,
    }),
    action: `resuming sandbox ${namespace}/${params.providerLeaseId}`,
  });
  if (!patched.ok) {
    return expired(patched.reason, "Sandbox was removed while it was being resumed");
  }

  // The pod was just observed Ready and marked busy. The upload interceptor is
  // left alone: a concurrent resume that loses the host's lease handoff must
  // not clear the buffers of the run that won it. Release and destroy clear it.
  readySandboxesByLease.add(params.providerLeaseId);
  releasedLeases.delete(params.providerLeaseId);
  busyRefreshedAt.set(params.providerLeaseId, Date.now());
  void maybeSweepReuseNamespace(registration);

  const leaseMetadata: KubernetesLeaseMetadata = {
    namespace,
    jobName: params.providerLeaseId,
    podName: check.podName,
    secretName,
    phase: "Running",
    backend: "sandbox-cr",
    scopedNetworkPolicyName:
      typeof params.leaseMetadata?.scopedNetworkPolicyName === "string"
        ? params.leaseMetadata.scopedNetworkPolicyName
        : null,
    scopedNetworkEgress: parseScopedNetworkEgressGrant({
      networkEgress: params.leaseMetadata?.scopedNetworkEgress,
    }),
    nativeFileSyncUnsupported: false,
    remoteCwd: REUSE_REMOTE_CWD,
    kubernetesReuse: {
      ...stamp,
      version: REUSE_SPEC_VERSION,
      idleTtlSec: settings.idleTtlSec,
      podUid: check.podUid,
    },
  };
  return {
    providerLeaseId: params.providerLeaseId,
    metadata: { ...leaseMetadata, resumedLease: true } as unknown as Record<string, unknown>,
  };
}

/**
 * Retry `read` on temporary API errors (5xx, 429, transport failures) with
 * backoff until `deadline`. Not-found, credential and other errors are thrown
 * at once, as is the last temporary error once the deadline has passed.
 */
async function retryTransientKubeCall<T>(deadline: number, read: () => Promise<T>): Promise<T> {
  let delayMs = 250;
  for (;;) {
    try {
      return await read();
    } catch (err) {
      if (!isTransientKubeError(err) || isKubeAuthError(err) || Date.now() + delayMs > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 2_000);
    }
  }
}

/** Part of the release budget spent retrying temporary API errors. */
const REUSE_RELEASE_RETRY_BUDGET_MS = 8_000;

/**
 * Remove other idle sandboxes stamped with the same reuse key. The host keeps
 * one sandbox per task: it resumes the most recently released lease of the
 * task, so any older idle sibling (possible only when two runs of the same task
 * each created a sandbox) would never be resumed and would hold a cap slot
 * until its TTL. Busy siblings are left alone; the delete is conditional on
 * the version read, like the reaper's. Best effort.
 */
async function removeIdleSiblings(
  clients: KubeClients,
  input: { namespace: string; keepName: string; reuseKey: string },
): Promise<void> {
  try {
    const listed = (await clients.custom.listNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: input.namespace,
      plural: SANDBOX_PLURAL,
      labelSelector: `${REUSE_LABEL_SELECTOR},${REUSE_LABELS.reuseKey}=${reuseKeyLabelValue(input.reuseKey)}`,
    })) as { items?: unknown[] };
    for (const item of listed.items ?? []) {
      const sibling = readReusableSandboxState(item);
      if (!sibling || sibling.name === input.keepName || sibling.deleting) continue;
      if (sibling.reuseKey !== input.reuseKey || sibling.leaseState !== "idle") continue;
      if (await deleteReusableSandboxIfUnchanged(clients, input.namespace, sibling)) {
        console.info(
          `[plugin-kubernetes] removed reusable sandbox ${input.namespace}/${sibling.name}: a newer sandbox of the same task was released`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[plugin-kubernetes] could not check ${input.namespace} for older sandboxes of the same task: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Release a reusable lease: stop every process the run left in the pod, verify
 * nothing is left, and mark the sandbox idle. Returns a `stopped` receipt only
 * after the processes are confirmed gone; an explicit cancellation takes the
 * same path, since the verified stop is exactly the proof it needs. Anything
 * that prevents that proof (a missing or replaced pod, a failed verification)
 * or that makes the sandbox unfit to keep (removed while being released, too
 * many failed runs in a row) falls back to a full teardown with a `destroyed`
 * receipt. Temporary API errors are retried within the release budget.
 */
async function releaseReusableLease(
  params: PluginEnvironmentReleaseLeaseParams & { providerLeaseId: string; runStatus?: unknown },
  config: KubernetesProviderConfig,
  stamp: KubernetesReuseLeaseStamp,
): Promise<PluginEnvironmentTerminationReceipt> {
  const startedAt = Date.now();
  const retryDeadline = startedAt + REUSE_RELEASE_RETRY_BUDGET_MS;
  const leaseId = params.providerLeaseId;
  const namespace =
    typeof params.leaseMetadata?.namespace === "string"
      ? params.leaseMetadata.namespace
      : deriveTenantNamespace(config, params.companyId);
  const settings = resolveReuseSettings(config);

  // The run is over either way: drop its per-lease in-memory state, and refuse
  // commands that still arrive for it until a later run resumes the sandbox.
  uploadInterceptorsByLease.delete(leaseId);
  readySandboxesByLease.delete(leaseId);
  busyRefreshedAt.delete(leaseId);
  releasedLeases.add(leaseId);

  const destroy = async (why: string): Promise<PluginEnvironmentTerminationReceipt> => {
    console.warn(
      `[plugin-kubernetes] removing reusable sandbox ${namespace}/${leaseId} instead of keeping it: ${why}`,
    );
    return await teardownLease(params, {
      confirmTimeoutMs: Math.max(5_000, REUSE_RELEASE_BUDGET_MS - (Date.now() - startedAt)),
    });
  };

  const { kc, clients } = getKubeConnection(config);
  const registration = trackReuseNamespaces(config, namespace, true);

  let cr: unknown;
  try {
    cr = await retryTransientKubeCall(retryDeadline, () =>
      clients.custom.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace,
        plural: SANDBOX_PLURAL,
        name: leaseId,
      }),
    );
  } catch (err) {
    if (isKubeNotFoundError(err)) return await destroy("the sandbox no longer exists");
    throw err;
  }
  const state = readReusableSandboxState(cr);
  if (!state || state.deleting) return await destroy("the sandbox is being deleted");
  if (state.reuseKey !== stamp.key) return await destroy("the sandbox reuse key does not match the lease");

  let pod: { metadata?: { uid?: string; deletionTimestamp?: unknown }; status?: { phase?: string } };
  try {
    pod = await retryTransientKubeCall(retryDeadline, () =>
      clients.core.readNamespacedPod({ namespace, name: state.podName }),
    ) as typeof pod;
  } catch (err) {
    if (isKubeNotFoundError(err)) return await destroy(`pod ${state.podName} no longer exists`);
    throw err;
  }
  const podUid = pod.metadata?.uid ?? "";
  if (!podUid || pod.metadata?.deletionTimestamp || pod.status?.phase !== "Running") {
    return await destroy(`pod ${state.podName} is not running`);
  }
  // The pod the run started on: recorded by the resume, or for a run that
  // created the sandbox, on the CR when the run first reached the pod.
  const expectedPodUid = stamp.podUid ?? state.podUid;
  if (expectedPodUid && expectedPodUid !== podUid) {
    // The run started on another pod; this one has none of the task's state.
    return await destroy(`pod ${state.podName} was replaced during the run`);
  }

  const reset = await stopPodProcesses(kc, config, { namespace, podName: state.podName, retryDeadline });
  if (!reset.ok) {
    return await destroy(`could not verify that the run's processes stopped (${reset.detail || "no output"})`);
  }

  // Only the host knows how the run ended. A failed run adds to the count and
  // a completed one resets it. A cancelled run or one the host interrupted
  // (for example because the host went away) says nothing about the sandbox
  // and leaves the count as it is. Older hosts do not say, and then nothing is
  // counted.
  const consecutiveFailures =
    params.runStatus === "failed"
      ? state.consecutiveFailures + 1
      : params.runStatus === "expired" || params.runStatus === "interrupted"
        ? state.consecutiveFailures
        : 0;
  if (consecutiveFailures >= REUSE_MAX_CONSECUTIVE_FAILURES) {
    return await destroy(`the last ${consecutiveFailures} runs in it failed; the next run starts in a fresh sandbox`);
  }

  let marked;
  try {
    marked = await retryTransientKubeCall(retryDeadline, () =>
      patchReusableSandboxAnnotations(clients, {
        namespace,
        name: leaseId,
        annotations: buildIdleAnnotations({ now: new Date(), idleTtlSec: settings.idleTtlSec, podUid, consecutiveFailures }),
        action: `releasing sandbox ${namespace}/${leaseId}`,
      }),
    );
  } catch (err) {
    if (isTransientKubeError(err)) {
      // The run's processes are verified stopped, so the receipt is true and
      // the sandbox stays usable. It only keeps its busy mark, so the reaper
      // applies the stale-busy rule to it instead of the idle TTL.
      evictKubeConnectionOnAuthError(config, err);
      console.warn(
        `[plugin-kubernetes] kept reusable sandbox ${namespace}/${leaseId} but could not mark it idle: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { providerLeaseId: leaseId, state: "stopped" };
    }
    return await destroy(`could not mark the sandbox idle (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!marked.ok) return await destroy("the sandbox was removed while it was being released");

  await removeIdleSiblings(clients, { namespace, keepName: leaseId, reuseKey: stamp.key });
  if (registration) void maybeSweepReuseNamespace(registration);
  return { providerLeaseId: leaseId, state: "stopped" };
}

/**
 * Stop every process in the sandbox pod (see process-reset.ts) and verify that
 * none is left. A failed exec (for example a dropped connection) verified
 * nothing either way, so it is tried once more while `retryDeadline` allows.
 */
async function stopPodProcesses(
  kc: ReturnType<typeof getKubeConnection>["kc"],
  config: KubernetesProviderConfig,
  input: { namespace: string; podName: string; retryDeadline: number },
) {
  const execReset = () =>
    resetSandboxProcesses((command, timeoutMs) =>
      execInPod(
        kc,
        input.namespace,
        input.podName,
        "agent",
        command,
        undefined,
        timeoutMs,
        undefined,
        undefined,
        execLivenessFromConfig(config),
      ),
    );
  let reset = await execReset();
  if (!reset.ok && reset.execFailed && Date.now() < input.retryDeadline) {
    reset = await execReset();
  }
  return reset;
}

/**
 * Stop a lease's work and keep its sandbox (the host's stop-and-retain, see
 * onEnvironmentStopLease). Unlike a release this never removes the sandbox:
 * when the stop cannot be verified it throws, and the host keeps the lease and
 * tries again. A sandbox kept between runs is marked idle, so the next run of
 * the task resumes it and the idle reaper removes it once its idle lifetime
 * ends (also when reuse was turned off since). Only a sandbox whose run can no
 * longer be running (the sandbox or its pod is gone, the pod ended or was
 * replaced) is reported `destroyed`; nothing is deleted for it here.
 */
async function stopLeaseKeepingSandbox(
  params: PluginEnvironmentReleaseLeaseParams & { providerLeaseId: string },
  config: KubernetesProviderConfig,
): Promise<PluginEnvironmentTerminationReceipt> {
  const retryDeadline = Date.now() + REUSE_RELEASE_RETRY_BUDGET_MS;
  const leaseId = params.providerLeaseId;
  const namespace =
    typeof params.leaseMetadata?.namespace === "string"
      ? params.leaseMetadata.namespace
      : deriveTenantNamespace(config, params.companyId);
  const leaseBackend =
    typeof params.leaseMetadata?.backend === "string" ? params.leaseMetadata.backend : config.backend;
  if (leaseBackend !== "sandbox-cr") {
    // A Job runs a one-shot entrypoint: its pod cannot be stopped and kept.
    throw new Error(
      `Kubernetes ${leaseBackend} sandbox ${namespace}/${leaseId} cannot be stopped without removing it; it was left as it is.`,
    );
  }
  const stamp = readReuseStamp(params.leaseMetadata);
  const label = `${stamp ? "reusable sandbox" : "sandbox"} ${namespace}/${leaseId}`;

  // The same per-lease state handling as a release: the work in the sandbox
  // is being stopped, and commands that still arrive for it are refused until
  // a later run resumes the sandbox.
  uploadInterceptorsByLease.delete(leaseId);
  readySandboxesByLease.delete(leaseId);
  busyRefreshedAt.delete(leaseId);
  releasedLeases.add(leaseId);

  const { kc, clients } = getKubeConnection(config);
  const registration = trackReuseNamespaces(config, namespace, stamp !== null);
  const gone = (why: string): PluginEnvironmentTerminationReceipt => {
    console.info(`[plugin-kubernetes] ${label} needs no stop: ${why}`);
    return { providerLeaseId: leaseId, state: "destroyed" };
  };

  let cr: unknown;
  try {
    cr = await retryTransientKubeCall(retryDeadline, () =>
      clients.custom.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace,
        plural: SANDBOX_PLURAL,
        name: leaseId,
      }),
    );
  } catch (err) {
    if (isKubeNotFoundError(err)) return gone("the sandbox no longer exists");
    throw err;
  }
  const state = readReusableSandboxState(cr);
  if (!state || state.deleting) {
    // Its pod may still be running until the deletion completes; the next
    // attempt finds the sandbox gone.
    throw new Error(`The ${label} is being deleted; its stop cannot be confirmed yet.`);
  }
  if (stamp && state.reuseKey !== stamp.key) {
    throw new Error(`The ${label} does not carry the lease's reuse key; it was left as it is.`);
  }

  let pod: { metadata?: { uid?: string; deletionTimestamp?: unknown }; status?: { phase?: string } };
  try {
    pod = await retryTransientKubeCall(retryDeadline, () =>
      clients.core.readNamespacedPod({ namespace, name: state.podName }),
    ) as typeof pod;
  } catch (err) {
    if (isKubeNotFoundError(err)) return gone(`pod ${state.podName} no longer exists`);
    throw err;
  }
  const phase = pod.status?.phase;
  if (phase === "Succeeded" || phase === "Failed") return gone(`pod ${state.podName} has ended (${phase})`);
  const podUid = pod.metadata?.uid ?? "";
  if (!podUid || pod.metadata?.deletionTimestamp || phase !== "Running") {
    throw new Error(`Pod ${state.podName} of the ${label} is not running; its stop cannot be confirmed yet.`);
  }
  // The pod the lease's run started on (see releaseReusableLease). A
  // replacement pod holds none of the run's processes or files.
  const expectedPodUid = stamp?.podUid ?? state.podUid;
  if (expectedPodUid && expectedPodUid !== podUid) return gone(`pod ${state.podName} was replaced`);

  const reset = await stopPodProcesses(kc, config, { namespace, podName: state.podName, retryDeadline });
  if (!reset.ok) {
    throw new Error(
      `Could not verify that the processes in the ${label} stopped (${reset.detail || "no output"}); the sandbox was kept.`,
    );
  }
  if (!stamp) return { providerLeaseId: leaseId, state: "stopped" };

  const settings = resolveReuseSettings(config);
  let marked;
  try {
    marked = await retryTransientKubeCall(retryDeadline, () =>
      patchReusableSandboxAnnotations(clients, {
        namespace,
        name: leaseId,
        annotations: buildIdleAnnotations({
          now: new Date(),
          idleTtlSec: settings.enabled ? settings.idleTtlSec : stamp.idleTtlSec,
          podUid,
          // A stop says nothing about how the run went; keep the count.
          consecutiveFailures: state.consecutiveFailures,
        }),
        action: `stopping sandbox ${namespace}/${leaseId}`,
      }),
    );
  } catch (err) {
    // The processes are verified stopped, so the receipt is true. The sandbox
    // only keeps its busy mark, and the reaper's stale-busy rule covers it.
    evictKubeConnectionOnAuthError(config, err);
    console.warn(
      `[plugin-kubernetes] kept ${label} but could not mark it idle: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { providerLeaseId: leaseId, state: "stopped" };
  }
  if (!marked.ok) return gone("the sandbox was removed while it was being stopped");

  await removeIdleSiblings(clients, { namespace, keepName: leaseId, reuseKey: stamp.key });
  if (registration) void maybeSweepReuseNamespace(registration);
  return { providerLeaseId: leaseId, state: "stopped" };
}

// How long onEnvironmentResumeLease waits for an existing Sandbox pod to
// report Ready before declaring the lease non-resumable. Deliberately short:
// this is a liveness check on an already-provisioned pod, not a fresh
// provision — if the pod isn't (almost) up, falling back to acquireLease is
// faster and more reliable than waiting.
const RESUME_READY_TIMEOUT_MS = 30_000;
const RESUME_READY_POLL_MS = 1_000;

// The resume liveness wait is a pod-readiness wait like any other, so it also
// honours podReadyTimeoutSec: min(RESUME_READY_TIMEOUT_MS, podReadyTimeoutSec
// ?? 600s). With the default cap this stays at RESUME_READY_TIMEOUT_MS.
function resumeReadyTimeoutMs(config: KubernetesProviderConfig): number {
  return resolvePodReadyTimeoutMs(config, RESUME_READY_TIMEOUT_MS);
}

// The workspace remote dir is the confinement root for native file sync. It is
// recorded on the lease metadata at realizeWorkspace time (`remoteCwd`); require
// it so a sync can never run without a concrete root to confine every sandbox
// path against.
function resolveSyncRemoteDir(lease: PluginEnvironmentLease): string {
  const remoteCwd = lease.metadata?.remoteCwd;
  if (typeof remoteCwd === "string" && remoteCwd.trim().length > 0) {
    return remoteCwd.trim();
  }
  throw new Error("Kubernetes file sync requires a workspace remote dir on the lease metadata.");
}

/**
 * Resolve the running Sandbox-CR pod for a native file-sync operation and return
 * a `PodStreamExec` bound to it, exactly like `onEnvironmentExecute` resolves its exec
 * target: parse config, derive the namespace, wait for the Sandbox pod to reach
 * Ready (cached per lease), and find the pod name. The `job` backend carries no
 * file path and is out of scope — file sync is only supported on `sandbox-cr`.
 */
// Pod-exec keepalive settings from the provider config (see types.ts). Every exec
// path uses the same settings so a dropped WebSocket fails fast everywhere.
function execLivenessFromConfig(config: KubernetesProviderConfig): ExecLivenessOptions {
  return {
    keepaliveIntervalMs: config.execKeepaliveIntervalSec * 1000,
    timeoutMs: config.execLivenessTimeoutSec * 1000,
  };
}

async function resolveSyncPodExec(
  params:
    | PluginEnvironmentSyncInParams
    | PluginEnvironmentSyncOutParams,
): Promise<{
  exec: PodStreamExec;
  timeoutMs: number;
  keepBusy: <T>(work: () => Promise<T>) => Promise<T>;
}> {
  const { lease } = params;
  if (!lease.providerLeaseId) {
    throw new Error("Kubernetes file sync requires a provider lease ID.");
  }

  const config = kubernetesProviderConfigSchema.parse(params.config);
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config, params.companyId);

  const leaseBackend =
    typeof lease.metadata?.backend === "string"
      ? (lease.metadata.backend as "sandbox-cr" | "job")
      : config.backend;
  if (leaseBackend !== "sandbox-cr") {
    throw new Error(
      `Kubernetes file sync is only supported on the sandbox-cr backend (lease backend: ${leaseBackend}).`,
    );
  }

  // Reuse the parsed kubeconfig + API clients across RPCs (see kube-client-cache.ts).
  const { kc, clients } = getKubeConnection(config);
  // `timeoutMs` is the budget handed back to the caller for the sync
  // operation itself (the whole run budget) — it must stay the full
  // podActivityDeadlineSec. Only the readiness POLL below is bounded
  // separately by podReadyTimeoutSec, so a pod that can never come up fails
  // fast instead of burning the sync operation's entire budget.
  const timeoutMs = config.podActivityDeadlineSec * 1000;
  const podReadyTimeoutMs = resolvePodReadyTimeoutMs(config, timeoutMs);
  const reuseStamp = readReuseStamp(lease.metadata);
  trackReuseNamespaces(config, namespace, reuseStamp !== null);
  const refusal = releasedLeaseRefusal(lease.providerLeaseId);
  if (refusal) throw new Error(refusal);

  // Ensure the Sandbox pod is Ready (wait only the first time for this lease),
  // then resolve the pod name — mirrors the onEnvironmentExecute resolution.
  // A reusable sandbox takes the same bounded wait whenever this worker has
  // not yet seen its pod Ready (its first sync after acquire, or any sync
  // after a worker restart).
  const podAlreadyKnownReady = readySandboxesByLease.has(lease.providerLeaseId);
  if (!podAlreadyKnownReady) {
    try {
      await sandboxCrOrchestrator.waitForCompletion(clients, namespace, lease.providerLeaseId, {
        timeoutMs: podReadyTimeoutMs,
        pollMs: 2000,
      });
      readySandboxesByLease.add(lease.providerLeaseId);
    } catch (err) {
      if (err instanceof SandboxCrTimeoutError) {
        // A thrown Error (rather than a structured "failed" result) is how
        // this plugin's sync hooks already signal a retryable provider
        // failure — see onEnvironmentSyncOut's DaytonaNotFoundError handling
        // in the sibling daytona plugin for the same convention: only a
        // specific, stable "this is gone for good" error is terminal, and
        // every other thrown error remains retryable. Enrich the message
        // with the pod's recent events so the retry (or the operator) knows
        // WHY it wasn't ready, without changing that retryable contract.
        const eventPodName =
          typeof lease.metadata?.podName === "string" && lease.metadata.podName
            ? lease.metadata.podName
            : lease.providerLeaseId;
        const { summary } = await summarizeRecentPodEvents(clients, namespace, eventPodName);
        throw new Error(
          summary ? `${err.message} (recent pod events: ${summary})` : err.message,
        );
      }
      throw err;
    }
  }

  const podName =
    typeof lease.metadata?.podName === "string" && lease.metadata.podName
      ? lease.metadata.podName
      : await sandboxCrOrchestrator.findPod(clients, namespace, lease.providerLeaseId);
  if (!podName) {
    throw new Error("Kubernetes file sync could not resolve the Sandbox pod name.");
  }
  if (!podAlreadyKnownReady && reuseStamp && !reuseStamp.podUid) {
    // See onEnvironmentExecute: the first sync of a new sandbox records its pod.
    await recordReusableSandboxPodUid(clients, { namespace, name: lease.providerLeaseId, podName });
  }
  const leaseId = lease.providerLeaseId;
  const keepBusy = <T>(work: () => Promise<T>) =>
    withReusableSandboxBusy(reuseStamp !== null, clients, namespace, leaseId, work);

  // Bind the streaming exec: raw tar bytes move over stdin/stdout straight to and
  // from a host file, so neither side buffers the whole payload. The file-sync
  // module bounds the untrusted pod's stdout with its own streamed-bytes disk
  // guard and passes the stderr cap through `io`.
  const exec: PodStreamExec = (command, io) =>
    execInPodStreaming(kc, namespace, podName, "agent", command, {
      ...io,
      timeoutMs: io.timeoutMs ?? timeoutMs,
      liveness: execLivenessFromConfig(config),
    });
  return { exec, timeoutMs, keepBusy };
}

/**
 * Connection inputs straight from an RPC's raw `config` (pre-schema-parse), used
 * to evict the matching cached connection. The schema leaves `inCluster` and
 * `kubeconfig` untouched (apart from defaulting `inCluster`), and the cache key
 * normalizes `inCluster` to a boolean, so this hits the same entry.
 */
function connectionInputFromRawConfig(raw: unknown): KubeConnectionInput {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    inCluster: record.inCluster === true,
    kubeconfig: typeof record.kubeconfig === "string" ? record.kubeconfig : undefined,
  };
}

/**
 * Wrap the cluster-touching RPC handlers so any thrown 401/403 evicts the cached
 * KubeConfig/clients for that config; the host's next call then rebuilds them
 * from the (possibly rotated) kubeconfig it resolves.
 */
function withAuthEviction(
  handlers: PluginDefinition,
  names: Array<keyof PluginDefinition>,
): PluginDefinition {
  const wrapped: Record<string, unknown> = { ...handlers };
  for (const name of names) {
    const original = handlers[name];
    if (typeof original !== "function") continue;
    wrapped[name as string] = async (params: { config?: unknown }, ...rest: unknown[]) => {
      try {
        return await (original as (...args: unknown[]) => Promise<unknown>)(params, ...rest);
      } catch (err) {
        evictKubeConnectionOnAuthError(connectionInputFromRawConfig(params?.config), err);
        throw err;
      }
    };
  }
  return wrapped as unknown as PluginDefinition;
}

const plugin = definePlugin(withAuthEviction({
  async setup(ctx) {
    ctx.logger.info("Kubernetes sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Kubernetes sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => i.message),
      };
    }
    const warnings: string[] = [];
    const cfg = parsed.data;
    if (cfg.reuseLease && cfg.backend !== "sandbox-cr") {
      return {
        ok: false,
        errors: [
          'reuseLease requires backend "sandbox-cr": the job backend runs a one-shot entrypoint and cannot keep a sandbox between runs.',
        ],
      };
    }
    if (cfg.reuseLease) {
      // Idle reusable sandboxes keep counting against the tenant quota.
      const settings = resolveReuseSettings(cfg);
      const fit = maxReusableSandboxesInQuota(DEFAULT_RESOURCE_QUOTA, settings.resources);
      if (fit !== null && settings.maxSandboxes > fit) {
        warnings.push(
          `reuseMaxSandboxes=${settings.maxSandboxes} is more than the ${fit} reusable sandboxes (requests ${settings.resources.requests.cpu}/${settings.resources.requests.memory}, limits ${settings.resources.limits.cpu}/${settings.resources.limits.memory}) that fit the default tenant ResourceQuota (pods ${DEFAULT_RESOURCE_QUOTA.pods}, limits ${DEFAULT_RESOURCE_QUOTA.limitsCpu} CPU / ${DEFAULT_RESOURCE_QUOTA.limitsMemory}). New sandboxes will be rejected by the quota before the cap is reached; lower reuseMaxSandboxes or reuseResources, or raise the paperclip-quota ResourceQuota in the tenant namespace.`,
        );
      }
    }
    const adapterDefaults = getAdapterDefaults(cfg.adapterType, cfg.adapters);
    const totalFqdns = [...adapterDefaults.allowFqdns, ...cfg.egressAllowFqdns];
    if (cfg.egressMode === "standard" && totalFqdns.length > 0) {
      if (cfg.egressAllowCidrs.length === 0) {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules (Kubernetes NetworkPolicy is CIDR-only). To keep the configured FQDNs reachable (${totalFqdns.join(", ")}) without operator intervention, the plugin will allow public IPv4 egress on TCP 80/443 with private/link-local/loopback/multicast ranges excluded. This is broader than exact FQDN allow-listing — switch egressMode to "cilium" (requires Cilium CNI) for precise enforcement, or set egressAllowCidrs explicitly to override the fallback.`,
        );
      } else {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via the operator-supplied egressAllowCidrs: ${totalFqdns.join(", ")}. Switch egressMode to "cilium" (requires Cilium CNI) for exact FQDN allow-listing.`,
        );
      }
    }
    return { ok: true, normalizedConfig: cfg as Record<string, unknown>, warnings: warnings.length > 0 ? warnings : undefined };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        summary: "Invalid Kubernetes provider configuration.",
        metadata: {
          errors: parsed.error.issues.map((i) => i.message),
        },
      };
    }
    const config = parsed.data;
    const namespace = deriveTenantNamespace(config, params.companyId);

    try {
      // Reuse the parsed kubeconfig + API clients across RPCs (see kube-client-cache.ts).
      const { clients } = getKubeConnection(config);
      // Reachability check: list pods in the tenant namespace. If the namespace
      // doesn't exist yet this will throw a 404 which we treat as "reachable
      // but namespace not provisioned" — still a successful probe.
      try {
        await clients.core.listNamespacedPod({ namespace });
      } catch (err) {
        const code = (err as { code?: number; statusCode?: number }).code
          ?? (err as { code?: number; statusCode?: number }).statusCode;
        if (code !== 404) throw err;
        // 404 means namespace doesn't exist yet — cluster is reachable.
      }
      return {
        ok: true,
        summary: `Kubernetes cluster reachable. Tenant namespace: ${namespace}.`,
        metadata: { namespace, provider: "kubernetes" },
      };
    } catch (err) {
      // A rejected credential must not stay cached for the next probe/RPC.
      evictKubeConnectionOnAuthError(config, err);
      return {
        ok: false,
        summary: "Kubernetes cluster probe failed.",
        metadata: {
          namespace,
          provider: "kubernetes",
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    // `adapterType` is an optional per-run hint the server may pass once the
    // SDK lease params grow that field (companion server-integration PR). The
    // plugin works without it: absent means "use the environment's configured
    // default adapter", so it stays compatible with the current SDK.
    params: PluginEnvironmentAcquireLeaseParams & {
      adapterType?: string;
      executionWorkspaceSettings?: Record<string, unknown> | null;
      leasePolicy?: string;
    },
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace = deriveTenantNamespace(config, params.companyId);

    // The adapter for THIS run is the agent's adapter (params.adapterType) when
    // supplied, so one environment can serve mixed harnesses; otherwise fall back
    // to the environment's configured default adapter. getAdapterDefaults validates
    // it is a registered adapter (throws otherwise), so a curated-out adapter fails
    // the lease as before.
    const effectiveAdapterType = resolveRunAdapterType(params.adapterType, config.adapterType);

    // Emit a runtime warning if FQDNs are configured but egressMode=standard
    // cannot enforce them. Mirrors the validateConfig warning so operators see
    // it in paperclip-server logs even if they missed the validation step.
    const adapterDefaultsForWarn = getAdapterDefaults(effectiveAdapterType, config.adapters);
    const totalFqdnsForWarn = [...adapterDefaultsForWarn.allowFqdns, ...config.egressAllowFqdns];
    if (config.egressMode === "standard" && totalFqdnsForWarn.length > 0) {
      if (config.egressAllowCidrs.length === 0) {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules; falling back to public-IPv4 (TCP 80/443) with private/link-local ranges excluded so the configured FQDNs (${totalFqdnsForWarn.join(", ")}) remain reachable. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      } else {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via operator-supplied egressAllowCidrs: ${totalFqdnsForWarn.join(", ")}. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      }
    }

    // Reuse the parsed kubeconfig + API clients across RPCs (see kube-client-cache.ts).
    const { clients } = getKubeConnection(config);

    // Ensure the tenant namespace and all its RBAC / network policy resources
    // exist before we try to create the Job.
    const adapterDefaults = getAdapterDefaults(effectiveAdapterType, config.adapters);

    await ensureTenant(clients, {
      namespace,
      companyId: params.companyId,
      paperclipServerNamespace: PAPERCLIP_SERVER_NAMESPACE,
      serviceAccountAnnotations: config.serviceAccountAnnotations,
      egressMode: config.egressMode,
      egressAllowFqdns: [...adapterDefaults.allowFqdns, ...config.egressAllowFqdns],
      egressAllowCidrs: config.egressAllowCidrs,
      resourceQuota: DEFAULT_RESOURCE_QUOTA,
    });

    const jobName = `pc-${newRunUlidDns()}`;
    const secretName = `${jobName}-env`;

    // Reuse applies only to a heartbeat-style run with a reuse scope (execution
    // workspace + agent) and no caller deadline: a lease that must end by a
    // fixed time is never kept for later runs. A host that states the lease
    // policy it will record decides: a lease it records as ephemeral is never
    // resumed, so its sandbox must not be kept. Without a stated policy (an
    // older host) the plugin decides from the fields above alone.
    const reuseSettings = resolveReuseSettings(config);
    const hostAllowsReuse =
      typeof params.leasePolicy !== "string" || params.leasePolicy === "reuse_by_environment";
    const reuseScope =
      reuseSettings.enabled &&
      hostAllowsReuse &&
      typeof params.executionWorkspaceId === "string" &&
      params.executionWorkspaceId.length > 0 &&
      typeof params.agentId === "string" &&
      params.agentId.length > 0 &&
      !params.requestedExpiresAt
        ? { executionWorkspaceId: params.executionWorkspaceId, agentId: params.agentId }
        : null;
    let reuseStamp: KubernetesReuseLeaseStamp | null = null;
    let reuseAnnotations: Record<string, string> | undefined;
    let reuseLabels: Record<string, string> = {};
    if (reuseScope) {
      const reuseKey = computeReuseKey({
        companyId: params.companyId,
        environmentId: params.environmentId,
        executionWorkspaceId: reuseScope.executionWorkspaceId,
        agentId: reuseScope.agentId,
        runAdapterType: effectiveAdapterType,
      });
      const specHash = reusableSandboxSpecHash(config, namespace, effectiveAdapterType);
      reuseStamp = {
        version: REUSE_SPEC_VERSION,
        key: reuseKey,
        specHash,
        runAdapterType: effectiveAdapterType,
        idleTtlSec: reuseSettings.idleTtlSec,
        podUid: null,
      };
      reuseAnnotations = buildInitialReuseAnnotations({
        specHash,
        reuseKey,
        idleTtlSec: reuseSettings.idleTtlSec,
        staleBusySec: reuseSettings.staleBusySec,
        now: new Date(),
      });
      reuseLabels = buildReuseLabels({
        reuseKey,
        executionWorkspaceId: reuseScope.executionWorkspaceId,
        issueId: params.issueId ?? null,
      });
    }
    const reuseRegistration = trackReuseNamespaces(config, namespace, reuseStamp !== null);

    // TODO: use params.runId as stand-in for agentId in labels; future
    // versions will have a dedicated agentId on AcquireLeaseParams. A reusable
    // sandbox outlives the run, so it is labelled with the real agent.
    const labels = {
      ...paperclipLabels({
        runId: params.runId,
        agentId: reuseScope ? reuseScope.agentId : params.runId,
        companyId: params.companyId,
        adapterType: effectiveAdapterType,
      }),
      ...reuseLabels,
    };

    const image = resolveImage(
      { imageOverride: null },
      adapterDefaults,
      { imageAllowList: config.imageAllowList, imageRegistry: config.imageRegistry },
    );

    // Pick the orchestrator and build the appropriate manifest based on backend.
    const isSandboxCrBackend = config.backend === "sandbox-cr";
    const orchestrator = isSandboxCrBackend ? sandboxCrOrchestrator : jobOrchestrator;

    const manifest = isSandboxCrBackend
      ? buildSandboxCrManifest({
          namespace,
          sandboxName: jobName,
          adapterType: effectiveAdapterType,
          image,
          envSecretName: secretName,
          serviceAccountName: TENANT_SERVICE_ACCOUNT,
          labels,
          // An idle reusable sandbox holds its requests for its whole life, so
          // it requests little; limits stay as for any other sandbox.
          resources: reuseStamp ? reuseSettings.resources : config.defaultResources ?? {},
          runtimeClassName: config.runtimeClassName,
          imagePullSecrets: config.imagePullSecrets,
          ...(reuseAnnotations ? { annotations: reuseAnnotations } : {}),
        })
      : buildJobManifest({
          namespace,
          jobName,
          adapterType: effectiveAdapterType,
          image,
          envSecretName: secretName,
          serviceAccountName: TENANT_SERVICE_ACCOUNT,
          labels,
          resources: config.defaultResources ?? {},
          runtimeClassName: config.runtimeClassName,
          activeDeadlineSec: config.podActivityDeadlineSec,
          ttlSecondsAfterFinished: config.jobTtlSecondsAfterFinished,
          imagePullSecrets: config.imagePullSecrets,
        });

    const claimWorkload = () => orchestrator.claim(clients, namespace, manifest);
    const { uid: ownerUid } =
      reuseStamp && reuseRegistration
        ? // Make room under the per-namespace cap (least recently used idle
          // sandboxes go first) and reap expired ones right before creating the
          // sandbox, one acquire per namespace at a time so concurrent acquires
          // do not overshoot the cap. The sweep wait is bounded so a slow API
          // does not hold up the run.
          await withReuseSlot(reuseRegistration, async () => {
            await maybeSweepReuseNamespace(reuseRegistration, {
              reserveSlot: true,
              waitMs: ACQUIRE_SWEEP_BUDGET_MS,
            });
            return await claimWorkload();
          })
        : await claimWorkload();
    const scopedNetworkEgress = parseScopedNetworkEgressGrant(params.executionWorkspaceSettings);
    const scopedNetworkPolicyName = await createScopedNetworkEgressPolicyOrReleaseWorkload(
      {
        clients,
        namespace,
        mode: config.egressMode,
        runId: params.runId,
        workloadName: jobName,
        ownerReference: {
          apiVersion: isSandboxCrBackend ? "agents.x-k8s.io/v1alpha1" : "batch/v1",
          kind: isSandboxCrBackend ? "Sandbox" : "Job",
          name: jobName,
          uid: ownerUid,
          controller: false,
          blockOwnerDeletion: false,
        },
        grant: scopedNetworkEgress,
      },
      () => orchestrator.release(clients, namespace, jobName),
    );

    // defaultEnv (non-secret base, e.g. the inference base URL) is layered first;
    // the process-env secrets named by envKeys override it.
    const adapterEnv = buildAdapterEnv(adapterDefaults);
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_POLICY = "kubernetes-default-deny";
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_GRANT_PATH = NETWORK_EGRESS_GRANT_PATH;
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS = scopedNetworkEgress.allowFqdns.join(",");
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_CIDRS = scopedNetworkEgress.allowCidrs.join(",");
    const bootstrapToken = generateBootstrapToken();

    // Secret ownerRef: for job backend, the Job owns the Secret (cascade delete).
    // For sandbox-cr backend, the Sandbox CR owns the Secret.
    // NOTE: For sandbox-cr, if the Secret outlives the Sandbox due to a cluster
    // quirk, the release() call will still clean it up via namespace GC or
    // explicit delete in a future iteration.
    await createPerRunSecret(clients, {
      namespace,
      secretName,
      runId: params.runId,
      ownerKind: isSandboxCrBackend ? "Sandbox" : "Job",
      ownerApiVersion: isSandboxCrBackend ? "agents.x-k8s.io/v1alpha1" : "batch/v1",
      ownerName: jobName,
      ownerUid,
      bootstrapToken,
      adapterEnv,
    });

    const podName = await orchestrator.findPod(clients, namespace, jobName);
    if (reuseStamp) busyRefreshedAt.set(jobName, Date.now());

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName,
      podName,
      secretName,
      phase: "Pending",
      backend: config.backend,
      scopedNetworkPolicyName,
      scopedNetworkEgress,
      // Native file sync streams over a pod exec; only the sandbox-cr backend
      // exposes one. Flag the job backend so the server keeps the base64 fallback
      // rather than routing its sync to a hook that would reject immediately.
      nativeFileSyncUnsupported: config.backend !== "sandbox-cr",
      // A reusable sandbox pins its working directory so every run that resumes
      // it gets the same remote cwd (the harness session identity includes it).
      ...(reuseStamp ? { remoteCwd: REUSE_REMOTE_CWD, kubernetesReuse: reuseStamp } : {}),
    };

    return {
      providerLeaseId: jobName,
      metadata: leaseMetadata as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    // Leases acquired with reuseLease on carry a reuse stamp and take the
    // reusable path; every other lease keeps the original liveness check.
    const reuseStamp = readReuseStamp(params.leaseMetadata);
    if (reuseStamp) return await resumeReusableLease(params, config, reuseStamp);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    // acquireLease names the per-run Secret `${jobName}-env` and uses jobName
    // as the providerLeaseId, so the suffix fallback reconstructs it exactly.
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;

    // Reuse the parsed kubeconfig + API clients across RPCs (see kube-client-cache.ts).
    const { clients } = getKubeConnection(config);
    trackReuseNamespaces(config, namespace, false);

    const check = await checkLeaseResumable(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      readyTimeoutMs: resumeReadyTimeoutMs(config),
      pollMs: RESUME_READY_POLL_MS,
    });

    if (!check.resumable) {
      // Kubernetes pods are NOT restartable the way Daytona sandboxes are: a
      // stopped Daytona sandbox can be started again by ID, but a k8s pod that
      // is gone or terminally failed can never be revived in place. Gone = not
      // resumable, by design. Returning providerLeaseId: null tells the server
      // the lease expired so it falls back to a fresh acquireLease.
      return {
        providerLeaseId: null,
        metadata: { expired: true, reason: check.reason },
      };
    }

    // A resumed lease starts with clean per-lease state: drop any stale upload
    // interceptor buffers a previous run on this lease may have left behind,
    // and accept commands again after a stop that kept the sandbox.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    releasedLeases.delete(params.providerLeaseId);
    if (leaseBackend === "sandbox-cr") {
      // We just observed the Sandbox pod Ready, so the first exec on the
      // resumed lease can skip its readiness poll.
      readySandboxesByLease.add(params.providerLeaseId);
    }

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName: params.providerLeaseId,
      podName: check.podName,
      secretName,
      phase: check.phase,
      backend: leaseBackend,
      scopedNetworkPolicyName:
        typeof params.leaseMetadata?.scopedNetworkPolicyName === "string"
          ? params.leaseMetadata.scopedNetworkPolicyName
          : null,
      scopedNetworkEgress: parseScopedNetworkEgressGrant({
        networkEgress: params.leaseMetadata?.scopedNetworkEgress,
      }),
      // See acquireLease: only the sandbox-cr backend has a pod-exec channel for
      // native sync, so a resumed job lease must keep the base64 fallback.
      nativeFileSyncUnsupported: leaseBackend !== "sandbox-cr",
    };

    return {
      providerLeaseId: params.providerLeaseId,
      metadata: {
        ...leaseMetadata,
        resumedLease: true,
      } as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    // The agent pod already has /workspace mounted as an emptyDir at pod
    // scheduling time (see pod-spec-builder). Nothing to provision here —
    // we just hand back the cwd. Honor a caller-supplied remotePath if set.
    const cwd =
      params.workspace.remotePath && params.workspace.remotePath.trim().length > 0
        ? params.workspace.remotePath.trim()
        : "/workspace";
    return {
      cwd,
      metadata: {
        provider: "kubernetes",
        remoteCwd: cwd,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    if (params.resourceDisposition === "stop_and_retain") {
      return await plugin.definition.onEnvironmentStopLease!(params);
    }
    // A reusable lease keeps its sandbox when reuse is still on for the
    // environment: the run's processes are stopped and verified gone (a
    // `stopped` receipt) and the pod idles until the next run resumes it.
    const reuseStamp = readReuseStamp(params.leaseMetadata);
    if (reuseStamp) {
      const config = kubernetesProviderConfigSchema.parse(params.config);
      const leaseBackend =
        typeof params.leaseMetadata?.backend === "string" ? params.leaseMetadata.backend : config.backend;
      if (resolveReuseSettings(config).enabled && leaseBackend === "sandbox-cr") {
        return await releaseReusableLease(
          // `runStatus` is how the run ended, when the host says (see
          // releaseReusableLease); it is not part of the SDK params yet.
          { ...params, providerLeaseId: params.providerLeaseId },
          config,
          reuseStamp,
        );
      }
    }
    // Kubernetes pods cannot be stopped and restarted in place, so releasing a
    // lease tears down everything acquireLease created, exactly like destroy.
    // Both return a termination receipt only once the API server confirms the
    // resources are gone: the host needs that receipt to certify that a
    // stopped run's remote execution ended (saved comments wait on it).
    return await teardownLease({ ...params, providerLeaseId: params.providerLeaseId });
  },

  // Stop the lease's work and keep its sandbox and files, whatever its release
  // policy (the host's stop-and-retain): the processes in the pod are stopped
  // and verified gone, the pod keeps running, and a sandbox kept between runs
  // is marked idle for the next run. A stop that cannot be verified throws and
  // never falls back to removing the sandbox. See stopLeaseKeepingSandbox.
  async onEnvironmentStopLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt> {
    if (!params.providerLeaseId) throw new Error("Kubernetes stop requires an exact sandbox identity.");
    const config = kubernetesProviderConfigSchema.parse(params.config);
    return await stopLeaseKeepingSandbox({ ...params, providerLeaseId: params.providerLeaseId }, config);
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!params.providerLeaseId) return;
    return await teardownLease({ ...params, providerLeaseId: params.providerLeaseId });
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const { lease, timeoutMs } = params;

    if (!lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = kubernetesProviderConfigSchema.parse(params.config);
    const scopedNetworkEgress = parseScopedNetworkEgressGrant({
      networkEgress: lease.metadata?.scopedNetworkEgress,
    });
    const namespace =
      typeof lease.metadata?.namespace === "string"
        ? lease.metadata.namespace
        : deriveTenantNamespace(config, params.companyId);

    // Determine which backend this lease was created with.
    const leaseBackend =
      typeof lease.metadata?.backend === "string"
        ? (lease.metadata.backend as "sandbox-cr" | "job")
        : config.backend;

    // Reuse the parsed kubeconfig + API clients across RPCs (see kube-client-cache.ts).
    const { kc, clients } = getKubeConnection(config);
    const reuseStamp = readReuseStamp(lease.metadata);
    trackReuseNamespaces(config, namespace, reuseStamp !== null);

    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? timeoutMs
        : config.podActivityDeadlineSec * 1000;

    const refusal = releasedLeaseRefusal(lease.providerLeaseId);
    if (refusal) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: refusal,
        metadata: { provider: "kubernetes", namespace, sandboxName: lease.providerLeaseId, leaseReleased: true },
      };
    }

    if (leaseBackend === "sandbox-cr") {
      // ── Sandbox-CR backend ──────────────────────────────────────────────────
      // 1. Ensure the Sandbox pod is Ready (wait only on first exec for this lease).
      // 2. Exec the command into the running pod.
      // 3. Return exec result directly (no log scraping needed).

      let podName =
        typeof lease.metadata?.podName === "string" && lease.metadata.podName
          ? lease.metadata.podName
          : null;

      // Skip the readiness poll if we've already observed this Sandbox CR
      // reaching Ready during this worker's lifetime. See readySandboxesByLease
      // declaration for rationale.
      const podAlreadyKnownReady = readySandboxesByLease.has(lease.providerLeaseId);

      // The caller's timeout is a budget for the WHOLE execute call: readiness
      // wait + exec must share it, or the first exec on a fresh lease could
      // block for up to twice the requested timeout.
      const executeStartedAt = Date.now();

      // Bound the readiness poll itself to min(run budget, podReadyTimeoutSec
      // ?? 600s) — separately from effectiveTimeoutMs, which remains the
      // budget for the whole call (readiness wait + exec). A pod stuck
      // Pending (no capacity, bad node selector, an image that will never
      // pull) would otherwise silently consume the entire run budget before
      // failing; this makes that failure fast and diagnosable instead.
      const podReadyTimeoutMs = resolvePodReadyTimeoutMs(config, effectiveTimeoutMs);

      if (!podAlreadyKnownReady) {
        try {
          await sandboxCrOrchestrator.waitForCompletion(
            clients,
            namespace,
            lease.providerLeaseId,
            { timeoutMs: podReadyTimeoutMs, pollMs: 2000 },
          );
          readySandboxesByLease.add(lease.providerLeaseId);
        } catch (err) {
          if (err instanceof SandboxCrTimeoutError) {
            // Best-effort pod-name resolution purely to target the event
            // lookup — the Sandbox CR's own name is a reasonable fallback
            // (agent-sandbox v0.4.x names the pod exactly after the CR; see
            // findPodForSandbox).
            const eventPodName =
              podName ??
              (await sandboxCrOrchestrator
                .findPod(clients, namespace, lease.providerLeaseId)
                .catch(() => null)) ??
              lease.providerLeaseId;
            const { summary, events } = await summarizeRecentPodEvents(
              clients,
              namespace,
              eventPodName,
            );
            return {
              // exitCode: null + timedOut: true is this file's existing
              // convention for a provider-side failure that a caller's own
              // retry policy can act on (the exec-call watchdog timeout
              // below uses the identical shape). `metadata.transient`
              // documents that intent explicitly for any consumer
              // inspecting metadata — but as of this change no caller reads
              // it, and a plain `timedOut` result on this path is not
              // auto-retried by the scheduler today. This still fails fast
              // and explains why (recent pod events, above) instead of
              // silently spending the whole run budget; wiring an actual
              // retry decision to this shape is separate follow-up work.
              exitCode: null,
              timedOut: true,
              stdout: "",
              stderr: summary
                ? `Sandbox pod did not become Ready within ${podReadyTimeoutMs}ms — recent pod events: ${summary}`
                : `Sandbox pod did not become Ready within ${podReadyTimeoutMs}ms`,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
                transient: true,
                podReadyTimeoutMs,
                podEvents: events,
              },
            };
          }
          throw err;
        }
      }

      // Resolve pod name (may now be populated in Sandbox status).
      if (!podName) {
        podName = await sandboxCrOrchestrator.findPod(
          clients,
          namespace,
          lease.providerLeaseId,
        );
      }

      if (!podName) {
        return {
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "Sandbox pod is Ready but podName could not be resolved.",
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
          },
        };
      }

      if (!podAlreadyKnownReady && reuseStamp && !reuseStamp.podUid) {
        // First time this worker reaches a sandbox the run created: record its
        // pod so release can tell whether it was replaced during the run.
        await recordReusableSandboxPodUid(clients, { namespace, name: lease.providerLeaseId, podName });
      }
      const leaseId = lease.providerLeaseId;
      const keepBusy = <T>(work: () => Promise<T>) =>
        withReusableSandboxBusy(reuseStamp !== null, clients, namespace, leaseId, work);

      // Build the command to exec. The adapter passes shell invocations as
      // `command: "sh", args: ["-c", "<script>"]` — must combine both, NOT
      // drop args. If only command is present (no args), wrap in a login shell.
      const command = typeof params.command === "string" ? params.command.trim() : "";
      const args = Array.isArray(params.args) ? params.args : [];

      // Fast-upload interceptor: short-circuit the chunked-shell file transfer
      // protocol (adapter-utils writeFile) so an N-chunk upload becomes 1 exec
      // instead of N+2. Falls back transparently when patterns don't match.
      // See upload-interceptor.ts.
      const shellScript =
        command === "sh" && args[0] === "-c" && typeof args[1] === "string"
          ? args[1]
          : null;
      if (shellScript) {
        const decision = getOrCreateUploadInterceptor(lease.providerLeaseId).decide(shellScript);
        if (decision.action === "ack") {
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "ack",
            },
          };
        }
        if (decision.action === "flush") {
          // Single exec: `head -c <N> | base64 -d > '<TARGET>'` with stdin =
          // base64 ASCII. `head -c` reads EXACTLY N bytes and exits, so we
          // don't depend on WebSocket-driven EOF detection on stdin (which is
          // racy against the `base64 -d` exit timing in @kubernetes/client-node
          // v0.21.0 — see pod-exec.ts). All bytes are sent through the
          // WebSocket data channel; size is unbounded by ARG_MAX.
          const base64Body = decision.flush.payload.toString("base64");
          const dir = decision.flush.targetPath.substring(
            0,
            decision.flush.targetPath.lastIndexOf("/"),
          );
          const script =
            `mkdir -p '${dir}' && ` +
            `head -c ${base64Body.length} | base64 -d > '${decision.flush.targetPath}'`;
          // The flush shares the caller's single execute budget (same contract
          // as the normal exec path below) and surfaces watchdog/WebSocket
          // failures as a timed-out result instead of an uncaught throw.
          const flushTimeoutMs = Math.max(
            5_000,
            effectiveTimeoutMs - (Date.now() - executeStartedAt),
          );
          let flushResult: { exitCode: number; stdout: string; stderr: string };
          const flushPodName = podName;
          try {
            flushResult = await keepBusy(() =>
              execInPod(
                kc,
                namespace,
                flushPodName,
                "agent",
                ["/bin/sh", "-c", script],
                base64Body,
                flushTimeoutMs,
                undefined,
                undefined,
                execLivenessFromConfig(config),
              ),
            );
          } catch (err) {
            // Converted to a result below, so evict here rather than in the RPC wrapper
            // (evictKubeConnectionOnAuthError is a no-op unless err is actually a 401/403).
            evictKubeConnectionOnAuthError(config, err);
            // Same transport-failure contract as the main exec path below:
            // tag the failure kind and keep whatever output arrived.
            const transport = err instanceof PodExecTransportError ? err : null;
            const reason = `fast-upload flush failed: ${err instanceof Error ? err.message : String(err)}`;
            return {
              exitCode: null,
              // A dropped exec connection is a transport failure, not a timeout.
              timedOut: !transport || transport.kind === "timeout",
              stdout: transport?.partialStdout ?? "",
              stderr: transport && transport.partialStderr.length > 0
                ? `${reason}\n${transport.partialStderr}`
                : reason,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
                podName,
                fastUpload: "flush",
                ...(transport ? { execTransportFailure: transport.kind } : {}),
              },
            };
          }
          return {
            exitCode: flushResult.exitCode,
            timedOut: false,
            stdout: flushResult.stdout,
            stderr: flushResult.stderr,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "flush",
              uploadedBytes: decision.flush.payload.length,
            },
          };
        }
        // decision.action === "passthrough" — fall through to normal exec
      }

      const baseExecCommand =
        command.length > 0 && args.length > 0
          ? [command, ...args]
          : command.length > 0
            ? ["/bin/sh", "-lc", command]
            : ["/bin/sh", "-l"];

      // Apply the caller-provided run env (params.env) to the in-pod process. Without
      // this the adapter's runtime env (e.g. XDG_CONFIG_HOME pointing at the shipped
      // OpenCode config, plus helper settings like small_model/provider routing) never
      // reaches the harness, which falls back to its in-image HOME config -> wrong or
      // partial behaviour. The values go over stdin, never onto the command line:
      // run env carries API keys and tokens, and a command line is readable by
      // every process in the pod.
      const { command: execCommand, stdin: execStdin } = wrapCommandWithEnv(
        baseExecCommand,
        params.env,
        typeof params.stdin === "string" ? params.stdin : undefined,
      );

      // Remaining share of the caller's budget after the readiness wait (floor
      // of 5s so an exec attempt is still made when readiness consumed most of
      // it; the watchdog then bounds it tightly).
      const remainingTimeoutMs = Math.max(
        5_000,
        effectiveTimeoutMs - (Date.now() - executeStartedAt),
      );

      let execResult: { exitCode: number; stdout: string; stderr: string };
      const execPodName = podName;
      try {
        execResult = await keepBusy(() =>
          execInPod(
            kc,
            namespace,
            execPodName,
            "agent",
            execCommand,
            execStdin,
            remainingTimeoutMs,
            undefined,
            undefined,
            execLivenessFromConfig(config),
          ),
        );
      } catch (err) {
        if (err instanceof PodExecTransportError) {
          // Only the watchdog is a real timeout. A dropped connection is a
          // transport failure detected within ~execLivenessTimeoutSec, so it
          // must not be reported as "timed out after <budget>". The command is
          // NOT re-run here: an agent run is not idempotent and may still be
          // running in the pod (see PodExecTransportError). Partial output is
          // kept so the adapter can still parse e.g. the session id; our
          // diagnosis goes first so it becomes the run's error line.
          const stderr = err.partialStderr.length > 0
            ? `${err.message}\n${err.partialStderr}`
            : err.message;
          return {
            exitCode: null,
            timedOut: err.kind === "timeout",
            stdout: err.partialStdout,
            stderr: appendNetworkEgressDenyHint(stderr, scopedNetworkEgress),
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              execTransportFailure: err.kind,
            },
          };
        }
        // Watchdog-fired or WebSocket-setup error. Surface as a timeout so
        // the caller can retry instead of hanging forever. A 401/403 on the
        // exec upgrade evicts the cached client so the retry rebuilds it.
        evictKubeConnectionOnAuthError(config, err);
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: appendNetworkEgressDenyHint(err instanceof Error ? err.message : String(err), scopedNetworkEgress),
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
            podName,
          },
        };
      }

      return {
        exitCode: execResult.exitCode,
        timedOut: false,
        stdout: execResult.stdout,
        stderr: appendNetworkEgressDenyHint(execResult.stderr, scopedNetworkEgress),
        metadata: {
          provider: "kubernetes",
          backend: "sandbox-cr",
          namespace,
          sandboxName: lease.providerLeaseId,
          podName,
        },
      };
    } else {
      // ── Job backend (legacy / stable fallback) ──────────────────────────────
      // The container entrypoint is baked into the Job spec (Tini + paperclip-agent-shim).
      // We do NOT re-exec command/args — instead we wait for the Job to finish
      // and collect its logs.
      //
      // params.command / params.args / params.stdin are intentionally ignored.

      // Two-phase wait, mirroring the sandbox-cr backend above: first bound
      // how long we wait for the Job's pod to actually start running
      // (scheduling + image pull) to min(run budget, podReadyTimeoutSec ??
      // 600s) — the SAME cap the sandbox-cr backend uses for its readiness
      // wait — then, only once the pod is up, wait for the Job to finish
      // with whatever run budget remains. A Job stuck Pending (no capacity,
      // a bad node selector, an image that will never pull) now fails fast
      // and diagnosably instead of silently consuming the whole run budget,
      // AND a Job that legitimately runs longer than podReadyTimeoutSec once
      // its pod is up is no longer capped by it (see waitForJobPodRunning in
      // job-orchestrator.ts for why getJobStatus's own "Running" phase isn't
      // enough to detect the pod-is-up transition).
      const podReadyTimeoutMs = resolvePodReadyTimeoutMs(config, effectiveTimeoutMs);
      const jobWaitStartedAt = Date.now();

      let status: JobStatus | null = null;
      let timeoutStage: "pod_not_ready" | "completion" | null = null;
      let completionTimeoutMs = 0;
      let podName: string | null =
        typeof lease.metadata?.podName === "string" ? lease.metadata.podName : null;

      try {
        const podRunning = await waitForJobPodRunning(
          clients,
          namespace,
          lease.providerLeaseId,
          { timeoutMs: podReadyTimeoutMs, pollMs: 2000 },
        );
        podName = podRunning.podName ?? podName;
        status = podRunning.jobStatus;
      } catch (err) {
        if (err instanceof JobPodNotReadyError) {
          timeoutStage = "pod_not_ready";
        } else {
          throw err;
        }
      }

      if (
        timeoutStage === null &&
        status &&
        status.phase !== "Succeeded" &&
        status.phase !== "Failed"
      ) {
        completionTimeoutMs = Math.max(0, effectiveTimeoutMs - (Date.now() - jobWaitStartedAt));
        try {
          status = await jobOrchestrator.waitForCompletion(
            clients,
            namespace,
            lease.providerLeaseId,
            { timeoutMs: completionTimeoutMs, pollMs: 2000 },
          );
        } catch (err) {
          if (err instanceof JobTimeoutError) {
            timeoutStage = "completion";
            status = null;
          } else {
            throw err;
          }
        }
      }
      const timedOut = timeoutStage !== null;

      // Collect logs from the pod.
      if (!podName) {
        podName = await jobOrchestrator.findPod(clients, namespace, lease.providerLeaseId);
      }

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      if (podName) {
        await jobOrchestrator.streamLogs(
          clients,
          namespace,
          podName,
          async (stream, text) => {
            if (stream === "stdout") stdoutChunks.push(text);
            else stderrChunks.push(text);
          },
        );
      }

      // On timeout, fetch the pod's recent events (FailedScheduling,
      // ImagePullBackOff, etc.) so the caller knows WHY the Job never
      // finished, not just that it didn't. exitCode: null + timedOut: true
      // is this file's existing convention for a provider-side failure that
      // is a candidate for a caller's own retry policy to act on;
      // `metadata.transient` documents that intent explicitly for any
      // consumer inspecting metadata, though see this plugin's own
      // observation elsewhere that no caller currently reads it — treat a
      // timed-out result as "explained, not yet auto-retried".
      const timeoutEventSummary = timedOut
        ? await summarizeRecentPodEvents(clients, namespace, podName ?? lease.providerLeaseId)
        : null;
      const timeoutMessage =
        timeoutStage === "pod_not_ready"
          ? `Job's pod did not start running within ${podReadyTimeoutMs}ms`
          : timeoutStage === "completion"
            ? `Job did not complete within ${completionTimeoutMs}ms`
            : null;

      const stderrText = appendNetworkEgressDenyHint(stderrChunks.join(""), scopedNetworkEgress);
      return {
        exitCode: timedOut ? null : status?.phase === "Succeeded" ? 0 : 1,
        timedOut,
        stdout: stdoutChunks.join(""),
        stderr: timeoutMessage
          ? `${stderrText}${stderrText ? "\n" : ""}${timeoutMessage}${
              timeoutEventSummary?.summary ? ` — recent pod events: ${timeoutEventSummary.summary}` : ""
            }`
          : stderrText,
        metadata: {
          provider: "kubernetes",
          backend: "job",
          namespace,
          jobName: lease.providerLeaseId,
          podName: podName ?? null,
          phase: status?.phase ?? null,
          ...(timedOut
            ? {
                transient: true,
                timeoutStage,
                podReadyTimeoutMs,
                podEvents: timeoutEventSummary?.events ?? [],
              }
            : {}),
        },
      };
    }
  },

  // Opt-in native inbound transfer. Defining this hook (with onEnvironmentSyncOut)
  // makes the worker advertise `environmentSyncIn`/`environmentSyncOut`, so the
  // host runner routes workspace/asset transfers through a single pod exec per
  // operation (host tar streamed over the exec stdin → in-pod `head -c <N> | tar
  // -x` → stage-then-atomic-`mv -f`) instead of the base64-over-exec chunk loop.
  // Only the sandbox-cr backend is supported; the job backend carries no file
  // path. Providers that do not define these keep the byte-identical fallback.
  async onEnvironmentSyncIn(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs, keepBusy } = await resolveSyncPodExec(params);
    return await keepBusy(() =>
      performSyncIn({
        exec,
        operations: params.operations,
        remoteDir,
        timeoutMs,
      }),
    );
  },

  // Opt-in native outbound transfer. See onEnvironmentSyncIn.
  async onEnvironmentSyncOut(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs, keepBusy } = await resolveSyncPodExec(params);
    return await keepBusy(() =>
      performSyncOut({
        exec,
        operations: params.operations,
        remoteDir,
        timeoutMs,
      }),
    );
  },
}, [
  "onEnvironmentAcquireLease",
  "onEnvironmentResumeLease",
  "onEnvironmentReleaseLease",
  "onEnvironmentStopLease",
  "onEnvironmentDestroyLease",
  "onEnvironmentExecute",
  "onEnvironmentSyncIn",
  "onEnvironmentSyncOut",
]));

export default plugin;
