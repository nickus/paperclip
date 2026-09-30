# Connecting any remote MCP server

Paperclip can connect a standards-compliant remote HTTP MCP server without a
Paperclip code change. A curated `AppDefinition` is a **convenience layer** —
branding, tailored fields, scoped defaults, support copy — not a prerequisite.

This is the documented baseline for connecting anything. Read
[Connection authoring runbook](./CONNECTOR-PLAYBOOK.md) when you want to add the branded
convenience layer on top for a vendor Paperclip should promote.

Accepted in the [generic remote MCP plan](/PAP/issues/PAP-17078#document-plan),
implemented in [PAP-17087](/PAP/issues/PAP-17087).

## The two routes

| Route | Where | Use it when |
| --- | --- | --- |
| Guided URL | **Apps → Connect an app → Connect your own MCP server** | You have the server's address. Paperclip probes it and walks you through whatever it needs. |
| Paste a config | **Advanced → Paste a config** | A README gave you an `mcpServers` snippet, or the server needs headers with names Paperclip could not guess. |

Both routes normalize through the same backend contract, so auth discovery,
secret handling, catalog refresh and review cannot diverge between them.

**Advanced → Run your own** is a separate, higher-trust path for local stdio
commands and is deliberately not covered here.

Don't know the address or the headers? The question-mark control beside
**Paste a config** gives you a request you can hand to an agent: it asks the
agent to consult the vendor's current documentation and reply with one
paste-ready `mcpServers` JSON object using credential *placeholders*, plus notes
on how to obtain each credential. Paste only the JSON block back into Paperclip;
Paperclip reads the header names from it and asks you for the values, which it
stores as Paperclip secrets.

## What the guided URL flow does

After you paste an address and press **Check link**, Paperclip probes the
endpoint and branches:

| Endpoint says | You get |
| --- | --- |
| Nothing needed | Discovered actions, straight to review. |
| Needs authorization, and publishes discoverable OAuth metadata | **Sign in to continue** — a browser sign-in at the provider. |
| Needs authorization, but no discoverable sign-in | A prompt to add the key or headers its docs list, under **Advanced authentication**. |
| Needs a client you registered yourself | A prompt for a client ID and secret. The draft connection is kept — you don't start over. |
| Not a valid address / private network / unreachable | The specific problem and which field to change. |

An unknown server is labelled **Unverified server** with its host shown, at every
step through review, access and install. Reads are enabled for review;
state-changing actions start off; newly discovered actions are quarantined until
reviewed. That is the same treatment a curated connection gets.

For **Just me**, the first probe of a new URL with no supplied credentials runs
before a personal authorization exists. If the server requires OAuth, Paperclip
creates the personal grant only after sign-in succeeds. If the server is public,
Paperclip creates a personal grant with no credentials after the probe succeeds.
That successful public probe saves the draft identity and its grant. A later
catalog-refresh failure leaves them available for retry instead of undoing a
grant that another setup attempt may already be using.
Catalog and default-profile writes after that probe are atomic: a failure rolls
back that step while retaining the established draft identity.
Later health checks still require the user's authorization and return an
actionable `422` error when it is missing.

### Slack app access

If Slack reports that MCP access is disabled for the app, ask the Slack app
owner to enable MCP access in the app's Slack settings, then refresh the
connection. Signing in alone does not enable that app setting. Paperclip shows
this as a setup error and keeps the connection available for retry. See
[Slack's MCP app requirements](https://docs.slack.dev/ai/slack-mcp-server/#app-identity).

### Advanced authentication

Collapsed by default. Open it when the server's docs are specific:

- **No sign-in needed** — the server is open to anyone with the address.
- **Key or token** — sent as an `Authorization` header.
- **Custom headers** — for servers that name their own headers.
- **Browser sign-in** — optionally with a client ID and secret you registered
  yourself, for providers that require preregistration.

Every value you enter becomes a Paperclip secret. Values are write-only: they
never appear in stored config JSON, logs, activity details, API responses after
write, or UI readback. Only header *names* are shown in review and diagnostics.

Paperclip refuses to send header names it manages or that belong to the
transport — `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding`,
hop-by-hop headers, and anything under `Proxy-*` or `Sec-*` — and rejects
values containing line breaks or control characters. This is enforced in shared
code (`packages/shared/src/mcp-remote-headers.ts`), checked at the API boundary,
and re-checked in the service immediately before the header is projected onto a
real request.

## How sign-in gets a client

You never choose this; Paperclip resolves it and the wizard shows none of it.
Recorded here for security review and diagnostics. In preference order:

1. **Deployment-preconfigured client.** `PAPERCLIP_TOOL_OAUTH_<PROVIDER>_CLIENT_ID`
   / `_SECRET`, or the unsuffixed `PAPERCLIP_TOOL_OAUTH_CLIENT_ID` / `_SECRET`.
   Always wins when set.
2. **Client ID Metadata Document (CIMD).** When the authorization server
   advertises `client_id_metadata_document_supported`, Paperclip presents the URL
   of its own published metadata document as the `client_id`. Nothing is
   registered. **Requires a public HTTPS base URL** (`PAPERCLIP_PUBLIC_URL`):
   the authorization server has to fetch that document server-to-server, so
   loopback and plain-HTTP deployments fall through to the next tier.
   The document is served unauthenticated at `/api/tools/oauth/client-metadata`
   and contains only this deployment's callback and the grant/response/auth
   methods Paperclip uses — no company, connection or secret data.
3. **Dynamic client registration (RFC 7591).** When the authorization server
   advertises a `registration_endpoint`. Paperclip registers a public client
   (`token_endpoint_auth_method: none`, `application_type: web`, PKCE S256).
4. **Manual preregistered client.** The client ID and secret you paste under
   **Advanced authentication → Browser sign-in**.

A generic connection may register (tiers 2 and 3) **only after** validated
protected-resource and authorization-server discovery actually produced a
metadata document, and only on an explicit operator connect action. An endpoint
that merely returns a 401 does not earn a registration.

### Client binding

Client material is bound to the authorization-server issuer, the MCP resource
URL, the callback URI, and the company. If any of those change:

- a Paperclip-minted client (CIMD or DCR) is **re-registered**;
- a client you supplied yourself is **not** — Paperclip stops and asks you to
  re-enter it, because it cannot register on your behalf in a console it does
  not control.

Credentials are never reused across issuers or across companies.

### Endpoint addresses are validated before they are used

Every OAuth endpoint address is chosen by the remote server — in discovered
metadata, in a `WWW-Authenticate` hint, in a pasted config, or in a gallery
default — and the authorization endpoint additionally becomes a top-level browser
navigation. All of them are parsed by one shared validator
(`checkOAuthEndpointUrl` in `@paperclipai/shared`) and must be:

- **`https:`.** Plain `http:` is refused, except for a loopback host under the
  local-development policy (the same policy that allows private remote
  endpoints), and except for this deployment's own origin.
- **Free of embedded credentials.** `https://accounts.google.com@evil.test/…`
  reads as the wrong site to a human, so Paperclip refuses it.
- **Free of a fragment**, and a well-formed absolute URL.

`javascript:`, `data:`, `file:` and friends are therefore refused before they can
reach `window.location`. The board applies the same validator to the address it
receives, so an unsafe value cannot pass the API boundary and then execute at the
navigation boundary. A refusal is reported as
`oauth_<kind>_endpoint_rejected` (422) and the unsafe value is never persisted on
the connection.

An address that passes is still only an address: a valid HTTPS authorization page
can be a phishing page. The redirect screen names the host you are being sent to,
and the **Unverified server** label stays visible for an endpoint with no curated
definition.

### Protocol conformance

- RFC 8707 `resource` on authorization, token, and refresh requests, naming the
  canonical MCP endpoint (origin + path, no query or fragment), so the
  authorization server can audience-restrict the token to that server.
- RFC 9728 protected-resource discovery, path-aware first
  (`/.well-known/oauth-protected-resource<path>`) then origin.
- RFC 8414 authorization-server discovery for issuers with a path, in the
  spec's insertion form (`/.well-known/oauth-authorization-server<path>`) and
  the widely deployed OIDC suffix form (`<path>/.well-known/...`). A metadata
  document whose `issuer` disagrees with the issuer used to build the discovery
  URL is discarded.
- RFC 9207 `iss` validated against the persisted expected issuer when the
  authorization server returns it. A mismatch refuses the code rather than
  exchanging it. An absent `iss` is tolerated — it is optional and widely
  omitted.
- PKCE S256, exact redirect/state binding, and SSRF/private-network and redirect
  limits are unchanged from the curated path.

The discovered auth kind, issuer, and resource are persisted on the connection,
so refresh, reconnect, revoke and diagnostics all use the generic path instead of
falling back to `authKind: none` semantics.

### Tool-call timeouts

Each tool call runs under one deadline that the gateway owns. When it passes,
the call fails with `reasonCode: "tool_timeout"` (HTTP `504`).

| Source | Applies when | Range |
| --- | --- | --- |
| `timeoutMs` in a `POST /api/tool-gateway/tools/call` body | The REST caller names one | Clamped to 1–300000 ms |
| `toolTimeoutMs` in the connection's `config` | The call names none: native MCP clients through an MCP gateway, REST calls without `timeoutMs`, and test calls | Integer, 1000–300000 ms, validated on create and update |
| Built-in default | Neither of the above | 10000 ms |

Set a longer default for a server whose tools are known to be slow, for
example one that answers questions by running a model:

```sh
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{ "config": { "url": "https://mcp.example.com/mcp", "toolTimeoutMs": 60000 } }'
```

`config` replaces the stored object, so send the connection's full config with
the new key. When Paperclip itself carries out an action a human approved, it
allows at least 60 s, or the connection's `toolTimeoutMs` when that is longer.

The hops around the gateway leave room for the longest call: the MCP client
configuration Paperclip writes for Claude Code and Codex runs, and the sandbox
callback bridge's tool-call routes (`POST /api/tool-gateway/tools/call`,
`POST /mcp/gateways/:id`), wait slightly longer than 300 s, so the caller sees
the gateway's `tool_timeout` answer rather than a transport error. A reverse
proxy in front of Paperclip needs a read timeout above that too if agents reach
the gateway through it; many default to 60 s.

A tool-call timeout, or any other error from a server that answered (a JSON-RPC
error, an HTTP error status, an unusable body), fails only that call. It does
not change the connection's health, so the connection's other tools stay
listed. Health follows health checks and reachability: three consecutive calls
that cannot reach the server at all (connection refused, DNS or TLS failure,
HTTP 502/503/504) mark the connection `error` until a health check or a
successful call restores it. Three consecutive timeouts with no answered call
in between do not change health either, but they make the connection's health
check due, so the periodic health sweep probes it with `tools/list` on its next
pass: a server that still answers stays healthy, one that accepts connections
but never answers is marked `error` and its tools stop being listed.

### Content retention

The gateway records every tool call. By default those records include a
redacted summary of the call's arguments and of its result (truncated to 4000
characters) next to their SHA-256 hashes and sizes. For a server that holds
private material, such as a personal notes server, a mailbox or a document
store, those summaries copy that material into Paperclip's database, where
anyone who can read the audit log can see it. `contentRetention` in the
connection's `config` chooses what is kept:

| `config.contentRetention` | Stored for each call |
| --- | --- |
| `"summary"` (default) | Who, when, which tool, policy decision, outcome, latency, error code and message, plus redacted, truncated argument and result summaries with their SHA-256 hashes and sizes |
| `"none"` | Who, when, which tool, policy decision, outcome, latency, error code, and the SHA-256 hashes and sizes of the arguments and the result. No argument text, result text or provider error text |

Any other value is rejected on create and update. A stored config whose
`contentRetention` is present but not one of these values (for example `null`,
written before validation or directly to the database) is read as `"none"`.
Keep content out of the database for a private notes server:

```sh
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{ "config": { "url": "https://notes.example.com/mcp", "contentRetention": "none" } }'
```

As with `toolTimeoutMs`, send the connection's full config with the new key.

The setting only changes what is stored; the agent that made a call still
receives the full result. With `"none"`:

- Tool invocations, the call event log, the gateway audit, the activity log,
  and the live and plugin events that the activity log feeds carry hashes and
  sizes only. Their summaries are empty and marked
  `"contentRetention": "none"`, so a reader can tell "not kept" from "empty".
- A failed call stores its error code and a fixed message instead of the
  provider's error text. The caller still receives the original message.
- An approval card and its action request show the action, its risk, and the
  SHA-256 and size of the arguments, but not their values, so the approver
  decides without seeing them. The signed arguments that execution needs stay
  on the action request only until it settles (executed, failed, rejected,
  expired or cancelled); then they are removed. The API never returns them,
  for any connection: they are signed, not encrypted.
- When Paperclip runs an action a human approved, the result is not stored, so
  the agent's follow-up wake says the action ran without including its result.
  A retry of the same call does not run it again and returns a note that the
  result was not kept. If the agent needs the output, it reads the current
  state with a read-only call.
- A question the server asks during a call (MCP elicitation) still appears on
  the task so a human can answer it; the call event does not keep a copy.
- Records written before the setting changed are not rewritten. The setting
  applies from the next call.
- Changing `config` while an action waits for approval makes that approval
  stale, as for any config change; the action needs a new review.

`PAPERCLIP_TOOL_CONTENT_RETENTION_DEFAULT` (`summary` or `none`) sets the
default for every connection whose config does not set `contentRetention`,
including connections that already exist. Leave it unset to keep summaries.
A connection that sets `"summary"` keeps summaries under a `none` default. The
variable is read at call time; an unrecognized value is treated as `none`.

Separately from this setting, the HTTP request log never records the body of a
failed tool-call request (`POST /api/tool-gateway/tools/call`,
`POST /mcp/gateways/:id`, `POST /api/tool-gateway/gateways/:id/mcp`,
`POST /api/tool-connections/:id/test-calls`, and any other route served by the
same handlers); an approval-gated call answers `409`, so these bodies used to
reach the log.

## Curated definitions remain optional

A curated definition matching a pasted endpoint is offered as a branded
shortcut beside the generic form — never instead of it. A definition adds labels,
logos, field validation, scoped defaults and support copy. It does **not** unlock
a separate execution capability, and it must not create a second connection or
change ownership.

The bespoke [PostHog connection](./POSTHOG.md) is the worked example: it is the
polished route for most users, and PostHog is also connectable generically
through this page with either a key or browser sign-in.

## Verifying

Deterministic coverage lives in
`server/src/__tests__/generic-mcp-connection.test.ts` uses a simulated MCP/OAuth
provider and a real loopback HTTP server for the personal public-URL regression.
It needs no vendor credentials. Tests create an isolated PostgreSQL database
and close their servers after use.
A credentialed vendor smoke (for example live PostHog OAuth) may be recorded by
QA but is not required for deterministic verification.

### Opt-in generic Notion live smoke

`pnpm smoke:notion-generic-live` exercises the generic **Advanced → Paste a
config** route against `https://mcp.notion.com/mcp`. It is intentionally outside
the normal unit, browser, and CI-required suites. Run it only against an
already-running, browser-reachable HTTPS Paperclip instance with these bindings
provided by the execution environment:

- `PAPERCLIP_E2E_BASE_URL`, `PAPERCLIP_E2E_EMAIL`, and
  `PAPERCLIP_DEV_LOGIN_PASSWORD` for the target instance;
- `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, and
  `PAPERCLIP_TASK_ID` for the control plane;
- the approved on-demand secret binding
  `access.notion_generic_flow_test_account`, delivered by the agent secret API
  under its normalized key `generic-flow-test-account`, for the existing Notion
  test account.

If that account requires an emailed one-time code, also set `AGENTMAIL_API_KEY`
and `NOTION_AGENTMAIL_INBOX_ID` for the already-configured forwarding inbox. The
smoke loads the AgentMail SDK only after Notion presents the code challenge,
accepts only a fresh authenticated Notion message, fills the code once in
memory, and never records the message, address, or code.

Check the URL, health endpoint, and binding metadata without retrieving the
credential value or opening a browser:

```sh
pnpm smoke:notion-generic-live -- --dry-run
```

The live command retrieves the credential only after the safe preflight and
Paperclip login succeed. It disables trace, video, and HAR capture, takes only
post-callback screenshots, enables and invokes only `notion-get-self`, proves
`notion-create-pages` remains locally denied, and removes its uniquely named
connection in a `finally` cleanup. Its `summary.json` and PNG files contain
sanitized IDs, decisions, outcomes, and endpoint origins/paths only; they
default to `PAPERCLIP_RUN_SCRATCH_DIR`, or to `NOTION_EVIDENCE_DIR` when set.

Run the credential-free harness checks with:

```sh
node --test scripts/smoke/notion-generic-live.test.mjs
```
