import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: z.string().url().optional(),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string()).default({}),

    jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900),
    podActivityDeadlineSec: z.number().int().positive().default(3600),

    /**
     * Pod-exec WebSocket keepalive. Every `execKeepaliveIntervalSec` the plugin
     * pings the kube-apiserver over the exec connection; if no frame, pong or
     * outbound send progress is seen for `execLivenessTimeoutSec` the exec is
     * declared dead and fails fast instead of waiting out the whole run budget.
     * A command that is merely quiet still answers pings, so it is not affected.
     * `execKeepaliveIntervalSec: 0` disables the keepalive (close/error events
     * are still honored). The liveness timeout is floored at two intervals.
     */
    execKeepaliveIntervalSec: z.number().int().nonnegative().default(15),
    execLivenessTimeoutSec: z.number().int().positive().default(60),

    /**
     * Upper bound (seconds) on a single "wait for pod ready" poll, separate
     * from the overall run budget (`podActivityDeadlineSec`, or a caller's
     * per-execute `timeoutMs`). The effective wait is always
     * `min(runBudget, podReadyTimeoutSec ?? 600)`: a pod that cannot schedule
     * or pull its image fails fast with its recent events instead of quietly
     * consuming the whole run budget. The liveness check on lease resume
     * (a short 30s wait of its own) is capped the same way. Raise this for
     * clusters where slow autoscaling or large images routinely need more
     * than ten minutes to bring a pod up.
     */
    podReadyTimeoutSec: z.number().int().positive().optional(),

    /**
     * The adapter type that Jobs in this environment will run.
     * Each Kubernetes environment is bound to one adapter; create multiple
     * environments for different adapters.
     * Defaults to `"claude_local"`.
     */
    adapterType: z
      .string()
      .default("claude_local")
      .refine((v) => KNOWN_ADAPTER_TYPES.has(v), {
        message: "adapterType must be one of the known adapter types",
      }),

    /**
     * Optional declarative adapter registry. When present it is authoritative
     * for runtime image / envKeys / allowFqdns / probe / defaultEnv resolution
     * (replace semantics). Absent = built-in defaults.
     */
    adapters: adapterRegistrySchema.optional(),

    /**
     * The sandbox backend to use.
     *
     * - `"sandbox-cr"` (default, alpha) — uses the kubernetes-sigs/agent-sandbox
     *   Sandbox CRD (agents.x-k8s.io/v1alpha1). Creates a long-lived pod that
     *   paperclip-server can exec into for multi-command adapter-install workflows.
     *   Requires the agent-sandbox controller to be installed in the cluster.
     *
     * - `"job"` — uses batch/v1 Job (stable fallback). One-shot entrypoint; does
     *   NOT support multi-command exec. Use this for clusters without agent-sandbox
     *   installed, or when you need stable (non-alpha) k8s APIs.
     */
    backend: z.enum(["sandbox-cr", "job"]).default("sandbox-cr"),

    /**
     * Keep one long-lived sandbox per reuse scope (company, environment,
     * execution workspace, agent and adapter) between runs instead of deleting
     * it on release. The host resumes the same sandbox on the next run for the
     * same scope, so the harness session store and the pod filesystem survive.
     * Requires the `sandbox-cr` backend. Declared here so config normalization
     * keeps the host-owned flag instead of silently dropping it.
     */
    reuseLease: z.boolean().default(false),

    /**
     * Host-owned warm-runner idle timeout, passed through from the environment
     * config. Used as the idle lifetime of a reusable sandbox when
     * `reuseIdleTtlSec` is not set.
     */
    runnerIdleTimeoutMs: z.number().int().positive().optional(),

    /** Idle lifetime of a reusable sandbox in seconds (default: 24h). */
    reuseIdleTtlSec: z.number().int().min(60).max(604_800).optional(),

    /**
     * Upper bound on reusable sandboxes per tenant namespace. When a new one is
     * needed at the cap, the least recently used idle sandbox is removed.
     * Default: 8.
     */
    reuseMaxSandboxes: z.number().int().min(1).max(100).optional(),

    /**
     * Resources for reusable sandboxes. An idle sandbox holds its requests for
     * its whole lifetime, so the defaults request little (100m / 256Mi) and keep
     * the regular limits.
     */
    reuseResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export interface KubernetesLeaseMetadata {
  namespace: string;
  /** Name of the workload resource (Job name for job backend, Sandbox CR name for sandbox-cr backend). */
  jobName: string;
  podName: string | null;
  secretName: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  /** Which backend provisioned this lease. */
  backend: "sandbox-cr" | "job";
  scopedNetworkPolicyName: string | null;
  scopedNetworkEgress: {
    allowFqdns: string[];
    allowCidrs: string[];
  };
  /**
   * True when this lease's backend has NO data channel for the native file-sync
   * transport. Native sync streams over a pod exec, which only the `sandbox-cr`
   * backend exposes; the `job` backend carries no exec path, so its sync hook
   * rejects immediately. The server's per-lease sync-capability gate honors this
   * opt-out so a job lease keeps the byte-identical base64 fallback instead of
   * being routed to a native hook that would only error. Absent/false ⇒ native
   * sync may be used when the worker advertises the verbs.
   */
  nativeFileSyncUnsupported?: boolean;
  /**
   * Working directory of a reusable sandbox. Only reusable leases set it, so the
   * host keeps the same remote cwd (and with it the harness session identity)
   * for every run that resumes the sandbox.
   */
  remoteCwd?: string;
  /** Reuse stamp; present only on leases acquired with `reuseLease` on. */
  kubernetesReuse?: KubernetesReuseLeaseStamp;
}

export interface KubernetesReuseLeaseStamp {
  /** Stamp format version. */
  version: number;
  /** Full reuse key (see reuse.ts computeReuseKey). */
  key: string;
  /** Pod spec hash the sandbox was created from. */
  specHash: string;
  /** Adapter type the sandbox runtime image was chosen for. */
  runAdapterType: string;
  /** Idle lifetime recorded at acquire/resume time. */
  idleTtlSec: number;
  /** UID of the pod observed by the last resume; null right after acquire. */
  podUid: string | null;
}
