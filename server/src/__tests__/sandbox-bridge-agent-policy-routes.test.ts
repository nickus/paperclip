import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeSandboxCallbackBridgeRequestForPolicy } from "@paperclipai/adapter-utils/sandbox-callback-bridge";

/**
 * Route inventory for the `agent` bridge policy.
 *
 * Remote (SSH and sandbox) runs reach the control plane through the Paperclip
 * API bridge. Under the `agent` policy the bridge forwards route families
 * rather than a fixed route list, so a route added later inside an allowed
 * family becomes reachable from remote runs without anyone deciding that it
 * should. This test statically lists every route the server registers,
 * evaluates the `agent` policy for it, and compares the result with a
 * checked-in snapshot. A new or reclassified route fails the test until the
 * snapshot is reviewed and updated (`vitest -u`).
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = join(SRC_DIR, "routes");
const RUN_COMPANY_ID = "company-1";

type RouteEntry = { method: string; path: string; file: string };

function readRouterMounts(): Map<string, string[]> {
  const app = readFileSync(join(SRC_DIR, "app.ts"), "utf8");
  const mounts = new Map<string, string[]>();
  // `app.use(fooRoutes(...))`, `api.use("/prefix", fooRoutes(...))`; `api` is
  // the router mounted at `/api`.
  for (const match of app.matchAll(/\b(app|api)\.use\(\s*(?:"([^"]*)"\s*,\s*)?([A-Za-z0-9_]+)\(/g)) {
    const prefix = (match[1] === "api" ? "/api" : "") + (match[2] ?? "");
    mounts.set(match[3]!, [...(mounts.get(match[3]!) ?? []), prefix]);
  }
  return mounts;
}

function listServerRoutes(): { routes: RouteEntry[]; unmounted: string[] } {
  const mounts = readRouterMounts();
  const routes: RouteEntry[] = [];
  const unmounted: string[] = [];
  const files = readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const file of files.sort()) {
    const source = readFileSync(join(ROUTES_DIR, file), "utf8");
    const factories = [...source.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)\s*\(/g)]
      .map((match) => ({ name: match[1]!, index: match.index! }));
    for (const match of source.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
      const factory = factories.filter((candidate) => candidate.index < match.index!).pop();
      const prefixes = factory ? mounts.get(factory.name) : undefined;
      if (!prefixes) {
        unmounted.push(`${file}: ${match[1]!.toUpperCase()} ${match[3]}`);
        continue;
      }
      for (const prefix of prefixes) {
        routes.push({ method: match[1]!.toUpperCase(), path: `${prefix}${match[3]}`, file });
      }
    }
  }
  return { routes, unmounted };
}

function samplePath(routePath: string): string {
  // Company-scoped routes use the run's own company; every other parameter
  // gets a plain placeholder value.
  return routePath
    .replace(/:companyId\b/g, RUN_COMPANY_ID)
    .replace(/:[A-Za-z0-9_]+\??/g, "sample-id");
}

function classify(route: RouteEntry): "allow" | "deny" {
  return authorizeSandboxCallbackBridgeRequestForPolicy(
    { method: route.method, path: samplePath(route.path) },
    { policy: "agent", companyId: RUN_COMPANY_ID },
  ) === null
    ? "allow"
    : "deny";
}

describe("agent bridge policy route inventory", () => {
  const { routes, unmounted } = listServerRoutes();

  it("finds every registered route and its mount point", () => {
    expect(unmounted, "route factories not mounted in app.ts").toEqual([]);
    // Guards the scanner itself: a regex that stops matching must not turn
    // this test into a no-op.
    expect(routes.length).toBeGreaterThan(700);
  });

  it("classifies every server route (update the snapshot only after reviewing new allows)", async () => {
    const lines = [...new Set(routes.map((route) => `${classify(route).toUpperCase()} ${route.method} ${route.path}`))]
      .sort((left, right) => left.slice(6).localeCompare(right.slice(6)) || left.localeCompare(right));
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./__snapshots__/sandbox-bridge-agent-policy-routes.txt");
  });

  it("never forwards secret, credential, environment, or administration routes", () => {
    const mustDeny = routes.filter((route) => {
      const path = route.path.toLowerCase();
      return (
        /(?:^|\/)[^/]*secret[^/]*(?:\/|$)/.test(path) ||
        /^\/api\/(?:companies\/:companyid\/)?environments?(?:\/|$)/.test(path) ||
        /^\/api\/environment-[^/]+(?:\/|$)/.test(path) ||
        /^\/api\/(?:instance|admin|adapters|board-api-keys|cli-auth|auth|invites|join-requests|bootstrap|board-claim|tool-connections|tool-profiles|tool-profile-entries|tool-applications|tool-gateway|connection-intents)(?:\/|$)/.test(path) ||
        /^\/api\/companies\/:companyid\/(?:tools|ai-connections|adapters|claude-oauth-token-status|setup-token-login-sessions|provider-traces|invites|join-requests|exports?|imports?|budgets|cost-events|finance-events|budget-incidents)(?:\/|$)/.test(path) ||
        /^\/api\/agents\/:[a-z]+\/(?:keys|permissions|budgets)(?:\/|$)/.test(path) ||
        /provider-trace/.test(path) ||
        (route.method !== "GET" && /^\/api\/agents\/:[a-z]+$/.test(path)) ||
        (route.method !== "GET" && /^\/api\/agents\/:[a-z]+\/(?:instructions-bundle|config-revisions)(?:\/|$)/.test(path)) ||
        (route.method !== "GET" && /^\/api\/projects(?:\/|$)/.test(path)) ||
        (route.method !== "GET" && /^\/api\/heartbeat-runs(?:\/|$)/.test(path)) ||
        /^\/api\/plugins\/(?!tools(?:\/execute)?$)/.test(path)
      ) && !(route.method === "GET" && path === "/api/companies/:companyid/budgets/overview");
    });
    expect(mustDeny.length).toBeGreaterThan(100);
    const forwarded = mustDeny.filter((route) => classify(route) === "allow")
      .map((route) => `${route.method} ${route.path} (${route.file})`);
    expect(forwarded).toEqual([]);
  });

  it("forwards the task, artifact, interaction, run, and summary routes agents rely on", () => {
    const required = [
      "POST /api/companies/:companyId/issues",
      "PATCH /api/issues/:id",
      "DELETE /api/issues/:id",
      "POST /api/issues/:id/comments",
      "POST /api/issues/:id/checkout",
      "POST /api/issues/:id/release",
      "POST /api/issues/:id/children",
      "PUT /api/issues/:id/documents/:key",
      "POST /api/issues/:id/work-products",
      "POST /api/companies/:companyId/issues/:issueId/attachments",
      "POST /api/issues/:id/interactions",
      "POST /api/issues/:id/interactions/:interactionId/withdraw",
      "GET /api/issues/:id/recovery-actions",
      "POST /api/issues/:id/recovery-actions/resolve",
      "POST /api/companies/:companyId/labels",
      "GET /api/companies/:companyId/heartbeat-runs",
      "GET /api/heartbeat-runs/:runId/events",
      "GET /api/heartbeat-runs/:runId/log",
      "GET /api/agents/:id/instructions-bundle",
      "GET /api/agents/:id/instructions-bundle/file",
      "GET /api/companies/:companyId/summary-slots/:scopeKind/:slotKey",
      "PUT /api/companies/:companyId/summary-slots/:scopeKind/:slotKey",
      "POST /api/agents/:id/wakeup",
      "GET /api/companies/:companyId/agents",
      "PATCH /api/routines/:id",
    ];
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
    for (const key of required) {
      const route = byKey.get(key);
      expect(route, `${key} is registered`).toBeDefined();
      expect(classify(route!), key).toBe("allow");
    }
  });
});
