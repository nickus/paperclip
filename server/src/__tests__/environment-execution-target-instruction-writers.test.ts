import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * The agents an `agent-with-instruction-writes` bridge may write instructions
 * for, resolved against a real database: only the run company's live agents
 * whose default environment is the run's environment, with an adapter that
 * can run there.
 */
describeEmbeddedPostgres("instruction-writable agents on remote execution targets", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridge-instruction-writers-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Company ${id}`,
      issuePrefix: `W${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  async function insertEnvironment(driver: "ssh" | "sandbox") {
    const id = randomUUID();
    await db.insert(environments).values({ id, name: `Environment ${id}`, driver });
    return id;
  }

  async function insertAgent(input: {
    companyId: string;
    environmentId: string | null;
    adapterType?: string;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: `Agent ${id}`,
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: input.adapterType ?? "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      defaultEnvironmentId: input.environmentId,
    });
    return id;
  }

  it("lists only live, same-company agents whose default environment is the run's", async () => {
    const companyId = await insertCompany();
    const otherCompanyId = await insertCompany();
    const runEnvironmentId = await insertEnvironment("ssh");
    const otherEnvironmentId = await insertEnvironment("sandbox");

    const sameEnvironment = await insertAgent({ companyId, environmentId: runEnvironmentId });
    const pausedSameEnvironment = await insertAgent({
      companyId,
      environmentId: runEnvironmentId,
      adapterType: "codex_local",
      status: "paused",
    });
    // None of these may be written through this run's bridge.
    await insertAgent({ companyId, environmentId: runEnvironmentId, status: "terminated" });
    await insertAgent({ companyId, environmentId: runEnvironmentId, adapterType: "process" });
    await insertAgent({ companyId, environmentId: otherEnvironmentId });
    await insertAgent({ companyId, environmentId: null });
    await insertAgent({ companyId: otherCompanyId, environmentId: runEnvironmentId });

    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
        paperclipApiBridgePolicy: "agent-with-instruction-writes",
      },
    });
    const target = await resolveEnvironmentExecutionTarget({
      db,
      companyId,
      adapterType: "claude_local",
      environment: { id: runEnvironmentId, driver: "ssh", config: {} },
      leaseId: null,
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      paperclipApiBridgePolicy: "agent-with-instruction-writes",
      paperclipApiBridgeCompanyId: companyId,
    });
    expect((target as { paperclipApiBridgeInstructionWriteAgentIds?: string[] })
      .paperclipApiBridgeInstructionWriteAgentIds)
      .toEqual([sameEnvironment, pausedSameEnvironment].sort());
  });
});
