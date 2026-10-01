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

When your run sets its own task to `done`, `in_review` or `cancelled` (also with an approving review comment), Paperclip first checks for comments that arrived during the run and that you have not seen. If there are any, the request is refused with HTTP 409 and nothing is saved: not the status, not the comment you sent with it.

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

- This is not a failed write and not a permission error. Read every comment in `details.comments` (a `bodyTruncated: true` entry carries only the start of the text; fetch `GET /api/issues/{issueId}/comments/{commentId}` for the rest).
- Re-check your conclusion. If a comment asks you to hold, pause, or revert, do that first; your status may need to be `blocked` instead.
- Then send the status change again. Retrying after re-checking is expected: the same comments do not stop it a second time. If `remainingCount` is above 0, the next attempt shows the rest.
- `scripts/paperclip-issue-update.sh` prints these comments and exits 1 with a message that says so.

## After your run

Comments your run never saw are not lost. They start your next run, and its wake says which of them arrived while your previous run was working ("comments your previous run did not see"). Re-check what that run did, and pause or revert it if they ask for that. If your run completed the task without seeing them, the task is reopened for you.
