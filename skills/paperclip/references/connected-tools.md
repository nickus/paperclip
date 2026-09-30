# Connected tools over REST (tool gateway)

Use this when a tool granted to you (an MCP tool connection or another gateway tool) is not offered to you as a native tool, for example because your agent CLI has no MCP client. The REST tool gateway serves the same tools as the MCP gateway, through the same tool profiles, policies, approval gates and audit, with four plain HTTP calls. It works the same from a local run and from an SSH or sandbox run, whose `PAPERCLIP_API_URL` points at the run bridge. If your harness already lists these tools natively, use those instead.

## Rules

- **One session per run.** Create it once, reuse it for every list and call in the run, and revoke it when you are done with tools. A session is bound to your current run and stops working when the run ends or it expires (15 minutes by default; `ttlMs` in the create body allows up to 1 hour).
- **The session token is a credential.** Never print or echo it, and never put it in a comment, document, workspace file, log, or URL. Keep it off command lines: the recipe writes it straight from the create response into a private header file and passes that file with `curl -H @file`.
- Send your normal `Authorization: Bearer $PAPERCLIP_API_KEY` on every call (the run bridge requires it). The session token goes only in the `X-Paperclip-Tool-Gateway-Token` header.
- Build tool arguments with `jq` (`--arg`, `--argjson`, or a file), never by hand-escaping JSON.

## Recipe

```bash
# Setup: repeat these lines in every new shell. TG_DIR is a private directory for this run's
# session files, outside the workspace.
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
TG_DIR="${TMPDIR:-/tmp}/paperclip-tool-gateway-$PAPERCLIP_RUN_ID"
mkdir -p -m 700 "$TG_DIR"

# 1. Create the session. The response holds the token, so it goes to a file, never to the terminal.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary '{}' \
  -o "$TG_DIR/session.json" \
  "$PAPERCLIP_API_BASE/api/tool-gateway/sessions"
jq -er '.token | strings | "X-Paperclip-Tool-Gateway-Token: " + .' "$TG_DIR/session.json" > "$TG_DIR/headers" \
  && jq '{sessionId, expiresAt}' "$TG_DIR/session.json" \
  || jq '{error, reasonCode}' "$TG_DIR/session.json"
jq -r '.sessionId // empty' "$TG_DIR/session.json" > "$TG_DIR/session-id"
rm -f "$TG_DIR/session.json"

# 2. List the tools this run may use: name, description, risk, and the JSON Schema of their parameters.
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H @"$TG_DIR/headers" \
  "$PAPERCLIP_API_BASE/api/tool-gateway/tools" |
  jq 'if type == "array" then map({name, description, risk, parametersSchema}) else . end'

# 3. Call one tool by its exact listed name, with JSON parameters that match its schema.
jq -n --arg tool "<name from step 2>" --argjson parameters '{"query": "open invoices"}' \
  '{tool: $tool, parameters: $parameters}' |
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H @"$TG_DIR/headers" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$PAPERCLIP_API_BASE/api/tool-gateway/tools/call"

# 4. Revoke the session when you are done with tools, then remove its files.
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary '{}' \
  "$PAPERCLIP_API_BASE/api/tool-gateway/sessions/$(cat "$TG_DIR/session-id")/revoke"
rm -rf "$TG_DIR"
```

A successful call returns `{"invocationId": "...", "status": "completed", "tool": "...", "result": ...}`. A call may also set `"timeoutMs"` (default 10000, at most 60000); on SSH and sandbox runs the bridge gives up on a request after about 30 seconds, so stay below that there.

The session takes its task from your run. A run woken without a task that needs an approval-gated tool can name the task it checked out when it creates the session: `--data-binary '{"issueId": "<issue id>"}'`, using the issue's `id`, not its identifier.

## Approval-gated tools

Tools configured as **ask first** say so in their description. Calling one behaves exactly as described in the Paperclip skill under **MCP Tool Approval Gates**:

- The call returns `409` with `reasonCode: "approval_required"`, an `actionRequestId`, and `instructions`. Paperclip has posted one approval card on your task. Do not retry while it is pending: finish other useful work, note that you are waiting on tool approval, move the task to `in_review`, and end the run.
- You are woken with the decision. Approval runs the stored call exactly once and your wake includes the result; do not call the tool again for it. Rejection means it did not run; change your approach instead of retrying.
- Calling again with identical arguments never stacks cards: a pending request is reused, an executed one returns its stored outcome, and an expired one (after 60 minutes) opens one fresh card.
- `409` with `reasonCode: "approval_path_missing"` means the session has no task to post the card on; create the session from a run that has the task checked out, or name the task when you create it (see above).

## Errors

Errors are JSON with `error` and `reasonCode`:

- `401` `session_invalid`, `session_expired`, `session_revoked`: create one new session and continue with it.
- `403` or `429` with a `decision`: a tool policy denied or rate-limited the call. Do not retry it in a loop; change your approach or ask for access.
- `404` `tool_not_found`: the name is not in your list; list the tools again.
- `502` `tool_error`: the tool itself failed; read `error` and adjust the parameters or approach.
- `403` with an `error` starting `Route not allowed`: the run bridge refused the route; see `references/bridge-policies.md` and do not retry.
