/**
 * Tool-call time budgets shared by the tool gateway, the sandbox callback
 * bridge and the adapters that write MCP client configuration.
 *
 * A gateway tool call crosses several HTTP hops: the agent's MCP (or REST)
 * client, optionally the sandbox callback bridge, the Paperclip server, and
 * finally the upstream MCP server. The gateway owns the tool-call deadline and
 * answers with a clean `tool_timeout` error when it passes. Every hop outside
 * the gateway therefore gets a slightly larger budget than the longest tool
 * call the gateway allows, so the inner deadline always fires first:
 *
 *   gateway tool deadline      <= MAX_TOOL_CALL_TIMEOUT_MS            (300 s)
 *   bridge host forward         = TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS  (315 s)
 *   in-sandbox bridge wait      = TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS     (325 s)
 *   agent-side MCP client       = TOOL_CALL_CLIENT_TIMEOUT_MS          (330 s)
 */

/** Deadline for a remote MCP tool call when neither the caller nor the connection sets one. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 10_000;

/** Smallest tool-call timeout a connection can configure. */
export const MIN_CONFIGURED_TOOL_CALL_TIMEOUT_MS = 1_000;

/**
 * Upper bound for any single tool call: an explicit caller `timeoutMs`, a
 * connection's configured default, and an approved action's execution are all
 * clamped to it.
 */
export const MAX_TOOL_CALL_TIMEOUT_MS = 300_000;

/**
 * Host-side budget for relaying one tool call through the sandbox callback
 * bridge to the Paperclip API. Leaves room for the gateway's own bookkeeping
 * around the longest tool call.
 */
export const TOOL_CALL_BRIDGE_FORWARD_TIMEOUT_MS = MAX_TOOL_CALL_TIMEOUT_MS + 15_000;

/**
 * How long the in-sandbox bridge gateway waits for the host to answer a
 * relayed tool call. Above the host forward budget, so the host's own timeout
 * response reaches the caller before the gateway gives up.
 */
export const TOOL_CALL_BRIDGE_GATEWAY_WAIT_MS = MAX_TOOL_CALL_TIMEOUT_MS + 25_000;

/**
 * Per-request timeout for agent-side MCP clients that Paperclip configures
 * (for example the per-run MCP config of a CLI adapter). The outermost hop.
 */
export const TOOL_CALL_CLIENT_TIMEOUT_MS = MAX_TOOL_CALL_TIMEOUT_MS + 30_000;

/** Connection config key for a remote MCP connection's default tool-call timeout. */
export const REMOTE_MCP_TOOL_TIMEOUT_CONFIG_KEY = "toolTimeoutMs";

/** Clamp a caller-supplied tool-call timeout into the supported range. */
export function clampToolCallTimeoutMs(value: number): number {
  return Math.max(1, Math.min(MAX_TOOL_CALL_TIMEOUT_MS, Math.floor(value)));
}

/** True when `value` is a valid configured tool-call timeout. */
export function isValidConfiguredToolCallTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_CONFIGURED_TOOL_CALL_TIMEOUT_MS &&
    value <= MAX_TOOL_CALL_TIMEOUT_MS
  );
}

/**
 * Read a remote MCP connection's configured default tool-call timeout, or null
 * when the config does not set a valid one. Stored configs predating
 * validation may hold anything, so an invalid value is ignored rather than
 * clamped.
 */
export function readConfiguredToolCallTimeoutMs(config: unknown): number | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>)[REMOTE_MCP_TOOL_TIMEOUT_CONFIG_KEY];
  return isValidConfiguredToolCallTimeoutMs(value) ? value : null;
}
