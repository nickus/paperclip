/**
 * Content retention for connected-tool calls.
 *
 * The tool gateway records every call it brokers: who called which tool, the
 * policy decision, timing, outcome, and by default a redacted, truncated
 * summary of the arguments and of the result. For a connection to a private
 * data source (a personal notes server, a mailbox, a document store) that
 * summary copies private content into the platform database, where anyone with
 * audit access can read it.
 *
 * A connection chooses what the gateway keeps with `config.contentRetention`:
 *
 *   "summary"  (default) redacted, truncated summaries of arguments and
 *              results, plus sha256 hashes and sizes;
 *   "none"     metadata only: who, when, which tool, decision, outcome,
 *              latency, error code, sha256 hashes and sizes. No argument or
 *              result text and no upstream error text is stored.
 *
 * Retention only changes what is stored. The agent that made a call still
 * receives the full result.
 */

export const TOOL_CONTENT_RETENTION_MODES = ["summary", "none"] as const;

export type ToolContentRetention = (typeof TOOL_CONTENT_RETENTION_MODES)[number];

/** What the gateway keeps when neither the connection nor the instance chooses. */
export const DEFAULT_TOOL_CONTENT_RETENTION: ToolContentRetention = "summary";

/** Connection config key that selects a connection's content retention. */
export const CONNECTION_CONTENT_RETENTION_CONFIG_KEY = "contentRetention";

export function isToolContentRetention(value: unknown): value is ToolContentRetention {
  return typeof value === "string" && (TOOL_CONTENT_RETENTION_MODES as readonly string[]).includes(value);
}

/**
 * Read the retention a connection config selects, or null when it selects
 * none. Only a config without the key selects none. The key is validated on
 * create and update, so any other value that is not a mode (an unrecognized
 * string, `null`, a number) can only come from a config stored before
 * validation or written around the API. Such a value fails closed to "none":
 * someone tried to change what is kept, and keeping less is the safe reading of
 * an unclear intent.
 */
export function readConfiguredToolContentRetention(config: unknown): ToolContentRetention | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  // An `undefined` value is the in-memory form of an absent key: JSON storage
  // drops it, so reading it as "not set" keeps both forms of one config equal.
  const value = record[CONNECTION_CONTENT_RETENTION_CONFIG_KEY];
  if (value === undefined) return null;
  return isToolContentRetention(value) ? value : "none";
}

/** The stricter of two retentions: "none" wins over "summary". */
export function strictestToolContentRetention(
  ...values: Array<ToolContentRetention | null | undefined>
): ToolContentRetention {
  return values.includes("none") ? "none" : DEFAULT_TOOL_CONTENT_RETENTION;
}
