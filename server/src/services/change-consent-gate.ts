import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { RequestConfirmationPayload, RequestConfirmationResult } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export const AGENT_PROFILE_CHANGE_CONSENT_FIELDS = ["name", "role", "title", "capabilities"] as const;

type ConsumedRequestConfirmationResult = RequestConfirmationResult & {
  consumedAt?: string | null;
  consumedByRunId?: string | null;
};

export function agentInstructionsChangeTargetKey(agentId: string) {
  return `agent:${agentId}:instructions`;
}

export function agentProfileChangeTargetKey(agentId: string) {
  return `agent:${agentId}:profile`;
}

export function skillChangeTargetKey(skillId: string) {
  return `skill:${skillId}`;
}

export function skillSlugChangeTargetKey(slug: string) {
  return `skill-slug:${slug}`;
}

export function skillImportChangeTargetKey(source: string) {
  return `skill-import:${source}`;
}

export function skillsScanProjectsChangeTargetKey() {
  return "skills:scan-projects";
}

/**
 * Target keys the change-consent gate reads, including the legacy spellings it
 * still honours. A `request_confirmation` bound to one of them is change
 * consent, so only a board user may resolve it.
 */
const CHANGE_CONSENT_TARGET_KEY_PATTERNS: readonly RegExp[] = [
  /^agent:.+:(?:instructions|profile)$/,
  /^skill:.+$/,
  /^skill-slug:.+$/,
  /^skill-import:.+$/,
  /^skills:scan-projects$/,
  /^reflection-coach:.+$/,
];

export function isChangeConsentTargetKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  return trimmed.length > 0 && CHANGE_CONSENT_TARGET_KEY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function touchesAgentProfileChangeConsentFields(patchData: Record<string, unknown>) {
  return AGENT_PROFILE_CHANGE_CONSENT_FIELDS.some((key) =>
    Object.prototype.hasOwnProperty.call(patchData, key),
  );
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadHasDisplayedDiff(payload: RequestConfirmationPayload) {
  const details = readNonEmptyString(payload.detailsMarkdown);
  if (!details) return false;
  if (/```diff\b/i.test(details)) return true;
  return /(^|\n)[+-][^\n]+/.test(details);
}

function requestConfirmationResultConsumed(result: RequestConfirmationResult | null) {
  const consumed = result as ConsumedRequestConfirmationResult | null;
  return Boolean(readNonEmptyString(consumed?.consumedByRunId) || readNonEmptyString(consumed?.consumedAt));
}

function markRequestConfirmationResultConsumed(
  result: RequestConfirmationResult,
  actorRunId: string,
  consumedAt: Date,
): ConsumedRequestConfirmationResult {
  return {
    ...result,
    consumedAt: consumedAt.toISOString(),
    consumedByRunId: actorRunId,
  };
}

function legacyTargetKeysFor(targetKey: string) {
  if (targetKey.startsWith("agent:") && targetKey.endsWith(":instructions")) {
    const agentId = targetKey.slice("agent:".length, -":instructions".length);
    if (agentId) return [`reflection-coach:agent-instructions:${agentId}`];
  }
  if (targetKey.startsWith("agent:") && targetKey.endsWith(":profile")) {
    const agentId = targetKey.slice("agent:".length, -":profile".length);
    if (agentId) return [`reflection-coach:agent-description:${agentId}`];
  }
  if (targetKey.startsWith("skill:")) {
    const skillId = targetKey.slice("skill:".length);
    if (skillId) return [`reflection-coach:company-skill:${skillId}`];
  }
  if (targetKey.startsWith("skill-slug:")) {
    const slug = targetKey.slice("skill-slug:".length);
    if (slug) return [`reflection-coach:company-skill-slug:${slug}`];
  }
  if (targetKey.startsWith("skill-import:")) {
    const source = targetKey.slice("skill-import:".length);
    if (source) {
      return [
        `reflection-coach:company-skill-import:${source}`,
        `reflection-coach:company-skill-catalog:${source}`,
      ];
    }
  }
  if (targetKey === "skills:scan-projects") {
    return ["reflection-coach:company-skills:scan-projects"];
  }
  return [];
}

function expandTargetKeysForLegacyCompatibility(targetKeys: string[]) {
  const expanded = new Set<string>();
  for (const targetKey of targetKeys) {
    expanded.add(targetKey);
    for (const legacyTargetKey of legacyTargetKeysFor(targetKey)) {
      expanded.add(legacyTargetKey);
    }
  }
  return [...expanded];
}

/** A change consent a change consumed, as `consume` returns it. */
export interface ChangeConsentReceipt {
  interactionId: string;
  companyId: string;
  consumedByRunId: string;
  consumedAt: string;
}

function missingConsent(targetKeys: string[]) {
  return forbidden(
    "This change requires a request_confirmation with a displayed diff for this target, "
      + "accepted by a board user, created in a previous run and not already consumed.",
    {
      code: "reflection_coach_mutation_gate_required",
      targetKeys,
    },
  );
}

export function changeConsentGateService(db: Db) {
  const gate = {
    /**
     * Consume an accepted change consent for `targetKeys`, or throw 403. Returns
     * null when there is no acting agent. `matchesChange`, when given, must also
     * accept the card's payload: the route uses it to check that the card showed
     * this exact change, so a card accepted for one change cannot apply another.
     */
    consume: async (input: {
      companyId: string;
      actorAgentId: string | null | undefined;
      actorRunId: string | null | undefined;
      targetKeys: string[];
      matchesChange?: (payload: RequestConfirmationPayload) => boolean;
    }): Promise<ChangeConsentReceipt | null> => {
      const actorAgentId = readNonEmptyString(input.actorAgentId);
      if (!actorAgentId) return null;

      const actorRunId = readNonEmptyString(input.actorRunId);
      if (!actorRunId) {
        throw forbidden("Reflection Coach mutations require a run id", {
          code: "reflection_coach_mutation_run_id_required",
        });
      }

      const targetKeys = [...new Set(input.targetKeys.map(readNonEmptyString).filter((key): key is string => Boolean(key)))];
      if (targetKeys.length === 0) {
        throw forbidden("Reflection Coach mutation target is not gateable", {
          code: "reflection_coach_mutation_target_required",
        });
      }
      const queryTargetKeys = expandTargetKeysForLegacyCompatibility(targetKeys);

      const targetKeyPredicate = or(
        ...queryTargetKeys.map((targetKey) =>
          sql`${issueThreadInteractions.payload}->'target'->>'key' = ${targetKey}`,
        ),
      );

      // Consent means a board user accepted the card. A card resolved by an
      // agent (including the one that created it, which the default
      // `anyone` resolver policy allows) or by the system never counts. Spent
      // cards are filtered here, before the limit, so older spent cards never
      // hide an unspent one.
      const rows = await db
        .select({
          id: issueThreadInteractions.id,
          sourceRunId: issueThreadInteractions.sourceRunId,
          payload: issueThreadInteractions.payload,
          result: issueThreadInteractions.result,
          resolvedByUserId: issueThreadInteractions.resolvedByUserId,
          resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.createdByAgentId, actorAgentId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "accepted"),
          isNotNull(issueThreadInteractions.resolvedByUserId),
          isNull(issueThreadInteractions.resolvedByAgentId),
          sql`coalesce(${issueThreadInteractions.result}->>'consumedByRunId', ${issueThreadInteractions.result}->>'consumedAt') is null`,
          targetKeyPredicate,
        ))
        .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt))
        .limit(50);

      const accepted = rows.find((row) => {
        const payload = row.payload as RequestConfirmationPayload;
        const result = row.result as RequestConfirmationResult | null;
        return payload.target?.type === "custom"
          && queryTargetKeys.includes(payload.target.key)
          && result?.outcome === "accepted"
          && Boolean(readNonEmptyString(row.resolvedByUserId))
          && !row.resolvedByAgentId
          && !requestConfirmationResultConsumed(result)
          && payloadHasDisplayedDiff(payload)
          && Boolean(row.sourceRunId)
          && row.sourceRunId !== actorRunId
          && (!input.matchesChange || input.matchesChange(payload));
      });

      const acceptedResult = accepted?.result as RequestConfirmationResult | null | undefined;
      if (!accepted || !acceptedResult) throw missingConsent(targetKeys);

      const now = new Date();
      const [consumed] = await db
        .update(issueThreadInteractions)
        .set({
          result: markRequestConfirmationResultConsumed(acceptedResult, actorRunId, now),
          updatedAt: now,
        })
        .where(and(
          eq(issueThreadInteractions.id, accepted.id),
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.createdByAgentId, actorAgentId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "accepted"),
          isNotNull(issueThreadInteractions.resolvedByUserId),
          isNull(issueThreadInteractions.resolvedByAgentId),
          sql`${issueThreadInteractions.result}->>'outcome' = 'accepted'`,
          sql`coalesce(${issueThreadInteractions.result}->>'consumedByRunId', ${issueThreadInteractions.result}->>'consumedAt') is null`,
        ))
        .returning({ id: issueThreadInteractions.id });

      if (!consumed) throw missingConsent(targetKeys);

      return {
        interactionId: accepted.id,
        companyId: input.companyId,
        consumedByRunId: actorRunId,
        consumedAt: now.toISOString(),
      };
    },

    assertConsented: async (input: {
      companyId: string;
      actorAgentId: string | null | undefined;
      actorRunId: string | null | undefined;
      targetKeys: string[];
    }): Promise<boolean> => (await gate.consume(input)) !== null,

    /**
     * Give back a consent a change consumed and then failed to apply, so the
     * same change can be retried. Only the consumption `receipt` names is
     * undone; a card consumed again since is left alone.
     */
    release: async (receipt: ChangeConsentReceipt): Promise<void> => {
      await db
        .update(issueThreadInteractions)
        .set({
          result: sql`(${issueThreadInteractions.result} - 'consumedAt') - 'consumedByRunId'`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueThreadInteractions.id, receipt.interactionId),
          eq(issueThreadInteractions.companyId, receipt.companyId),
          sql`${issueThreadInteractions.result}->>'consumedByRunId' = ${receipt.consumedByRunId}`,
          sql`${issueThreadInteractions.result}->>'consumedAt' = ${receipt.consumedAt}`,
        ));
    },
  };
  return gate;
}
