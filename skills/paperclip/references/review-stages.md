# Execution-policy review and approval stages

How to move an issue into `in_review` for a typed execution-policy stage, and
how to record the one decision that stage is waiting for. This is the exact
recipe agents get wrong most often; read it before guessing at the request
bodies.

## Moving an issue into `in_review`

An agent-authored `PATCH` that sets `status: "in_review"` must leave the
issue with a real review path: something or someone that will act next.
Without one you get a `422`:

```json
{
  "error": "invalid_issue_disposition: Agent-authored updates that move an issue to in_review must include a real review path. ...",
  "code": "invalid_issue_disposition",
  "details": {
    "code": "invalid_issue_disposition",
    "missing": "review_path",
    "validReviewPaths": [
      "pending_issue_thread_interaction",
      "linked_pending_approval",
      "human_assignee_user_id",
      "typed_execution_state_current_participant",
      "scheduled_issue_monitor"
    ],
    "example": {
      "reviewPath": "typed_execution_state_current_participant",
      "body": { "...": "see below" }
    }
  }
}
```

Any one of the five paths is enough. The two you will use most often:

- **`human_assignee_user_id`** — hand the issue to a person: `PATCH` with
  `{"status": "in_review", "assigneeUserId": "<a human user's id>"}`.
- **`typed_execution_state_current_participant`** — hand it to the next
  stage of an execution policy, agent or human:

  ```json
  {
    "status": "in_review",
    "executionState": {
      "status": "pending",
      "currentStageId": "<a stage id from this issue's executionPolicy>",
      "currentStageIndex": 0,
      "currentStageType": "review",
      "currentParticipant": { "type": "agent", "agentId": "<the reviewer's agent id>" },
      "returnAssignee": { "type": "agent", "agentId": "<your agent id>" },
      "completedStageIds": [],
      "lastDecisionId": null,
      "lastDecisionOutcome": null
    }
  }
  ```

  `currentParticipant` is who the review wakes next; `returnAssignee` is who
  gets the issue back on "request changes". Both accept `{"type": "user",
  "userId": "..."}` instead of `agentId` for a human. In practice the server
  usually builds this object for you (approving one stage advances
  `currentStageId`/`currentParticipant` to the next one automatically) — you
  write it by hand only when starting a review outside that flow.

The other three paths: a pending `request_confirmation`/`ask_user_questions`
issue-thread interaction, a linked pending approval, or a scheduled issue
monitor (`executionPolicy.monitor`). See `references/api-reference.md` for
interactions and approvals, and the main `SKILL.md` for monitors.

## Recording a review or approval decision

Once you are the stage's `currentParticipant` (the server woke you for
`execution_review_requested` or `execution_approval_requested`, or your
Run Brief says `authority: review`), there is exactly one way to record a
decision, and it is **one `PATCH /issues/{issueId}`** carrying both a
status and a comment together:

| Decision | Request body |
| --- | --- |
| Approve | `{"status": "done", "comment": "<your verdict>"}` |
| Request changes | `{"status": "in_progress", "comment": "<your verdict>"}` (any status other than `"in_review"` works; the issue goes back to the stored `returnAssignee`) |

**A comment alone records nothing.** `POST /issues/{issueId}/comments`
leaves a note on the thread, but the execution-policy stage only reads the
`comment` field of a `PATCH` that also changes `status` in the same
request. Posting your verdict as a plain comment, then finishing your run,
leaves the stage exactly where it was — Paperclip will wake you again
(see below), and if that still records nothing the issue is escalated to
the board as blocked.

Two `422`s guard this:

- **Approving without a comment** — `PATCH {"status": "done"}` with no
  `comment` on a stage that requires one:
  `Approving a review or approval stage requires a comment. Include the
  decision comment in the same PATCH request; prior comments are not
  considered.` The `details` name exactly what is missing:
  `{"code": "execution_review_decision_missing_comment", "missing":
  "comment", "expectedBody": {"status": "done", "comment": "<your
  verdict>"}}`.
- **Requesting changes without a comment** — same shape, with
  `Requesting changes requires a comment.` and `expectedBody.status` set to
  whatever non-`in_review` status you sent (typically `"in_progress"`).

Only the stage's current participant can record the decision (`Only the
active reviewer or approver can advance the current execution stage`) —
check `GET /api/issues/{issueId}` if you are unsure who that is.

## If your run ends without recording a decision

If your run finishes — successfully or not — while you were still the
stage's current participant and no decision was recorded, Paperclip wakes
you (or a replacement run of you) once more to try again. That wake's
prompt says explicitly that the previous run ended without recording a
decision, and repeats the recipe above; it is not a generic re-wake. Treat
it the same way: one `PATCH` with `status` and `comment` together. If a
second attempt also records nothing, Paperclip stops retrying and moves the
issue to `blocked` for the board to inspect.
