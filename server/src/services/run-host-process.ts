import { eq } from "drizzle-orm";
import { environmentLeases, environments, type Db } from "@paperclipai/db";

/**
 * Built-in adapters whose runs are a child process that the server spawns and
 * tracks. Their recorded pid and process group are always probed when the
 * server has lost the in-memory handle of a run.
 */
export const SESSIONED_LOCAL_ADAPTER_TYPES: ReadonlySet<string> = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

export function isSessionedLocalAdapter(adapterType: string): boolean {
  return SESSIONED_LOCAL_ADAPTER_TYPES.has(adapterType);
}

// A local run executes its command on this host, and an SSH run executes it
// through an SSH client that also runs on this host. Any other lease places the
// command inside a sandbox, where a recorded pid names a process this host
// cannot see.
const HOST_PROCESS_LEASE_KINDS = new Set(["local", "ssh"]);

/**
 * Whether the pid and process group recorded for a run name a process on this
 * host. Any adapter can report its process through `onSpawn`, so an adapter
 * outside the built-in list gets the same liveness check as long as its run
 * did not execute inside a sandbox. A run without an environment lease ran on
 * the host.
 */
export async function runProcessIsOnHost(db: Db, runId: string): Promise<boolean> {
  const leases = await db
    .select({ provider: environmentLeases.provider, driver: environments.driver })
    .from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(eq(environmentLeases.heartbeatRunId, runId));
  // Without a provider the environment driver decides, and a lease that names
  // neither is local bookkeeping.
  return leases.every((lease) => HOST_PROCESS_LEASE_KINDS.has(lease.provider ?? lease.driver ?? "local"));
}
