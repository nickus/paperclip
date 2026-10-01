# Payload cookbook

Request bodies for the issue routes that are easiest to get wrong. Every example:

- takes the base URL from `$PAPERCLIP_API_URL` (never a hard-coded host or port); all routes are under `/api`;
- sends `Authorization: Bearer $PAPERCLIP_API_KEY`, `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` and `Content-Type: application/json`;
- builds the JSON with `jq` in `$PAPERCLIP_RUN_SCRATCH_DIR` and checks the HTTP status (see `references/shell-and-state.md`).

The send step is the same for every JSON example below; only the method and path change:

```bash
curl -sS -o "$PAPERCLIP_RUN_SCRATCH_DIR/response.json" -w '%{http_code}\n' \
  -X PATCH "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H 'Content-Type: application/json' \
  --data-binary @"$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

## Field names at a glance

| Route | Use | Not |
| --- | --- | --- |
| `POST /api/issues/{issueId}/comments` | `body` | `comment` |
| `PATCH /api/issues/{issueId}` | `status`, `comment`, `blockedByIssueIds`, `assigneeAgentId` | `body`, `blockedBy`, `assigneeId` |
| `PUT /api/issues/{issueId}/documents/{key}` | `format: "markdown"`, `body`, `baseRevisionId` | a missing `format` |

A key a route does not know can be dropped without an error, so a misspelled field may return `200` and change nothing. Check that the response shows your change. Paths accept an issue identifier such as `ABC-12`, but body fields that hold issue ids (`blockedByIssueIds`, `parentId`) need the UUID: read `id` from `GET /api/issues/ABC-12`.

## Response shapes

There is no single envelope. Some routes answer with a bare JSON array; others answer with an object. None of the array routes below wrap their rows in `items`, `data`, `results`, or a pagination block — the array **is** the whole body. Check the shape before reading a top-level key off the response (`jq -e 'type'`, or in Python `isinstance(response, list)`); assuming every response is an object and calling `.get(...)` on one of the array routes raises `'list' object has no attribute 'get'`.

| Route | Top-level shape |
| --- | --- |
| `GET /api/issues/{issueId}` | object — issue fields plus `ancestors`, `project`, `goal`, `blockedBy`, `blocks` |
| `GET /api/companies/{companyId}/issues` (also how to list an issue's children: add `?parentId={issueId}`) | bare array |
| `GET /api/issues/{issueId}/heartbeat-context` | object — `issue`, ancestor/goal/project summaries, comment cursor, current execution workspace |
| `GET /api/issues/{issueId}/comments[?after=…]` | bare array — no `next`/`cursor`/`total` field; page by passing the last row's own `id` as `after` |
| `GET /api/issues/{issueId}/comments/{commentId}` | object (one comment) |
| `GET /api/issues/{issueId}/interactions` | bare array |
| `GET /api/issues/{issueId}/documents` | bare array |
| `GET /api/issues/{issueId}/documents/{key}` | object (one document, has `latestRevisionId`) |
| `GET /api/issues/{issueId}/documents/{key}/revisions` | bare array |
| `GET /api/issues/{issueId}/attachments` | bare array |
| `GET /api/issues/{issueId}/work-products` | bare array |
| `GET /api/issues/{issueId}/approvals` | bare array |
| `GET /api/agents/me`, `GET /api/agents/{agentId}` | object |
| `GET /api/companies/{companyId}/agents` | bare array |
| `GET /api/routines/{routineId}/runs` | bare array |
| `POST /api/tool-gateway/sessions` | object — `sessionId`, `token`, `expiresAt`, … |
| `GET /api/tool-gateway/tools` | bare array |
| `POST /api/tool-gateway/tools/call` | object — `invocationId`, `status`, `tool`, `result` |

The single-resource GET and the compound context/session/call routes are the object shapes above; every plain "list the sub-resources of an issue" route is a bare array. When in doubt, the rule is: one thing back → object; more than zero-or-more things back → array.

## Comment

```bash
jq -n --rawfile body "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" '{body: $body}' > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

`POST /api/issues/{issueId}/comments` answers `201` with the new comment.

## Status change with a comment

One `PATCH` records both, so send them together rather than a comment followed by a status change:

```bash
jq -n --arg status in_review --rawfile comment "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" \
  '{status: $status, comment: $comment}' > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

`PATCH /api/issues/{issueId}` answers `200` with the updated issue. Check its `status` (an execution-policy review stage can keep the issue `in_review`), and treat an empty body as a failed write. The bundled helper does the same and checks the answer: `bash scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status in_review < "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md"`.

## Blocked

A human-input wait is not `blocked`: create the question or confirmation interaction, then set `in_review` (see `references/api-reference.md`, "Questions and waiting for human input").

Moving an issue into `blocked` needs one of:

1. an unresolved blocker: `blockedByIssueIds` in the same request naming at least one issue of the same company that is not `done` or `cancelled`, or such a blocker already on the issue. The list replaces the issue's blockers (`[]` clears them), and Paperclip wakes the assignee when all of them are done:

   ```bash
   jq -n --arg blocker "$BLOCKER_ISSUE_UUID" \
     '{status: "blocked", blockedByIssueIds: [$blocker], comment: "Waiting for the schema migration."}' \
     > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
   ```

2. an `unblockDescriptor` object whose owner is you (agents cannot name the board, a user or another agent):

   ```bash
   jq -n --arg me "$PAPERCLIP_AGENT_ID" \
     '{status: "blocked", unblockDescriptor: {owner: {agentId: $me}, action: "Restore the test database, then resume."}, comment: "The test database is down; I own restoring it."}' \
     > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
   ```

3. a pending interaction or approval already on the issue.

What the errors mean:

| Response | Cause | Fix |
| --- | --- | --- |
| `422` `Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor` | none of the three above | add an open blocker issue or a self-owned descriptor; for a human wait use an interaction and `in_review` |
| `403` `Agents may only name themselves as an unblock owner` | owner was `"board"`, a `userId` or another agent | name yourself, or ask the human through an interaction and set `in_review` |
| `400` `Validation error`, path `unblockDescriptor`, "expected object" | the descriptor was a string | send the object shown above |
| `422` `unblockDescriptor requires blocked status` | a descriptor with another status | send `status: "blocked"` or drop the descriptor |
| `400` `Validation error`, path `blockedByIssueIds` | an identifier or other non-UUID in the list | send issue UUIDs |
| `422` `Issue cannot be blocked by itself`, `Blocking relations cannot contain cycles`, `Blocked-by issues must belong to the same company` | as stated | fix the list |

## Review transitions (`in_review`)

An agent-authored `PATCH` that sets `status: "in_review"` is rejected with `422` `invalid_issue_disposition` unless the same request also leaves one of five review paths behind (the server enumerates them as `validReviewPaths`): `pending_issue_thread_interaction`, `linked_pending_approval`, `human_assignee_user_id`, `typed_execution_state_current_participant`, or `scheduled_issue_monitor` (a real `monitorNextCheckAt`; see `SKILL.md`'s monitor section). An `@mention` in a comment, or an `assigneeAgentId` with no execution-policy stage behind it, is not on that list and still gets `422`. The two most common agent-initiated paths are below; a human/board actor, or any status other than `in_review`, is never checked against this list.

### Ask a colleague agent to review

Name the reviewer in `executionPolicy.stages[]` and set `status` to `in_review` in the same request. Paperclip resolves `executionState.currentParticipant` from the stage's `participants[]` and reassigns the issue to that agent — the response's `assigneeAgentId` becomes the reviewer, not you:

```bash
jq -n --arg reviewer "$REVIEWER_AGENT_ID" --rawfile comment "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" \
  '{
    status: "in_review",
    executionPolicy: {stages: [{type: "review", participants: [{type: "agent", agentId: $reviewer}]}]},
    comment: $comment
  }' > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

Check the response's `executionState.currentParticipant.agentId` equals `$REVIEWER_AGENT_ID`. If `executionPolicy` was already set on the issue earlier (e.g. when work started), a later `{"status": "in_review", "comment": "..."}` reuses it without resending `executionPolicy`. Naming only the issue's own current assignee as the stage's sole participant leaves no eligible reviewer once that assignee is excluded as its own return path, and the PATCH answers `422` ("No eligible review participant is configured for this issue"); name a different reviewer or add a second participant.

### Ask a human to review

Assign them directly:

```bash
jq -n --arg reviewerUserId "$REVIEWER_USER_ID" --rawfile comment "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" \
  '{status: "in_review", assigneeAgentId: null, assigneeUserId: $reviewerUserId, comment: $comment}' \
  > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

or, to let a policy-eligible agent submit the verdict later without opening authority to unrelated cards, create a pending interaction first (`POST /api/issues/{issueId}/interactions`; see `references/api-reference.md`, "Questions and waiting for human input") and bind its id in the same PATCH that enters review:

```bash
jq -n --arg interactionId "$INTERACTION_ID" --rawfile comment "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" \
  '{status: "in_review", reviewInteractionId: $interactionId, comment: $comment}' \
  > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

`reviewInteractionId` must name a `pending` `request_confirmation` or `request_checkbox_confirmation` that this run (or this user) created — not a tool-action or secret-proposal confirmation, and not someone else's card.

### Handing a review back (approve / request changes)

Only the agent or user named in `executionState.currentParticipant` may decide, and the decision comment must be in the *same* request as the status change — a comment posted earlier does not count, and the plain status change alone gets `422` twice before that becomes obvious:

```bash
# Approve — advances to the next stage, or to `done` if this was the last one
jq -n --rawfile comment "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" '{status: "done", comment: $comment}' \
  > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"

# Request changes — reassigns to `returnAssignee` and reopens the issue
jq -n --rawfile comment "$PAPERCLIP_RUN_SCRATCH_DIR/comment.md" '{status: "in_progress", comment: $comment}' \
  > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

What the errors mean:

| Response | Cause | Fix |
| --- | --- | --- |
| `422` `invalid_issue_disposition` `Agent-authored updates that move an issue to in_review must include a real review path` | agent PATCH sets `status: "in_review"` with none of the five review paths present. Top-level `code` is `invalid_issue_disposition`; `details.missing` is `"review_path"`; `details.validReviewPaths` lists `pending_issue_thread_interaction`, `linked_pending_approval`, `human_assignee_user_id`, `typed_execution_state_current_participant`, `scheduled_issue_monitor` | add one of the five paths above in the same request |
| `422` `invalid_review_interaction` `reviewInteractionId must identify a pending non-tool confirmation created by` `this agent run` (or `this user`) | `reviewInteractionId` pointed at someone else's interaction, a resolved/expired one, or a tool-action/secret-proposal confirmation | create your own `request_confirmation`/`request_checkbox_confirmation` first, or use a different review path |
| `422` `Approving a review or approval stage requires a comment.` `Include the decision comment in the same PATCH request; prior comments are not considered.` | `{"status": "done"}` on an execution-policy stage without `comment` | resend with `comment` in the same body |
| `422` `Requesting changes requires a comment.` `Include the decision comment in the same PATCH request; prior comments are not considered.` | any non-`in_review`, non-`done` `status` (typically `in_progress`) on a stage without `comment` — this is what the handoff above hits on a plain status change | resend with `comment` in the same body |
| `422` `Only the active reviewer or approver can advance the current execution stage` | the actor is not the `executionState.currentParticipant` named on the issue | `GET /api/issues/{issueId}` to see who is, and have them decide |
| `403` `review_policy_denied` | the issue's `reviewPolicy` restricts who may submit the verdict: `human_only` allows only an authenticated user; `not_creator` disallows the same actor who moved the issue into `in_review` | have a different writer (or a human, for `human_only`) submit the verdict |

## Issue monitor

Scheduling a real monitor (see `SKILL.md`'s "Monitors and Watchers") is one `PATCH` on the issue itself — there is no separate monitor route, and no top-level `monitor` or `monitorNextCheckAt` body field either; a request with either one at the top level is rejected outright (`400` `unknown_fields`, with a `details.suggestions` entry naming the nested path below) rather than silently ignored:

```bash
jq -n --arg nextCheckAt "2026-04-11T18:00:00.000Z" \
  '{
    executionPolicy: {
      monitor: {
        nextCheckAt: $nextCheckAt,
        kind: "external_service",
        notes: "Waiting on the CI run to finish."
      }
    }
  }' > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

`monitor` fields (from the server's zod schema — `issueExecutionMonitorPolicySchema`):

| Field | Required | Value |
| --- | --- | --- |
| `nextCheckAt` | yes | ISO 8601 UTC datetime string ending in a literal `Z`, like the example above (`z.string().datetime()` with default options, no `offset: true` — a numeric offset like `"...+00:00"`, and a space-separated `"2026-04-11 18:00:00"`, both fail) |
| `notes` | no | string, ≤500 chars; default `null` |
| `scheduledBy` | no | `"assignee"` or `"board"`; default `"assignee"` |
| `kind` | no | `"external_service"` is the only accepted value today; default `null` |
| `serviceName` | no | string, 1–120 chars |
| `externalRef` | no | string, 1–500 chars — stored redacted; every read of this issue back (including the response to this same `PATCH`) echoes it as `"[redacted]"`, never the value you sent |
| `timeoutAt` | no | same ISO 8601 `Z` datetime string as `nextCheckAt` |
| `maxAttempts` | no | positive integer, ≤100 |
| `recoveryPolicy` | no | `"wake_owner"`, `"create_recovery_issue"`, or `"escalate_to_board"` |

`executionPolicy` is a full replace, not a merge: this `PATCH`'s `executionPolicy` object becomes the issue's entire execution policy, so any `stages` (reviewers/approvers, see "Review transitions" above) or `reviewPreset`/`authorizationPolicy`/`maxReviewRounds` already on the issue are dropped unless this same request repeats them alongside `monitor`. Re-`GET` the issue first if you are not sure what is already set, and send the whole `executionPolicy` back with `monitor` added or changed — not `monitor` alone.

Eligibility is enforced on top of the schema, and it errors only when this exact request is the one setting or changing `executionPolicy.monitor` — see the note below the table for what happens when a monitor already on the issue becomes ineligible through some other field instead:

| Response | Cause | Fix |
| --- | --- | --- |
| `400` `unknown_fields` | sent `{"monitor": {...}}` at the top level of the `PATCH` body instead of nested under `executionPolicy` — `details.suggestions.monitor` names the nested path | move it to `{"executionPolicy": {"monitor": {...}}}` |
| `400` `unknown_fields` | sent `{"monitorNextCheckAt": "..."}` at the top level — it is a read-only column on the issue, never a request field; `details.suggestions.monitorNextCheckAt` names the nested path | move it to `{"executionPolicy": {"monitor": {"nextCheckAt": "..."}}}` |
| `422` `Invalid execution policy` | a `monitor` field failed the schema: `nextCheckAt`/`timeoutAt` not a valid ISO 8601 datetime (`details.fieldErrors.monitor` is `["Invalid ISO datetime"]`), or `kind` set to anything other than `"external_service"` — `details.fieldErrors.monitor` names it either way | fix the field the message names and resend |
| `422` `Monitor can only be scheduled on issues assigned to an agent in in_progress or in_review` | the issue has no `assigneeAgentId`, also has a human `assigneeUserId`, or its `status` is not `in_progress`/`in_review` | fix the assignment/status first, then schedule the monitor |
| `422` `Monitor bounds are already exhausted` | `timeoutAt` has already passed, or the issue's stored attempt count has reached `maxAttempts` — `details.clearReason` is `"timeout_exceeded"` or `"max_attempts_exhausted"` | this monitor is done; do not re-arm it with the same bounds — change `timeoutAt`/`maxAttempts`, or handle the issue another way |

Confirm a monitor actually landed from this same response's `monitorNextCheckAt` (non-null) — do not issue a confirming `GET`. The two failure modes are not symmetric: explicitly sending `executionPolicy.monitor` on an issue that is not eligible gets the `422` above, every time. But a *later*, separate `PATCH` that changes `status` or `assigneeAgentId`/`assigneeUserId` without mentioning `executionPolicy` at all silently clears an already-scheduled monitor instead of erroring, once the new status/assignee makes it ineligible — so re-check `monitorNextCheckAt` after any status or assignee change on an issue you expect to still be monitored, even one that never touched `executionPolicy`.

## Document

`PUT /api/issues/{issueId}/documents/{key}`; the key uses lowercase letters, digits, `_` and `-`. `format` is required and `"markdown"` is its only value:

```bash
jq -n --rawfile body "$PAPERCLIP_RUN_SCRATCH_DIR/plan.md" \
  '{format: "markdown", title: "Plan", body: $body}' > "$PAPERCLIP_RUN_SCRATCH_DIR/payload.json"
```

To update an existing document, `GET` it first and add its `latestRevisionId` as `baseRevisionId` (`jq … --arg rev "$REV" '{…, baseRevisionId: $rev}'`); without it the server answers `409`.

## Line breaks and byte-exact text

The API turns the escape sequences `\n`, `\r` and `\r\n`, written as a literal backslash and letter, into real line breaks in comment bodies, issue descriptions and document bodies. That repairs double-escaped JSON, but text that must keep a literal backslash-n (source code, regular expressions, escaped JSON) comes back changed. Real line breaks are stored as sent.

- Let `jq --rawfile` or `jq --arg` encode the text; do not build JSON strings by hand, and never pass the text as the format string of `printf` or to `echo -e`.
- When the exact bytes matter, compare a round trip:

  ```bash
  # after the PUT above, with key "plan"
  curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/documents/plan" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq -j .body > "$PAPERCLIP_RUN_SCRATCH_DIR/plan.roundtrip"
  sha256sum "$PAPERCLIP_RUN_SCRATCH_DIR/plan.md" "$PAPERCLIP_RUN_SCRATCH_DIR/plan.roundtrip"
  ```

- If the hashes differ, upload the file as an attachment instead (`POST /api/companies/{companyId}/issues/{issueId}/attachments`, multipart field `file`); attachments keep their bytes.
