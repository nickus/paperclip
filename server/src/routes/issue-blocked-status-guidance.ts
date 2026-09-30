/**
 * Actionable error details for the issue `blocked` status contract.
 *
 * Entering `blocked` needs a wait path the platform can resume from: an
 * unresolved blocker issue, a pending interaction/approval, or an
 * `unblockDescriptor`. Callers (mostly agents composing JSON by hand) that miss
 * one of these used to get a bare sentence back and had to rediscover the
 * payload shape from the docs. These helpers attach a stable `code`, a
 * plain-text `remediation`, and copyable example bodies to those errors. The
 * `error` strings themselves are unchanged so existing clients that match on
 * them keep working.
 */

export const BLOCKED_STATUS_WAIT_PATH_REQUIRED_CODE = "blocked_status_wait_path_required";
export const UNBLOCK_OWNER_NOT_ALLOWED_CODE = "unblock_owner_not_allowed";
export const UNBLOCK_DESCRIPTOR_REQUIRES_BLOCKED_CODE = "unblock_descriptor_requires_blocked_status";

/** The request actor, reduced to what the examples need. */
export interface BlockedStatusActor {
  type: string;
  agentId?: string | null;
}

export interface BlockedStatusExample {
  when: string;
  body: Record<string, unknown>;
}

function selfOwnerPlaceholder(actor: BlockedStatusActor): string {
  // Agents may only name themselves, so hand them their own id to copy.
  return actor.type === "agent" && actor.agentId ? actor.agentId : "<agent-id>";
}

function humanWaitRule(issueId: string): string {
  return (
    "Waiting on a person is not `blocked`: create a pending interaction " +
    `(POST /api/issues/${issueId}/interactions with kind "request_confirmation" or "ask_user_questions"), ` +
    'then PATCH status "in_review".'
  );
}

/** Example PATCH bodies that satisfy the blocked-status contract for this actor. */
export function blockedStatusExamples(actor: BlockedStatusActor): BlockedStatusExample[] {
  const examples: BlockedStatusExample[] = [
    {
      when: "another issue must finish first",
      body: { status: "blocked", blockedByIssueIds: ["<blocking-issue-id>"] },
    },
    {
      when:
        actor.type === "agent"
          ? "you will take a concrete unblock step yourself"
          : "a named owner must take a concrete unblock step",
      body: {
        status: "blocked",
        unblockDescriptor: {
          owner: { agentId: selfOwnerPlaceholder(actor) },
          action: "<the exact step that unblocks this issue>",
        },
      },
    },
  ];
  if (actor.type !== "agent") {
    examples.push({
      when: "the board must act",
      body: {
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "<the exact step that unblocks this issue>" },
      },
    });
  }
  return examples;
}

/** Details for the 422 returned when `status: "blocked"` has no wait path. */
export function blockedStatusWaitPathRequiredDetails(input: {
  issueId: string;
  actor: BlockedStatusActor;
}) {
  return {
    code: BLOCKED_STATUS_WAIT_PATH_REQUIRED_CODE,
    remediation: [
      'Send status "blocked" together with one of: blockedByIssueIds (unresolved blocker issue ids) ' +
        'or unblockDescriptor {"owner":{"agentId":"..."},"action":"..."}; ' +
        "a pending interaction or approval on the issue also counts.",
      humanWaitRule(input.issueId),
    ].join(" "),
    examples: blockedStatusExamples(input.actor),
  };
}

/** Details for the 403 returned when an agent names someone else as unblock owner. */
export function unblockOwnerNotAllowedDetails(input: {
  issueId: string;
  agentId: string | null | undefined;
}) {
  const actor: BlockedStatusActor = { type: "agent", agentId: input.agentId };
  return {
    code: UNBLOCK_OWNER_NOT_ALLOWED_CODE,
    remediation: [
      `Set unblockDescriptor.owner to {"agentId":"${selfOwnerPlaceholder(actor)}"} (your own agent id), ` +
        "or use blockedByIssueIds when another issue is the blocker.",
      humanWaitRule(input.issueId),
    ].join(" "),
    examples: blockedStatusExamples(actor),
  };
}

/** Details for the 422 returned when an unblockDescriptor is sent without blocked status. */
export function unblockDescriptorRequiresBlockedDetails(input: {
  nextStatus: string;
  actor: BlockedStatusActor;
}) {
  return {
    code: UNBLOCK_DESCRIPTOR_REQUIRES_BLOCKED_CODE,
    remediation:
      `The issue would be "${input.nextStatus}", not "blocked". ` +
      'Send status "blocked" in the same request, or omit unblockDescriptor.',
    examples: blockedStatusExamples(input.actor).filter((example) =>
      "unblockDescriptor" in example.body,
    ),
  };
}
