import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "@paperclipai/adapter-utils/ssh";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { agents, companies, createDb, environments, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { secretService } from "../services/secrets.ts";
import { deriveSshWorkspaceReuseKey, sshWorkspaceReuseKeyHolder } from "../services/ssh-workspace-reuse.ts";

// What the adapter saw during each run, and whether the remote scratch
// directory existed while it ran.
interface ObservedRun {
  runId: string;
  workspaceReuseKey: unknown;
  remoteCwd: unknown;
  env: Record<string, unknown>;
  scratch: Record<string, unknown> | null;
  scratchDirExisted: boolean;
  scratchDirMode: number | null;
  keyHolderDuringRun: string | null;
}

const observed = vi.hoisted(() => [] as ObservedRun[]);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: AdapterExecutionContext) => {
    const target = ctx.executionTarget as Record<string, unknown> | null | undefined;
    const env = (ctx.config.env ?? {}) as Record<string, unknown>;
    const scratchDir = typeof env.PAPERCLIP_SCRATCH_DIR === "string" ? env.PAPERCLIP_SCRATCH_DIR : null;
    // The env-lab sshd runs as this user on this machine, so remote paths are local paths.
    const scratchStat = scratchDir ? await stat(scratchDir).catch(() => null) : null;
    const key = typeof target?.workspaceReuseKey === "string" ? target.workspaceReuseKey : null;
    const { sshWorkspaceReuseKeyHolder: holder } = await import("../services/ssh-workspace-reuse.ts");
    observed.push({
      runId: ctx.runId,
      workspaceReuseKey: target?.workspaceReuseKey,
      remoteCwd: target?.remoteCwd,
      env,
      scratch: (ctx.context.paperclipScratch as Record<string, unknown> | undefined) ?? null,
      scratchDirExisted: scratchStat?.isDirectory() ?? false,
      scratchDirMode: scratchStat ? scratchStat.mode & 0o777 : null,
      keyHolderDuringRun: key ? holder(key) : null,
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionParams: { sessionId: `session-${ctx.runId}` },
      sessionDisplayId: `session-${ctx.runId}`,
      provider: "test",
      model: "test-model",
    };
  }),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "opencode_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "opencode_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const sshSupport = await getSshEnvLabSupport();
const supported = embeddedPostgresSupport.supported && sshSupport.supported;
const describeSupported = supported ? describe : describe.skip;

if (!supported) {
  console.warn(
    `Skipping SSH workspace reuse heartbeat tests on this host: ${
      embeddedPostgresSupport.reason ?? sshSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeSupported("heartbeat SSH workspace reuse and remote scratch", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let fixture: SshEnvLabFixtureState | null = null;
  const tempRoots: string[] = [];
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    // The SSH private key is stored as a company secret; keep its key in memory.
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-ssh-workspace-reuse-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-ssh-reuse-"));
    tempRoots.push(fixtureRoot);
    fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    observed.length = 0;
    adapterExecute.mockClear();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agent_task_sessions",
        "company_secret_bindings",
        "company_secret_versions",
        "company_secrets",
        "project_workspaces",
        "projects",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    if (fixture) await stopSshEnvLabFixture(fixture).catch(() => undefined);
    await tempDb?.cleanup();
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    const agentId = randomUUID();
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-heartbeat-ssh-reuse-ws-"));
    tempRoots.push(workspaceRoot);
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture!);
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      defaultResponsibleUserId: "responsible-user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "SSH Reuse",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const secret = await secretService(db).create(companyId, {
      name: `ssh-reuse-private-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: sshConfig.privateKey ?? "",
    });
    await secretService(db).createBinding({
      companyId,
      secretId: secret.id,
      targetType: "environment",
      targetId: environmentId,
      configPath: "privateKeySecretRef",
    });
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "Fixture SSH",
      driver: "ssh",
      status: "active",
      config: {
        ...sshConfig,
        privateKey: null,
        privateKeySecretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OpenCodeAgent",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: environmentId,
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { agentId, projectId, workspaceRoot, remoteRoot: sshConfig.remoteWorkspacePath };
  }

  async function runOnce(agentId: string, projectId: string, taskKey: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId, taskKey },
    });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();
    return run!.id;
  }

  it("hands consecutive runs of one task the same workspace key and gives each run a private remote scratch dir", async () => {
    const { agentId, projectId, workspaceRoot, remoteRoot } = await seed();

    const run1 = await runOnce(agentId, projectId, "task-a");
    const run2 = await runOnce(agentId, projectId, "task-a");
    const run3 = await runOnce(agentId, projectId, "task-b");

    expect(observed.map((entry) => entry.runId)).toEqual([run1, run2, run3]);
    const keyA = deriveSshWorkspaceReuseKey({ agentId, taskKey: "task-a", hostCwd: workspaceRoot });
    const keyB = deriveSshWorkspaceReuseKey({ agentId, taskKey: "task-b", hostCwd: workspaceRoot });
    expect(observed[0]!.workspaceReuseKey).toBe(keyA);
    expect(observed[1]!.workspaceReuseKey).toBe(keyA);
    expect(observed[2]!.workspaceReuseKey).toBe(keyB);
    expect(keyA).not.toBe(keyB);
    // Held by the running run, released once it ends.
    expect(observed[0]!.keyHolderDuringRun).toBe(run1);
    expect(sshWorkspaceReuseKeyHolder(keyA)).toBeNull();
    expect(sshWorkspaceReuseKeyHolder(keyB)).toBeNull();

    for (const entry of observed) {
      const scratchDir = path.posix.join(remoteRoot, ".paperclip-runtime", "runs", entry.runId, "scratch");
      expect(entry.remoteCwd).toBe(remoteRoot);
      expect(entry.env).toMatchObject({
        PAPERCLIP_RUN_SCRATCH_DIR: scratchDir,
        PAPERCLIP_TASK_SCRATCH_DIR: scratchDir,
        PAPERCLIP_SCRATCH_DIR: scratchDir,
        PAPERCLIP_TMPDIR: scratchDir,
        TMPDIR: scratchDir,
        TMP: scratchDir,
        TEMP: scratchDir,
      });
      expect(entry.scratch).toMatchObject({ type: "heartbeat_run", location: "remote", dir: scratchDir });
      // Created on the SSH host before the adapter ran, private to the run.
      expect(entry.scratchDirExisted).toBe(true);
      expect(entry.scratchDirMode).toBe(0o700);
      // Removed when the run ended.
      await expect(stat(scratchDir)).rejects.toThrow();
    }
  }, 60_000);

  it("keeps an explicitly configured TMPDIR and leaves runs without a task key on the per-run layout", async () => {
    const { agentId, projectId, remoteRoot } = await seed();
    await db.execute(sql`
      update agents set adapter_config = ${JSON.stringify({ env: { TMPDIR: "/var/tmp/custom" } })}::jsonb
      where id = ${agentId}
    `);
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
    }, { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();

    expect(observed).toHaveLength(1);
    const scratchDir = path.posix.join(remoteRoot, ".paperclip-runtime", "runs", run!.id, "scratch");
    expect(observed[0]!.workspaceReuseKey).toBeUndefined();
    expect(observed[0]!.env.PAPERCLIP_SCRATCH_DIR).toBe(scratchDir);
    expect(observed[0]!.env.TMPDIR).toBe("/var/tmp/custom");
    expect(observed[0]!.env.TMP).toBe(scratchDir);
    expect(observed[0]!.scratch).toMatchObject({ tempKeysApplied: ["TEMP", "TMP"] });
  }, 60_000);
});
