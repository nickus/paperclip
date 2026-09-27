/**
 * Reusable sandbox lifecycle against a local kind cluster with the
 * agent-sandbox controller installed (same prerequisites as
 * end-to-end-run.test.ts). Run with RUN_K8S_INTEGRATION_TESTS=1.
 *
 * acquire -> leave a background process and files behind -> release (the
 * process is stopped, the pod stays) -> resume (same sandbox, files still
 * there) -> destroy (everything gone).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin from "../../src/plugin.js";
import { createKubeConfig, makeKubeClients } from "../../src/kube-client.js";
import { execInPod } from "../../src/pod-exec.js";
import { sandboxCrOrchestrator } from "../../src/sandbox-cr-orchestrator.js";
import { deleteNamespaceIfExists, kubectl, readKindKubeconfig } from "./_kind-harness.js";

const NAMESPACE = "paperclip-reuse-e2e";
const COMPANY_ID = "33333333-3333-3333-3333-333333333333";
const RUN = process.env.RUN_K8S_INTEGRATION_TESTS === "1";

describe("plugin-kubernetes reusable sandbox", () => {
  beforeAll(() => {
    if (RUN) deleteNamespaceIfExists(NAMESPACE);
  });

  afterAll(() => {
    if (RUN) deleteNamespaceIfExists(NAMESPACE);
  });

  it.runIf(RUN)(
    "keeps the pod and its files across release/resume and stops the run's processes",
    async () => {
      const kubeconfig = readKindKubeconfig();
      const config = {
        inCluster: false,
        kubeconfig,
        companySlug: "reuse-e2e",
        adapterType: "claude_local",
        backend: "sandbox-cr",
        podActivityDeadlineSec: 120,
        reuseLease: true,
      };
      const base = { driverKey: "kubernetes", config, companyId: COMPANY_ID, environmentId: "env-reuse" };
      const kc = createKubeConfig({ inCluster: false, kubeconfig });
      const clients = makeKubeClients(kc);
      const exec = (podName: string, script: string) =>
        execInPod(kc, NAMESPACE, podName, "agent", ["/bin/sh", "-c", script]);

      const lease = await plugin.definition.onEnvironmentAcquireLease!({
        ...base,
        runId: "44444444-4444-4444-4444-444444444444",
        agentId: "55555555-5555-5555-5555-555555555555",
        executionWorkspaceId: "66666666-6666-6666-6666-666666666666",
      });
      expect(lease.metadata?.remoteCwd).toBe("/workspace");
      await sandboxCrOrchestrator.waitForCompletion(clients, NAMESPACE, lease.providerLeaseId!, {
        timeoutMs: 90_000,
        pollMs: 3000,
      });
      const podName = (await sandboxCrOrchestrator.findPod(clients, NAMESPACE, lease.providerLeaseId!))!;

      // What a run leaves behind: session files, scratch files, a background process.
      const setup = await exec(
        podName,
        "mkdir -p /workspace/.paperclip-runtime/claude && echo session > /workspace/.paperclip-runtime/claude/marker && " +
          "echo scratch > /tmp/marker && (nohup sleep 600 >/dev/null 2>&1 &) && echo started",
      );
      expect(setup.stdout).toContain("started");

      const receipt = await plugin.definition.onEnvironmentReleaseLease!({
        ...base,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      });
      expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
      expect(kubectl(`get sandboxes.agents.x-k8s.io -n ${NAMESPACE} -o name`)).toContain(lease.providerLeaseId!);
      const leftovers = await exec(podName, "for d in /proc/[0-9]*; do tr '\\000' ' ' < $d/cmdline 2>/dev/null; echo; done");
      expect(leftovers.stdout).not.toContain("sleep 600");

      const resumed = await plugin.definition.onEnvironmentResumeLease!({
        ...base,
        providerLeaseId: lease.providerLeaseId!,
        leaseMetadata: lease.metadata,
      });
      expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
      expect(resumed.metadata?.remoteCwd).toBe("/workspace");
      const files = await exec(podName, "cat /workspace/.paperclip-runtime/claude/marker /tmp/marker");
      expect(files.stdout.split("\n").filter(Boolean)).toEqual(["session", "scratch"]);

      await plugin.definition.onEnvironmentDestroyLease!({
        ...base,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: resumed.metadata,
      });
      expect(kubectl(`get sandboxes.agents.x-k8s.io -n ${NAMESPACE} -o name 2>&1 || true`)).not.toContain(
        lease.providerLeaseId!,
      );
    },
    300_000,
  );
});
