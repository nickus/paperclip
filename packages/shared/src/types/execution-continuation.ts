/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  /** Set when `objective` was cut to the envelope's size budget. */
  objectiveTruncated?: boolean;
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    /** Set when `body` is a prefix of the comment; `bodyChars` is its full length. */
    bodyTruncated?: boolean;
    bodyChars?: number;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  /**
   * Newest-first digest of this agent's most recent earlier runs on the task.
   * The summary is agent-authored low-trust text (one line, bounded length).
   */
  priorRuns?: Array<{
    id: string;
    status: string;
    liveness: string | null;
    summary: string | null;
  }>;
  coverage: {
    /**
     * `full_task_history`: every message of the task is in `messages`.
     * `recent_task_history`: the most recent messages plus the originating
     * requests; older ones are counted in `omittedMessageCount` and can be
     * read from `historyPath`.
     */
    kind: "full_task_history" | "recent_task_history" | "task_history_delta";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
    totalMessageCount?: number;
    omittedMessageCount?: number;
    /** The most recent omitted message ids (at most a few dozen). */
    omittedMessageIds?: string[];
    /** API path that lists the task's full message history. */
    historyPath?: string;
    omittedInteractionOutcomeCount?: number;
    omittedHumanResponseCount?: number;
    omittedCompletedActionCount?: number;
    omittedRecoveryOutcomeCount?: number;
    omittedUnresolvedInteractionIdCount?: number;
    omittedOriginCommentIdCount?: number;
  };
}
