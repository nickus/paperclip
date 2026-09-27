import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";

// Count real kubeconfig parses/client builds while keeping the real behavior.
const h = vi.hoisted(() => ({ creates: 0, makes: 0 }));
vi.mock("../../src/kube-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/kube-client.js")>();
  return {
    ...actual,
    createKubeConfig: vi.fn((input: Parameters<typeof actual.createKubeConfig>[0]) => {
      h.creates += 1;
      return actual.createKubeConfig(input);
    }),
    makeKubeClients: vi.fn((kc: KubeConfig) => {
      h.makes += 1;
      return actual.makeKubeClients(kc);
    }),
  };
});

import {
  evictKubeConnection,
  evictKubeConnectionOnAuthError,
  getKubeConnection,
  isKubeAuthError,
  kubeConnectionCacheSize,
  KUBE_CLIENT_CACHE_TTL_MS,
  resetKubeConnectionCache,
  withKubeAuthEviction,
} from "../../src/kube-client-cache.js";

function kubeconfigYaml(token: string): string {
  return `apiVersion: v1
kind: Config
clusters:
  - name: test
    cluster:
      server: https://fake.example.com
contexts:
  - name: test
    context:
      cluster: test
      user: test
current-context: test
users:
  - name: test
    user:
      token: ${token}
`;
}

let clock = 0;
beforeEach(() => {
  h.creates = 0;
  h.makes = 0;
  clock = 1_000_000;
  resetKubeConnectionCache({ now: () => clock });
});
afterEach(() => {
  resetKubeConnectionCache();
});

describe("getKubeConnection", () => {
  it("parses the kubeconfig once for many RPCs (before: 1 parse per call)", () => {
    const config = { inCluster: false, kubeconfig: kubeconfigYaml("tok-a") };
    const first = getKubeConnection(config);
    for (let i = 0; i < 99; i += 1) {
      const again = getKubeConnection({ ...config }); // fresh object, same content
      expect(again.clients).toBe(first.clients);
      expect(again.kc).toBe(first.kc);
    }
    // 100 calls → 1 parse / 1 client build (previously 100 of each).
    expect(h.creates).toBe(1);
    expect(h.makes).toBe(1);
    expect(first.kc.getCurrentUser()?.token).toBe("tok-a");
  });

  it("builds a new client when the kubeconfig text changes (rotation)", () => {
    const a = getKubeConnection({ kubeconfig: kubeconfigYaml("tok-a") });
    const b = getKubeConnection({ kubeconfig: kubeconfigYaml("tok-b") });
    expect(b.clients).not.toBe(a.clients);
    expect(b.kc.getCurrentUser()?.token).toBe("tok-b");
    expect(h.creates).toBe(2);
  });

  it("expires entries after the TTL", () => {
    const config = { kubeconfig: kubeconfigYaml("tok-a") };
    const a = getKubeConnection(config);
    clock += KUBE_CLIENT_CACHE_TTL_MS - 1;
    expect(getKubeConnection(config).clients).toBe(a.clients);
    clock += 2;
    expect(getKubeConnection(config).clients).not.toBe(a.clients);
    expect(h.creates).toBe(2);
  });

  it("never caches an invalid config", () => {
    expect(() => getKubeConnection({ inCluster: false })).toThrow(/requires/i);
    expect(kubeConnectionCacheSize()).toBe(0);
  });

  it("stays bounded", () => {
    for (let i = 0; i < 40; i += 1) getKubeConnection({ kubeconfig: kubeconfigYaml(`tok-${i}`) });
    expect(kubeConnectionCacheSize()).toBeLessThanOrEqual(16);
  });

  it("evicts explicitly", () => {
    const config = { kubeconfig: kubeconfigYaml("tok-a") };
    const a = getKubeConnection(config);
    evictKubeConnection(config);
    expect(getKubeConnection(config).clients).not.toBe(a.clients);
  });
});

describe("auth-error eviction", () => {
  it("recognizes 401/403 API and WebSocket errors only", () => {
    expect(isKubeAuthError(Object.assign(new Error("HTTP-Code: 401"), { code: 401 }))).toBe(true);
    expect(isKubeAuthError({ statusCode: 403 })).toBe(true);
    expect(isKubeAuthError(new Error("Unexpected server response: 401"))).toBe(true);
    // A re-wrapped ApiException keeps its "HTTP-Code: 403" text but loses `.code`.
    expect(isKubeAuthError(new Error("create job failed: HTTP-Code: 403\nMessage: Forbidden"))).toBe(true);
    expect(isKubeAuthError(Object.assign(new Error("not found"), { code: 404 }))).toBe(false);
    expect(isKubeAuthError(new Error("socket hang up"))).toBe(false);
    expect(isKubeAuthError(null)).toBe(false);
  });

  it("recognizes a rejected exec upgrade delivered as a ws ErrorEvent", () => {
    // ws hands the exec's onerror an ErrorEvent: NOT an Error instance, with
    // `message` and the underlying `error` (ws abortHandshake text).
    const upgradeRejected = {
      type: "error",
      message: "Unexpected server response: 401",
      error: new Error("Unexpected server response: 401"),
    };
    expect(upgradeRejected instanceof Error).toBe(false);
    expect(isKubeAuthError(upgradeRejected)).toBe(true);
    expect(isKubeAuthError({ type: "error", message: "", error: new Error("Unexpected server response: 403") })).toBe(true);
    expect(isKubeAuthError(new Error("wrapped", { cause: Object.assign(new Error("x"), { code: 401 }) }))).toBe(true);
  });

  it("does not treat incidental 401/403/forbidden text as a credential rejection", () => {
    // execInPod's watchdog message embeds the pod name and cmd0 verbatim.
    expect(isKubeAuthError(new Error(
      "execInPod timed out after 30000ms (pod=pc-01j9x-403, container=agent, cmd0=forbidden). The WebSocket likely dropped before the command produced a status frame.",
    ))).toBe(false);
    expect(isKubeAuthError(new Error("Unauthorized"))).toBe(false);
    expect(isKubeAuthError(new Error("exit 401"))).toBe(false);
    expect(isKubeAuthError("forbidden")).toBe(false);
  });

  it("evicts on 401 but keeps the client on other errors", async () => {
    const config = { kubeconfig: kubeconfigYaml("tok-a") };
    const a = getKubeConnection(config);

    evictKubeConnectionOnAuthError(config, new Error("socket hang up"));
    expect(getKubeConnection(config).clients).toBe(a.clients);

    await expect(
      withKubeAuthEviction(config, async () => {
        throw Object.assign(new Error("Unauthorized"), { code: 401 });
      }),
    ).rejects.toThrow("Unauthorized");
    const b = getKubeConnection(config);
    expect(b.clients).not.toBe(a.clients);
    expect(h.creates).toBe(2);
  });
});
