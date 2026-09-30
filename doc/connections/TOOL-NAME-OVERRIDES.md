# Presenting connected tools under other names

An MCP connection's tools reach agents under generated gateway names such as
`mcp.tickets-1a2b3c4d:search`, with the description the upstream server wrote.
An operator can present any of those tools under a different name and
description, and can give the connection itself a different name and
description wherever agents see it. Typical reasons: upstream names that are too
generic (`search`, `list`), names that collide in meaning across servers, and
upstream descriptions that are vague, very long, or written for another client.

Overrides change only what agents see and call. They never change which tools
an agent may use, how a call is reviewed, or what is audited.

## Configuration

Overrides live in the connection's `config`, next to settings such as
`toolTimeoutMs`:

```json
{
  "url": "https://mcp.example.com/mcp",
  "toolOverrides": {
    "search": { "name": "find_tickets", "description": "Find support tickets by keyword." },
    "create_ticket": { "name": "open_ticket" },
    "export": { "description": "Export tickets as CSV. Large exports take a minute." }
  },
  "agentDisplayName": "Ticket desk",
  "agentDescription": "Support tickets for the help desk."
}
```

| Key | Meaning |
| --- | --- |
| `toolOverrides` | Object keyed by the **upstream** tool name (the catalog entry's `toolName`). Each value sets `name`, `description`, or both. |
| `toolOverrides.<tool>.name` | Name agents see and call instead of the generated gateway name. |
| `toolOverrides.<tool>.description` | Description agents see instead of the upstream description. |
| `agentDisplayName` | Connection name agents see (for example in `connections_search`) instead of the connection's own name. |
| `agentDescription` | Connection description agents see instead of the application's description. |

Set them with the connection API. `config` replaces the stored object, so send
the connection's full config with the new keys:

```sh
curl -fsS "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $BOARD_API_KEY" | jq '.config' > config.json
jq '.toolOverrides.search = {"name": "find_tickets", "description": "Find support tickets by keyword."}' \
  config.json > next.json
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d "$(jq -c '{config: .}' next.json)"
```

`GET /api/tool-connections/:id/catalog` reports the effective values per entry
as `exposedName` and `exposedDescription`; the entry's own `name`,
`toolName` and `description` stay the upstream values.

### Validation

The connection schema rejects, with `422`:

- an exposed name that does not start with a letter, contains anything other
  than letters, digits, `_` and `-`, or is longer than 64 characters. Generated
  and platform tool names always contain `.` or `:`, so an alias can never take
  one of their names;
- an exposed name reserved for a platform tool: `search_tools`, `run_tool`, or
  any name starting with `paperclip` (all compared case-insensitively);
- the same exposed name for two tools of one connection (case-insensitively);
- an override with neither `name` nor `description`, an unknown field, an empty
  description, or a description over 4000 characters;
- an `agentDisplayName` over 160 characters or an `agentDescription` over 4000.

The server additionally rejects, with `422`:

- an exposed name that another connection of the company, not archived, already
  uses (`code: "exposed_tool_name_conflict"`). An agent can be granted tools
  from several connections, so aliases are unique across the company;
- `toolOverrides` on a connection that is not an MCP tool connection
  (transport `mcp_remote` or `local_stdio`).

## Where agents see the override

| Surface | Behavior |
| --- | --- |
| MCP gateway (`POST /mcp/gateways/:id`, `POST /api/tool-gateway/gateways/:id/mcp`), used by native MCP clients such as Claude Code and Codex | `tools/list` returns the alias as `name` and `title` and the override description. `tools/call` accepts the alias. |
| REST tool gateway | `GET /api/tool-gateway/tools` returns the alias as `name` (also as `exposedName`; `providerMetadata` keeps `gatewayToolName` and `upstreamToolName`). `POST /api/tool-gateway/tools/call` accepts the alias, and the response's `tool` echoes it. |
| On-demand tools | `search_tools` results name the tool by its alias and match queries against it; `run_tool` accepts it. |
| Runner-relayed tools | The runner keeps its `app_` namespace so an assigned tool can never shadow a runner tool; the name is derived from the alias (`app_find_tickets_<digest>`). |
| Approval cards | The card asks to approve the alias; its technical details name the upstream tool too. The wake that reports the outcome names the tool by its alias. |
| Errors | Approval, policy and elicitation errors name the tool by its alias. |
| `connections_search` | A configured connection is shown with `agentDisplayName` / `agentDescription`, and matches searches for its tools' aliases and override descriptions (a replaced upstream description is no longer matched). |

When a tool has neither an upstream nor an override description, the fallback
text names the alias and the connection's `agentDisplayName`.

## What does not change

The generated gateway name stays the tool's identity, and the alias is only a
second name for it:

- Tool profiles (`tool_name` entries), policies (`toolName` / `toolNames`
  selectors), trust rules and rate-limit buckets keep matching the generated
  name and the upstream name, never the alias. Renaming a tool therefore never
  widens or narrows access, and a policy cannot be sidestepped by calling a
  tool under its alias.
- Invocation records and pending approvals store the generated name. Renaming a
  tool while an approval is pending does not break its execution or the
  agent's retry, and calls by the generated name keep working.
- The generated name itself is unchanged; `agentDisplayName` does not rename
  the connection's tools.

## Audit

Call events keep `toolName` as the generated name and record both
`metadata.upstreamToolName` and `metadata.exposedToolName`, and the gateway's
audit entries carry the same two fields. `GET /api/tool-gateway/audit?search=`
matches an alias, and the audit shows the alias as the tool's display name.

## Catalog refresh and review

Overrides are keyed by the upstream tool name and stored on the connection, not
on catalog entries, so they survive catalog refreshes. They are not part of a
catalog entry's version or schema hash: a changed upstream schema still puts
the entry back into review (quarantine) as before, and a quarantined tool is not
listed to agents under either name until it is re-enabled. An override for a
tool the server no longer offers is inert and applies again if the tool returns.

A stored config that would no longer pass validation (for example two
connections that end up with the same alias, or a name that has since become
reserved by a platform tool) never makes a call ambiguous: the gateway drops
that alias, the tool keeps its generated name, and a description override still
applies.
