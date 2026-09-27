import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  environments,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.ts";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { secretService } from "../services/secrets.ts";
import {
  createRuntimeSecretValueCache,
  environmentRuntimeSecretCache,
  isCredentialRejectionError,
  RUNTIME_SECRET_CACHE_TTL_MS,
} from "../services/runtime-secret-value-cache.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// Regression for repeated audited system reads of the kubeconfig secret
// while sandboxed agents run: every plugin sandbox RPC re-resolved the
// provider config, and each resolution did a full audited secret read (an
// INSERT into secret_access_events). These tests count those rows.

describe("runtime secret value cache (unit)", () => {
  const key = {
    companyId: "c",
    consumerId: "env-1",
    configPath: "kubeconfig",
    secretId: "s",
    version: "latest" as const,
  };

  it("serves a hit only for the same fingerprint and within the TTL", () => {
    let clock = 0;
    const cache = createRuntimeSecretValueCache({ now: () => clock });
    cache.set(key, "fp-1", "value-1");
    expect(cache.get(key, "fp-1")).toBe("value-1");
    expect(cache.get(key, "fp-2")).toBeNull(); // rotated/binding changed → miss
    cache.set(key, "fp-1", "value-1");
    clock += RUNTIME_SECRET_CACHE_TTL_MS;
    expect(cache.get(key, "fp-1")).toBeNull(); // TTL elapsed → miss
  });

  it("keys by run context and consumer, and invalidates per consumer / secret", () => {
    const cache = createRuntimeSecretValueCache();
    cache.set(key, "fp", "v");
    expect(cache.get({ ...key, heartbeatRunId: "run-1" }, "fp")).toBeNull();
    expect(cache.get({ ...key, consumerId: "env-2" }, "fp")).toBeNull();
    cache.set({ ...key, consumerId: "env-2" }, "fp", "v2");
    cache.invalidateConsumer("env-1");
    expect(cache.get(key, "fp")).toBeNull();
    expect(cache.get({ ...key, consumerId: "env-2" }, "fp")).toBe("v2");
    cache.invalidateSecret("s");
    expect(cache.size()).toBe(0);
  });

  it("is bounded", () => {
    const cache = createRuntimeSecretValueCache({ maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) cache.set({ ...key, secretId: `s-${i}` }, "fp", "v");
    expect(cache.size()).toBe(3);
  });

  it("classifies credential rejections", () => {
    expect(isCredentialRejectionError(new Error("HTTP-Code: 401 Message: Unauthorized"))).toBe(true);
    expect(isCredentialRejectionError(Object.assign(new Error("x"), { statusCode: 403 }))).toBe(true);
    expect(isCredentialRejectionError(new Error("Forbidden"))).toBe(true);
    expect(isCredentialRejectionError(new Error("socket hang up"))).toBe(false);
    expect(isCredentialRejectionError(Object.assign(new Error("gone"), { status: 404 }))).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runtime secret cache tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("runtime secret resolution for plugin sandbox leases", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  const PLUGIN_KEY = "paperclip.kubecache-test-sandbox-provider";
  const PROVIDER = "kubecache-test";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime-secret-cache");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.useRealTimers();
    environmentRuntimeSecretCache.clear();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  // A plugin sandbox provider whose `kubeconfig` field is a secret ref, an
  // environment bound to a kubeconfig secret — the common shape.
  async function seed(kubeconfigValue = "kubeconfig-v1") {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: PLUGIN_KEY,
      packageName: "@paperclipai/plugin-kubecache-test",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: PLUGIN_KEY,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Kubecache Test Provider",
        description: "Test provider with a kubeconfig secret-ref field",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: PROVIDER,
            kind: "sandbox_provider",
            displayName: "Kubecache Test",
            configSchema: {
              type: "object",
              properties: { kubeconfig: { type: "string", format: "secret-ref" } },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const secret = await secretService(db).create(companyId, {
      name: `kubeconfig-${randomUUID()}`,
      provider: "local_encrypted",
      value: kubeconfigValue,
    });
    await secretService(db).createBinding({
      companyId,
      secretId: secret.id,
      targetType: "environment",
      targetId: environmentId,
      configPath: "kubeconfig",
    });
    const config = { provider: PROVIDER, kubeconfig: secret.id, reuseLease: false };
    await db.insert(environments).values({
      id: environmentId,
      name: `kubecache-${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const environment = await db
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))
      .then((rows) => rows[0]!);
    return { companyId, environment, secretId: secret.id, pluginId, config };
  }

  async function countAccessEvents(secretId: string) {
    const rows = await db
      .select({ id: secretAccessEvents.id })
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secretId));
    return rows.length;
  }

  async function resolveKubeconfig(input: { companyId: string; environment: { id: string; config: unknown } }) {
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, {
      id: input.environment.id,
      driver: "sandbox",
      config: input.environment.config as Record<string, unknown>,
    });
    return (parsed.config as Record<string, unknown>).kubeconfig;
  }

  it("does one audited secret read for 50 runtime resolutions (before: 50)", async () => {
    const seeded = await seed();
    for (let i = 0; i < 50; i += 1) {
      expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v1");
    }
    expect(await countAccessEvents(seeded.secretId)).toBe(1);
  });

  it("picks up a rotation on the very next call", async () => {
    const seeded = await seed();
    expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v1");
    expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v1");
    await secretService(db).rotate(seeded.secretId, { value: "kubeconfig-v2" });
    expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v2");
    expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v2");
    expect(await countAccessEvents(seeded.secretId)).toBe(2); // one per version
  });

  it("stops serving the value as soon as the binding is removed", async () => {
    const seeded = await seed();
    expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v1");
    await db
      .delete(companySecretBindings)
      .where(and(
        eq(companySecretBindings.secretId, seeded.secretId),
        eq(companySecretBindings.targetId, seeded.environment.id),
      ));
    await expect(resolveKubeconfig(seeded)).rejects.toThrow(/not bound/);
  });

  it("stops serving the value as soon as the secret is disabled", async () => {
    const seeded = await seed();
    expect(await resolveKubeconfig(seeded)).toBe("kubeconfig-v1");
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, seeded.secretId));
    await expect(resolveKubeconfig(seeded)).rejects.toThrow(/not active/);
  });

  it("re-resolves (and re-audits) after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const seeded = await seed();
    await resolveKubeconfig(seeded);
    await resolveKubeconfig(seeded);
    expect(await countAccessEvents(seeded.secretId)).toBe(1);
    vi.setSystemTime(Date.now() + RUNTIME_SECRET_CACHE_TTL_MS + 1);
    await resolveKubeconfig(seeded);
    expect(await countAccessEvents(seeded.secretId)).toBe(2);
  });

  it("shares one entry between null and absent run context (the hot path)", async () => {
    const seeded = await seed();
    const env = { id: seeded.environment.id, driver: "sandbox" as const, config: seeded.config };
    // Execute/sync/capability calls resolve with no run context; explicit nulls
    // must hit the same entry (distinct run ids are keyed apart, see unit test).
    await resolveEnvironmentDriverConfigForRuntime(db, seeded.companyId, env, { heartbeatRunId: null, issueId: null });
    await resolveEnvironmentDriverConfigForRuntime(db, seeded.companyId, env);
    await resolveEnvironmentDriverConfigForRuntime(db, seeded.companyId, env);
    expect(await countAccessEvents(seeded.secretId)).toBe(1);
  });

  describe("through the sandbox runtime execute path", () => {
    function makeLease(seeded: Awaited<ReturnType<typeof seed>>) {
      // Plugin sandbox leases record the provider config (with the secret REF)
      // in their metadata; execute re-resolves it on every call.
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        environmentId: seeded.environment.id,
        issueId: null,
        heartbeatRunId: null,
        providerLeaseId: "pc-lease-1",
        leasePolicy: "ephemeral",
        status: "active",
        expiresAt: null,
        metadata: {
          ...seeded.config,
          sandboxProviderPlugin: true,
          pluginId: seeded.pluginId,
          pluginKey: PLUGIN_KEY,
          remoteCwd: "/workspace",
        },
      } as any;
    }

    it("sends the resolved kubeconfig on every execute but reads the secret once", async () => {
      const seeded = await seed();
      const seenKubeconfigs: unknown[] = [];
      const workerManager = {
        isRunning: vi.fn(() => true),
        getWorker: vi.fn(() => ({ supportedMethods: ["environmentExecute"] })),
        call: vi.fn(async (_pluginId: string, method: string, params: any) => {
          if (method !== "environmentExecute") throw new Error(`Unexpected plugin method: ${method}`);
          seenKubeconfigs.push(params.config.kubeconfig);
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        }),
      } as unknown as PluginWorkerManager;
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
      const lease = makeLease(seeded);

      for (let i = 0; i < 50; i += 1) {
        await runtime.execute({
          environment: seeded.environment as any,
          lease,
          command: "true",
          args: [],
          cwd: "/workspace",
          env: {},
          timeoutMs: 1000,
        });
      }
      expect(seenKubeconfigs).toHaveLength(50);
      expect(new Set(seenKubeconfigs)).toEqual(new Set(["kubeconfig-v1"]));
      // Before the fix: 50 audited secret reads (one per execute). After: 1.
      expect(await countAccessEvents(seeded.secretId)).toBe(1);
    });

    it("evicts the environment's cached secrets when the provider rejects the credential", async () => {
      const seeded = await seed();
      let rejectNext = false;
      const workerManager = {
        isRunning: vi.fn(() => true),
        getWorker: vi.fn(() => ({ supportedMethods: ["environmentExecute"] })),
        call: vi.fn(async () => {
          if (rejectNext) {
            rejectNext = false;
            throw new Error("HTTP-Code: 401 Message: Unauthorized");
          }
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        }),
      } as unknown as PluginWorkerManager;
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
      const lease = makeLease(seeded);
      const exec = () =>
        runtime.execute({
          environment: seeded.environment as any,
          lease,
          command: "true",
          args: [],
          cwd: "/workspace",
          env: {},
          timeoutMs: 1000,
        });

      await exec();
      await exec();
      expect(await countAccessEvents(seeded.secretId)).toBe(1);
      rejectNext = true;
      await expect(exec()).rejects.toThrow(/401/);
      await exec(); // cache was evicted → full re-resolution
      expect(await countAccessEvents(seeded.secretId)).toBe(2);
    });
  });
});
