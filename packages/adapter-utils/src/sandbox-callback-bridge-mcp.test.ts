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
    expect(relay.unrelayedNames).toEqual(["external"]);
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

  it("leaves a server at its own address when its path or credential cannot be relayed", () => {
    const relay = createSandboxCallbackBridgeMcpRelay({
      servers: [
        server("first", `${API}/mcp/gateways/gw_1`, "first-token"),
        // The same path with another credential: the bridge cannot tell them apart.
        server("second", `${API}/mcp/gateways/gw_1`, "second-token"),
        server("tokenless", `${API}/mcp/gateways/gw_3`, ""),
        server("encoded", `${API}/mcp/gateways/gw%2F6`),
        server("userinfo", "http://user:pass@paperclip.example.test:3100/mcp/gateways/gw_4"),
        server("other port", "http://paperclip.example.test:3200/mcp/gateways/gw_5"),
        server("not a url", "::"),
      ],
      paperclipOrigins: [API],
    });
    expect(relay.relayedNames).toEqual(["first"]);
    expect(relay.routeFor("/mcp/gateways/gw_1")?.token).toBe("first-token");
    const targetServers = relay.serversFor({ baseUrl: "http://127.0.0.1:4310", token: "bridge-token" });
    expect(targetServers.slice(1).map((entry) => entry.token)).toEqual([
      "second-token", "", "encoded-token", "userinfo-token", "other port-token", "not a url-token",
    ]);
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
