/**
 * Agent-facing presentation overrides for a tool connection.
 *
 * An operator can present an upstream MCP tool to agents under a different
 * name and description, and can give the connection itself a different name
 * and description wherever agents see it. The overrides live in the
 * connection's `config`, keyed by the upstream tool name, so they survive
 * catalog refreshes and never touch the catalog entry that the review and
 * quarantine rules hash:
 *
 * ```json
 * {
 *   "toolOverrides": {
 *     "search": { "name": "find_tickets", "description": "Search open tickets." }
 *   },
 *   "agentDisplayName": "Ticket tracker",
 *   "agentDescription": "Tickets for the support team."
 * }
 * ```
 *
 * An exposed name is only an alias. The gateway keeps the generated gateway
 * tool name as the tool's identity: tool profiles, policies, trust rules, rate
 * limits, approvals and invocation records keep matching the generated name
 * (and the upstream name), so renaming a tool never widens or narrows access.
 */

/** Connection config key holding per-tool overrides, keyed by upstream tool name. */
export const CONNECTION_TOOL_OVERRIDES_CONFIG_KEY = "toolOverrides";

/** Connection config key for the connection name shown to agents. */
export const CONNECTION_AGENT_DISPLAY_NAME_CONFIG_KEY = "agentDisplayName";

/** Connection config key for the connection description shown to agents. */
export const CONNECTION_AGENT_DESCRIPTION_CONFIG_KEY = "agentDescription";

/** Longest exposed tool name. Fits the tool-name limits of common model APIs. */
export const EXPOSED_TOOL_NAME_MAX_LENGTH = 64;

/** Longest exposed tool description. */
export const EXPOSED_TOOL_DESCRIPTION_MAX_LENGTH = 4000;

/** Longest connection name shown to agents. */
export const CONNECTION_AGENT_DISPLAY_NAME_MAX_LENGTH = 160;

/** Longest connection description shown to agents. */
export const CONNECTION_AGENT_DESCRIPTION_MAX_LENGTH = 4000;

/** Most tool overrides one connection can hold. */
export const CONNECTION_TOOL_OVERRIDES_MAX_ENTRIES = 500;

/** Longest upstream tool name an override can be keyed by. */
export const CONNECTION_TOOL_OVERRIDE_UPSTREAM_NAME_MAX_LENGTH = 500;

/**
 * A letter followed by letters, digits, `_` or `-`. This is the portable subset
 * of tool names that MCP clients and model APIs accept, and it can never
 * contain the `.` and `:` separators of generated gateway and platform tool
 * names, so an exposed name cannot shadow one of them.
 */
export const EXPOSED_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Tool names the gateway itself serves next to connected tools (the on-demand
 * `search_tools` / `run_tool` pair). Compared case-insensitively.
 */
export const RESERVED_EXPOSED_TOOL_NAMES: readonly string[] = ["search_tools", "run_tool"];

/**
 * Prefixes reserved for platform tools, such as the MCP gateway's
 * `paperclip_list_resources`. Compared case-insensitively.
 */
export const RESERVED_EXPOSED_TOOL_NAME_PREFIXES: readonly string[] = ["paperclip"];

export interface ConnectionToolOverride {
  /** Name agents see and call instead of the generated gateway tool name. */
  name: string | null;
  /** Description agents see instead of the upstream description. */
  description: string | null;
}

export interface ConnectionAgentPresentation {
  /** Connection name agents see instead of the connection's own name. */
  name: string | null;
  /** Connection description agents see instead of the application's description. */
  description: string | null;
}

export interface ConnectionToolOverrideIssue {
  /** Path inside the connection config, e.g. `["toolOverrides", "search", "name"]`. */
  path: Array<string | number>;
  message: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Case-insensitive key used to compare exposed names for uniqueness. */
export function exposedToolNameKey(name: string): string {
  return name.toLowerCase();
}

/** True when `name` is reserved for a platform tool. */
export function isReservedExposedToolName(name: string): boolean {
  const key = exposedToolNameKey(name);
  return (
    RESERVED_EXPOSED_TOOL_NAMES.includes(key) ||
    RESERVED_EXPOSED_TOOL_NAME_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** Why `name` cannot be an exposed tool name, or null when it can. */
export function exposedToolNameProblem(name: string): string | null {
  if (name.length === 0) return "Exposed tool name must not be empty.";
  if (name.length > EXPOSED_TOOL_NAME_MAX_LENGTH) {
    return `Exposed tool name must be at most ${EXPOSED_TOOL_NAME_MAX_LENGTH} characters.`;
  }
  if (!EXPOSED_TOOL_NAME_PATTERN.test(name)) {
    return "Exposed tool name must start with a letter and contain only letters, digits, '_' or '-'.";
  }
  if (isReservedExposedToolName(name)) {
    return `Exposed tool name "${name}" is reserved for a platform tool.`;
  }
  return null;
}

function optionalText(
  value: unknown,
  maxLength: number,
  label: string,
): { value: string | null; problem: string | null } {
  if (value === undefined || value === null) return { value: null, problem: null };
  if (typeof value !== "string") return { value: null, problem: `${label} must be a string.` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: null, problem: `${label} must not be empty.` };
  if (trimmed.length > maxLength) {
    return { value: null, problem: `${label} must be at most ${maxLength} characters.` };
  }
  return { value: trimmed, problem: null };
}

/**
 * Validate the agent-facing overrides in a connection config. Returns one
 * issue per problem; an empty list means the overrides are valid. Checks
 * everything that can be decided from this config alone: the name charset,
 * length and reserved names, and that exposed names are unique within the
 * connection (case-insensitively). Uniqueness across connections needs the
 * other connections and is checked by the server.
 */
export function validateConnectionToolOverridesConfig(config: unknown): ConnectionToolOverrideIssue[] {
  if (!isPlainRecord(config)) return [];
  const issues: ConnectionToolOverrideIssue[] = [];

  for (const [key, maxLength, label] of [
    [CONNECTION_AGENT_DISPLAY_NAME_CONFIG_KEY, CONNECTION_AGENT_DISPLAY_NAME_MAX_LENGTH, "Agent display name"],
    [CONNECTION_AGENT_DESCRIPTION_CONFIG_KEY, CONNECTION_AGENT_DESCRIPTION_MAX_LENGTH, "Agent description"],
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue;
    const { problem } = optionalText(config[key], maxLength, label);
    if (problem) issues.push({ path: [key], message: problem });
  }

  if (!Object.prototype.hasOwnProperty.call(config, CONNECTION_TOOL_OVERRIDES_CONFIG_KEY)) return issues;
  const overrides = config[CONNECTION_TOOL_OVERRIDES_CONFIG_KEY];
  if (overrides === null || overrides === undefined) return issues;
  if (!isPlainRecord(overrides)) {
    issues.push({
      path: [CONNECTION_TOOL_OVERRIDES_CONFIG_KEY],
      message: "toolOverrides must be an object keyed by upstream tool name.",
    });
    return issues;
  }
  const entries = Object.entries(overrides);
  if (entries.length > CONNECTION_TOOL_OVERRIDES_MAX_ENTRIES) {
    issues.push({
      path: [CONNECTION_TOOL_OVERRIDES_CONFIG_KEY],
      message: `toolOverrides can hold at most ${CONNECTION_TOOL_OVERRIDES_MAX_ENTRIES} tools.`,
    });
  }
  // Exposed name key -> upstream tool name that claimed it first.
  const claimed = new Map<string, string>();
  for (const [upstreamToolName, override] of entries) {
    const path = [CONNECTION_TOOL_OVERRIDES_CONFIG_KEY, upstreamToolName];
    if (
      upstreamToolName.trim().length === 0 ||
      upstreamToolName.length > CONNECTION_TOOL_OVERRIDE_UPSTREAM_NAME_MAX_LENGTH
    ) {
      issues.push({
        path,
        message: `Upstream tool name must be 1-${CONNECTION_TOOL_OVERRIDE_UPSTREAM_NAME_MAX_LENGTH} characters.`,
      });
      continue;
    }
    if (!isPlainRecord(override)) {
      issues.push({ path, message: "A tool override must be an object with name and/or description." });
      continue;
    }
    const unknownKeys = Object.keys(override).filter((key) => key !== "name" && key !== "description");
    for (const key of unknownKeys) {
      issues.push({ path: [...path, key], message: `Unknown tool override field: ${key}.` });
    }
    const hasName = override.name !== undefined && override.name !== null;
    const hasDescription = override.description !== undefined && override.description !== null;
    if (!hasName && !hasDescription) {
      issues.push({ path, message: "A tool override must set a name, a description, or both." });
    }
    if (hasName) {
      if (typeof override.name !== "string") {
        issues.push({ path: [...path, "name"], message: "Exposed tool name must be a string." });
      } else {
        // Names are identifiers: no trimming, so what is stored is what agents call.
        const problem = exposedToolNameProblem(override.name);
        if (problem) {
          issues.push({ path: [...path, "name"], message: problem });
        } else {
          const key = exposedToolNameKey(override.name);
          const owner = claimed.get(key);
          if (owner !== undefined) {
            issues.push({
              path: [...path, "name"],
              message: `Exposed tool name "${override.name}" is already used for upstream tool "${owner}" on this connection.`,
            });
          } else {
            claimed.set(key, upstreamToolName);
          }
        }
      }
    }
    if (hasDescription) {
      const { problem } = optionalText(override.description, EXPOSED_TOOL_DESCRIPTION_MAX_LENGTH, "Exposed tool description");
      if (problem) issues.push({ path: [...path, "description"], message: problem });
    }
  }
  return issues;
}

/**
 * Read the per-tool overrides of a stored connection config, keyed by upstream
 * tool name. Stored configs may predate validation, so invalid entries are
 * ignored rather than trusted, and an exposed name claimed by two tools of the
 * same connection is dropped for both (their description overrides still apply).
 */
export function readConnectionToolOverrides(config: unknown): Map<string, ConnectionToolOverride> {
  const result = new Map<string, ConnectionToolOverride>();
  if (!isPlainRecord(config)) return result;
  const overrides = config[CONNECTION_TOOL_OVERRIDES_CONFIG_KEY];
  if (!isPlainRecord(overrides)) return result;
  const nameCounts = new Map<string, number>();
  for (const [upstreamToolName, override] of Object.entries(overrides)) {
    if (!isPlainRecord(override) || upstreamToolName.trim().length === 0) continue;
    const name =
      typeof override.name === "string" && exposedToolNameProblem(override.name) === null
        ? override.name
        : null;
    const description = optionalText(override.description, EXPOSED_TOOL_DESCRIPTION_MAX_LENGTH, "description").value;
    if (!name && !description) continue;
    if (name) nameCounts.set(exposedToolNameKey(name), (nameCounts.get(exposedToolNameKey(name)) ?? 0) + 1);
    result.set(upstreamToolName, { name, description });
  }
  for (const [upstreamToolName, override] of result) {
    if (override.name && (nameCounts.get(exposedToolNameKey(override.name)) ?? 0) > 1) {
      if (override.description) result.set(upstreamToolName, { name: null, description: override.description });
      else result.delete(upstreamToolName);
    }
  }
  return result;
}

/** Read the connection name and description shown to agents, when set. */
export function readConnectionAgentPresentation(config: unknown): ConnectionAgentPresentation {
  if (!isPlainRecord(config)) return { name: null, description: null };
  return {
    name: optionalText(
      config[CONNECTION_AGENT_DISPLAY_NAME_CONFIG_KEY],
      CONNECTION_AGENT_DISPLAY_NAME_MAX_LENGTH,
      "name",
    ).value,
    description: optionalText(
      config[CONNECTION_AGENT_DESCRIPTION_CONFIG_KEY],
      CONNECTION_AGENT_DESCRIPTION_MAX_LENGTH,
      "description",
    ).value,
  };
}
