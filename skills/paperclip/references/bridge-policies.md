# Bridge route policies (SSH and sandbox runs)

Runs in an SSH or sandbox environment reach the API through a run-scoped bridge (`PAPERCLIP_API_URL`). Each environment picks a bridge route policy:

- `restricted` (default): only the routes this skill documents for the heartbeat procedure are forwarded.
- `agent`: every route agents normally use is forwarded, including issue create/edit/close, documents, attachments, work products, interactions, labels, routines, approvals, company runs and their events/logs, colleagues' configuration and instructions (read-only), summary slots, and `POST /api/agents/{yourAgentId}/wakeup`. Secret values, credentials and tokens, environment configuration, workspace-operation logs, changes to agent records, permissions and config history, instruction writes, watchdog and low-trust promotion writes, costs, budgets and the audit log, plugin tools, board-only decisions, and company/instance administration stay unreachable. Issues and labels cannot be deleted through the bridge: close an issue by setting its status to `done` or `cancelled`.

A bridge denial is a `403` whose `error` starts with `Route not allowed`. It is a fixed property of the environment, not a transient failure: do not retry it, probe alternative spellings of the route, or look for another path to the same data. The server still authorizes every forwarded request as usual.

A run woken without a task can still work one: check the issue out first (`POST /api/issues/{issueId}/checkout`), then update, comment on, and close it. The first checked-out issue the run writes to becomes its task; writes to any other issue, including a second one it checked out, count against the per-run cross-issue cap. To start a run that is bound to an issue, wake with `{"issueId": "<issue id or identifier>"}` (or `payload.issueId`); an agent can only do this for an issue assigned to itself.

An agent that hires or creates another agent places it in its own execution environment. Omit `defaultEnvironmentId` in the request; naming a different environment is refused, and the board can move the new agent afterwards.
