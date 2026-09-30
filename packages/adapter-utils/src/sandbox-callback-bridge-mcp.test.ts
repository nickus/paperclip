import { describe, expect, it } from "vitest";

import {
  createSandboxCallbackBridgeMcpRelay,
  paperclipApiOriginsForMcpRelay,
  sandboxCallbackBridgeMcpMethodNotAllowed,
} from "./sandbox-callback-bridge-mcp.js";

const API = "http://paperclip.example.test:3100";

function server(name: string, url: string, token = `${name}-token`) {
  return { name, url, token, connectionId: `${name}-connection` };
}

describe("sandbox callback bridge MCP relay", () => {
  it("relays servers on a Paperclip API origin and points the target at the bridge", () => {
    const relay = createSandboxCallbackBridgeMcpRelay({
      servers: [
        server("Paperclip projects", `${API}/api/mcp/project-tools`),
        server("Paperclip connections", `${API}/mcp/runtime-tools`),
        server("paperclip-assigned", `${API}/mcp/gateways/gw_1?view=full`),
        server("external", "https://mcp.example.test/mcp"),
      ],
      paperclipOrigins: [API],
    });

    expect(relay.relayedNames).toEqual(["Paperclip projects", "Paperclip connections", "paperclip-assigned"]);
    expect(relay.externalNames).toEqual(["external"]);
    expect(relay.withheld).toEqual([]);
    expect(relay.routeFor("/mcp/runtime-tools")).toEqual({
      name: "Paperclip connections",
      path: "/mcp/runtime-tools",
      token: "Paperclip connections-token",
    });
    expect(relay.routeFor("/mcp/gateways/gw_2")).toBeNull();
    expect(relay.routeFor("/mcp/runtime-tools/")).toBeNull();

    expect(relay.serversFor({ baseUrl: "http://127.0.0.1:4310/", token: "bridge-token" })).toEqual([
      { ...server("Paperclip projects", "http://127.0.0.1:4310/api/mcp/project-tools"), token: "bridge-token" },
      { ...server("Paperclip connections", "http://127.0.0.1:4310/mcp/runtime-tools"), token: "bridge-token" },
      { ...server("paperclip-assigned", "http://127.0.0.1:4310/mcp/gateways/gw_1?view=full"), token: "bridge-token" },
      server("external", "https://mcp.example.test/mcp"),
    ]);
  });

  it("withholds a server on the Paperclip API origin whose path or credential cannot be relayed", () => {
    const relay = createSandboxCallbackBridgeMcpRelay({
      servers: [
        server("first", `${API}/mcp/gateways/gw_1`, "first-token"),
        // The same path with another credential: the bridge picks the token by path alone.
        server("second", `${API}/mcp/gateways/gw_1`, "second-token"),
        // The same path with the same credential shares the route.
        server("first again", `${API}/mcp/gateways/gw_1?view=full`, "first-token"),
        server("tokenless", `${API}/mcp/gateways/gw_3`, ""),
        server("encoded", `${API}/mcp/gateways/gw%2F6`),
        server("userinfo", "http://user:pass@paperclip.example.test:3100/mcp/gateways/gw_4"),
        server("fragment", `${API}/mcp/gateways/gw_7#part`),
        server("not a url", "::"),
        // Another port is another origin: not a Paperclip API server, left alone.
        server("other port", "http://paperclip.example.test:3200/mcp/gateways/gw_5"),
      ],
      paperclipOrigins: [API],
    });
    expect(relay.relayedNames).toEqual(["first", "first again"]);
    expect(relay.externalNames).toEqual(["other port"]);
    expect(relay.withheld).toEqual([
      { name: "second", reason: "another server already uses its path with a different token" },
      { name: "tokenless", reason: "it has no token to forward" },
      {
        name: "encoded",
        reason: "its path is not canonical (percent-encoded dot, slash, backslash, or NUL in path)",
      },
      { name: "userinfo", reason: "its URL carries user info" },
      { name: "fragment", reason: "its URL has a fragment" },
      { name: "not a url", reason: "its URL does not parse" },
    ]);
    expect(relay.routeFor("/mcp/gateways/gw_1")?.token).toBe("first-token");
    expect(relay.routeFor("/mcp/gateways/gw_3")).toBeNull();

    const targetServers = relay.serversFor({ baseUrl: "http://127.0.0.1:4310", token: "bridge-token" });
    // Withheld servers are not handed to the target at all, so none of their
    // tokens reach it; only the external server keeps its own address and token.
    expect(targetServers).toEqual([
      { ...server("first", "http://127.0.0.1:4310/mcp/gateways/gw_1"), token: "bridge-token" },
      { ...server("first again", "http://127.0.0.1:4310/mcp/gateways/gw_1?view=full"), token: "bridge-token" },
      server("other port", "http://paperclip.example.test:3200/mcp/gateways/gw_5"),
    ]);
    const handed = JSON.stringify(targetServers);
    for (const token of ["first-token", "second-token", "encoded-token", "userinfo-token", "fragment-token"]) {
      expect(handed).not.toContain(token);
    }
  });

  it("relays nothing without servers", () => {
    const relay = createSandboxCallbackBridgeMcpRelay({ servers: undefined, paperclipOrigins: [API] });
    expect(relay.relayedNames).toEqual([]);
    expect(relay.serversFor({ baseUrl: "http://127.0.0.1:4310", token: "bridge-token" })).toEqual([]);
  });

  it("collects the bridge forward origin and the configured API origins", () => {
    expect(paperclipApiOriginsForMcpRelay("http://127.0.0.1:3100", {
      PAPERCLIP_API_URL: "https://paperclip.example.test/api",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
    })).toEqual(["http://127.0.0.1:3100", "https://paperclip.example.test"]);
    expect(paperclipApiOriginsForMcpRelay("http://127.0.0.1:3100", { PAPERCLIP_API_URL: "not a url" }))
      .toEqual(["http://127.0.0.1:3100"]);
  });

  it("answers other methods with 405 and the allowed method", () => {
    const response = sandboxCallbackBridgeMcpMethodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("POST");
    expect(JSON.parse(response.body.toString("utf8")).error).toContain("only POST");
  });
});
