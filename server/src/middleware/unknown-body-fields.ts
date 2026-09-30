import type { NextFunction, Request, Response } from "express";
import { badRequest } from "../errors.js";

export const UNKNOWN_BODY_FIELDS_CODE = "unknown_fields";

const MAX_REPORTED_UNKNOWN_FIELDS = 20;
const MAX_SUGGESTED_FIELD_LENGTH = 64;

/**
 * How a route treats top-level JSON keys it does not accept.
 *
 * Non-strict Zod objects strip unknown keys, so a misnamed field (for example
 * `blockedBy` instead of `blockedByIssueIds`) used to return 200 while doing
 * nothing. Routes that opt into this policy reject such keys with a 400 that
 * names them, suggests the intended field, and lists what the route accepts.
 */
export interface UnknownBodyFieldPolicy {
  /** Payload name used in the error message, e.g. "issue update". */
  payloadName: string;
  /** Top-level keys the route accepts. */
  acceptedFields: readonly string[];
  /**
   * Alternative spellings that are renamed to their canonical field when the
   * canonical field is absent. Use only where the intent is unambiguous.
   */
  aliases?: Readonly<Record<string, string>>;
  /** Did-you-mean text for common wrong keys, keyed by the wrong key. */
  hints?: Readonly<Record<string, string>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editDistance(left: string, right: string): number {
  // Single-row Levenshtein distance; inputs are short JSON keys.
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex]!;
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex - 1]! + 1,
        above + 1,
        diagonal + substitutionCost,
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

// Compare keys without case or word separators, so `assignee_agent_id` and
// `AssigneeAgentId` both match `assigneeAgentId`.
function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The accepted key closest to `key` (case, separators or a small typo), if any. */
function nearestAcceptedField(key: string, accepted: readonly string[]): string | null {
  const normalizedKey = normalizeFieldName(key);
  if (!normalizedKey) return null;
  let best: { field: string; distance: number } | null = null;
  for (const field of accepted) {
    const normalizedField = normalizeFieldName(field);
    if (normalizedField === normalizedKey) return field;
    const distance = editDistance(normalizedKey, normalizedField);
    // Allow one edit for short keys and two for longer ones, so unrelated
    // short keys do not get a bogus hint.
    const threshold = Math.max(normalizedKey.length, normalizedField.length) >= 8 ? 2 : 1;
    if (distance > threshold || (best && distance >= best.distance)) continue;
    best = { field, distance };
  }
  return best?.field ?? null;
}

/**
 * Apply an {@link UnknownBodyFieldPolicy} to `req.body` before schema
 * validation. Non-object bodies pass through so the schema reports them.
 */
export function rejectUnknownBodyFields(policy: UnknownBodyFieldPolicy) {
  const accepted = new Set(policy.acceptedFields);
  const acceptedFields = [...policy.acceptedFields].sort();
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!isPlainObject(req.body)) {
      next();
      return;
    }
    let body = req.body;
    for (const [alias, canonical] of Object.entries(policy.aliases ?? {})) {
      // When both spellings are present the alias stays behind and is
      // reported below, rather than guessing which value was meant.
      if (!Object.hasOwn(body, alias) || Object.hasOwn(body, canonical)) continue;
      const { [alias]: value, ...rest } = body;
      body = { ...rest, [canonical]: value };
    }

    const unknownFields = Object.keys(body).filter((key) => !accepted.has(key));
    if (unknownFields.length === 0) {
      req.body = body;
      next();
      return;
    }

    // Report a bounded number of keys so an oversized body cannot make the
    // suggestion search (or the error message) arbitrarily large.
    const reportedFields = unknownFields.slice(0, MAX_REPORTED_UNKNOWN_FIELDS);
    const suggestions: Record<string, string> = {};
    for (const key of reportedFields) {
      const suggestion = policy.hints && Object.hasOwn(policy.hints, key)
        ? policy.hints[key]
        : key.length <= MAX_SUGGESTED_FIELD_LENGTH
          ? nearestAcceptedField(key, acceptedFields)
          : null;
      if (suggestion) suggestions[key] = suggestion;
    }
    const described = reportedFields.map((key) => {
      const shown = key.length > MAX_SUGGESTED_FIELD_LENGTH
        ? `${key.slice(0, MAX_SUGGESTED_FIELD_LENGTH)}...`
        : key;
      return Object.hasOwn(suggestions, key) ? `${shown} (did you mean ${suggestions[key]}?)` : shown;
    });
    if (unknownFields.length > reportedFields.length) {
      described.push(`and ${unknownFields.length - reportedFields.length} more`);
    }
    throw badRequest(
      `Unknown field${unknownFields.length === 1 ? "" : "s"} in ${policy.payloadName}: ${described.join(", ")}`,
      {
        code: UNKNOWN_BODY_FIELDS_CODE,
        remediation:
          `Unknown fields are rejected rather than ignored. Rename or remove them and resend; ` +
          `accepted fields: ${acceptedFields.join(", ")}.`,
        unknownFields: reportedFields,
        suggestions,
        acceptedFields,
      },
    );
  };
}
