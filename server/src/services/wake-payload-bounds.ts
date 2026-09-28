/**
 * Hard size cap for the Paperclip wake payload.
 *
 * Each section of the wake payload has its own limits (comment window, issue
 * description, review contexts), which keep typical payloads well under
 * PAPERCLIP_WAKE_PAYLOAD_TARGET_BYTES. Those limits add up, though, so an issue
 * that hits all of them at once could still produce a payload that is too
 * large to hand to an agent process. This is the ceiling: when the serialized
 * payload exceeds the hard cap, the bulkiest optional detail is dropped step
 * by step, each step leaves a truncation marker, and `fallbackFetchNeeded`
 * tells the agent to read the rest through the API.
 */

export const PAPERCLIP_WAKE_PAYLOAD_TARGET_BYTES = 32 * 1024;
export const PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES = 64 * 1024;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function paperclipWakePayloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");
}

function capText(record: Json, key: string, flagKey: string, maxChars: number): Json {
  const value = record[key];
  if (typeof value !== "string" || value.length <= maxChars) return record;
  return { ...record, [key]: value.slice(0, maxChars), [flagKey]: true };
}

const steps: Array<(payload: Json) => Json> = [
  // Review contexts: keep totals and flags, drop the thread bodies.
  (payload) => {
    const context = payload.documentReviewContext;
    if (!isRecord(context) || !Array.isArray(context.documents) || context.documents.length === 0) return payload;
    const omitted = typeof context.omittedDocumentCount === "number" ? context.omittedDocumentCount : 0;
    return {
      ...payload,
      documentReviewContext: {
        ...context,
        documents: [],
        omittedDocumentCount: omitted + context.documents.length,
        truncated: true,
      },
    };
  },
  (payload) => {
    const context = payload.planReviewContext;
    if (!isRecord(context) || !Array.isArray(context.threads) || context.threads.length === 0) return payload;
    return { ...payload, planReviewContext: { ...context, threads: [], truncated: true } };
  },
  // Free text: shorten comment and annotation bodies, then the brief.
  (payload) => ({
    ...payload,
    comments: Array.isArray(payload.comments)
      ? payload.comments.map((comment) => (isRecord(comment) ? capText(comment, "body", "bodyTruncated", 1_000) : comment))
      : payload.comments,
    annotationDeltas: Array.isArray(payload.annotationDeltas)
      ? payload.annotationDeltas.map((delta) => (isRecord(delta) ? capText(delta, "body", "bodyTruncated", 1_000) : delta))
      : payload.annotationDeltas,
  }),
  (payload) => ({
    ...payload,
    issue: isRecord(payload.issue) ? capText(payload.issue, "description", "descriptionTruncated", 4_000) : payload.issue,
    continuationSummary: isRecord(payload.continuationSummary)
      ? capText(payload.continuationSummary, "body", "bodyTruncated", 1_000)
      : payload.continuationSummary,
  }),
  (payload) => ({
    ...payload,
    childIssueSummaries: Array.isArray(payload.childIssueSummaries)
      ? payload.childIssueSummaries.slice(0, 10)
      : payload.childIssueSummaries,
    childIssueSummaryTruncated:
      payload.childIssueSummaryTruncated === true ||
      (Array.isArray(payload.childIssueSummaries) && payload.childIssueSummaries.length > 10),
    unresolvedBlockerSummaries: Array.isArray(payload.unresolvedBlockerSummaries)
      ? payload.unresolvedBlockerSummaries.slice(0, 10)
      : payload.unresolvedBlockerSummaries,
    agentMessage: isRecord(payload.agentMessage) ? capText(payload.agentMessage, "text", "textTruncated", 4_000) : payload.agentMessage,
  }),
];

/**
 * Returns `payload` unchanged when it fits `hardCapBytes`; otherwise a copy
 * with the bulkiest optional detail removed until it fits (or nothing is left
 * to remove), marked `truncated` with `fallbackFetchNeeded`.
 */
export function fitPaperclipWakePayloadToHardCap<T extends Json>(
  payload: T,
  hardCapBytes: number = PAPERCLIP_WAKE_PAYLOAD_HARD_CAP_BYTES,
): T {
  if (paperclipWakePayloadBytes(payload) <= hardCapBytes) return payload;
  let current: Json = { ...payload, truncated: true, fallbackFetchNeeded: true };
  for (const step of steps) {
    if (paperclipWakePayloadBytes(current) <= hardCapBytes) break;
    current = step(current);
  }
  return current as T;
}
