/**
 * Relaying a run's Paperclip-managed MCP servers through the callback bridge.
 *
 * The host hands a run its managed MCP servers (`ctx.runtimeMcp.getServers()`)
 * as URLs on the Paperclip API origin, each with its own bearer token. A
 * remote execution target (SSH or sandbox) reaches Paperclip through the run's
 * callback bridge: the agent's `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`
 * point at the in-target gateway, not at the host. Handing the host URLs to the
 * target only works when the target happens to have a network path to the
 * host, and it puts every server token (including a server that authenticates
 * with the run's own host API token) into the target's files.
 *
 * The relay registers each managed server's exact path with the bridge. The
 * target addresses the server at the bridge origin with the bridge token, like
 * any other Paperclip API call; the host forwards the request to the API with
 * that server's own token instead of the host API token. No server token
 * reaches the target.
 *
 * A server on a Paperclip API origin that cannot be relayed as it is (for
 * example a second server on an already relayed path with another credential,
 * or a URL with user info) is withheld: the target could not reach it at the
 * host address anyway, and handing it over would copy its token into the
 * target for nothing. Only servers on other origins are handed over unchanged,
 * since the target is expected to reach those at their own address.
 *
 * Route policy: the bridge policies bound what a run can reach with the host
 * API token. A relayed route never carries that token (unless the server's own
 * credential is it), and it exists only because the host handed that server to
 * this run, so it is forwarded under every policy. Nothing else under `/mcp` or
 * `/api/mcp` becomes reachable.
 */

import type { AdapterRuntimeMcpServer } from "./types.js";
import { describeNonCanonicalSandboxCallbackBridgePath } from "./sandbox-callback-bridge.js";

/** One relayed server route: the exact API path and the credential to forward with. */
export interface SandboxCallbackBridgeMcpRoute {
  name: string;
  path: string;
  token: string;
}

/** A server the bridge cannot relay and the target cannot use as it is, and why. */
export interface SandboxCallbackBridgeMcpWithheldServer {
  name: string;
  reason: string;
}

export interface SandboxCallbackBridgeMcpRelay {
  /** Names of the servers the bridge relays. */
  readonly relayedNames: readonly string[];
  /**
   * Names of the servers on other origins. They are handed to the target
   * unchanged; the target must reach them at their own address.
   */
  readonly externalNames: readonly string[];
  /**
   * Servers on a Paperclip API origin that cannot be relayed as they are, and
   * servers whose URL does not parse. They are left out of {@link serversFor}:
   * the target could not reach them, and their tokens must not land in the
   * target.
   */
  readonly withheld: readonly SandboxCallbackBridgeMcpWithheldServer[];
  /** The relayed route for an exact request path, if any. */
  routeFor(path: string): SandboxCallbackBridgeMcpRoute | null;
  /**
   * The run's servers as the execution target must address them: relayed ones
   * at the bridge origin with the bridge token, external ones unchanged, and
   * withheld ones left out.
   */
  serversFor(bridge: { baseUrl: string; token: string }): AdapterRuntimeMcpServer[];
}

function originOf(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins the host serves the Paperclip API on: the bridge's own forward
 * origin plus the configured public and runtime API URLs that managed MCP
 * server URLs are built from.
 */
export function paperclipApiOriginsForMcpRelay(
  hostApiUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [hostApiUrl, env.PAPERCLIP_API_URL, env.PAPERCLIP_RUNTIME_API_URL]
    .map(originOf)
    .filter((origin, index, all): origin is string => origin !== null && all.indexOf(origin) === index);
}

/**
 * Why a server on a Paperclip API origin cannot be relayed, or null when it
 * can. A second server may share a relayed path only with the same token,
 * because the bridge picks the credential by path alone.
 */
function withholdReason(
  server: AdapterRuntimeMcpServer,
  url: URL,
  routes: ReadonlyMap<string, SandboxCallbackBridgeMcpRoute>,
): string | null {
  if (url.username !== "" || url.password !== "") return "its URL carries user info";
  if (url.hash !== "") return "its URL has a fragment";
  const nonCanonical = describeNonCanonicalSandboxCallbackBridgePath(url.pathname);
  if (nonCanonical !== null) return `its path is not canonical (${nonCanonical})`;
  if (typeof server.token !== "string" || server.token.length === 0) return "it has no token to forward";
  const claimed = routes.get(url.pathname);
  if (claimed && claimed.token !== server.token) {
    return "another server already uses its path with a different token";
  }
  return null;
}

/**
 * Plan the relay for one run. A server on one of `paperclipOrigins` is relayed
 * when its path is canonical, it has a token, and no earlier server claimed
 * the same path with a different token; otherwise it is withheld. A server on
 * any other origin is external and left alone. A URL that does not parse
 * cannot be reached from any target and is withheld too.
 */
export function createSandboxCallbackBridgeMcpRelay(input: {
  servers: readonly AdapterRuntimeMcpServer[] | null | undefined;
  paperclipOrigins: readonly string[];
}): SandboxCallbackBridgeMcpRelay {
  const servers = [...(input.servers ?? [])];
  const origins = new Set(input.paperclipOrigins);
  const routes = new Map<string, SandboxCallbackBridgeMcpRoute>();
  // Per server index: how the target gets it.
  const dispositions: Array<"relayed" | "external" | "withheld"> = [];
  const relayedNames: string[] = [];
  const externalNames: string[] = [];
  const withheld: SandboxCallbackBridgeMcpWithheldServer[] = [];
  for (const server of servers) {
    let url: URL | null = null;
    try {
      url = new URL(server.url);
    } catch {
      url = null;
    }
    if (url === null) {
      dispositions.push("withheld");
      withheld.push({ name: server.name, reason: "its URL does not parse" });
      continue;
    }
    if (!origins.has(url.origin)) {
      dispositions.push("external");
      externalNames.push(server.name);
      continue;
    }
    const reason = withholdReason(server, url, routes);
    if (reason !== null) {
      dispositions.push("withheld");
      withheld.push({ name: server.name, reason });
      continue;
    }
    // A duplicate with the same token shares the route already registered.
    if (!routes.has(url.pathname)) {
      routes.set(url.pathname, { name: server.name, path: url.pathname, token: server.token });
    }
    dispositions.push("relayed");
    relayedNames.push(server.name);
  }

  return {
    relayedNames,
    externalNames,
    withheld,
    routeFor(path) {
      return routes.get(path) ?? null;
    },
    serversFor(bridge) {
      const base = bridge.baseUrl.replace(/\/+$/, "");
      const targetServers: AdapterRuntimeMcpServer[] = [];
      servers.forEach((server, index) => {
        const disposition = dispositions[index];
        if (disposition === "withheld") return; // never hand over its token
        if (disposition === "external") {
          targetServers.push({ ...server });
          return;
        }
        const url = new URL(server.url);
        targetServers.push({ ...server, url: `${base}${url.pathname}${url.search}`, token: bridge.token });
      });
      return targetServers;
    },
  };
}

/**
 * The response the bridge gives a relayed route for any method but POST,
 * without a round trip. Paperclip's MCP endpoints are stateless Streamable
 * HTTP servers with no server-initiated stream: 405 tells a client not to
 * open the optional GET stream (instead of re-polling it through the bridge)
 * and that there is no session to DELETE.
 */
export function sandboxCallbackBridgeMcpMethodNotAllowed(): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  return {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST" },
    body: Buffer.from(
      JSON.stringify({ error: "This MCP endpoint accepts only POST requests; it offers no event stream." }),
      "utf8",
    ),
  };
}
