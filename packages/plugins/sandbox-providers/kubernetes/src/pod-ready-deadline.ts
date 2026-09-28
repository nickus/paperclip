/**
 * Shared helpers for bounding how long this plugin waits for a Kubernetes pod
 * to become Ready (or, for the Job backend, to finish) independently of the
 * caller's overall run budget, and for explaining a readiness timeout with
 * the pod's own recent Kubernetes events.
 *
 * A pod that can never schedule (no capacity, a bad node selector, quota
 * exhaustion) or never pulls its image (a typo'd tag, a registry outage,
 * ErrImagePull/ImagePullBackOff) will sit in `Pending` for as long as the
 * caller lets it. Before this module existed, that meant the FULL run
 * budget — often `podActivityDeadlineSec` (default one hour) — was spent
 * polling a pod that was never going to come up, so a stuck lease looked
 * exactly like a slow-but-working one until the entire budget was gone.
 * Bounding the wait separately turns that into a fast, diagnosable failure.
 */

import type { KubeClients } from "./kube-client.js";
import type { KubernetesProviderConfig } from "./types.js";

/**
 * Default cap (seconds) on a single pod-readiness wait when the provider
 * config does not set `podReadyTimeoutSec`. Ten minutes comfortably covers
 * node autoscaling and a cold image pull on a healthy cluster; a pod that
 * is not Ready by then is far more likely stuck than merely slow.
 */
export const DEFAULT_POD_READY_TIMEOUT_SEC = 600;

/**
 * Resolve the deadline (ms) for a single "wait for pod ready" poll: the
 * lesser of the caller's own run budget and the configured (or default)
 * pod-ready cap. Never waits longer than the run budget even when
 * `podReadyTimeoutSec` is configured larger than it — a readiness wait can
 * never outlive the run it is gating.
 */
export function resolvePodReadyTimeoutMs(
  config: Pick<KubernetesProviderConfig, "podReadyTimeoutSec">,
  runBudgetMs: number,
): number {
  const cappedRunBudgetMs = Math.max(0, runBudgetMs);
  const configuredSec = config.podReadyTimeoutSec ?? DEFAULT_POD_READY_TIMEOUT_SEC;
  const configuredMs = Math.max(0, configuredSec) * 1000;
  return Math.min(cappedRunBudgetMs, configuredMs);
}

const MAX_SUMMARIZED_EVENTS = 5;
const MAX_EVENT_MESSAGE_CHARS = 160;

export interface PodEventSummary {
  /**
   * Compact, single-line rendering safe to append to stderr, e.g.
   * `FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu.; ImagePullBackOff: Back-off pulling image "..."`.
   * Empty when no events were found (or the lookup itself failed).
   */
  summary: string;
  /** The (reason, message) pairs behind `summary`, oldest first. */
  events: Array<{ reason: string; message: string }>;
}

const EMPTY_POD_EVENT_SUMMARY: PodEventSummary = { summary: "", events: [] };

/**
 * Fetch the most recent Kubernetes events involving `podName` (FailedScheduling,
 * ImagePullBackOff, ErrImagePull, FailedCreatePodSandBox, FailedMount, and any
 * other reason the API server recorded) and render them as a compact summary
 * for a readiness-timeout error.
 *
 * Best-effort and never throws: a cluster that can't be reached for events
 * (RBAC, transient API error) must not mask the underlying timeout, so a
 * lookup failure degrades to an empty summary instead of propagating.
 */
export async function summarizeRecentPodEvents(
  clients: Pick<KubeClients, "core">,
  namespace: string,
  podName: string | null,
): Promise<PodEventSummary> {
  if (!podName) return EMPTY_POD_EVENT_SUMMARY;
  try {
    const result = await clients.core.listNamespacedEvent({
      namespace,
      fieldSelector: `involvedObject.name=${podName}`,
    });
    const items =
      ((result as unknown as { items?: Array<Record<string, unknown>> }).items) ?? [];
    const events = items
      .map((item) => ({
        reason: typeof item.reason === "string" ? item.reason : "",
        message: typeof item.message === "string" ? item.message : "",
        // Prefer lastTimestamp (most recent occurrence of a repeated event),
        // then the newer `eventTime` (events.k8s.io style), then firstTimestamp.
        sortKey: String(item.lastTimestamp ?? item.eventTime ?? item.firstTimestamp ?? ""),
      }))
      .filter((event) => event.reason.length > 0)
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .slice(-MAX_SUMMARIZED_EVENTS)
      .map(({ reason, message }) => ({
        reason,
        message:
          message.length > MAX_EVENT_MESSAGE_CHARS
            ? `${message.slice(0, MAX_EVENT_MESSAGE_CHARS)}...`
            : message,
      }));
    if (events.length === 0) return EMPTY_POD_EVENT_SUMMARY;
    return {
      summary: events.map((event) => `${event.reason}: ${event.message}`).join("; "),
      events,
    };
  } catch {
    return EMPTY_POD_EVENT_SUMMARY;
  }
}
