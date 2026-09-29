import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  environmentLeases,
  environments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

// Record every call into the SSH helpers (commands, workspace preparation,
// directory sync). Settling an SSH lease must not reach the remote host.
const sshHelperCalls = vi.hoisted(() => [] as string[]);
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            sshHelperCalls.push(name);
            return (value as (...callArgs: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
});

import { logger } from "../middleware/logger.ts";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SSH pending_cleanup sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const SSH_CONFIG = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

describeEmbeddedPostgres("heartbeat sweepPendingCleanupLeases with SSH leases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-pending-cleanup-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    sshHelperCalls.length = 0;
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSshEnvironment() {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "Remote SSH",
      driver: "ssh",
      status: "active",
      config: SSH_CONFIG,
    });
    return { companyId, environmentId };
  }

  // The row shape the SSH driver writes on acquire, parked in pending_cleanup
  // the way the orphaned-active-lease recovery leaves it.
  async function insertPendingCleanupSshLease(input: {
    companyId: string;
    environmentId: string | null;
    leasePolicy: "ephemeral" | "reuse_by_environment";
    provider?: string;
    providerLeaseId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      status: "pending_cleanup",
      leasePolicy: input.leasePolicy,
      provider: input.provider ?? "ssh",
      providerLeaseId:
        input.providerLeaseId ??
        `ssh://${SSH_CONFIG.username}@${SSH_CONFIG.host}:${SSH_CONFIG.port}${SSH_CONFIG.remoteWorkspacePath}`,
      cleanupStatus: "failed",
      failureReason: "orphaned_active_lease_recovered",
      metadata: {
        driver: "ssh",
        host: SSH_CONFIG.host,
        port: SSH_CONFIG.port,
        username: SSH_CONFIG.username,
        remoteWorkspacePath: SSH_CONFIG.remoteWorkspacePath,
        remoteCwd: SSH_CONFIG.remoteWorkspacePath,
      },
      acquiredAt: stale,
      lastUsedAt: stale,
      releasedAt: stale,
      createdAt: stale,
      updatedAt: stale,
    });
    return id;
  }

  async function leaseRow(leaseId: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
  }

  it.each([
    { leasePolicy: "ephemeral", environmentDeleted: false },
    { leasePolicy: "ephemeral", environmentDeleted: true },
    { leasePolicy: "reuse_by_environment", environmentDeleted: false },
  ] as const)(
    "releases a pending_cleanup SSH lease without a remote command ($leasePolicy, environment deleted: $environmentDeleted)",
    async ({ leasePolicy, environmentDeleted }) => {
      const { companyId, environmentId } = await seedSshEnvironment();
      const leaseId = await insertPendingCleanupSshLease({ companyId, environmentId, leasePolicy });
      if (environmentDeleted) {
        await db.delete(environments).where(eq(environments.id, environmentId));
      }

      const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) });
      const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

      expect(result).toEqual({ swept: 1, destroyed: 1, capped: 0 });
      const row = await leaseRow(leaseId);
      expect(row).toMatchObject({ status: "expired", cleanupStatus: "success" });
      expect(row?.releasedAt).toBeInstanceOf(Date);
      // An SSH lease proves nothing about remote termination, so no receipt.
      expect(row?.metadata).not.toHaveProperty("remoteExecutionTermination");
      expect(sshHelperCalls).toEqual([]);
      expect(
        vi.mocked(logger.warn).mock.calls.find((call) => call[1] === "pending_cleanup lease retry failed"),
      ).toBeUndefined();
    },
  );

  it("settles only the SSH leases of the SSH driver and keeps an unexpected provider resource", async () => {
    const { companyId, environmentId } = await seedSshEnvironment();
    const sshLeaseId = await insertPendingCleanupSshLease({ companyId, environmentId, leasePolicy: "ephemeral" });
    // A row on the SSH driver that names a provider resource the driver never
    // creates. Releasing it as bookkeeping could strand that resource.
    const foreignLeaseId = await insertPendingCleanupSshLease({
      companyId,
      environmentId,
      leasePolicy: "ephemeral",
      provider: "fake",
      providerLeaseId: "sandbox://fake/unexpected-resource",
    });

    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) });
    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toEqual({ swept: 2, destroyed: 1, capped: 0 });
    expect(await leaseRow(sshLeaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(await leaseRow(foreignLeaseId)).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    expect(sshHelperCalls).toEqual([]);
    const retryCalls = vi
      .mocked(logger.warn)
      .mock.calls.filter((call) => call[1] === "pending_cleanup lease retry failed");
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]?.[0]).toMatchObject({ errorKind: "destroy_failed", leaseId: foreignLeaseId });
  });
});
