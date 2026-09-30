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
