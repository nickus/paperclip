import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { TOOL_CALL_CLIENT_TIMEOUT_MS } from "@paperclipai/shared/tool-call-timeouts";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * OpenCode names each MCP tool `<server>_<tool>`, replacing every character
 * outside [a-zA-Z0-9_-] with "_". Keying the config by that same form keeps two
 * servers whose names differ only in punctuation from shadowing each other's
 * tools.
 */
function openCodeMcpServerKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * OpenCode `mcp` entries for the Paperclip-managed MCP servers of one run, in
 * OpenCode's remote MCP server format. The bearer token goes into the entry's
 * request headers, so it only ever lives in the per-run config file.
 */
export function buildOpenCodeRuntimeMcpConfig(
  servers: AdapterRuntimeMcpServer[],
): Record<string, Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const baseKey = openCodeMcpServerKey(server.name) || "paperclip-mcp";
    // Same collision handling as the Claude adapter: suffix the connection id.
    const connectionSuffix = openCodeMcpServerKey(server.connectionId.slice(0, 8));
    let key = baseKey;
    if (Object.hasOwn(entries, key)) key = `${baseKey}-${connectionSuffix}`;
    let suffix = 2;
    while (Object.hasOwn(entries, key)) {
      key = `${baseKey}-${connectionSuffix}-${suffix}`;
      suffix += 1;
    }
    entries[key] = {
      type: "remote",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
      // The server authenticates with the bearer token above. Without this,
      // OpenCode answers a 401 by starting OAuth discovery against the server.
      oauth: false,
      enabled: true,
      // OpenCode gives up on an MCP tool call after 60 s unless the server
      // entry sets a timeout (in ms, used for every request to that server).
      // The Paperclip gateway enforces each tool's own deadline, up to five
      // minutes, and answers with a `tool_timeout` error when it passes; give
      // the client a little more so that answer arrives instead of a
      // client-side abort.
      timeout: TOOL_CALL_CLIENT_TIMEOUT_MS,
    };
  }
  return entries;
}

/**
 * Put the run's managed MCP servers into an OpenCode config, keeping the
 * user's own MCP servers except where a managed server takes the same name
 * (and so the same tool names). Returns the notes to log.
 */
function mergeOpenCodeRuntimeMcpServers(
  config: Record<string, unknown>,
  servers: AdapterRuntimeMcpServer[],
): string[] {
  const managedMcp = buildOpenCodeRuntimeMcpConfig(servers);
  const inheritedMcp = isPlainObject(config.mcp) ? config.mcp : {};
  const keptMcp: Record<string, unknown> = {};
  const replacedMcp: string[] = [];
  for (const [key, value] of Object.entries(inheritedMcp)) {
    if (Object.hasOwn(managedMcp, openCodeMcpServerKey(key))) replacedMcp.push(key);
    else keptMcp[key] = value;
  }
  config.mcp = { ...keptMcp, ...managedMcp };
  const notes = [
    `Added ${servers.length} Paperclip-managed MCP server(s) to the runtime OpenCode config: ${Object.keys(managedMcp).join(", ")}.`,
  ];
  if (replacedMcp.length > 0) {
    notes.push(
      `Paperclip-managed MCP servers replace the OpenCode MCP server(s) of the same name from the user config: ${replacedMcp.join(", ")}.`,
    );
  }
  return notes;
}

/**
 * The runtime `opencode.json` text with the run's managed MCP servers added.
 * A remote run calls this once its callback bridge is up, with the servers as
 * the target reaches them, and ships the result to the target.
 */
export function renderOpenCodeRuntimeConfigWithMcpServers(
  configText: string,
  servers: AdapterRuntimeMcpServer[],
): { text: string; notes: string[] } {
  const parsed = JSON.parse(configText) as unknown;
  const config = isPlainObject(parsed) ? { ...parsed } : {};
  const notes = mergeOpenCodeRuntimeMcpServers(config, servers);
  return { text: `${JSON.stringify(config, null, 2)}\n`, notes };
}

/**
 * Resolve the baseURL of the OpenCode provider the configured model
 * (`config.model`, `"<provider>/<model>"`) would route through, when that
 * provider is a custom gateway declared via PAPERCLIP_OPENCODE_PROVIDERS
 * (see prepareOpenCodeRuntimeConfig above for why that env var exists).
 *
 * Returns null whenever the baseURL isn't knowable this way: `config.model`
 * isn't in `"<provider>/<model>"` form, PAPERCLIP_OPENCODE_PROVIDERS doesn't
 * declare that provider, or the provider entry has no `options.baseURL`. A
 * caller that only wants to act when the baseURL IS known (e.g. a pre-spawn
 * health probe) should treat null as "nothing to check", not as a failure.
 */
export function resolveConfiguredOpenCodeProviderBaseUrl(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): string | null {
  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (!configuredModel) return null;

  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    [], // discard notes here -- this is a lookup, not the config-writing path
  );
  const providerEntry = gatewayProviders?.[configuredModel.provider];
  if (!isPlainObject(providerEntry)) return null;
  const options = providerEntry.options;
  if (!isPlainObject(options)) return null;
  const baseUrl = options.baseURL;
  return typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl.trim() : null;
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
  /** Paperclip-managed MCP servers of this run (`ctx.runtimeMcp.getServers()`). */
  runtimeMcpServers?: AdapterRuntimeMcpServer[];
  /**
   * Prepare the config for the managed MCP servers but leave them out: a
   * remote run adds them with {@link renderOpenCodeRuntimeConfigWithMcpServers}
   * once its callback bridge is up, so no server token is staged before that.
   */
  deferRuntimeMcpServers?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const runtimeMcpServers = input.runtimeMcpServers ?? [];
  // The Paperclip-managed MCP servers need a per-run config even when the
  // agent keeps OpenCode's own permission prompts.
  if (!skipPermissions && runtimeMcpServers.length === 0) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const writeRuntimeConfig = async (
    nextConfig: Record<string, unknown>,
    notes: string[],
  ): Promise<PreparedOpenCodeRuntimeConfig> => {
    if (runtimeMcpServers.length > 0 && input.deferRuntimeMcpServers) {
      notes.push(
        `Prepared the runtime OpenCode config for ${runtimeMcpServers.length} Paperclip-managed MCP server(s); they are added once the callback bridge is up.`,
      );
    } else if (runtimeMcpServers.length > 0) {
      notes.push(...mergeOpenCodeRuntimeMcpServers(nextConfig, runtimeMcpServers));
    }
    // The runtime config can carry credentials (MCP bearer tokens, resolved
    // provider keys), so it is written owner-only. The copied entry is removed
    // first: it may be a symlink into the user's own config, which must never
    // receive the run's settings.
    try {
      await fs.rm(runtimeConfigPath, { force: true });
      await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (err) {
      // Do not leave a partly written config behind for a run that never starts.
      await fs.rm(runtimeConfigHome, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    return {
      env: {
        ...input.env,
        XDG_CONFIG_HOME: runtimeConfigHome,
      },
      notes,
      cleanup: async () => {
        await fs.rm(runtimeConfigHome, { recursive: true, force: true });
      },
    };
  };

  if (!skipPermissions) {
    // Only the managed MCP servers are added; OpenCode keeps the user's
    // permission rules and providers as they are.
    return await writeRuntimeConfig({ ...existingConfig }, []);
  }

  const notes = [
    "Injected runtime OpenCode config with permission=allow for all tools and connections.",
  ];

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (configuredModel) {
    const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
      ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const providerModels = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(providerModels[configuredModel.model])) {
      providerModels[configuredModel.model] = {};
      providerEntry.models = providerModels;
      nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
      notes.push(
        `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
      );
    }
  }

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: "allow",
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }
  return await writeRuntimeConfig(nextConfig, notes);
}

/**
 * Stable key of the account behind a managed AI connection: its grant and
 * responsible user, without the credential generation, so a rotated
 * credential keeps the same key. Null when the connection carries no identity.
 */
function managedConnectionAccountKey(connection: unknown): string | null {
  if (!connection || typeof connection !== "object") return null;
  const identity = (connection as { identity?: unknown }).identity;
  if (typeof identity !== "string") return null;
  const [grant, user] = identity.split(":");
  if (!grant) return null;
  return createHash("sha256").update(`${grant}:${user ?? ""}`).digest("hex").slice(0, 32);
}

export interface ManagedOpenCodeRemoteHome {
  /** Directory that holds every managed home of this runtime root. */
  managedAuthRoot: string;
  /** Name of this run's home under `managedAuthRoot`. */
  homeName: string;
  /** True when the home is shared by the runs of one account (a reused sandbox). */
  perAccount: boolean;
}

/**
 * Managed credentials must never leave host-only homes in a remote process.
 * Each run gets its own home, except in a sandbox the host keeps for the next
 * run of the same task (`reusedSandbox`): there the home is per account, so
 * OpenCode's session store (under XDG_DATA_HOME) is still there on the next
 * run and the session resumes, while a run with another account gets another
 * home. Returns where the home is, or null when the agent has no managed
 * connection.
 */
export function prepareManagedOpenCodeRemoteHomes(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeRootDir: string | null | undefined;
  runId: string;
  configDir?: string;
  reusedSandbox?: boolean;
}): ManagedOpenCodeRemoteHome | null {
  if (!input.config.managedAiConnection) return null;
  if (!input.runtimeRootDir) throw new Error("Managed OpenCode authentication requires an isolated remote runtime directory.");
  const accountKey = input.reusedSandbox ? managedConnectionAccountKey(input.config.managedAiConnection) : null;
  const managedAuthRoot = path.posix.join(input.runtimeRootDir, "managed-auth");
  const homeName = accountKey ? `account-${accountKey}` : input.runId;
  const home = path.posix.join(managedAuthRoot, homeName);
  Object.assign(input.env, {
    HOME: home,
    XDG_CONFIG_HOME: input.configDir ?? path.posix.join(home, "config"),
    XDG_DATA_HOME: path.posix.join(home, "data"),
    XDG_CACHE_HOME: path.posix.join(home, "cache"),
    XDG_STATE_HOME: path.posix.join(home, "state"),
  });
  return { managedAuthRoot, homeName, perAccount: accountKey !== null };
}

/**
 * Shell command that removes every managed home under `managedAuthRoot` except
 * the current one: in a reused sandbox, homes of earlier runs and of other
 * accounts must not pile up or stay readable by later runs.
 */
export function buildPruneManagedOpenCodeHomesCommand(home: ManagedOpenCodeRemoteHome): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return (
    `mkdir -p ${quote(home.managedAuthRoot)} && ` +
    `find ${quote(home.managedAuthRoot)} -mindepth 1 -maxdepth 1 ! -name ${quote(home.homeName)} -exec rm -rf -- {} +`
  );
}
