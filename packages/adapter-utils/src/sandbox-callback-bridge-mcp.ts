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

export interface SandboxCallbackBridgeMcpRelay {
  /** Names of the servers the bridge relays. */
  readonly relayedNames: readonly string[];
  /**
   * Names of the servers left at their own address because they are not on a
   * Paperclip API origin (or their path cannot be relayed as it is).
   */
  readonly unrelayedNames: readonly string[];
  /** The relayed route for an exact request path, if any. */
  routeFor(path: string): SandboxCallbackBridgeMcpRoute | null;
  /**
   * The run's servers as the execution target must address them: relayed ones
   * at the bridge origin with the bridge token, the rest unchanged.
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
 * Plan the relay for one run. A server is relayed when its URL is on one of
 * `paperclipOrigins`, its path is canonical, it has a token, and no earlier
 * server already claimed the same path.
 */
export function createSandboxCallbackBridgeMcpRelay(input: {
  servers: readonly AdapterRuntimeMcpServer[] | null | undefined;
  paperclipOrigins: readonly string[];
}): SandboxCallbackBridgeMcpRelay {
  const servers = [...(input.servers ?? [])];
  const origins = new Set(input.paperclipOrigins);
  const routes = new Map<string, SandboxCallbackBridgeMcpRoute>();
  const relayedIndexes = new Set<number>();
  const relayedNames: string[] = [];
  const unrelayedNames: string[] = [];
  servers.forEach((server, index) => {
    let url: URL | null = null;
    try {
      url = new URL(server.url);
    } catch {
      url = null;
    }
    const relayable =
      url !== null &&
      origins.has(url.origin) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      describeNonCanonicalSandboxCallbackBridgePath(url.pathname) === null &&
      typeof server.token === "string" &&
      server.token.length > 0 &&
      !routes.has(url.pathname);
    if (!relayable || !url) {
      unrelayedNames.push(server.name);
      return;
    }
    routes.set(url.pathname, { name: server.name, path: url.pathname, token: server.token });
    relayedIndexes.add(index);
    relayedNames.push(server.name);
  });

  return {
    relayedNames,
    unrelayedNames,
    routeFor(path) {
      return routes.get(path) ?? null;
    },
    serversFor(bridge) {
      const base = bridge.baseUrl.replace(/\/+$/, "");
      return servers.map((server, index) => {
        if (!relayedIndexes.has(index)) return { ...server };
        const url = new URL(server.url);
        return { ...server, url: `${base}${url.pathname}${url.search}`, token: bridge.token };
      });
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
