/** Keep only execution identity fields; never persist credentials or runner objects. */
export function serializeSessionExecutionIdentity(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return { transport: "invalid" };
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["transport", "host", "username", "remoteCwd", "providerKey", "environmentId", "leaseId", "providerLeaseId"]) {
    if (typeof record[key] === "string") result[key] = record[key];
  }
  if (typeof record.port === "number" && Number.isFinite(record.port)) result.port = record.port;
  // Malformed remote state must not become an empty, local-compatible identity.
  return Object.keys(result).length > 0 ? result : { transport: "invalid" };
}

/**
 * Keeps the execution identity of sandbox sessions only. Without it a saved
 * sandbox session is compared against `{}` on the next run and can never
 * resume. For adapters whose session store lives in a per-run directory on an
 * SSH host, so an SSH session could not be resumed even with a matching
 * identity.
 */
export function serializeSandboxSessionExecutionIdentity(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ((value as Record<string, unknown>).transport !== "sandbox") return null;
  return serializeSessionExecutionIdentity(value);
}

/**
 * Keeps the execution identity of sandbox and SSH sessions, for adapters whose
 * CLI keeps its session store in a home directory that outlives the run. An
 * SSH identity keeps only host, port, username and remote working directory;
 * the key material of the connection is never stored. Any other transport is
 * dropped.
 */
export function serializeRemoteSessionExecutionIdentity(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const transport = (value as Record<string, unknown>).transport;
  if (transport !== "sandbox" && transport !== "ssh") return null;
  return serializeSessionExecutionIdentity(value);
}
