import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeSandboxCallbackBridgeRequestForPolicy } from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { COMPANY_IMPORT_ROUTE_PATH } from "../routes/company-import-paths.js";
import { OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH } from "../services/tool-access.js";

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
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Route paths registered through an expression rather than a string literal,
 * keyed by the exact source text of that expression. The scanner fails on any
 * expression missing here, so a new one cannot drop out of the inventory.
 */
const NON_LITERAL_ROUTE_PATHS: Record<string, string> = {
  COMPANY_IMPORT_ROUTE_PATH,
  COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
  'OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH.replace(/^\\/api/, "")':
    OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH.replace(/^\/api/, ""),
};

/**
 * Parameters whose handler accepts a fixed set of values. Each value is
 * classified on its own, because the policy can treat them differently (for
 * example runtime-service start/stop/restart against run/repair).
 */
const ENUMERATED_PARAM_VALUES: Record<string, readonly string[]> = {
  action: ["start", "stop", "restart", "repair", "run"],
};

// `router.use(path, handler)` mounts a handler for every method and sub-path.
type RouteEntry = { method: (typeof METHODS)[number] | "USE"; path: string; file: string };

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

/** Read the first call argument starting at `start`, up to its top-level comma. */
function readFirstArgument(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return source.slice(start, index).trim();
      depth -= 1;
    } else if (char === "," && depth === 0) return source.slice(start, index).trim();
  }
  return source.slice(start).trim();
}

function listServerRoutes(): { routes: RouteEntry[]; unmounted: string[]; unresolved: string[] } {
  const mounts = readRouterMounts();
  const routes: RouteEntry[] = [];
  const unmounted: string[] = [];
  const unresolved: string[] = [];
  const files = readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const file of files.sort()) {
    const source = readFileSync(join(ROUTES_DIR, file), "utf8");
    const factories = [...source.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)\s*\(/g)]
      .map((match) => ({ name: match[1]!, index: match.index! }));
    for (const match of source.matchAll(/\brouter\.(get|post|put|patch|delete|all|use)\(\s*/g)) {
      const verb = match[1]!.toUpperCase();
      const argument = readFirstArgument(source, match.index! + match[0].length);
      let routePath: string | undefined;
      const literal = /^(["'`])([^"'`]*)\1$/.exec(argument);
      // A template literal may only interpolate the known path constants.
      const interpolated = literal?.[1] === "`"
        ? literal[2]!.replace(/\$\{\s*([A-Za-z0-9_]+)\s*\}/g, (whole, name: string) =>
          Object.prototype.hasOwnProperty.call(NON_LITERAL_ROUTE_PATHS, name) ? NON_LITERAL_ROUTE_PATHS[name]! : whole)
        : literal?.[2];
      if (interpolated !== undefined && !interpolated.includes("${")) {
        routePath = interpolated;
      } else if (Object.prototype.hasOwnProperty.call(NON_LITERAL_ROUTE_PATHS, argument)) {
        routePath = NON_LITERAL_ROUTE_PATHS[argument];
      } else if (verb === "USE" && !/^["'`]/.test(argument) && !/^[A-Z][A-Z0-9_]*$/.test(argument)) {
        // Path-less middleware (`router.use(fn)`) registers no route.
        continue;
      } else {
        unresolved.push(`${file}: router.${match[1]}(${argument.slice(0, 80)}`);
        continue;
      }
      if (verb === "ALL") {
        unresolved.push(`${file}: router.all(${argument}) is not classified; list its methods`);
        continue;
      }
      const factory = factories.filter((candidate) => candidate.index < match.index!).pop();
      const prefixes = factory ? mounts.get(factory.name) : undefined;
      if (!prefixes) {
        unmounted.push(`${file}: ${verb} ${routePath}`);
        continue;
      }
      for (const prefix of prefixes) {
        routes.push({ method: verb as RouteEntry["method"], path: `${prefix}${routePath}`, file });
      }
    }
  }
  return { routes, unmounted, unresolved };
}

/** Every concrete path to try for a route pattern. */
function samplePaths(routePath: string): Array<{ path: string; values: Record<string, string> }> {
  // Company-scoped routes use the run's own company; enumerated parameters
  // take each of their values; every other parameter gets a placeholder.
  let samples: Array<{ path: string; values: Record<string, string> }> = [
    { path: routePath.replace(/:companyId\b/g, RUN_COMPANY_ID), values: {} },
  ];
  for (const [name, values] of Object.entries(ENUMERATED_PARAM_VALUES)) {
    const pattern = new RegExp(`:${name}\\b\\??`, "g");
    if (!pattern.test(routePath)) continue;
    samples = samples.flatMap((sample) =>
      values.map((value) => ({
        path: sample.path.replace(pattern, value),
        values: { ...sample.values, [name]: value },
      })),
    );
  }
  return samples.map((sample) => ({ ...sample, path: sample.path.replace(/:[A-Za-z0-9_]+\??/g, "sample-id") }));
}

function allowed(method: string, path: string): boolean {
  return authorizeSandboxCallbackBridgeRequestForPolicy(
    { method, path },
    { policy: "agent", companyId: RUN_COMPANY_ID },
  ) === null;
}

/**
 * ALLOW or DENY when every sample agrees; otherwise MIXED, naming the allowed
 * samples. A `router.use` mount is tried for every method, at its own path and
 * one level below it.
 */
function classify(route: RouteEntry): string {
  const probes: Array<{ label: string; method: string; path: string }> = [];
  for (const sample of samplePaths(route.path)) {
    const valueLabel = Object.entries(sample.values).map(([name, value]) => `${name}=${value}`).join(",");
    if (route.method === "USE") {
      for (const method of METHODS) {
        probes.push({ label: method, method, path: sample.path });
        probes.push({ label: `${method} /*`, method, path: `${sample.path}/sample-id` });
      }
    } else {
      probes.push({ label: valueLabel, method: route.method, path: sample.path });
    }
  }
  const allowedLabels = probes.filter((probe) => allowed(probe.method, probe.path)).map((probe) => probe.label);
  if (allowedLabels.length === 0) return "DENY";
  if (allowedLabels.length === probes.length) return "ALLOW";
  return `MIXED (allows ${allowedLabels.join("; ")})`;
}

function decisionOf(route: RouteEntry): "allow" | "deny" | "mixed" {
  const decision = classify(route);
  return decision === "ALLOW" ? "allow" : decision === "DENY" ? "deny" : "mixed";
}

describe("agent bridge policy route inventory", () => {
  const { routes, unmounted, unresolved } = listServerRoutes();

  it("finds every registered route and its mount point", () => {
    expect(unmounted, "route factories not mounted in app.ts").toEqual([]);
    // A path the scanner cannot read would silently leave the inventory; add
    // it to NON_LITERAL_ROUTE_PATHS instead.
    expect(unresolved, "route paths the scanner cannot resolve").toEqual([]);
    // Guards the scanner itself: a regex that stops matching must not turn
    // this test into a no-op.
    expect(routes.length).toBeGreaterThan(700);
  });

  it("classifies every server route (update the snapshot only after reviewing new allows)", async () => {
    const lines = [...new Set(routes.map((route) => {
      const [decision, ...detail] = classify(route).split(" ");
      return [decision, route.method, route.path, ...detail].join(" ");
    }))].sort((left, right) => left.slice(6).localeCompare(right.slice(6)) || left.localeCompare(right));
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./__snapshots__/sandbox-bridge-agent-policy-routes.txt");
  });

  it("never forwards secret, credential, environment, or administration routes", () => {
    const mustDeny = routes.filter((route) => {
      const path = route.path.toLowerCase();
      return (
        /(?:^|\/)[^/]*secret[^/]*(?:\/|$)/.test(path) ||
        /(?:^|\/)(?:workspace-operations|feedback-traces)(?:\/|$)/.test(path) ||
        /^\/api\/companies\/:companyid\/(?:costs|audit)(?:\/|$)/.test(path) ||
        /^\/api\/plugins(?:\/|$)/.test(path) ||
        (route.method === "DELETE" && /^\/api\/(?:issues|labels)\/:[a-z]+$/.test(path)) ||
        (route.method !== "GET" && /^\/api\/issues\/:[a-z]+\/(?:watchdog|low-trust)(?:\/|$)/.test(path)) ||
        /^\/api\/approvals\/:[a-z]+\/(?:approve|reject|request-revision)$/.test(path) ||
        /^\/api\/agents\/:[a-z]+\/(?:runtime-state|task-sessions)(?:\/|$)/.test(path) ||
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
        /^\/api\/plugins(?:\/|$)/.test(path)
      );
    });
    expect(mustDeny.length).toBeGreaterThan(100);
    const forwarded = mustDeny.filter((route) => decisionOf(route) !== "deny")
      .map((route) => `${route.method} ${route.path} (${route.file})`);
    expect(forwarded).toEqual([]);
  });

  it("forwards the task, artifact, interaction, run, and summary routes agents rely on", () => {
    const required = [
      "POST /api/companies/:companyId/issues",
      "PATCH /api/issues/:id",
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
      expect(decisionOf(route!), key).toBe("allow");
    }
  });
});
