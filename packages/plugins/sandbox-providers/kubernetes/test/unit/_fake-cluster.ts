import { vi } from "vitest";

/**
 * A small in-memory stand-in for the Kubernetes API surface the reusable-lease
 * paths use: Sandbox CRs (with a pretend controller that creates the backing
 * pod), pods, Secrets and NetworkPolicies. Objects are keyed by name; every
 * write bumps a cluster-wide resourceVersion like the real API server.
 */

type Obj = Record<string, any>;

export function notFound(): Error {
  return Object.assign(new Error("HTTP-Code: 404 Message: not found"), { code: 404 });
}

function conflict(): Error {
  return Object.assign(new Error("HTTP-Code: 409 Message: precondition failed"), { code: 409 });
}

function patchTestFailed(): Error {
  return Object.assign(new Error("HTTP-Code: 422 Message: the server rejected our request: test operation failed"), { code: 422 });
}

function unescapePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function matchesSelector(labels: Record<string, string> | undefined, selector: string | undefined): boolean {
  if (!selector) return true;
  return selector.split(",").every((term) => {
    const [key, value] = term.split("=");
    return (labels ?? {})[key!] === value;
  });
}

export function createFakeCluster() {
  let version = 100;
  let podCounter = 0;
  const sandboxes = new Map<string, Obj>();
  const pods = new Map<string, Obj>();
  const secrets = new Map<string, Obj>();
  const networkPolicies = new Map<string, Obj>();
  const nextVersion = () => String(++version);

  function startPod(sandboxName: string): Obj {
    podCounter += 1;
    const pod: Obj = {
      metadata: {
        name: sandboxName,
        uid: `pod-uid-${podCounter}`,
        creationTimestamp: new Date().toISOString(),
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [{ name: "agent", ready: true, state: { running: {} } }],
      },
    };
    pods.set(sandboxName, pod);
    return pod;
  }

  const custom = {
    createNamespacedCustomObject: vi.fn(async (req: { plural: string; namespace?: string; body: Obj }) => {
      const body = structuredClone(req.body);
      body.metadata = {
        ...body.metadata,
        namespace: body.metadata.namespace ?? req.namespace,
        uid: `cr-uid-${body.metadata.name}`,
        resourceVersion: nextVersion(),
        creationTimestamp: new Date().toISOString(),
      };
      if (req.plural === "sandboxes") {
        body.status = { podName: body.metadata.name, conditions: [{ type: "Ready", status: "True" }] };
        sandboxes.set(body.metadata.name, body);
        startPod(body.metadata.name);
      } else {
        networkPolicies.set(body.metadata.name, body);
      }
      return structuredClone(body);
    }),
    getNamespacedCustomObject: vi.fn(async (req: { plural: string; name: string }) => {
      const cr = req.plural === "sandboxes" ? sandboxes.get(req.name) : networkPolicies.get(req.name);
      if (!cr) throw notFound();
      return structuredClone(cr);
    }),
    listNamespacedCustomObject: vi.fn(async (req: { plural: string; labelSelector?: string }) => ({
      items: req.plural === "sandboxes"
        ? [...sandboxes.values()].filter((cr) => matchesSelector(cr.metadata.labels, req.labelSelector)).map((cr) => structuredClone(cr))
        : [],
    })),
    listClusterCustomObject: vi.fn(async (req: { plural: string; labelSelector?: string }) => ({
      items: req.plural === "sandboxes"
        ? [...sandboxes.values()].filter((cr) => matchesSelector(cr.metadata.labels, req.labelSelector)).map((cr) => structuredClone(cr))
        : [],
    })),
    patchNamespacedCustomObject: vi.fn(async (req: { name: string; body: Array<{ op: string; path: string; value: string }> }) => {
      const cr = sandboxes.get(req.name);
      if (!cr) throw notFound();
      // JSON Patch is atomic: check every `test` op before applying anything.
      const annotationPrefix = "/metadata/annotations/";
      for (const op of req.body) {
        if (op.op !== "test") continue;
        const actual = op.path === "/metadata/resourceVersion"
          ? cr.metadata.resourceVersion
          : op.path.startsWith(annotationPrefix)
            ? cr.metadata.annotations?.[unescapePointer(op.path.slice(annotationPrefix.length))]
            : (() => { throw new Error(`unsupported test path ${op.path}`); })();
        if (actual !== op.value) throw patchTestFailed();
      }
      for (const op of req.body) {
        if (op.op === "test") continue;
        if (op.op !== "add" || !op.path.startsWith(annotationPrefix)) throw new Error(`unsupported patch ${op.op} ${op.path}`);
        const key = unescapePointer(op.path.slice(annotationPrefix.length));
        if (!cr.metadata.annotations) throw new Error("add to a missing annotations map");
        cr.metadata.annotations[key] = op.value;
      }
      cr.metadata.resourceVersion = nextVersion();
      return structuredClone(cr);
    }),
    deleteNamespacedCustomObject: vi.fn(async (req: { plural: string; name: string; body?: { preconditions?: { resourceVersion?: string } } }) => {
      if (req.plural !== "sandboxes") {
        if (!networkPolicies.delete(req.name)) throw notFound();
        return {};
      }
      const cr = sandboxes.get(req.name);
      if (!cr) throw notFound();
      const expected = req.body?.preconditions?.resourceVersion;
      if (expected && expected !== cr.metadata.resourceVersion) throw conflict();
      sandboxes.delete(req.name);
      pods.delete(req.name); // the controller removes the pod with its CR
      secrets.delete(`${req.name}-env`); // owner-reference garbage collection
      return {};
    }),
  };

  const core = {
    readNamespacedPod: vi.fn(async (req: { name: string }) => {
      const pod = pods.get(req.name);
      if (!pod) throw notFound();
      return structuredClone(pod);
    }),
    deleteNamespacedPod: vi.fn(async (req: { name: string }) => {
      if (!pods.delete(req.name)) throw notFound();
      return {};
    }),
    listNamespacedPod: vi.fn(async () => ({ items: [] })),
    createNamespacedSecret: vi.fn(async (req: { body: Obj }) => {
      secrets.set(req.body.metadata.name, structuredClone(req.body));
      return req.body;
    }),
    deleteNamespacedSecret: vi.fn(async (req: { name: string }) => {
      if (!secrets.delete(req.name)) throw notFound();
      return {};
    }),
  };

  const networking = {
    createNamespacedNetworkPolicy: vi.fn(async (req: { body: Obj }) => {
      networkPolicies.set(req.body.metadata.name, structuredClone(req.body));
      return req.body;
    }),
    deleteNamespacedNetworkPolicy: vi.fn(async (req: { name: string }) => {
      if (!networkPolicies.delete(req.name)) throw notFound();
      return {};
    }),
  };

  return {
    clients: { custom, core, networking, batch: {}, rbac: {} },
    sandboxes,
    pods,
    secrets,
    networkPolicies,
    /** Simulate the controller replacing a sandbox's pod (eviction, node loss). */
    replacePod(name: string) {
      pods.delete(name);
      return startPod(name);
    },
  };
}

export type FakeCluster = ReturnType<typeof createFakeCluster>;
