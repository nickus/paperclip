import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import type { GetQuotaWindowsContext, QuotaWindowsCredential } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { listServerAdapters } from "../adapters/registry.js";
import { agentService } from "./agents.js";
import { isFixedClaudeOAuthBinding, readClaudeOAuthBinding, secretService } from "./secrets.js";

const QUOTA_PROVIDER_TIMEOUT_MS = 20_000;
const CLAUDE_LOCAL_ADAPTER_TYPE = "claude_local";
const CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

function providerSlugForAdapterType(type: string): string {
  switch (type) {
    case "claude_local":
      return "anthropic";
    case "codex_local":
      return "openai";
    default:
      return type;
  }
}

/** Actor identity the route derived from `req.actor`, used to resolve any
 *  secret bindings we find on the company's agents the same way the agents
 *  routes already do (see server/src/routes/authz.ts buildActorSecretContext). */
export interface QuotaActorContext {
  actorType: "agent" | "user";
  actorId: string | null;
  actorSource?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant";
  responsibleUserId: string | null;
}

/**
 * Asks each registered adapter the company actually uses for its provider
 * quota windows and aggregates the results. An adapter whose type no agent of
 * this company uses is skipped entirely — never polled, never shown — so an
 * unused provider cannot surface a broken or empty panel. Adapters that don't
 * implement getQuotaWindows() are silently skipped. Individual adapter
 * failures are caught and returned as error results rather than letting one
 * provider's outage block the entire response.
 *
 * For claude_local specifically, this also resolves the company's distinct
 * bound `CLAUDE_CODE_OAUTH_TOKEN` credentials (company secret_ref and the
 * fixed user_secret_ref "Claude login" binding) through the same audited
 * secret-resolution path the agents routes use, and polls each one
 * separately so the UI can show one panel per distinct bound token instead
 * of one panel that only ever reflects the Paperclip host's own login. An
 * agent with no such binding keeps falling back to the host-login probe
 * (unchanged behavior).
 */
export async function fetchAllQuotaWindows(
  db: Db,
  companyId: string,
  actor: QuotaActorContext,
): Promise<ProviderQuotaResult[]> {
  const agents = await agentService(db).list(companyId);
  const adapterTypesInUse = new Set(agents.map((agent) => agent.adapterType));
  const adapters = listServerAdapters().filter(
    (a) => a.getQuotaWindows != null && adapterTypesInUse.has(a.type),
  );

  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const ctx =
        adapter.type === CLAUDE_LOCAL_ADAPTER_TYPE
          ? await buildClaudeQuotaContext(db, companyId, actor, agents.filter((a) => a.adapterType === CLAUDE_LOCAL_ADAPTER_TYPE))
          : undefined;
      const raw = await withQuotaTimeout(adapter.type, adapter.getQuotaWindows!(ctx));
      return Array.isArray(raw) ? raw : [raw];
    }),
  );

  return settled.flatMap((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const adapterType = adapters[i]!.type;
    return [{
      provider: providerSlugForAdapterType(adapterType),
      ok: false,
      error: String(result.reason),
      windows: [],
    }];
  });
}

async function withQuotaTimeout(
  adapterType: string,
  task: Promise<ProviderQuotaResult | ProviderQuotaResult[]>,
): Promise<ProviderQuotaResult | ProviderQuotaResult[]> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<ProviderQuotaResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: providerSlugForAdapterType(adapterType),
            ok: false,
            error: `quota polling timed out after ${Math.round(QUOTA_PROVIDER_TIMEOUT_MS / 1000)}s`,
            windows: [],
          });
        }, QUOTA_PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// claude_local: resolve the company's distinct bound CLAUDE_CODE_OAUTH_TOKEN
// credentials and the latest passively-observed rate-limit snapshot for each.
// ---------------------------------------------------------------------------

type PendingClaudeCredential = {
  /** Stable, non-secret identity used to dedupe agents that share one binding. */
  dedupeKey: string;
  label: string;
  /** The raw env binding to resolve via the audited secret service, or null
   *  when `plainValue` already carries the resolved value directly. */
  binding: unknown;
  plainValue?: string;
  agentIds: string[];
}

function claudeOAuthBindingDedupeKey(raw: unknown): { key: string; label: string; plainValue?: string } | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { key: `plain:${createHash("sha256").update(trimmed).digest("hex")}`, label: "Claude token", plainValue: trimmed };
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (isFixedClaudeOAuthBinding(raw)) {
    // The fixed user_secret_ref binding always resolves against "whichever
    // user is responsible for this read" (see resolveEnvBindings' context),
    // not a token baked into the binding itself, so every agent using it
    // shares exactly one company-wide "Claude login" panel.
    return { key: "user_secret_ref:CLAUDE_CODE_OAUTH_TOKEN", label: "Claude login" };
  }
  if (record.type === "secret_ref" && typeof record.secretId === "string") {
    const version = record.version === undefined ? "latest" : String(record.version);
    return { key: `secret_ref:${record.secretId}:${version}`, label: "Claude token" };
  }
  if (record.type === "plain" && typeof record.value === "string" && record.value.trim()) {
    const trimmed = record.value.trim();
    return { key: `plain:${createHash("sha256").update(trimmed).digest("hex")}`, label: "Claude token", plainValue: trimmed };
  }
  return null;
}

/**
 * Build the getQuotaWindows() context for claude_local: one entry per
 * distinct bound CLAUDE_CODE_OAUTH_TOKEN among the company's claude_local
 * agents (resolved to an env var through the audited secret service, never
 * exposing a secret reference to the adapter), plus one "Server login" entry
 * when at least one claude_local agent carries no such binding at all (the
 * existing host-login probe).
 */
async function buildClaudeQuotaContext(
  db: Db,
  companyId: string,
  actor: QuotaActorContext,
  claudeLocalAgents: Array<{ id: string; adapterConfig: Record<string, unknown> }>,
): Promise<GetQuotaWindowsContext> {
  const pendingByKey = new Map<string, PendingClaudeCredential>();
  const hostLoginAgentIds: string[] = [];

  for (const agent of claudeLocalAgents) {
    const raw = readClaudeOAuthBinding(agent.adapterConfig);
    if (raw == null) {
      hostLoginAgentIds.push(agent.id);
      continue;
    }
    const identity = claudeOAuthBindingDedupeKey(raw);
    if (!identity) {
      // A binding is present but not a shape this aggregator understands
      // (e.g. a malformed config). Never fall back to the host login for
      // it — that would silently show the wrong account — surface it as
      // its own unresolved credential instead.
      pendingByKey.set(`unsupported:${agent.id}`, {
        dedupeKey: `unsupported:${agent.id}`,
        label: "Claude token",
        binding: raw,
        agentIds: [agent.id],
      });
      continue;
    }
    const existing = pendingByKey.get(identity.key);
    if (existing) {
      existing.agentIds.push(agent.id);
      continue;
    }
    pendingByKey.set(identity.key, {
      dedupeKey: identity.key,
      label: identity.label,
      binding: identity.plainValue == null ? raw : null,
      plainValue: identity.plainValue,
      agentIds: [agent.id],
    });
  }

  // Company secret_ref bindings get the real secret name as their label when
  // it can be looked up; fall back to the generic label on any failure.
  const secretsSvc = secretService(db);
  await Promise.all(
    [...pendingByKey.values()]
      .filter((pending) => pending.dedupeKey.startsWith("secret_ref:"))
      .map(async (pending) => {
        const secretId = pending.dedupeKey.split(":")[1];
        if (!secretId) return;
        try {
          const secret = await secretsSvc.getById(secretId);
          if (secret?.name) pending.label = secret.name;
        } catch {
          // keep the generic label
        }
      }),
  );

  const credentials: QuotaWindowsCredential[] = await Promise.all(
    [...pendingByKey.values()].map(async (pending): Promise<QuotaWindowsCredential> => {
      const passiveSnapshot = await latestClaudeRateLimitSnapshot(db, companyId, pending.agentIds);
      if (pending.plainValue != null) {
        return {
          key: pending.dedupeKey,
          label: pending.label,
          env: { [CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY]: pending.plainValue },
          passiveSnapshot,
        };
      }
      try {
        const resolution = await secretsSvc.resolveEnvBindings(
          companyId,
          { [CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY]: pending.binding },
          {
            consumerType: "agent",
            consumerId: pending.agentIds[0]!,
            actorType: actor.actorType,
            actorId: actor.actorId,
            actorSource: actor.actorSource,
            responsibleUserId: actor.responsibleUserId,
          },
        );
        const token = resolution.env[CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY];
        if (!token) {
          // Resolved to nothing (e.g. an optional, unset user secret) — no
          // token to poll with, but still worth a panel that says so.
          return { key: pending.dedupeKey, label: pending.label, env: {}, passiveSnapshot };
        }
        return {
          key: pending.dedupeKey,
          label: pending.label,
          env: { [CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY]: token },
          passiveSnapshot,
        };
      } catch {
        // Binding exists but could not be resolved (missing secret, revoked
        // access, etc.) — never throw out of here and never leak why in a
        // way that could carry secret material; the adapter's own
        // getQuotaWindows() turns a credential with no token into an
        // ok:false result, falling back to the passive snapshot if any.
        return { key: pending.dedupeKey, label: pending.label, env: {}, passiveSnapshot };
      }
    }),
  );

  if (hostLoginAgentIds.length > 0) {
    credentials.push({
      key: "host_login",
      label: "Server login",
      env: {},
      passiveSnapshot: await latestClaudeRateLimitSnapshot(db, companyId, hostLoginAgentIds),
    });
  }

  return { credentials };
}

/**
 * The most recent passively-observed `claudeRateLimit` snapshot (see
 * packages/adapters/claude-local/src/server/parse.ts) among the given
 * agents' heartbeat runs, read straight from the already-persisted
 * `result_json` column rather than a new table — this data already exists
 * for every run execute.ts recorded it on. Returns null when none of the
 * given agents have ever recorded one.
 */
async function latestClaudeRateLimitSnapshot(
  db: Db,
  companyId: string,
  agentIds: string[],
): Promise<Record<string, unknown> | null> {
  if (agentIds.length === 0) return null;
  const rows = await db
    .select({ resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.agentId, agentIds),
      // Only finished runs ever have a result_json worth reading. Required
      // explicitly: Postgres sorts NULL as the greatest value by default, so
      // an unfiltered "ORDER BY finished_at DESC" would put still-running
      // runs (finished_at null) ahead of the completed ones we want.
      isNotNull(heartbeatRuns.finishedAt),
    ))
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(20);
  for (const row of rows) {
    const resultJson = row.resultJson;
    if (typeof resultJson !== "object" || resultJson === null) continue;
    const snapshot = (resultJson as Record<string, unknown>).claudeRateLimit;
    if (typeof snapshot === "object" && snapshot !== null) {
      return snapshot as Record<string, unknown>;
    }
  }
  return null;
}
