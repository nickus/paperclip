import path from "node:path";

const SESSION_CWD_SYSTEM_ROOTS = new Set([
  "/",
  "/tmp",
  "/var",
  "/var/tmp",
  "/var/run",
  "/usr",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/private",
  "/private/tmp",
]);

export function isUnsafeSessionWorkspaceCwd(cwd: string | null | undefined): boolean {
  const value = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  if (!value) return false;
  const normalized = path.normalize(value.replace(/\/+$/, "") || "/");
  return SESSION_CWD_SYSTEM_ROOTS.has(normalized);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * True when a saved session's cwd is the working directory on a remote
 * execution target (SSH host or sandbox) rather than a path on this host.
 * Such a cwd must never be used as the local workspace of a run.
 */
export function isRemoteSessionWorkspaceCwd(
  sessionParams: Record<string, unknown> | null | undefined,
): boolean {
  const cwd = readTrimmedString(sessionParams?.cwd);
  if (!cwd) return false;
  const remoteExecution = sessionParams?.remoteExecution;
  if (!remoteExecution || typeof remoteExecution !== "object" || Array.isArray(remoteExecution)) return false;
  const identity = remoteExecution as Record<string, unknown>;
  if (identity.transport !== "ssh" && identity.transport !== "sandbox") return false;
  return readTrimmedString(identity.remoteCwd) === cwd;
}
