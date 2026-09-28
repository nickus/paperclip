import type { Db } from "@paperclipai/db";
import { environmentLeases, environments } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";

/**
 * Whether a heartbeat run executes in a remote execution environment (SSH,
 * sandbox or plugin), and so reaches this API through that environment's
 * Paperclip API bridge rather than from the host.
 *
 * The answer comes only from the run's environment leases, which the host
 * records when it places the run. Nothing the request carries is read: pass
 * the run id the caller authenticated with (the signed run claim of an agent
 * JWT). A run that holds a lease on any environment other than a `local`
 * one counts as bridged, and so does a lease whose environment has since been
 * deleted. A run with no lease, or a value that is not a run id, is local.
 */
export async function heartbeatRunUsesPaperclipApiBridge(
  db: Db,
  input: { companyId: string; runId: string | null | undefined },
): Promise<boolean> {
  const runId = input.runId?.trim();
  if (!runId || !isUuidLike(runId)) return false;
  const leases = await db
    .select({ driver: environments.driver })
    .from(environmentLeases)
    .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
    .where(and(
      eq(environmentLeases.heartbeatRunId, runId),
      eq(environmentLeases.companyId, input.companyId),
    ));
  // A missing environment (null driver) fails closed to "bridged".
  return leases.some((lease) => lease.driver !== "local");
}
