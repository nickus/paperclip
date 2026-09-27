# @paperclipai/plugin-kubernetes (alpha)

First-party Paperclip sandbox-provider plugin for Kubernetes.

**Alpha:** the default backend (`sandbox-cr`) is built on `kubernetes-sigs/agent-sandbox` v1alpha1 — expect breaking changes as that CRD evolves toward Beta. A stable fallback backend (`job`, using `batch/v1` Job) is available for clusters without agent-sandbox installed, but it does NOT support multi-command exec (paperclip-server's adapter-install pattern requires sandbox-cr).

## Prerequisites

### For `sandbox-cr` backend (default, recommended)

1. A Kubernetes cluster running k8s 1.27+
2. [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) controller installed in the cluster (alpha — installs the `sandboxes.agents.x-k8s.io/v1alpha1` CRD and controller)
3. Paperclip-server running with access to the cluster (in-cluster via `inCluster: true` or external via `kubeconfig`)

### For `job` backend (stable fallback)

1. A Kubernetes cluster running k8s 1.27+
2. Paperclip-server with cluster access — no additional controllers or CRDs required

## Installation

```bash
paperclipai plugin install @paperclipai/plugin-kubernetes
```

Or, for local development:

```bash
paperclipai plugin install --local /path/to/paperclip/packages/plugins/sandbox-providers/kubernetes
```

## Backends

The plugin supports two backend modes, selected via the `backend` config field:

| Backend | Default | Stability | Multi-command exec | Requires |
|---|---|---|---|---|
| `sandbox-cr` | Yes | Alpha | Yes | `kubernetes-sigs/agent-sandbox` controller |
| `job` | No | Stable | No | Nothing beyond k8s 1.27+ |

**`sandbox-cr` (default):** Creates a `Sandbox` CR (`agents.x-k8s.io/v1alpha1`) whose controller provisions a long-lived pod running `sleep infinity`. paperclip-server execs individual commands into the running pod — this is the multi-command adapter-install pattern. When you `releaseLease`, the Sandbox CR is deleted and the controller tears down the pod.

**`job` (stable fallback):** Creates a `batch/v1` Job. The container entrypoint runs once and exits — no multi-command exec possible. Use this when you cannot install agent-sandbox, or when you need strictly stable Kubernetes APIs. Note: paperclip-server's adapter-install pattern will not work in job mode.

### Migrating from `job` to `sandbox-cr`

1. Install the agent-sandbox controller: `kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml`
2. Update your environment config to set `backend: "sandbox-cr"` (or remove `backend` since `sandbox-cr` is the default)
3. New leases will use the Sandbox CR backend. Existing leases created with `job` mode continue to use job semantics until they are released.

## Configuration

Create a `sandbox` environment with `driver: kubernetes`. One of these auth fields is required:

- `inCluster: true` — use the in-pod ServiceAccount credentials (when paperclip-server runs inside the same cluster).
- `kubeconfig: <YAML>` — inline kubeconfig (stored as a company secret).
- `kubeconfigSecretRef: <secret-uuid>` — reference to an existing Paperclip secret.

Common optional fields:

| Field | Default | Purpose |
|---|---|---|
| `backend` | `"sandbox-cr"` | `sandbox-cr` (alpha, requires agent-sandbox controller) or `job` (stable, one-shot entrypoint). |
| `adapterType` | `"claude_local"` | One of the supported adapter types (claude_local, codex_local, gemini_local, cursor_local, opencode_local, pi_local). Determines runtime image + env keys + egress allow-list. |
| `namespacePrefix` | `"paperclip-"` | Prefix for the per-company tenant namespace. |
| `companySlug` | derived from companyId | Override the auto-derived company slug. |
| `imageRegistry` | (none) | Override the default registry for agent runtime images. |
| `imageAllowList` | `[]` | Glob patterns of allowed `target.imageOverride` values. Empty = no override permitted. |
| `imagePullSecrets` | `[]` | Names of pre-created Docker image pull secrets in the tenant namespace. |
| `egressAllowFqdns` | `[]` | Additional FQDNs (beyond adapter defaults like `api.anthropic.com`). |
| `egressAllowCidrs` | `[]` | Additional CIDRs to allow egress to. |
| `egressMode` | `"standard"` | `standard` (NetworkPolicy + CIDRs) or `cilium` (CiliumNetworkPolicy + FQDN allow-list). |
| `runtimeClassName` | (none) | e.g. `kata-fc` for Firecracker-backed microVMs. Cluster must have the RuntimeClass installed. |
| `serviceAccountAnnotations` | `{}` | Annotations applied to per-tenant ServiceAccount (e.g. IRSA `eks.amazonaws.com/role-arn`). |
| `jobTtlSecondsAfterFinished` | `900` | Seconds after a Job completes before garbage-collection. |
| `podActivityDeadlineSec` | `3600` | Hard ceiling on a single run's wall-clock time. |
| `execKeepaliveIntervalSec` | `15` | Seconds between WebSocket pings on a pod exec connection. `0` disables the keepalive (close/error events are still honored). |
| `execLivenessTimeoutSec` | `60` | Fail an exec whose connection shows no sign of life (no output, pong or send progress) for this long, instead of waiting out `podActivityDeadlineSec`. Quiet but connected commands keep answering pings and are unaffected. Floored at two keepalive intervals. |
| `reuseLease` | `false` | Keep one sandbox per task between runs; see [Reusable sandboxes](#reusable-sandboxes-reuselease). |

Full JSON Schema in `src/manifest.ts`.

### Task-scoped egress grants

Keep provider-level egress defaults narrow, then grant only the destinations a task needs through its execution workspace settings:

```json
{
  "executionWorkspaceSettings": {
    "networkEgress": {
      "allowFqdns": ["github.com", "pypi.org"],
      "allowCidrs": []
    }
  }
}
```

The provider creates a workload-owned policy selected by the task run label, so the additional destinations do not become reachable from other concurrent agent pods. Cilium mode enforces FQDNs directly. Standard NetworkPolicy mode cannot express FQDNs, so an FQDN grant permits public IPv4 TCP 80/443 for that run while excluding private, loopback, link-local, CGNAT, and multicast ranges. Network failures that look policy-related include the grant path in stderr, and the sandbox exposes the effective policy through `PAPERCLIP_NETWORK_EGRESS_*` environment variables.

### Reusable sandboxes (`reuseLease`)

By default every run gets a fresh sandbox that is deleted when the run ends, so an agent re-clones its repositories and starts a new harness session on every follow-up run. With `reuseLease: true` (sandbox-cr backend only) the plugin keeps **one sandbox per task** instead: per reuse scope of company, environment, execution workspace, agent and adapter. With `isolated_workspace` execution workspaces that is one sandbox per issue and agent. The next run on the same task resumes the same pod, so both of these carry over:

- the harness session: the OpenCode session store and Claude's config/session directory live under `/workspace/.paperclip-runtime/<adapter>/` (the harness `HOME`; with a managed AI connection, OpenCode keeps one home per account there), and the session resumes because the run keeps the same provider lease and the same working directory (`/workspace`);
- the environment: dependency and build directories in the working tree (`node_modules`, `vendor`, `dist`, `build`, `out`, `coverage`, `.next`, `.turbo`, `.cache`, `target`, `.venv`, `venv`, `__pycache__`, `.gradle`, `.pytest_cache`, `.mypy_cache`, `.tox`, at any depth), `$HOME` caches (`~/.cache`, `~/.npm`, `~/.cargo`, ...) under `.paperclip-runtime`, `/tmp`, and `/home/paperclip`.

The rest of the repository tree in `/workspace` is re-extracted from the host execution workspace at the start of each run (the host copy is the durable one and is synced back at the end of each run). The build directories above are moved aside for that and put back afterwards, unless the host copy now has something at that path (the host wins) or the project that held them is gone. Other untracked files that exist only in the sandbox are not kept; clone extra repositories under `$HOME` or `/tmp` to keep them.

| Field | Default | Purpose |
|---|---|---|
| `reuseLease` | `false` | Keep one sandbox per task between runs. Rejected with `backend: "job"`. |
| `reuseIdleTtlSec` | `runnerIdleTimeoutMs`/1000, else `86400` | How long an idle sandbox is kept (60s–7d). |
| `reuseMaxSandboxes` | `8` | Reusable sandboxes per tenant namespace. At the cap, the least recently used idle sandbox is removed to make room. |
| `reuseResources` | requests `100m`/`256Mi`, limits as `defaultResources` (else `2`/`4Gi`) | Resources of reusable sandboxes. See **Quota** for the trade-off of the low requests. |

Enable it on an existing environment (the config is merged shallowly, secret references are kept):

```json
{ "config": { "reuseLease": true, "runnerIdleTimeoutMs": 86400000, "reuseMaxSandboxes": 8 } }
```

**Lifecycle.** A run's release stops every process the run left in the pod (the keepalive is kept), verifies nothing is left, and marks the sandbox idle; only then does it return a `stopped` receipt. An explicit Stop (cancellation) takes the same path, and commands for a released sandbox are refused until a run resumes it. If the stop cannot be verified, if reuse was turned off, or if the last 3 runs in the sandbox failed, the sandbox is deleted as before (`destroyed`), so the next run starts clean. Temporary API errors during a release are retried for a few seconds; a sandbox whose processes were verified stopped is kept even if it could not be marked idle. Resume checks that the Sandbox, its pod and its spec are unchanged and marks it busy; a sandbox that is gone, failing, built from a different image/config (pod spec hash, including the adapter credentials), or whose pod was replaced (also during the run that created it) is reported expired, and the host provisions a fresh one (with a fresh harness session). Temporary API errors fail the resume instead, so the task's sandbox is kept for the next attempt.

The host only resumes a sandbox whose lease still matches its current lease fingerprint, which covers the environment config, the plugin version and the versions of the environment's secrets. So a change to the environment config, **every plugin upgrade and every rotation of a secret the environment uses (such as its kubeconfig)** retires all kept sandboxes on their next use: the next run on each task starts in a fresh sandbox with a fresh harness session.

**One sandbox per task.** The host hands a kept sandbox to one run at a time: it resumes only released leases and moves ownership to the new run with a compare-and-swap on the lease row, and it resumes the most recently released lease of a task. The first sandbox of a task is created without such a check, so if two runs of the same task start at the same time with no sandbox yet (the host normally merges wakeups for the same issue and agent into one run), each gets its own. They are never shared; when the second one is released, the plugin removes the older idle one of the same task.

**Idle expiry.** All reuse state lives in labels (`paperclip.io/reuse`, `paperclip.io/reuse-key`, `paperclip.io/execution-workspace-id`, `paperclip.io/issue-id`) and annotations (`paperclip.io/lease-state`, `paperclip.io/last-used-at`, `paperclip.io/idle-ttl-seconds`, `paperclip.io/consecutive-failures`, ...) on the Sandbox CR. The plugin worker sweeps every 5 minutes (and on acquire/release): idle sandboxes past their TTL, sandboxes left busy for longer than max(`podActivityDeadlineSec`, 30 min) + TTL (their run never released them; a running command re-marks its sandbox busy every 5 minutes), and, where reuse is on, the least recently used idle ones over the cap. Deletes carry a `resourceVersion` precondition, so a sandbox a run is resuming at that moment is never removed. The worker sweeps every namespace it serves with reuse on, and, from any call that reaches the cluster (whatever its config), it lists reusable sandboxes cluster-wide at most every 30 minutes and sweeps each namespace that has one. After a restart, or after reuse was turned off, idle sandboxes therefore still expire as soon as the plugin handles any call. If the credential may not list Sandbox CRs cluster-wide, only namespaces it serves are swept. If the plugin handles no call at all, nothing is swept; remove idle sandboxes by hand in that case (see **Operations**).

**Quota.** Idle sandboxes keep their requests and count against the tenant `ResourceQuota`. With the default quota (`pods 20`, `requests 10 CPU / 20Gi`, `limits 20 CPU / 40Gi`) and default reuse resources, at most

```
min(pods, ⌊limits.cpu / 2⌋, ⌊limits.memory / 4Gi⌋, ⌊requests.cpu / 100m⌋, ⌊requests.memory / 256Mi⌋)
  = min(20, 10, 10, 100, 80) = 10
```

sandboxes fit per company namespace; `reuseMaxSandboxes: 8` leaves room for two ordinary sandboxes. Note that the limits bind first under the default quota: regular requests (`250m`/`512Mi`) would also fit 10. The low requests pay off on the nodes (many idle pods schedule on little capacity) and under a quota whose limits were raised. A pod cannot change its requests in place here, so they also apply while a run uses the sandbox: under contention a run gets a smaller CPU share, and under node memory pressure the kubelet evicts a pod earlier the more its usage exceeds its request (an evicted sandbox is replaced by a fresh one on the next run). Set `reuseResources.requests` to the regular values if that matters more than idle density. `paperclip-quota` is only created when missing, so raise it in place (`kubectl edit resourcequota paperclip-quota -n paperclip-<company>`) for more concurrent tasks. `validateConfig` warns when the cap does not fit the default quota.

**Operations.**

```bash
# Reusable sandboxes and their state
kubectl get sandboxes.agents.x-k8s.io -A -l paperclip.io/reuse=true \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,STATE:.metadata.annotations.paperclip\\.io/lease-state,LAST_USED:.metadata.annotations.paperclip\\.io/last-used-at
# Drop one (its next run starts fresh)
kubectl delete sandboxes.agents.x-k8s.io -n paperclip-<company> <name>
# Drop every idle one, e.g. when the plugin will not run for a while
kubectl get sandboxes.agents.x-k8s.io -A -l paperclip.io/reuse=true -o json \
  | jq -r '.items[] | select(.metadata.annotations["paperclip.io/lease-state"] == "idle") | "\(.metadata.namespace) \(.metadata.name)"' \
  | while read -r ns name; do kubectl delete sandboxes.agents.x-k8s.io -n "$ns" "$name"; done
```

**Limitations.** A task-scoped egress grant (`executionWorkspaceSettings.networkEgress`) changed between runs only applies to the next fresh sandbox. A mutable image tag cannot be detected as a change; pin images by digest. A workspace larger than the 8Gi `/workspace` volume gets the pod evicted, which starts a fresh sandbox. The process reset relies on `/proc`, `tr` and `sleep` in the runtime image. The host removes a task's sandbox when the issue reaches a terminal state or its execution workspace is closed; deleting an environment that still has kept sandboxes needs `?destroyReusableSandboxLeases=true`.

## What gets created in your cluster

For each company that runs agents (created lazily on first dispatch):

```
Namespace          paperclip-{companySlug}        (PSS: restricted enforce + audit)
ServiceAccount     paperclip-tenant-sa
Role               paperclip-tenant-role          (only get pods/log)
RoleBinding        paperclip-tenant-rb
ResourceQuota      paperclip-quota                (pods, requests/limits cpu+memory)
LimitRange         paperclip-limits               (container max/min/default/defaultRequest)
NetworkPolicy      paperclip-deny-all             (deny ingress + egress baseline)
NetworkPolicy      paperclip-egress-allow         (DNS + paperclip-server callback + user CIDRs)
                   OR CiliumNetworkPolicy paperclip-egress-fqdn if egressMode=cilium
```

For each agent run (sandbox-cr backend):

```
Sandbox CR         pc-{ulid}                       (agents.x-k8s.io/v1alpha1; explicit delete on release)
Pod                pc-{ulid}-{podSuffix}           (managed by Sandbox controller; torn down on CR delete)
Secret             pc-{ulid}-env                   (owned by Sandbox CR; cascade-deleted)
```

For each agent run (job backend):

```
Job                pc-{ulid}                       (backoffLimit: 0, ttlSecondsAfterFinished from config)
Pod                pc-{ulid}-{podSuffix}           (owned by Job; cascade-deleted)
Secret             pc-{ulid}-env                   (owned by Job; cascade-deleted)
```

## Security baseline

Every agent pod is:

- non-root (`runAsUser: 1000`, `runAsGroup: 1000`, `runAsNonRoot: true`)
- drops ALL Linux capabilities, `allowPrivilegeEscalation: false`
- `readOnlyRootFilesystem: true` with explicit `emptyDir` mounts for `/workspace`, `/home/paperclip`, `/home/paperclip/.cache`, `/tmp`
- `seccompProfile: RuntimeDefault`
- Tini as PID 1 (reaps zombies, forwards signals)
- `fsGroupChangePolicy: OnRootMismatch` (fast PVC startup; openclaw-operator lesson)
- `automountServiceAccountToken: true` (for the agent shim's paperclip-server callback)

Plus per-namespace `pod-security.kubernetes.io/enforce: restricted` and a deny-all NetworkPolicy baseline with explicit egress allow-list (DNS, paperclip-server, configured FQDNs/CIDRs).

The per-run Secret carrying the bootstrap token and adapter API keys has `ownerReferences` pointing at the owning Job, so a single `kubectl delete job …` cascades cleanly to the Pod and Secret.

## Optional Kata-FC microVM isolation

For stronger isolation, install [Kata Containers](https://github.com/kata-containers/kata-containers) with the Firecracker hypervisor, then set `runtimeClassName: kata-fc` in the plugin config. Each agent pod will run inside a Firecracker microVM. Requires nested-virt-capable nodes (bare-metal or specific cloud instance types).

## Roadmap

- **Phase A (done):** `sandbox-cr` backend — multi-command exec via agent-sandbox Sandbox CRD.
- **Phase B:** Warm pool support — pre-provisioned Sandbox CRs for sub-second cold starts. The `SandboxOrchestrator` interface reserves optional `pause?`/`resume?` extension slots.
- **Phase C:** Kata-FC + snapshots — `runtimeClassName: kata-fc` with VM snapshot for fast restore.
- **Phase D:** Contribute back to agent-sandbox upstream if their Beta model diverges from our needs. The `SandboxOrchestrator` interface (`src/sandbox-orchestrator.ts`) is the clean swap point — a new implementation can be added without touching `plugin.ts` business logic.

## Lessons learned (from openclaw-operator)

This plugin adopts patterns from `openclaw-rocks/openclaw-operator`:

- Tini PID 1 (issue #471 — zombie helper processes)
- Read-only rootFS with explicit writable mounts (issue #456 — ~/.config not writable)
- Strategic merge on reconcile (issue #446 — preserve third-party annotations)
- Multi-storage-class testing (issue #448 — `local-path-provisioner` differences)
- Image version compat matrix (issue #462 — runtime deps cannot resolve after upgrade)

## Development

```bash
cd packages/plugins/sandbox-providers/kubernetes
pnpm install --ignore-workspace
pnpm test           # unit tests only (fast)
pnpm typecheck
pnpm build
```

To run the kind-cluster integration test (requires `kubectl --context kind-paperclip` and a pre-loaded alpine image; see `test/integration/end-to-end-run.test.ts`):

```bash
RUN_K8S_INTEGRATION_TESTS=1 pnpm test test/integration/end-to-end-run.test.ts
RUN_K8S_INTEGRATION_TESTS=1 pnpm test test/integration/reusable-sandbox.test.ts
```
