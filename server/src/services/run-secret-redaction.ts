import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { StoredSecretVersionMaterial } from "../secrets/types.js";

const REGISTRY_KEY = "paperclipSecretRedactions";
// Project only the registry: run contexts can contain megabytes of prompt data.
const registrySnapshot = sql`jsonb_build_object('paperclipSecretRedactions', ${heartbeatRuns.contextSnapshot} -> 'paperclipSecretRedactions')`;

type RegistryEntry = {
  fingerprintSha256: string;
  material: StoredSecretVersionMaterial;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function registryEntries(contextSnapshot: unknown): RegistryEntry[] {
  const context = asRecord(contextSnapshot);
  const raw = context?.[REGISTRY_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const entry = asRecord(value);
    const material = asRecord(entry?.material);
    return typeof entry?.fingerprintSha256 === "string" && material
      ? [{ fingerprintSha256: entry.fingerprintSha256, material }]
      : [];
  });
}

// Run logs are persisted as NDJSON, so a value that contains quotes,
// backslashes or control characters (a PEM key, a JSON credential) is stored in
// its JSON-escaped spelling. Match that spelling as well as the raw one.
function redactionValues(values: Iterable<string>): string[] {
  const expanded = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    expanded.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) expanded.add(escaped);
  }
  // Longest first, so a value is never partially replaced by a shorter one.
  return [...expanded].sort((left, right) => right.length - left.length);
}

function redactText(input: string, values: string[]) {
  return values.reduce(
    (result, value) => value.length > 0 ? result.split(value).join(REDACTED_EVENT_VALUE) : result,
    input,
  );
}

/**
 * True for the context key that holds a run's encrypted redaction registry.
 * Redacted copies of run data drop it (see redactRegisteredSecretValues).
 */
export function isRedactionRegistryKey(key: string) {
  return key === REGISTRY_KEY;
}

export function redactRegisteredSecretValues<T>(input: T, values: string[]): T {
  if (typeof input === "string") return redactText(input, values) as T;
  if (Array.isArray(input)) return input.map((value) => redactRegisteredSecretValues(value, values)) as T;
  // Dates carry no redactable text; rebuilding them via Object.entries would
  // collapse them to `{}` and break every timestamp in redacted responses.
  if (input instanceof Date) return input;
  const record = asRecord(input);
  if (!record) return input;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !isRedactionRegistryKey(key))
      .map(([key, value]) => [key, redactRegisteredSecretValues(value, values)]),
  ) as T;
}

/**
 * Rewrites a run's whole contextSnapshot from an in-memory copy without
 * dropping values registered for redaction while the run executed. Those
 * registrations exist only in the stored row, so the stored registry wins.
 */
export function contextSnapshotKeepingRedactionRegistry(context: Record<string, unknown>) {
  return sql`${JSON.stringify(context)}::jsonb || case
    when ${heartbeatRuns.contextSnapshot} -> ${REGISTRY_KEY}::text is not null
      then jsonb_build_object(${REGISTRY_KEY}::text, ${heartbeatRuns.contextSnapshot} -> ${REGISTRY_KEY}::text)
    else '{}'::jsonb
  end`;
}

// Resolved values for runs that this process is executing, so that live
// run-log and run-event publishing can redact every chunk without a database
// round trip. An entry exists only while a run holds it (retainLiveRun).
//
// This cache is local to the server process, like the live-event bus that
// the redacted payloads are published on. A registration served by this
// process marks the run's entry stale (register), so the next payload is
// redacted with the new value. A registration served by another server
// process that shares the database cannot reach this map, so a retained entry
// is also re-read once it is older than LIVE_RUN_REGISTRY_MAX_AGE_MS. That
// bounds, but does not close, the window in which such a value can reach live
// payloads and stored output unredacted; the read routes always apply the
// stored registry. A deployment that runs several server processes against
// one database and needs a registration to apply to the very next chunk must
// route a run's agent API calls to the process that executes the run.
const LIVE_RUN_REGISTRY_MAX_AGE_MS = 2_000;

type LiveRunRedactionEntry = {
  companyId: string;
  holders: number;
  generation: number;
  loadedGeneration: number;
  // Date.now() when the registry behind loadedGeneration was read.
  loadedAt: number;
  // fingerprint -> plaintext. Only grows while the entry lives: a value that
  // was registered for the run stays redacted even if the stored registry is
  // later rewritten without it.
  resolved: Map<string, string>;
  values: string[];
  inflight: { generation: number; promise: Promise<string[]> } | null;
};

const liveRunRedactions = new Map<string, LiveRunRedactionEntry>();

function markLiveRunRegistryStale(runId: string) {
  const entry = liveRunRedactions.get(runId);
  if (entry) entry.generation += 1;
}

export function createRunSecretRedactionRegistry(db: Db) {
  const provider = getSecretProvider("local_encrypted");

  async function valuesForRuns(rows: Array<{ contextSnapshot: unknown }>) {
    const entries = rows.flatMap((row) => registryEntries(row.contextSnapshot));
    const unique = new Map(entries.map((entry) => [entry.fingerprintSha256, entry]));
    const values = await Promise.all(
      [...unique.values()].map((entry) => provider.resolveVersion({
        material: entry.material,
        externalRef: null,
      })),
    );
    return redactionValues(values);
  }

  function selectRunRegistry(companyId: string, runId: string) {
    return db.select({ contextSnapshot: registrySnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  }

  async function valuesForRun(companyId: string, runId: string) {
    return valuesForRuns(await selectRunRegistry(companyId, runId));
  }

  async function reloadLiveRun(
    entry: LiveRunRedactionEntry,
    runId: string,
    generation: number,
    previous: Promise<string[]> | undefined,
  ) {
    // Settle loads in the order they were started, so a caller that waited on a
    // newer registry never resumes before one that waited on an older one.
    await previous?.catch(() => undefined);
    const readAt = Date.now();
    const rows = await selectRunRegistry(entry.companyId, runId);
    const pending = rows
      .flatMap((row) => registryEntries(row.contextSnapshot))
      .filter((registered) => !entry.resolved.has(registered.fingerprintSha256));
    await Promise.all(pending.map(async (registered) => {
      const value = await provider.resolveVersion({ material: registered.material, externalRef: null });
      entry.resolved.set(registered.fingerprintSha256, value);
    }));
    entry.values = redactionValues(entry.resolved.values());
    entry.loadedGeneration = Math.max(entry.loadedGeneration, generation);
    entry.loadedAt = Math.max(entry.loadedAt, readAt);
    return entry.values;
  }

  async function valuesForLiveRun(companyId: string, runId: string): Promise<string[]> {
    const entry = liveRunRedactions.get(runId);
    // Not executing in this process: read the registry for this call only.
    if (!entry || entry.companyId !== companyId) return valuesForRun(companyId, runId);
    if (
      entry.loadedGeneration === entry.generation &&
      Date.now() - entry.loadedAt >= LIVE_RUN_REGISTRY_MAX_AGE_MS
    ) {
      // Pick up registrations served by other server processes.
      entry.generation += 1;
    }
    if (entry.loadedGeneration === entry.generation) return entry.values;
    if (entry.inflight?.generation !== entry.generation) {
      const generation = entry.generation;
      const promise = reloadLiveRun(entry, runId, generation, entry.inflight?.promise);
      entry.inflight = { generation, promise };
      const settle = () => {
        if (entry.inflight?.promise === promise) entry.inflight = null;
      };
      promise.then(settle, settle);
    }
    return entry.inflight!.promise;
  }

  async function valuesForIssue(companyId: string, issueId: string) {
    const rows = await db.select({ contextSnapshot: registrySnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} -> 'paperclipIssue' ->> 'id' = ${issueId}`,
        ),
      ));
    return valuesForRuns(rows);
  }

  return {
    register: async (companyId: string, runId: string, value: string) => {
      const fingerprintSha256 = createHash("sha256").update(value).digest("hex");
      let added = false;
      await db.transaction(async (tx) => {
        const row = await tx.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) throw new Error("Heartbeat run redaction registration failed");
        if (registryEntries(row.contextSnapshot).some((entry) => entry.fingerprintSha256 === fingerprintSha256)) {
          return;
        }
        const prepared = await provider.createSecret({ value });
        const entry: RegistryEntry = { fingerprintSha256, material: prepared.material };
        const contextSnapshot = asRecord(row.contextSnapshot) ?? {};
        const currentEntries = Array.isArray(contextSnapshot[REGISTRY_KEY])
          ? contextSnapshot[REGISTRY_KEY]
          : [];
        await tx.update(heartbeatRuns)
          .set({
            contextSnapshot: { ...contextSnapshot, [REGISTRY_KEY]: [...currentEntries, entry] },
            updatedAt: new Date(),
          })
          .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
        added = true;
      });
      // The caller hands the value out only after this returns, so any output
      // that can contain it is redacted with the reloaded registry when this
      // process executes the run (see LIVE_RUN_REGISTRY_MAX_AGE_MS otherwise).
      if (added) markLiveRunRegistryStale(runId);
    },
    redactForRuns: async <T extends { id: string }>(companyId: string, runs: T[]): Promise<T[]> => {
      if (runs.length === 0) return [];
      const rows = await db.select({ id: heartbeatRuns.id, contextSnapshot: registrySnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runs.map((run) => run.id))));
      // Resolve each encrypted value once per request, but apply only each run's
      // own registry. Do not retain plaintext secrets across requests.
      const resolved = new Map<string, Promise<string>>();
      const valuesByRun = new Map(await Promise.all(rows.map(async (row) => {
        const values = await Promise.all(registryEntries(row.contextSnapshot).map((entry) => {
          let value = resolved.get(entry.fingerprintSha256);
          if (!value) {
            value = provider.resolveVersion({ material: entry.material, externalRef: null });
            resolved.set(entry.fingerprintSha256, value);
          }
          return value;
        }));
        return [row.id, redactionValues(values)] as const;
      })));
      return runs.map((run) => redactRegisteredSecretValues(run, valuesByRun.get(run.id) ?? []));
    },
    redactForRun: async <T>(companyId: string, runId: string, value: T): Promise<T> =>
      redactRegisteredSecretValues(value, await valuesForRun(companyId, runId)),
    redactForIssue: async <T>(companyId: string, issueId: string, value: T): Promise<T> =>
      redactRegisteredSecretValues(value, await valuesForIssue(companyId, issueId)),
    /**
     * Keeps this run's resolved values in memory until the returned release
     * function is called, so valuesForLiveRun needs no database read per
     * published payload. Call it for the lifetime of a run's execution.
     */
    retainLiveRun: (companyId: string, runId: string): (() => void) => {
      let entry = liveRunRedactions.get(runId);
      if (!entry) {
        entry = {
          companyId,
          holders: 0,
          generation: 0,
          loadedGeneration: -1,
          loadedAt: 0,
          resolved: new Map(),
          values: [],
          inflight: null,
        };
        liveRunRedactions.set(runId, entry);
      }
      const retained = entry;
      retained.holders += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained.holders -= 1;
        if (retained.holders <= 0 && liveRunRedactions.get(runId) === retained) {
          liveRunRedactions.delete(runId);
        }
      };
    },
    /**
     * The values redactForRun applies, for payloads persisted or published
     * while the run is live (use with redactRegisteredSecretValues). Served
     * from memory while the run is retained in this process, re-read after a
     * registration in this process or once the copy is older than
     * LIVE_RUN_REGISTRY_MAX_AGE_MS. Rejects when the registry cannot be read
     * or decrypted, like redactForRun.
     */
    valuesForLiveRun,
  };
}
