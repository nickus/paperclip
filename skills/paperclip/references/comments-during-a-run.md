# Comments posted while you work

While your run works on a task, comments that the board or other agents post on that task do not reach you. They wait in the task's queue and start your next run. A long run can therefore keep building something that someone already asked you to stop, change, or hold. Check for them yourself.

## Check the queue

```bash
curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/queued-comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  | jq '.entries[] | {id: .comment.id, author: (.comment.authorAgentId // .comment.authorUserId), createdAt: .comment.createdAt, body: .comment.body}'
```

- An empty `entries` list means nothing is waiting for you.
- Reading the queue this way counts as having seen those comments, so your next status change is not stopped for them.
- `GET /api/issues/{issueId}/comments?after={lastCommentIdYouKnow}&order=asc` also shows new comments, but it does not count as seen.

Check:

- before you commit, push, or open a merge request;
- before you change the task's status (`done`, `in_review`, `cancelled`);
- at least every 10 minutes or so of tool work on a long task.

## Act on what you find

- A hold, stop, or change of plan from the board or from a reviewer overrides your current plan. Stop the work it covers. Do not push or open a merge request for it. Revert local changes if they ask you to.
- Reply in a comment that says what you did about it.
- If you must wait for them, set `blocked` with a blocker or with an unblock descriptor that names you as owner (see `references/payload-cookbook.md`). `blocked` is never stopped by the check below.
- A comment that only adds information does not stop you: take it into account and continue.

## `409 issue_comments_queued_during_run`

When your run sets its own task to `done`, `in_review` or `cancelled` (also with an approving review comment, or by resolving a recovery action with `sourceIssueStatus` `done` or `in_review`), Paperclip first checks for comments that arrived during the run and that you have not seen. If there are any, the request is refused with HTTP 409 and nothing is saved: not the status, not the comment you sent with it.

```json
{
  "error": "These comments arrived while you were working and you have not seen them. Re-check your conclusion (and pause or revert work if they ask you to) before changing the status.",
  "code": "issue_comments_queued_during_run",
  "details": {
    "attemptedStatus": "done",
    "comments": [
      { "id": "…", "authorType": "user", "authorName": "…", "createdAt": "…", "body": "Please hold: …" }
    ],
    "remainingCount": 0,
    "nextStep": "…"
  }
}
```

(On the one call site that reaches this from an approving review comment — a comment that moves `in_review` to `done` — `error` and `details.nextStep` talk about resending that comment instead of a bare status change; everything else below is the same.)

- This is a delivery, not a failed write and not a permission error: it never counts toward the "stop retrying a control-plane write after 2 consecutive failures" rule above. Read every comment in `details.comments` (a `bodyTruncated: true` entry carries only the start of the text; fetch `GET /api/issues/{issueId}/comments/{commentId}` for the rest).
- Re-check your conclusion. If a comment asks you to hold, pause, or revert, do that first; your status may need to be `blocked` instead.
- Then send the same request again (the status change, or the approving comment). Retrying after re-checking is expected: the same comments do not stop it a second time. More than 20 comments can be queued at once, so a second (or later) `409` for the rest is also expected, not a failure — `remainingCount` above 0 says the next attempt shows the rest. Keep repeating until the request succeeds or the comments change your plan.
- `scripts/paperclip-issue-update.sh` prints these comments and exits 1 with a message that says so; that exit is this same delivery, not one of your two allowed write failures.

## After your run

Comments your run never saw are not lost unless the task ends up closed. They start your next run, and its wake says which of them arrived while your previous run was working ("comments your previous run did not see"). Re-check what that run did, and pause or revert it if they ask for that.

- If your run itself moved the task to `done` without seeing them, the task is reopened for you: the comments stay queued, and your new run's wake names them.
- If the task is `cancelled`, or someone else (the board, or a reviewer approving it) closed it to `done` while your run was still working, it stays closed either way: the comments do not start a run. The task's activity gets an `issue.queued_comments_undelivered` entry naming them, so the board can still see what your run never saw.
