import { remoteRunGitHubLauncherDir, sshRunDir } from "@paperclipai/adapter-utils/ssh-workspace-layout";
import type { EnvironmentLease } from "@paperclipai/shared";

/**
 * Paths inside a sandbox that hold only files private to the run that held
 * `lease`: its run directory (with its scratch and temp directory, see
 * sandbox-run-scratch.ts) and its managed GitHub launchers. The run removes
 * them itself when it ends, but a run that was interrupted (its host went
 * away) or stopped (the sandbox refuses commands once it is stopped) leaves
 * them behind, and a sandbox kept for later runs must not carry them along.
 * The provider removes them on release once the run's processes are stopped.
 *
 * Built from the lease's recorded `remoteCwd`, which is where the run created
 * them; a lease without one, or without a run, names nothing.
 */
export function sandboxRunPrivatePaths(
  lease: Pick<EnvironmentLease, "heartbeatRunId" | "metadata">,
): string[] {
  const remoteCwd = typeof lease.metadata?.remoteCwd === "string" ? lease.metadata.remoteCwd.trim() : "";
  if (!lease.heartbeatRunId || !remoteCwd.startsWith("/")) return [];
  try {
    return [sshRunDir(remoteCwd, lease.heartbeatRunId), remoteRunGitHubLauncherDir(remoteCwd, lease.heartbeatRunId)];
  } catch {
    // A run id the layout refuses never named a directory.
    return [];
  }
}
