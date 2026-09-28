import type { Db } from "@paperclipai/db";
import { agents, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, desc, eq } from "drizzle-orm";

interface LeasePlacement {
  provider: string | null;
  metadata: Record<string, unknown> | null;
  driver: string | null;
}

/**
 * A lease is on the host only when everything recorded about it says so: the
 * provider and the environment driver the host wrote on the lease when it took
 * it, which never change afterwards, and the environment row's current driver,
 * which a board user can edit. A lease whose environment has since been
 * deleted, or one missing either recorded value, counts as remote.
 */
function leaseIsLocal(lease: LeasePlacement) {
  return lease.provider === "local" && lease.metadata?.driver === "local" && lease.driver === "local";
}

/**
 * Whether a heartbeat run executes in a remote execution environment (SSH,
 * sandbox or plugin), and so reaches this API through that environment's
 * Paperclip API bridge rather than from the host.
 *
 * The answer comes only from the run's environment leases, which the host
 * records when it places the run. Nothing the request carries is read: pass
 * the run id the caller authenticated with (the signed run claim of an agent
 * JWT). A run that holds any lease not on a `local` environment counts as
 * bridged (see `leaseIsLocal`). A run with no lease, or a value that is not a
 * run id, is local.
 */
export async function heartbeatRunUsesPaperclipApiBridge(
  db: Db,
  input: { companyId: string; runId: string | null | undefined },
): Promise<boolean> {
  const runId = input.runId?.trim();
  if (!runId || !isUuidLike(runId)) return false;
  const leases = await db
    .select({
      provider: environmentLeases.provider,
      metadata: environmentLeases.metadata,
      driver: environments.driver,
    })
    .from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(
      eq(environmentLeases.heartbeatRunId, runId),
      eq(environmentLeases.companyId, input.companyId),
    ));
  return leases.some((lease) => !leaseIsLocal(lease));
}

/**
 * Whether the agent is placed in a remote execution environment: its default
 * environment is not a local one, or the latest of its runs that took a lease
 * ran remotely. The latest lease covers placements the default environment
 * does not show, such as an instance-wide default.
 */
async function agentPlacedInRemoteEnvironment(
  db: Db,
  input: { companyId: string; agentId: string },
): Promise<boolean> {
  const [agent] = await db
    .select({ defaultEnvironmentId: agents.defaultEnvironmentId, driver: environments.driver })
    .from(agents)
    .leftJoin(environments, eq(environments.id, agents.defaultEnvironmentId))
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  if (!agent) return true;
  if (agent.defaultEnvironmentId && agent.driver !== "local") return true;
  const [latest] = await db
    .select({
      provider: environmentLeases.provider,
      metadata: environmentLeases.metadata,
      driver: environments.driver,
    })
    .from(environmentLeases)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, environmentLeases.heartbeatRunId))
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(eq(environmentLeases.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)))
    .orderBy(desc(environmentLeases.acquiredAt))
    .limit(1);
  return latest ? !leaseIsLocal(latest) : false;
}

/**
 * Whether an agent's request reaches this API from a remote execution
 * environment, for the changes that need a board-accepted consent there.
 *
 * With an agent JWT (`source: "agent_jwt"`) the run id is the token's signed
 * run claim, and that run's leases decide. Any other agent credential, such as
 * a long-lived agent API key, has no run of its own: its run id is whatever
 * the client sent in `X-Paperclip-Run-Id`. Such a request counts as remote
 * when that header is not the id of one of the agent's own runs, when the run
 * it names is remote, or when the agent itself is placed remotely. With no
 * header, the agent's placement alone decides.
 */
export async function agentRequestUsesPaperclipApiBridge(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null | undefined;
    source: string | null | undefined;
  },
): Promise<boolean> {
  if (input.source === "agent_jwt") {
    return heartbeatRunUsesPaperclipApiBridge(db, { companyId: input.companyId, runId: input.runId });
  }
  const runId = input.runId?.trim() || null;
  if (runId) {
    if (!isUuidLike(runId)) return true;
    const [run] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ));
    if (!run) return true;
    if (await heartbeatRunUsesPaperclipApiBridge(db, { companyId: input.companyId, runId })) return true;
  }
  return agentPlacedInRemoteEnvironment(db, { companyId: input.companyId, agentId: input.agentId });
}
