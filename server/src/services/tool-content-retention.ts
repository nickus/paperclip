import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolActionRequests, toolConnections } from "@paperclipai/db";
import {
  DEFAULT_TOOL_CONTENT_RETENTION,
  isToolContentRetention,
  readConfiguredToolContentRetention,
  type ToolContentRetention,
  type ToolRedactedValueSummary,
} from "@paperclipai/shared";

/**
 * Server side of per-connection content retention (see
 * packages/shared/src/tool-content-retention.ts). Every place that persists a
 * connected-tool call passes the value it is about to store through these
 * helpers, so a connection with `contentRetention: "none"` leaves hashes and
 * sizes behind but no argument text, result text or upstream error text.
 */

/** Instance-wide default for connections whose config chooses no retention. */
export const TOOL_CONTENT_RETENTION_DEFAULT_ENV = "PAPERCLIP_TOOL_CONTENT_RETENTION_DEFAULT";

type RetentionEnv = Partial<Record<typeof TOOL_CONTENT_RETENTION_DEFAULT_ENV, string | undefined>>;

/**
 * The instance default. Unset or empty keeps today's behaviour ("summary"). A
 * value that is set but not recognized fails closed to "none": the operator
 * asked to change what is kept, and keeping less is the safe reading.
 */
export function instanceDefaultToolContentRetention(
  env: RetentionEnv = process.env as RetentionEnv,
): ToolContentRetention {
  const raw = env[TOOL_CONTENT_RETENTION_DEFAULT_ENV]?.trim();
  if (!raw) return DEFAULT_TOOL_CONTENT_RETENTION;
  return isToolContentRetention(raw) ? raw : "none";
}

/**
 * The retention that applies to a connection: its own `config.contentRetention`
 * when set, otherwise the instance default. Read at call time, so changing the
 * setting affects the next call and never rewrites earlier records.
 */
export function resolveConnectionContentRetention(
  config: unknown,
  env: RetentionEnv = process.env as RetentionEnv,
): ToolContentRetention {
  return readConfiguredToolContentRetention(config) ?? instanceDefaultToolContentRetention(env);
}

/** Look up a stored connection's retention; a missing row gets the instance default. */
export async function connectionContentRetention(
  db: Pick<Db, "select">,
  companyId: string,
  connectionId: string | null | undefined,
): Promise<ToolContentRetention> {
  if (!connectionId) return DEFAULT_TOOL_CONTENT_RETENTION;
  const [row] = await db
    .select({ config: toolConnections.config })
    .from(toolConnections)
    .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)))
    .limit(1);
  return resolveConnectionContentRetention(row?.config);
}

/** True when a stored summary was written for a call that keeps no content. */
export function isUnretainedSummary(summary: unknown): boolean {
  return Boolean(
    summary &&
      typeof summary === "object" &&
      (summary as { contentRetention?: unknown }).contentRetention === "none",
  );
}

/**
 * The form of a redacted value summary that may be stored. For "summary" it is
 * the summary unchanged. For "none" only the sha256 and the size survive; the
 * text and the redacted field paths (which name the value's keys) are dropped
 * and the result is marked so readers can tell "not kept" from "empty".
 */
export function retainToolContentSummary<T extends ToolRedactedValueSummary>(
  summary: T,
  retention: ToolContentRetention,
): T | ToolRedactedValueSummary;
export function retainToolContentSummary<T extends ToolRedactedValueSummary>(
  summary: T | null | undefined,
  retention: ToolContentRetention,
): T | ToolRedactedValueSummary | null | undefined;
export function retainToolContentSummary<T extends ToolRedactedValueSummary>(
  summary: T | null | undefined,
  retention: ToolContentRetention,
): T | ToolRedactedValueSummary | null | undefined {
  if (!summary || retention !== "none") return summary;
  return {
    summary: "",
    sizeBytes: summary.sizeBytes ?? null,
    sha256: summary.sha256 ?? null,
    redactedFields: [],
    ...(summary.artifactId ? { artifactId: summary.artifactId } : {}),
    contentRetention: "none",
  };
}

/**
 * Error text to store for a failed call. Upstream tools put their own words in
 * errors (an MCP `isError` result carries the provider's text, an API error
 * may echo the request), so a connection that keeps no content stores only a
 * generic line; the error code is stored separately. The caller still sends
 * the original message to whoever made the call.
 */
export function retainToolErrorMessage(
  message: string | null | undefined,
  reasonCode: string | null | undefined,
  retention: ToolContentRetention,
): string | null {
  if (message === null || message === undefined) return null;
  if (retention !== "none") return message;
  return `Error details are not stored for this connection (content retention "none"); error code: ${reasonCode || "tool_execution_failed"}.`;
}

/** Keys in gateway audit details whose values carry call content. */
const SUMMARY_DETAIL_KEYS = ["argumentsSummary", "resultSummary", "requestSummary"] as const;
const ERROR_TEXT_DETAIL_KEYS = ["error", "errorMessage"] as const;

/**
 * Audit and activity details that may be stored for a call. For "none" the
 * argument and result summaries lose their text and upstream error text is
 * replaced; every other field (ids, decision, reason code, timings, the
 * result's shape flags) is metadata and stays.
 */
export function retainToolAuditDetails(
  details: Record<string, unknown>,
  retention: ToolContentRetention,
): Record<string, unknown> {
  if (retention !== "none") return details;
  const retained: Record<string, unknown> = { ...details, contentRetention: "none" };
  for (const key of SUMMARY_DETAIL_KEYS) {
    const value = retained[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      retained[key] = retainToolContentSummary(value as ToolRedactedValueSummary, "none");
    } else if (typeof value === "string") {
      retained[key] = "";
    }
  }
  for (const key of ERROR_TEXT_DETAIL_KEYS) {
    const value = retained[key];
    if (typeof value === "string") {
      retained[key] = retainToolErrorMessage(
        value,
        typeof retained.reasonCode === "string" ? retained.reasonCode : null,
        "none",
      );
    }
  }
  return retained;
}

/** Redaction plans list the redacted field paths, which name the value's keys. */
export function retainRedactionPlan<T extends { redactedFieldCount: number; redactedFields: string[] }>(
  plan: T,
  retention: ToolContentRetention,
): T {
  if (retention !== "none") return plan;
  return { ...plan, redactedFields: [] };
}

const SETTLED_ACTION_REQUEST_STATUSES = ["executed", "failed", "rejected", "expired", "cancelled"] as const;

/**
 * An approval-gated call has to keep its signed arguments until a human
 * decides and the gateway executes it. Once the request is settled nothing
 * reads them again, so for a call that keeps no content drop them. Scope to one
 * request after a transition, or run unscoped from the periodic sweep to catch
 * requests settled on paths that do not call this directly.
 */
export async function purgeSettledUnretainedActionArguments(
  db: Pick<Db, "update">,
  scope: { actionRequestId?: string; companyId?: string } = {},
): Promise<number> {
  const rows = await db
    .update(toolActionRequests)
    .set({ signedArguments: null })
    .where(
      and(
        scope.actionRequestId ? eq(toolActionRequests.id, scope.actionRequestId) : undefined,
        scope.companyId ? eq(toolActionRequests.companyId, scope.companyId) : undefined,
        inArray(toolActionRequests.status, [...SETTLED_ACTION_REQUEST_STATUSES]),
        isNotNull(toolActionRequests.signedArguments),
        sql`${toolActionRequests.canonicalArgumentsSummary}->>'contentRetention' = 'none'`,
      ),
    )
    .returning({ id: toolActionRequests.id });
  return rows.length;
}
