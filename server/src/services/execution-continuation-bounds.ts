import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/**
 * Size bounds for the execution continuation envelope.
 *
 * The envelope is stored in the run's context snapshot, rendered into the
 * agent prompt and (through the wake payload) handed to adapters. An envelope
 * that copies the whole task history grows without limit on a long-lived
 * issue: every comment body, every interaction result and every prior tool
 * receipt. A task whose whole history fits the target size is sent as is.
 * Otherwise the envelope keeps the originating requests and the most recent
 * messages (each body capped), counts and ids for the rest, and caps every
 * free-form field. Budget levels are tried in order until the serialized
 * envelope fits the target size; the hard cap is the ceiling.
 */

type ContinuationMessage = ExecutionContinuationEnvelope["messages"][number];

export interface ExecutionContinuationLimits {
  /** Most recent messages kept (besides the required ones). */
  maxRecentMessages: number;
  maxMessageBodyChars: number;
  /** Originating requests and the latest user request. */
  maxRequiredMessages: number;
  maxRequiredMessageBodyChars: number;
  /** Shared budget of all kept message bodies; recent messages stop at it. */
  maxTotalMessageBodyChars: number;
  maxObjectiveChars: number;
  maxCompletedWorkChars: number;
  maxInteractionOutcomes: number;
  maxOutcomeResultChars: number;
  /** The interaction that triggered this wake (e.g. an answered question). */
  maxTriggerOutcomeResultChars: number;
  maxCompletedActions: number;
  maxActionResultChars: number;
  maxRecoveryOutcomes: number;
  /** Id lists (origin comments, unresolved interactions, omitted messages). */
  maxListedIds: number;
}

/** No bounds: a task whose whole history fits the target is sent as is. */
const UNBOUNDED_LEVEL: ExecutionContinuationLimits = {
  maxRecentMessages: Number.POSITIVE_INFINITY,
  maxMessageBodyChars: Number.POSITIVE_INFINITY,
  maxRequiredMessages: Number.POSITIVE_INFINITY,
  maxRequiredMessageBodyChars: Number.POSITIVE_INFINITY,
  maxTotalMessageBodyChars: Number.POSITIVE_INFINITY,
  maxObjectiveChars: Number.POSITIVE_INFINITY,
  maxCompletedWorkChars: Number.POSITIVE_INFINITY,
  maxInteractionOutcomes: Number.POSITIVE_INFINITY,
  maxOutcomeResultChars: Number.POSITIVE_INFINITY,
  maxTriggerOutcomeResultChars: Number.POSITIVE_INFINITY,
  maxCompletedActions: Number.POSITIVE_INFINITY,
  maxActionResultChars: Number.POSITIVE_INFINITY,
  maxRecoveryOutcomes: Number.POSITIVE_INFINITY,
  maxListedIds: Number.POSITIVE_INFINITY,
};

export const EXECUTION_CONTINUATION_TARGET_BYTES = 32 * 1024;
export const EXECUTION_CONTINUATION_HARD_CAP_BYTES = 64 * 1024;

export const EXECUTION_CONTINUATION_BUDGET_LEVELS: readonly ExecutionContinuationLimits[] = [
  {
    maxRecentMessages: 20,
    maxMessageBodyChars: 2_000,
    maxRequiredMessages: 12,
    maxRequiredMessageBodyChars: 8_000,
    maxTotalMessageBodyChars: 16_000,
    maxObjectiveChars: 8_000,
    maxCompletedWorkChars: 6_000,
    maxInteractionOutcomes: 8,
    maxOutcomeResultChars: 1_500,
    maxTriggerOutcomeResultChars: 6_000,
    maxCompletedActions: 20,
    maxActionResultChars: 600,
    maxRecoveryOutcomes: 8,
    maxListedIds: 40,
  },
  {
    maxRecentMessages: 10,
    maxMessageBodyChars: 1_200,
    maxRequiredMessages: 8,
    maxRequiredMessageBodyChars: 4_000,
    maxTotalMessageBodyChars: 8_000,
    maxObjectiveChars: 6_000,
    maxCompletedWorkChars: 3_000,
    maxInteractionOutcomes: 4,
    maxOutcomeResultChars: 800,
    maxTriggerOutcomeResultChars: 4_000,
    maxCompletedActions: 12,
    maxActionResultChars: 300,
    maxRecoveryOutcomes: 4,
    maxListedIds: 40,
  },
  {
    maxRecentMessages: 4,
    maxMessageBodyChars: 600,
    maxRequiredMessages: 4,
    maxRequiredMessageBodyChars: 2_000,
    maxTotalMessageBodyChars: 3_000,
    maxObjectiveChars: 3_000,
    maxCompletedWorkChars: 1_500,
    maxInteractionOutcomes: 2,
    maxOutcomeResultChars: 400,
    maxTriggerOutcomeResultChars: 2_000,
    maxCompletedActions: 6,
    maxActionResultChars: 0,
    maxRecoveryOutcomes: 2,
    maxListedIds: 40,
  },
  {
    maxRecentMessages: 1,
    maxMessageBodyChars: 300,
    maxRequiredMessages: 2,
    maxRequiredMessageBodyChars: 1_000,
    maxTotalMessageBodyChars: 1_000,
    maxObjectiveChars: 1_500,
    maxCompletedWorkChars: 600,
    maxInteractionOutcomes: 1,
    maxOutcomeResultChars: 0,
    maxTriggerOutcomeResultChars: 1_000,
    maxCompletedActions: 3,
    maxActionResultChars: 0,
    maxRecoveryOutcomes: 1,
    maxListedIds: 40,
  },
  {
    maxRecentMessages: 0,
    maxMessageBodyChars: 0,
    maxRequiredMessages: 1,
    maxRequiredMessageBodyChars: 500,
    maxTotalMessageBodyChars: 500,
    maxObjectiveChars: 1_000,
    maxCompletedWorkChars: 300,
    maxInteractionOutcomes: 0,
    maxOutcomeResultChars: 0,
    maxTriggerOutcomeResultChars: 500,
    maxCompletedActions: 0,
    maxActionResultChars: 0,
    maxRecoveryOutcomes: 0,
    maxListedIds: 40,
  },
];

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, Math.max(0, maxChars)), truncated: true };
}

function truncateFreeText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars))}\n[truncated: ${value.length - maxChars} more characters]`;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Shortens long strings and arrays while keeping the value's shape. */
function shrinkJsonValue(value: unknown, maxString: number, maxArray: number, depth: number): unknown {
  if (typeof value === "string") return truncateFreeText(value, maxString);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArray).map((item) => shrinkJsonValue(item, maxString, maxArray, depth - 1));
    return value.length > maxArray ? [...kept, `[${value.length - maxArray} more items omitted]`] : kept;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      shrinkJsonValue(item, maxString, maxArray, depth - 1),
    ]),
  );
}

/**
 * Bounds an arbitrary JSON result (interaction result, tool receipt result,
 * reconciliation decision) to about `maxChars` serialized characters. Never
 * embeds more than a preview of oversized content.
 */
export function boundContinuationJsonValue(value: unknown, maxChars: number): unknown {
  const length = safeJsonLength(value);
  if (length <= maxChars) return value;
  if (maxChars <= 0) return { omitted: true, originalChars: length };
  for (const [maxString, maxArray] of [
    [Math.max(120, Math.floor(maxChars / 3)), 20],
    [Math.max(80, Math.floor(maxChars / 8)), 8],
  ] as const) {
    const shrunk = shrinkJsonValue(value, maxString, maxArray, 6);
    if (safeJsonLength(shrunk) <= maxChars) return shrunk;
  }
  let preview = "";
  try {
    preview = JSON.stringify(value) ?? "";
  } catch {
    preview = "";
  }
  return {
    truncated: true,
    originalChars: length,
    preview: preview.slice(0, Math.max(0, maxChars - 80)),
  };
}

function boundMessage(message: ContinuationMessage, maxChars: number): ContinuationMessage {
  const { bodyTruncated: _priorTruncated, bodyChars: _priorChars, ...rest } = message;
  const { text, truncated } = truncateText(message.body, maxChars);
  return truncated ? { ...rest, body: text, bodyTruncated: true, bodyChars: message.body.length } : { ...rest, body: text };
}

/**
 * True when a message delivered in an earlier (possibly bounded) envelope
 * still matches the current full message. A bounded body is a prefix whose
 * full length was recorded.
 */
export function continuationMessageUnchanged(
  prior: Record<string, unknown>,
  current: ContinuationMessage,
): boolean {
  const priorBody = typeof prior.body === "string" ? prior.body : null;
  if (priorBody === null) return false;
  const sameBody =
    prior.bodyTruncated === true
      ? prior.bodyChars === current.body.length && current.body.startsWith(priorBody)
      : priorBody === current.body;
  return (
    prior.id === current.id &&
    prior.updatedAt === current.updatedAt &&
    sameBody &&
    prior.deleted === current.deleted &&
    prior.authorId === current.authorId &&
    (prior.createdByRunId ?? null) === (current.createdByRunId ?? null) &&
    JSON.stringify(prior.sourceTrust) === JSON.stringify(current.sourceTrust)
  );
}

function newest<T>(items: readonly T[], count: number): T[] {
  return count <= 0 ? [] : items.slice(Math.max(0, items.length - count));
}

export interface BoundExecutionContinuationOptions {
  /** Messages that must stay: the originating requests and the latest user request. */
  requiredMessageIds: ReadonlySet<string>;
  triggerInteractionId: string | null;
  /** Messages the resumed provider session has not seen yet (full-history ids). */
  resumeDelta: { baseRunId: string; messageIds: ReadonlySet<string> } | null;
  historyPath: string;
  levels?: readonly ExecutionContinuationLimits[];
  targetBytes?: number;
  hardCapBytes?: number;
}

function shapeEnvelope(
  full: ExecutionContinuationEnvelope,
  options: BoundExecutionContinuationOptions,
  limits: ExecutionContinuationLimits,
): ExecutionContinuationEnvelope {
  const all = full.messages;
  const kept = new Map<number, ContinuationMessage>();
  let totalChars = 0;
  let requiredCount = 0;
  for (let index = all.length - 1; index >= 0 && requiredCount < limits.maxRequiredMessages; index -= 1) {
    const message = all[index]!;
    if (!options.requiredMessageIds.has(message.id)) continue;
    const bounded = boundMessage(message, limits.maxRequiredMessageBodyChars);
    kept.set(index, bounded);
    totalChars += bounded.body.length;
    requiredCount += 1;
  }
  let recentCount = 0;
  for (let index = all.length - 1; index >= 0 && recentCount < limits.maxRecentMessages; index -= 1) {
    if (kept.has(index)) continue;
    const bounded = boundMessage(all[index]!, limits.maxMessageBodyChars);
    // Keep the recent window contiguous: stop at the first message that no
    // longer fits instead of skipping ahead to older, shorter ones.
    if (recentCount > 0 && totalChars + bounded.body.length > limits.maxTotalMessageBodyChars) break;
    kept.set(index, bounded);
    totalChars += bounded.body.length;
    recentCount += 1;
  }
  const keptIndexes = [...kept.keys()].sort((a, b) => a - b);
  const messages = keptIndexes.map((index) => kept.get(index)!);
  const omittedMessages = all.filter((_message, index) => !kept.has(index));

  const objective = truncateText(full.objective, limits.maxObjectiveChars);

  const outcomes = full.interactionOutcomes;
  const recentOutcomes = newest(outcomes, limits.maxInteractionOutcomes);
  const trigger = options.triggerInteractionId
    ? outcomes.find((outcome) => outcome.id === options.triggerInteractionId)
    : undefined;
  const keptOutcomes =
    trigger && !recentOutcomes.includes(trigger)
      ? outcomes.filter((outcome) => outcome === trigger || recentOutcomes.includes(outcome))
      : recentOutcomes;
  const interactionOutcomes = keptOutcomes.map((outcome) => ({
    ...outcome,
    result: boundContinuationJsonValue(
      outcome.result,
      outcome === trigger ? limits.maxTriggerOutcomeResultChars : limits.maxOutcomeResultChars,
    ),
  }));

  const allActions = full.completedActions ?? [];
  const completedActions = newest(allActions, limits.maxCompletedActions).map((action) => ({
    ...action,
    result: boundContinuationJsonValue(action.result, limits.maxActionResultChars),
  }));
  const allRecoveryOutcomes = full.recoveryOutcomes ?? [];
  const recoveryOutcomes = newest(allRecoveryOutcomes, limits.maxRecoveryOutcomes).map((outcome) => ({
    ...outcome,
    decision: boundContinuationJsonValue(outcome.decision, limits.maxOutcomeResultChars),
  }));
  const unresolvedInteractionIds = newest(full.unresolvedInteractionIds, limits.maxListedIds);
  const originCommentIds = newest(full.originCommentIds, limits.maxListedIds);

  const originIds = new Set(full.originCommentIds);
  const resumeDelta = options.resumeDelta
    ? {
        baseRunId: options.resumeDelta.baseRunId,
        messages: messages.filter(
          (message) => originIds.has(message.id) || options.resumeDelta!.messageIds.has(message.id),
        ),
      }
    : undefined;

  const { resumeDelta: _fullDelta, ...fullRest } = full;
  return {
    ...fullRest,
    ...(resumeDelta ? { resumeDelta } : {}),
    originCommentIds,
    objective: objective.text,
    ...(objective.truncated ? { objectiveTruncated: true } : {}),
    messages,
    interactionOutcomes,
    recoveryOutcomes,
    completedWork: full.completedWork === null ? null : truncateFreeText(full.completedWork, limits.maxCompletedWorkChars),
    completedActions,
    unresolvedInteractionIds,
    coverage: {
      kind: omittedMessages.length > 0 ? "recent_task_history" : "full_task_history",
      throughCommentId: full.coverage.throughCommentId,
      summaryThroughCommentId: null,
      ...(omittedMessages.length > 0
        ? {
            totalMessageCount: all.length,
            omittedMessageCount: omittedMessages.length,
            omittedMessageIds: newest(omittedMessages, limits.maxListedIds).map((message) => message.id),
            historyPath: options.historyPath,
          }
        : {}),
      ...(outcomes.length > keptOutcomes.length
        ? { omittedInteractionOutcomeCount: outcomes.length - keptOutcomes.length }
        : {}),
      ...(allActions.length > completedActions.length
        ? { omittedCompletedActionCount: allActions.length - completedActions.length }
        : {}),
      ...(allRecoveryOutcomes.length > recoveryOutcomes.length
        ? { omittedRecoveryOutcomeCount: allRecoveryOutcomes.length - recoveryOutcomes.length }
        : {}),
      ...(full.unresolvedInteractionIds.length > unresolvedInteractionIds.length
        ? { omittedUnresolvedInteractionIdCount: full.unresolvedInteractionIds.length - unresolvedInteractionIds.length }
        : {}),
      ...(full.originCommentIds.length > originCommentIds.length
        ? { omittedOriginCommentIdCount: full.originCommentIds.length - originCommentIds.length }
        : {}),
    },
  };
}

export function executionContinuationBytes(envelope: unknown): number {
  return Buffer.byteLength(JSON.stringify(envelope) ?? "", "utf8");
}

/**
 * Returns the envelope at the first budget level whose serialized size fits
 * `targetBytes`, else the first that fits `hardCapBytes`, else the smallest.
 * `full` carries the complete history (and no resumeDelta; pass the delta's
 * message ids in `options.resumeDelta`).
 */
export function boundExecutionContinuation(
  full: ExecutionContinuationEnvelope,
  options: BoundExecutionContinuationOptions,
): ExecutionContinuationEnvelope {
  // The unbounded shape first: a task whose history fits is sent unchanged.
  const levels = [UNBOUNDED_LEVEL, ...(options.levels ?? EXECUTION_CONTINUATION_BUDGET_LEVELS)];
  const targetBytes = options.targetBytes ?? EXECUTION_CONTINUATION_TARGET_BYTES;
  const hardCapBytes = options.hardCapBytes ?? EXECUTION_CONTINUATION_HARD_CAP_BYTES;
  let firstUnderHardCap: ExecutionContinuationEnvelope | null = null;
  let last: ExecutionContinuationEnvelope | null = null;
  for (const limits of levels) {
    const shaped = shapeEnvelope(full, options, limits);
    const bytes = executionContinuationBytes(shaped);
    if (bytes <= targetBytes) return shaped;
    if (!firstUnderHardCap && bytes <= hardCapBytes) firstUnderHardCap = shaped;
    last = shaped;
  }
  return firstUnderHardCap ?? last ?? full;
}
