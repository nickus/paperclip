import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_SANDBOX_CALLBACK_BRIDGE_DENY_RULES,
  authorizeSandboxCallbackBridgeRequestForPolicy,
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAuthorizer,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST,
  describeNonCanonicalSandboxCallbackBridgePath,
  getSandboxCallbackBridgeServerSource,
  normalizeSandboxCallbackBridgePolicy,
  sandboxCallbackBridgeDirectories,
  sanitizeSandboxCallbackBridgeHeaders,
  startSandboxCallbackBridgeWorker,
  STEWARD_SANDBOX_CALLBACK_BRIDGE_DENY_RULES,
} from "./sandbox-callback-bridge.js";

type RouteCase = { method: string; path: string };

const COMPANY = "co-1";
const OTHER_COMPANY = "co-2";

function restricted(request: RouteCase) {
  return authorizeSandboxCallbackBridgeRequestForPolicy(request, { policy: "restricted" });
}

function agent(request: RouteCase) {
  return authorizeSandboxCallbackBridgeRequestForPolicy(request, { policy: "agent", companyId: COMPANY });
}

function steward(request: RouteCase) {
  return authorizeSandboxCallbackBridgeRequestForPolicy(request, { policy: "steward", companyId: COMPANY });
}

// Mirrors the case-insensitive, trailing-slash-stripped matching the real
// authorizer applies before testing deny rules, so these tests can tell
// which denial wording a fixture request should get: the detailed
// secrets/credentials/administration wording when a deny rule actually
// matches, or the plain "not available" wording when the request is simply
// outside the policy's allow families.
function matchesDenyRule(rules: readonly { methods: readonly string[]; path: RegExp }[], request: RouteCase): boolean {
  const method = request.method.toUpperCase();
  const lowered = request.path.toLowerCase();
  const matchPath = lowered.length > 1 && lowered.endsWith("/") ? lowered.slice(0, -1) : lowered;
  return rules.some((rule) => rule.methods.includes(method) && rule.path.test(matchPath));
}

// The REST tool gateway routes every policy forwards: create a session for
// the calling run, list its tools, call one, revoke the session.
const TOOL_GATEWAY_ALLOWED: RouteCase[] = [
  { method: "POST", path: "/api/tool-gateway/sessions" },
  { method: "POST", path: "/api/tool-gateway/sessions/3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b/revoke" },
  { method: "GET", path: "/api/tool-gateway/tools" },
  { method: "POST", path: "/api/tool-gateway/tools/call" },
];

// The rest of the tool gateway, and lookalikes of the four routes above, which
// no policy forwards.
const TOOL_GATEWAY_DENIED: RouteCase[] = [
  // Other methods on the forwarded routes.
  { method: "GET", path: "/api/tool-gateway/sessions" },
  { method: "PUT", path: "/api/tool-gateway/sessions" },
  { method: "DELETE", path: "/api/tool-gateway/sessions" },
  { method: "GET", path: "/api/tool-gateway/sessions/s-1/revoke" },
  { method: "DELETE", path: "/api/tool-gateway/sessions/s-1/revoke" },
  { method: "POST", path: "/api/tool-gateway/tools" },
  { method: "DELETE", path: "/api/tool-gateway/tools" },
  { method: "GET", path: "/api/tool-gateway/tools/call" },
  { method: "PUT", path: "/api/tool-gateway/tools/call" },
  // Paths next to them.
  { method: "GET", path: "/api/tool-gateway" },
  { method: "POST", path: "/api/tool-gateway" },
  { method: "GET", path: "/api/tool-gateway/sessions/s-1" },
  { method: "POST", path: "/api/tool-gateway/sessions/s-1" },
  { method: "DELETE", path: "/api/tool-gateway/sessions/s-1" },
  { method: "POST", path: "/api/tool-gateway/sessions/revoke" },
  { method: "POST", path: "/api/tool-gateway/sessions/s-1/revoke/extra" },
  { method: "POST", path: "/api/tool-gateway/sessions/s-1/s-2/revoke" },
  { method: "POST", path: "/api/tool-gateway/sessions/s-1/refresh" },
  { method: "POST", path: "/api/tool-gateway/session" },
  { method: "POST", path: "/api/tool-gateway/sessions-x" },
  { method: "GET", path: "/api/tool-gateway/tools/tool-1" },
  { method: "GET", path: "/api/tool-gateway/tools-x" },
  { method: "POST", path: "/api/tool-gateway/tools/call/extra" },
  { method: "POST", path: "/api/tool-gateway/tools/tool-1/call" },
  { method: "POST", path: "/api/tool-gateway/tools/calls" },
  { method: "POST", path: "/api/tool-gateway-sessions" },
  { method: "POST", path: "/api/companies/co-1/tool-gateway/sessions" },
  { method: "POST", path: "/tool-gateway/sessions" },
  { method: "POST", path: "/tool-gateway/tools/call" },
  // Named gateways and their tokens, approval decisions, runtime slots, audit.
  { method: "PATCH", path: "/api/tool-gateway/gateways/gw-1" },
  { method: "POST", path: "/api/tool-gateway/gateways/gw-1/tokens" },
  { method: "GET", path: "/api/tool-gateway/gateways/gw-1/mcp" },
  { method: "POST", path: "/api/tool-gateway/gateways/gw-1/mcp" },
  { method: "POST", path: "/api/tool-gateway/gateway-tokens/tok-1/revoke" },
  { method: "POST", path: "/api/tool-gateway/action-requests/ar-1/approve" },
  { method: "POST", path: "/api/tool-gateway/action-requests/ar-1/decline" },
  { method: "GET", path: "/api/tool-gateway/runtime-slots" },
  { method: "POST", path: "/api/tool-gateway/runtime-slots/slot-1/stop" },
  { method: "POST", path: "/api/tool-gateway/runtime-slots/slot-1/restart" },
  { method: "GET", path: "/api/tool-gateway/audit" },
  { method: "GET", path: "/api/companies/co-1/tools/gateways" },
  { method: "POST", path: "/api/companies/co-1/tools/gateways" },
  { method: "GET", path: "/mcp/gateways/gw-public-1" },
  { method: "POST", path: "/mcp/gateways/gw-public-1" },
];

// Every route the restricted allowlist carries, one sample each.
const RESTRICTED_ALLOWED: RouteCase[] = [
  { method: "POST", path: "/runtime-tools/github/credentials" },
  { method: "GET", path: "/api/agents/me" },
  { method: "GET", path: "/api/agents/me/inbox-lite" },
  { method: "GET", path: "/api/agents/me/inbox/mine" },
  { method: "GET", path: "/api/agents/agent-1" },
  { method: "GET", path: "/api/agents/agent-1/skills" },
  { method: "POST", path: "/api/agents/agent-1/skills/sync" },
  { method: "PATCH", path: "/api/agents/agent-1/instructions-path" },
  { method: "GET", path: "/api/openapi.json" },
  { method: "GET", path: "/api/companies/co-1" },
  { method: "GET", path: "/api/companies/co-1/dashboard" },
  { method: "GET", path: "/api/companies/co-1/agents" },
  { method: "GET", path: "/api/companies/co-1/issues" },
  { method: "GET", path: "/api/companies/co-1/projects" },
  { method: "GET", path: "/api/companies/co-1/goals" },
  { method: "GET", path: "/api/companies/co-1/org" },
  { method: "GET", path: "/api/companies/co-1/approvals" },
  { method: "GET", path: "/api/companies/co-1/routines" },
  { method: "GET", path: "/api/companies/co-1/skills" },
  { method: "GET", path: "/api/projects/proj-1" },
  { method: "GET", path: "/api/goals/goal-1" },
  { method: "GET", path: "/api/companies/co-1/email/inboxes" },
  { method: "GET", path: "/api/companies/co-1/email/tasks/issue-1" },
  { method: "GET", path: "/api/companies/co-1/email/deliveries/send-1" },
  { method: "POST", path: "/api/companies/co-1/email/send" },
  { method: "GET", path: "/api/issues/issue-1" },
  { method: "GET", path: "/api/issues/issue-1/heartbeat-context" },
  { method: "GET", path: "/api/issues/issue-1/comments" },
  { method: "GET", path: "/api/issues/issue-1/comments/c-1" },
  { method: "POST", path: "/api/issues/issue-1/comments" },
  { method: "GET", path: "/api/issues/issue-1/queued-comments" },
  { method: "GET", path: "/api/issues/issue-1/documents" },
  { method: "GET", path: "/api/issues/issue-1/documents/plan" },
  { method: "GET", path: "/api/issues/issue-1/documents/plan/revisions" },
  { method: "PUT", path: "/api/issues/issue-1/documents/plan" },
  { method: "POST", path: "/api/issues/issue-1/checkout" },
  { method: "POST", path: "/api/issues/issue-1/release" },
  { method: "PATCH", path: "/api/issues/issue-1" },
  { method: "GET", path: "/api/issues/issue-1/approvals" },
  { method: "GET", path: "/api/issues/issue-1/attachments" },
  { method: "POST", path: "/api/companies/co-1/issues/issue-1/attachments" },
  { method: "GET", path: "/api/attachments/att-1/content" },
  { method: "GET", path: "/api/issues/issue-1/work-products" },
  { method: "POST", path: "/api/issues/issue-1/work-products" },
  { method: "PATCH", path: "/api/work-products/wp-1" },
  { method: "GET", path: "/api/issues/issue-1/interactions" },
  { method: "GET", path: "/api/issues/issue-1/interactions/inter-1" },
  { method: "POST", path: "/api/issues/issue-1/interactions" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/accept" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/reject" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/respond" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/verdicts" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/withdraw" },
  { method: "POST", path: "/api/companies/co-1/issues" },
  { method: "GET", path: "/llms/agent-configuration.txt" },
  { method: "GET", path: "/llms/agent-configuration/claude_local.txt" },
  { method: "GET", path: "/llms/agent-icons.txt" },
  { method: "GET", path: "/api/companies/co-1/agent-configurations" },
  { method: "POST", path: "/api/companies/co-1/agent-hires" },
  { method: "POST", path: "/api/issues/issue-1/approvals" },
  { method: "GET", path: "/api/approvals/ap-1" },
  { method: "GET", path: "/api/approvals/ap-1/issues" },
  { method: "GET", path: "/api/approvals/ap-1/comments" },
  { method: "POST", path: "/api/approvals/ap-1/comments" },
  { method: "POST", path: "/api/companies/co-1/approvals" },
  { method: "GET", path: "/api/execution-workspaces/ws-1" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/start" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/stop" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/restart" },
  { method: "GET", path: "/api/routines/r-1" },
  { method: "GET", path: "/api/routines/r-1/runs" },
  { method: "POST", path: "/api/companies/co-1/routines" },
  { method: "PATCH", path: "/api/routines/r-1" },
  { method: "POST", path: "/api/routines/r-1/run" },
  { method: "POST", path: "/api/routines/r-1/triggers" },
  { method: "PATCH", path: "/api/routine-triggers/t-1" },
  { method: "DELETE", path: "/api/routine-triggers/t-1" },
  ...TOOL_GATEWAY_ALLOWED,
];

// Routes agents call that only the `agent` policy forwards. The server still
// authorizes each one for the calling agent.
const AGENT_ONLY_ALLOWED: RouteCase[] = [
  // Issues: create, edit, close, subtasks, documents, interactions.
  { method: "GET", path: "/api/issues" },
  { method: "GET", path: "/api/issues/identifier/ABC-1" },
  { method: "POST", path: "/api/issues/issue-1/children" },
  { method: "POST", path: "/api/issues/issue-1/documents/plan" },
  { method: "DELETE", path: "/api/issues/issue-1/documents/plan" },
  { method: "POST", path: "/api/issues/issue-1/documents/plan/revisions/rev-1/restore" },
  { method: "POST", path: "/api/issues/issue-1/documents/plan/annotations" },
  { method: "POST", path: "/api/issues/issue-1/documents/plan/lock" },
  { method: "DELETE", path: "/api/issues/issue-1/comments/c-1" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/cancel" },
  { method: "POST", path: "/api/issues/issue-1/interactions/inter-1/skip" },
  { method: "DELETE", path: "/api/issues/issue-1/approvals/ap-1" },
  { method: "POST", path: "/api/issues/issue-1/work-products/wp-1/review-document" },
  { method: "DELETE", path: "/api/work-products/wp-1" },
  { method: "DELETE", path: "/api/attachments/att-1" },
  { method: "GET", path: "/api/issues/issue-1/recovery-actions" },
  { method: "POST", path: "/api/issues/issue-1/recovery-actions/resolve" },
  { method: "GET", path: "/api/issues/issue-1/watchdog" },
  { method: "POST", path: "/api/issues/issue-1/tree-holds" },
  { method: "GET", path: "/api/issues/issue-1/runs" },
  { method: "GET", path: "/api/issues/issue-1/active-run" },
  { method: "POST", path: "/api/companies/co-1/labels" },
  // Agents: reads (colleagues, instructions, configuration) and self-wake.
  { method: "GET", path: "/api/agents/agent-2/instructions-bundle" },
  { method: "GET", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "GET", path: "/api/agents/agent-2/configuration" },
  { method: "GET", path: "/api/agents/agent-2/config-revisions" },
  { method: "GET", path: "/api/agents/agent-2/config-revisions/rev-1" },
  { method: "POST", path: "/api/agents/agent-1/wakeup" },
  // Runs and trajectories.
  { method: "GET", path: "/api/companies/co-1/heartbeat-runs" },
  { method: "GET", path: "/api/companies/co-1/live-runs" },
  { method: "GET", path: "/api/heartbeat-runs/run-1" },
  { method: "GET", path: "/api/heartbeat-runs/run-1/events" },
  { method: "GET", path: "/api/heartbeat-runs/run-1/log" },
  { method: "GET", path: "/api/heartbeat-runs/run-1/issues" },
  // Summary slots.
  { method: "GET", path: "/api/companies/co-1/summary-slots/project/header" },
  { method: "GET", path: "/api/companies/co-1/summary-slots/project/header/revisions" },
  { method: "PUT", path: "/api/companies/co-1/summary-slots/project/header" },
  { method: "POST", path: "/api/companies/co-1/summary-slots/project/header/generate" },
  // Company reads.
  { method: "GET", path: "/api/companies/co-1/issues/count" },
  { method: "GET", path: "/api/companies/co-1/search" },
  { method: "GET", path: "/api/companies/co-1/labels" },
  { method: "GET", path: "/api/companies/co-1/activity" },
  { method: "GET", path: "/api/companies/co-1/artifacts" },
  { method: "GET", path: "/api/companies/co-1/timeline" },
  { method: "GET", path: "/api/companies/co-1/execution-workspaces" },
  { method: "GET", path: "/api/companies/co-1/workspace-overview" },
  { method: "GET", path: "/api/companies/co-1/user-directory" },
  { method: "GET", path: "/api/companies/co-1/members" },
  { method: "GET", path: "/api/companies/co-1/project-repositories" },
  { method: "GET", path: "/api/companies/co-1/skills/skill-1/files" },
  // Routines and approvals.
  { method: "GET", path: "/api/routines/r-1/revisions" },
  { method: "POST", path: "/api/routines/r-1/revisions/rev-1/restore" },
  { method: "POST", path: "/api/approvals/ap-1/resubmit" },
  // Other reads.
  { method: "GET", path: "/api/projects/proj-1/workspaces" },
  { method: "GET", path: "/api/execution-workspaces/ws-1/close-readiness" },
  { method: "GET", path: "/api/status-cards/card-1" },
  { method: "GET", path: "/api/assets/asset-1/content" },
  { method: "GET", path: "/api/skills/index" },
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/llms/agent-icons.txt" },
];

// Routes the `agent` policy refuses: credential material, environment
// configuration, the agent's own record and history, administration, and
// anything outside the listed families.
const AGENT_DENIED: RouteCase[] = [
  // Secret values and anything else that names secrets.
  { method: "GET", path: "/api/agents/me/secrets" },
  { method: "POST", path: "/api/agents/me/secrets/API_KEY/value" },
  { method: "GET", path: "/api/agents/me/secret-proposals" },
  { method: "POST", path: "/api/agents/me/secret-proposals" },
  { method: "DELETE", path: "/api/agents/me/secret-proposals/p-1" },
  { method: "GET", path: "/api/companies/co-1/secrets" },
  { method: "POST", path: "/api/companies/co-1/secrets" },
  { method: "GET", path: "/api/companies/co-1/secrets/catalog" },
  { method: "GET", path: "/api/companies/co-1/secret-providers" },
  { method: "GET", path: "/api/companies/co-1/secret-provider-configs" },
  { method: "GET", path: "/api/companies/co-1/secret-proposals" },
  { method: "GET", path: "/api/companies/co-1/me/user-secrets" },
  { method: "GET", path: "/api/companies/co-1/user-secret-definitions" },
  { method: "GET", path: "/api/secrets/secret-1" },
  { method: "PATCH", path: "/api/secrets/secret-1" },
  { method: "POST", path: "/api/secrets/secret-1/rotate" },
  { method: "GET", path: "/api/secret-provider-configs/cfg-1" },
  { method: "POST", path: "/api/routine-triggers/t-1/rotate-secret" },
  // Keys, tokens, connections, provider traces.
  { method: "GET", path: "/api/agents/agent-1/keys" },
  { method: "POST", path: "/api/agents/agent-1/keys" },
  { method: "DELETE", path: "/api/agents/agent-1/keys/key-1" },
  { method: "POST", path: "/api/agents/me/connections/conn-1/token" },
  { method: "POST", path: "/api/agents/me/connections/conn-1/start-authorization" },
  { method: "GET", path: "/api/heartbeat-runs/run-1/provider-trace" },
  { method: "GET", path: "/api/heartbeat-runs/run-1/provider-trace/download" },
  { method: "GET", path: "/api/companies/co-1/provider-traces" },
  { method: "GET", path: "/api/board-api-keys" },
  { method: "GET", path: "/api/cli-auth/me" },
  { method: "POST", path: "/api/bootstrap/claim" },
  { method: "GET", path: "/api/invites/token-1" },
  { method: "POST", path: "/api/companies/co-1/invites" },
  { method: "GET", path: "/api/companies/co-1/join-requests" },
  // Tools, connections, adapters, AI connections, login sessions.
  { method: "GET", path: "/api/agents/me/tools" },
  { method: "GET", path: "/api/companies/co-1/tools/connections" },
  { method: "GET", path: "/api/companies/co-1/tools/applications" },
  { method: "GET", path: "/api/companies/co-1/tools/gallery" },
  { method: "GET", path: "/api/tool-connections/conn-1/test-agents" },
  { method: "GET", path: "/api/tool-gateway/sessions" },
  { method: "GET", path: "/api/companies/co-1/ai-connections" },
  { method: "GET", path: "/api/companies/co-1/adapters/claude_local/models" },
  { method: "GET", path: "/api/companies/co-1/claude-oauth-token-status" },
  { method: "POST", path: "/api/companies/co-1/setup-token-login-sessions" },
  { method: "POST", path: "/api/connection-intents/intent-1/approve" },
  // Environments.
  { method: "GET", path: "/api/companies/co-1/environments" },
  { method: "POST", path: "/api/companies/co-1/environments" },
  { method: "GET", path: "/api/environments/env-1" },
  { method: "PATCH", path: "/api/environments/env-1" },
  { method: "GET", path: "/api/environments/env-1/secret-refs" },
  { method: "GET", path: "/api/environment-leases/lease-1" },
  // The agent record, its permissions, lifecycle, and config history.
  { method: "PATCH", path: "/api/agents/agent-1" },
  { method: "DELETE", path: "/api/agents/agent-1" },
  { method: "PATCH", path: "/api/agents/agent-1/permissions" },
  { method: "PATCH", path: "/api/agents/agent-1/budgets" },
  { method: "POST", path: "/api/agents/agent-1/config-revisions/rev-1/rollback" },
  { method: "POST", path: "/api/agents/agent-1/pause" },
  { method: "POST", path: "/api/agents/agent-1/resume" },
  { method: "POST", path: "/api/agents/agent-1/approve" },
  { method: "POST", path: "/api/agents/agent-1/terminate" },
  { method: "POST", path: "/api/agents/agent-1/clear-error" },
  { method: "POST", path: "/api/agents/agent-1/heartbeat/invoke" },
  { method: "POST", path: "/api/agents/agent-1/runtime-state/reset-session" },
  { method: "POST", path: "/api/agents/agent-1/claude-login" },
  { method: "POST", path: "/api/companies/co-1/agents" },
  // Instruction writes.
  { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle" },
  { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/file" },
  // Project and workspace configuration, host runtime commands.
  { method: "POST", path: "/api/companies/co-1/projects" },
  { method: "PATCH", path: "/api/projects/proj-1" },
  { method: "DELETE", path: "/api/projects/proj-1" },
  { method: "POST", path: "/api/projects/proj-1/workspaces" },
  { method: "POST", path: "/api/projects/proj-1/workspaces/ws-1/runtime-commands/run" },
  { method: "PATCH", path: "/api/execution-workspaces/ws-1" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-commands/run" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/reconcile-branch" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/login-handoff" },
  { method: "POST", path: "/api/execution-workspaces/ws-1/runtime-services/delete" },
  // Goals are read-only.
  { method: "POST", path: "/api/companies/co-1/goals" },
  { method: "PATCH", path: "/api/goals/goal-1" },
  // Company, instance, billing and plugin administration.
  { method: "PATCH", path: "/api/companies/co-1" },
  { method: "DELETE", path: "/api/companies/co-1" },
  { method: "PATCH", path: "/api/companies/co-1/branding" },
  { method: "POST", path: "/api/companies/co-1/archive" },
  { method: "POST", path: "/api/companies/co-1/exports" },
  { method: "POST", path: "/api/companies/co-1/imports/apply" },
  { method: "PATCH", path: "/api/companies/co-1/members/m-1" },
  { method: "PATCH", path: "/api/companies/co-1/budgets" },
  { method: "POST", path: "/api/companies/co-1/budgets/policies" },
  { method: "POST", path: "/api/companies/co-1/cost-events" },
  { method: "POST", path: "/api/companies/co-1/finance-events" },
  { method: "POST", path: "/api/companies/co-1/budget-incidents/inc-1/resolve" },
  { method: "GET", path: "/api/companies" },
  { method: "GET", path: "/api/instance/settings/general" },
  { method: "GET", path: "/api/admin/users" },
  { method: "GET", path: "/api/adapters" },
  { method: "GET", path: "/api/plugins" },
  { method: "POST", path: "/api/plugins/install" },
  { method: "GET", path: "/api/cloud/status" },
  { method: "POST", path: "/api/heartbeat-runs/run-1/cancel" },
  { method: "POST", path: "/api/heartbeat-runs/run-1/watchdog-decisions" },
  { method: "POST", path: "/api/issues/issue-1/admin/force-release" },
  { method: "GET", path: "/api/issues/issue-1/file-resources/content" },
  // Workspace-operation output, wherever it is nested.
  { method: "GET", path: "/api/heartbeat-runs/run-1/workspace-operations" },
  { method: "GET", path: "/api/workspace-operations/op-1/log" },
  { method: "GET", path: "/api/execution-workspaces/ws-1/workspace-operations" },
  // Irreversible deletes; closing is a status update.
  { method: "DELETE", path: "/api/issues/issue-1" },
  { method: "DELETE", path: "/api/Issues/issue-1/" },
  { method: "DELETE", path: "/api/labels/label-1" },
  // Directing other agents and promoting low-trust content.
  { method: "PUT", path: "/api/issues/issue-1/watchdog" },
  { method: "DELETE", path: "/api/issues/issue-1/watchdog" },
  { method: "POST", path: "/api/issues/issue-1/low-trust/promotions" },
  // Board-only decisions and state.
  { method: "POST", path: "/api/approvals/ap-1/approve" },
  { method: "POST", path: "/api/approvals/ap-1/reject" },
  { method: "POST", path: "/api/approvals/ap-1/request-revision" },
  { method: "GET", path: "/api/agents/agent-2/runtime-state" },
  { method: "GET", path: "/api/agents/agent-2/task-sessions" },
  { method: "GET", path: "/api/feedback-traces/trace-1" },
  { method: "GET", path: "/api/feedback-traces/trace-1/bundle" },
  { method: "GET", path: "/api/issues/issue-1/feedback-traces" },
  { method: "GET", path: "/api/companies/co-1/feedback-traces" },
  // Costs, budgets and the audit log.
  { method: "GET", path: "/api/companies/co-1/costs/summary" },
  { method: "GET", path: "/api/companies/co-1/costs/finance-events" },
  { method: "GET", path: "/api/companies/co-1/budgets/overview" },
  { method: "GET", path: "/api/companies/co-1/audit/agent-actions" },
  { method: "GET", path: "/api/companies/co-1/audit/agent-actions.csv" },
  // Agent reads outside the listed ones.
  { method: "GET", path: "/api/agents/agent-2/new-thing" },
  { method: "GET", path: "/api/agents/me/new-thing" },
  // Plugin tools run in plugin workers on the host.
  { method: "GET", path: "/api/plugins/tools" },
  { method: "POST", path: "/api/plugins/tools/execute" },
  { method: "GET", path: "/api/plugins/plugin-1/api/anything" },
  // Unknown families fail closed.
  { method: "GET", path: "/api/new-thing" },
  { method: "GET", path: "/api/runs/run-1" },
  // `/` has no "/api"-prefixed form that any policy allows, so it stays a
  // plain unmatched-route denial; `/openapi.json` does (`GET /api/openapi.json`
  // is itself allowed), so it moved to the "missing /api prefix" cases below
  // instead of this fixture.
  { method: "GET", path: "/" },
  // Methods outside the listed ones.
  { method: "OPTIONS", path: "/api/issues/issue-1" },
  { method: "HEAD", path: "/api/issues/issue-1" },
  { method: "TRACE", path: "/api/issues/issue-1" },
];

// The only writes the `steward` policy adds on top of `agent`.
const STEWARD_ONLY_ALLOWED: RouteCase[] = [
  { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle" },
  { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "POST", path: "/api/companies/co-1/skills" },
  { method: "PATCH", path: "/api/companies/co-1/skills/skill-1/files" },
  { method: "DELETE", path: "/api/companies/co-1/skills/skill-1/files" },
];

// Routes next to the steward additions that `steward` still refuses: other
// methods and sub-paths on the same resources, the rest of the skill write
// surface, and the agent-record, permission, lifecycle, history and secret
// routes a reviewer must never reach.
const STEWARD_DENIED: RouteCase[] = [
  // Instruction bundle: only PATCH on the bundle, and PUT or DELETE on a file.
  { method: "POST", path: "/api/agents/agent-2/instructions-bundle" },
  { method: "PUT", path: "/api/agents/agent-2/instructions-bundle" },
  { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle" },
  { method: "POST", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/file/extra" },
  { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file/extra" },
  { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/other" },
  // Skills: no import, install, update, reset, fork, rename, delete,
  // metadata/sharing change, or version publish.
  { method: "PUT", path: "/api/companies/co-1/skills" },
  { method: "PATCH", path: "/api/companies/co-1/skills" },
  { method: "POST", path: "/api/companies/co-1/skills/import" },
  { method: "POST", path: "/api/companies/co-1/skills/install-catalog" },
  { method: "POST", path: "/api/companies/co-1/skills/scan-projects" },
  { method: "PATCH", path: "/api/companies/co-1/skills/skill-1" },
  { method: "DELETE", path: "/api/companies/co-1/skills/skill-1" },
  { method: "DELETE", path: "/api/companies/co-1/skills/skill-1/files/extra" },
  { method: "PUT", path: "/api/companies/co-1/skills/skill-1/files" },
  { method: "POST", path: "/api/companies/co-1/skills/skill-1/files" },
  { method: "POST", path: "/api/companies/co-1/skills/skill-1/versions" },
  { method: "POST", path: "/api/companies/co-1/skills/skill-1/install-update" },
  { method: "POST", path: "/api/companies/co-1/skills/skill-1/reset" },
  { method: "POST", path: "/api/companies/co-1/skills/skill-1/fork" },
  { method: "POST", path: "/api/companies/co-1/skills/skill-1/rename" },
  { method: "POST", path: "/api/skills/catalog" },
  // Agent record, permissions, lifecycle, config history, keys, secrets.
  { method: "PATCH", path: "/api/agents/agent-2" },
  { method: "PUT", path: "/api/agents/agent-2" },
  { method: "DELETE", path: "/api/agents/agent-2" },
  { method: "PATCH", path: "/api/agents/agent-2/permissions" },
  { method: "PATCH", path: "/api/agents/agent-2/budgets" },
  { method: "POST", path: "/api/agents/agent-2/terminate" },
  { method: "POST", path: "/api/agents/agent-2/pause" },
  { method: "POST", path: "/api/agents/agent-2/config-revisions/rev-1/rollback" },
  { method: "PATCH", path: "/api/agents/agent-2/config-revisions/rev-1" },
  { method: "POST", path: "/api/agents/agent-2/keys" },
  { method: "GET", path: "/api/agents/agent-2/secrets" },
  { method: "PUT", path: "/api/agents/agent-2/secrets/API_KEY" },
  { method: "PATCH", path: "/api/companies/co-1/skills/secret-helper/files" },
  { method: "POST", path: "/api/companies/co-1/agents" },
];

// Paths no policy may forward: each one either leaves the API origin or
// normalizes into a route other than the one a rule would have matched.
const NON_CANONICAL: RouteCase[] = [
  { method: "GET", path: "//evil.example/api/agents/me" },
  { method: "GET", path: "api/agents/me" },
  { method: "GET", path: "/api/issues/%2e%2e/heartbeat-context" },
  { method: "GET", path: "/api/issues/%2E%2E/%2e%2e/agents/me" },
  { method: "GET", path: "/api/issues/a/../b" },
  { method: "GET", path: "/api/issues/./issue-1" },
  { method: "GET", path: "/api/issues/issue-1/.." },
  { method: "GET", path: "/api/issues//issue-1" },
  { method: "GET", path: "/api/issues\\issue-1" },
  { method: "GET", path: "/api/issues/a%2fb" },
  { method: "GET", path: "/api/issues/a%5cb" },
  { method: "GET", path: "/api/issues/a%00" },
  { method: "GET", path: "/api/issues/a b" },
  { method: "GET", path: "/api/issues/a\tb" },
  { method: "GET", path: "/api/issues/é" },
  { method: "GET", path: "/api/agents/me?x=1" },
  { method: "GET", path: "/api/agents/me#x" },
];

describe("sandbox callback bridge route policies", () => {
  it("reads only the literals \"agent\" and \"steward\" as wider policies", () => {
    expect(normalizeSandboxCallbackBridgePolicy("agent")).toBe("agent");
    expect(normalizeSandboxCallbackBridgePolicy("steward")).toBe("steward");
    for (const value of [
      undefined, null, "", "restricted", "AGENT", "Agent", " agent", "open", 1, true, {},
      "STEWARD", "Steward", "steward ", " steward",
    ]) {
      expect(normalizeSandboxCallbackBridgePolicy(value)).toBe("restricted");
    }
  });

  describe("restricted (default)", () => {
    it("keeps forwarding every route on the upstream allowlist", () => {
      for (const request of RESTRICTED_ALLOWED) {
        expect(restricted(request), `${request.method} ${request.path}`).toBeNull();
      }
      const authorizeDefault = createSandboxCallbackBridgeAuthorizer();
      for (const request of RESTRICTED_ALLOWED) {
        expect(authorizeDefault(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("keeps refusing routes only the agent policy opens, with the unchanged message", () => {
      for (const request of [...AGENT_ONLY_ALLOWED, ...AGENT_DENIED, ...STEWARD_ONLY_ALLOWED, ...STEWARD_DENIED]) {
        // `GET /api/issues` is the one common wrong guess in this set: the
        // restricted list only forwards a single issue, not the bare
        // listing, so it keeps the unchanged message plus the route hint
        // (see the "route hints" describe block below).
        if (request.method === "GET" && request.path === "/api/issues") continue;
        expect(restricted(request)).toBe(`Route not allowed: ${request.method} ${request.path}`);
      }
    });

    it("treats a missing or unknown policy as restricted", () => {
      const request = { method: "GET", path: "/api/companies/co-1/heartbeat-runs" };
      for (const policy of [undefined, null, "", "open", "AGENT"]) {
        expect(authorizeSandboxCallbackBridgeRequestForPolicy(request, { policy })).toBe(
          "Route not allowed: GET /api/companies/co-1/heartbeat-runs",
        );
      }
    });
  });

  describe("route hints for common wrong instance-level guesses", () => {
    // Each wrong guess and the documented, company-scoped route it should
    // point at. `GET /api/issues` is left out here: under `agent`/`steward`
    // it is itself a forwarded route (see the `agent`/`steward` cases
    // below), so no hint about it ever fires there.
    const HINTS: { request: RouteCase; suggestion: string }[] = [
      {
        request: { method: "GET", path: "/api/agents" },
        suggestion: "list colleagues with GET /api/companies/{companyId}/agents",
      },
      {
        request: { method: "GET", path: "/api/projects" },
        suggestion: "list projects with GET /api/companies/{companyId}/projects",
      },
      {
        request: { method: "GET", path: "/api/routines" },
        suggestion: "list routines with GET /api/companies/{companyId}/routines",
      },
    ];

    it("restricted: appends the hint, after the unchanged 'Route not allowed: METHOD PATH' prefix, for agents/projects/routines and for the bare issues listing", () => {
      for (const { request, suggestion } of [
        ...HINTS,
        {
          request: { method: "GET", path: "/api/issues" },
          suggestion: "list issues with GET /api/companies/{companyId}/issues",
        },
      ]) {
        const denial = restricted(request);
        const unchangedPrefix = `Route not allowed: ${request.method} ${request.path}`;
        expect(denial, `${request.method} ${request.path}`).not.toBeNull();
        expect(denial!.startsWith(unchangedPrefix), denial!).toBe(true);
        expect(denial).toBe(`${unchangedPrefix}. Instead, ${suggestion}.`);
        // The suggested route is one the same (restricted) policy actually
        // forwards, substituting a concrete company id for the placeholder.
        const suggestedRoute = suggestion.match(/GET (\/api\/\S+)/)![1]!.replace("{companyId}", COMPANY);
        expect(restricted({ method: "GET", path: suggestedRoute }), suggestedRoute).toBeNull();
      }
    });

    it("agent and steward: append the same hint, after the unchanged policy-named prefix, for agents/projects/routines", () => {
      for (const authorize of [agent, steward]) {
        for (const { request, suggestion } of HINTS) {
          const denial = authorize(request);
          expect(denial, `${request.method} ${request.path}`).not.toBeNull();
          expect(denial).toContain(`${request.method} ${request.path}`);
          // None of these instance-level guesses match a deny rule, so they
          // get the plain "not available" wording, not the secrets/admin one.
          expect(denial).toContain("This route is not available to agent runs.");
          expect(denial).toContain(`Instead, ${suggestion}.`);
          // The suggested route is one the same policy actually forwards.
          const suggestedRoute = suggestion.match(/GET (\/api\/\S+)/)![1]!.replace("{companyId}", COMPANY);
          expect(authorize({ method: "GET", path: suggestedRoute }), suggestedRoute).toBeNull();
        }
      }
    });

    it("agent and steward: never hint at GET /api/issues, because that bare listing is itself already forwarded", () => {
      for (const authorize of [agent, steward]) {
        expect(authorize({ method: "GET", path: "/api/issues" })).toBeNull();
      }
    });

    it("never hints on a denial for a different method on the same path, or for a deny-listed path", () => {
      // Wrong method on a hinted path: no matching hint entry.
      expect(restricted({ method: "POST", path: "/api/agents" })).toBe("Route not allowed: POST /api/agents");
      const deniedAgentPost = agent({ method: "POST", path: "/api/agents" });
      expect(deniedAgentPost).not.toContain("Instead,");
      // A deny-rule match (secrets) never grows a hint even though the path
      // is close to a hinted family.
      const secretsDenial = agent({ method: "GET", path: "/api/agents/agent-1/secrets" });
      expect(secretsDenial).not.toContain("Instead,");
    });

    it("confirms every hint's suggested route against deny rules too, not just allow rules", () => {
      // The hint check must mirror the real authorizer's deny-overrides-allow
      // order (see `authorizeSandboxCallbackBridgeRequestForPolicy`), so a
      // hint never points at a route a deny rule would also refuse. None of
      // the current suggested routes match a deny rule under either policy;
      // this pins that down so a future deny rule (or hint) that overlaps one
      // of these company-scoped families is caught here instead of silently
      // telling a denied agent to retry a route that is itself denied.
      const suggestedFamilies = ["agents", "issues", "projects", "routines"];
      for (const denyRules of [AGENT_SANDBOX_CALLBACK_BRIDGE_DENY_RULES, STEWARD_SANDBOX_CALLBACK_BRIDGE_DENY_RULES]) {
        for (const family of suggestedFamilies) {
          const suggestedPath = `/api/companies/${COMPANY}/${family}`;
          const matchesDeny = denyRules.some((rule) => rule.methods.includes("GET") && rule.path.test(suggestedPath));
          expect(matchesDeny, suggestedPath).toBe(false);
        }
      }
    });
  });

  describe("missing /api prefix", () => {
    // A sandbox client that built its request URL from a base it assumed
    // already ended in "/api" sends e.g. `PATCH /issues/{id}` instead of
    // `PATCH /api/issues/{id}`. `agent` and `steward` recognize that specific
    // shape and name the fix instead of claiming the route is unreachable.
    it("agent and steward: names the missing prefix when the /api form would be allowed", () => {
      for (const authorize of [agent, steward]) {
        expect(authorize({ method: "PATCH", path: "/issues/issue-1" })).toBe(
          "Route not allowed: PATCH /issues/issue-1 is missing the /api prefix. Use PATCH /api/issues/issue-1.",
        );
        expect(authorize({ method: "POST", path: "/issues/issue-1/comments" })).toBe(
          "Route not allowed: POST /issues/issue-1/comments is missing the /api prefix. Use POST /api/issues/issue-1/comments.",
        );
        // Also covers the one non-issue example moved out of AGENT_DENIED
        // above: `GET /api/openapi.json` is itself allowed.
        expect(authorize({ method: "GET", path: "/openapi.json" })).toBe(
          "Route not allowed: GET /openapi.json is missing the /api prefix. Use GET /api/openapi.json.",
        );
      }
    });

    it("agent and steward: keeps the normal denial when the /api form is itself refused", () => {
      for (const authorize of [agent, steward]) {
        // A bare secrets path matches the secrets deny rule with or without
        // the prefix (the rule is not anchored to "/api"), so it is denied
        // the ordinary way and never told to retry with /api.
        const secretsDenial = authorize({ method: "GET", path: "/agents/agent-1/secrets" });
        expect(secretsDenial, "GET /agents/agent-1/secrets").not.toBeNull();
        expect(secretsDenial).not.toContain("is missing the /api prefix");
        expect(secretsDenial).toContain("retrying this route will not succeed");

        // A path whose deny rule only matches once it carries the "/api"
        // prefix (the agent record write below is anchored to "/api") is
        // refused as a plain unmatched route, not with a prefix hint either,
        // because the prefixed form is itself denied.
        const agentRecordDenial = authorize({ method: "PATCH", path: "/agents/agent-1" });
        expect(agentRecordDenial, "PATCH /agents/agent-1").not.toBeNull();
        expect(agentRecordDenial).not.toContain("is missing the /api prefix");
      }
    });

    it("leaves an already-prefixed, allowed route unaffected", () => {
      for (const authorize of [agent, steward]) {
        expect(authorize({ method: "PATCH", path: "/api/issues/issue-1" })).toBeNull();
      }
    });

    it("restricted: never rewrites a missing-prefix denial", () => {
      expect(restricted({ method: "PATCH", path: "/issues/issue-1" })).toBe(
        "Route not allowed: PATCH /issues/issue-1",
      );
      expect(restricted({ method: "GET", path: "/openapi.json" })).toBe("Route not allowed: GET /openapi.json");
    });
  });

  describe("agent", () => {
    it("forwards everything the restricted allowlist forwards", () => {
      for (const request of RESTRICTED_ALLOWED) {
        expect(agent(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("forwards the task, artifact, interaction, run, and summary routes agents use", () => {
      for (const request of AGENT_ONLY_ALLOWED) {
        expect(agent(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("refuses credential, environment, self-configuration and administration routes, naming the policy", () => {
      for (const request of AGENT_DENIED) {
        const denial = agent(request);
        expect(denial, `${request.method} ${request.path}`).not.toBeNull();
        expect(denial).toContain('bridge policy "agent"');
        expect(denial).toContain(`${request.method.toUpperCase()} ${request.path}`);
        // The detailed secrets/credentials/administration wording is truthful
        // only for an actual deny-rule match; a request that simply matches
        // no allow rule either (e.g. the OPTIONS/HEAD/TRACE methods here, or
        // an unlisted family) gets the plain "not available" wording instead.
        if (matchesDenyRule(AGENT_SANDBOX_CALLBACK_BRIDGE_DENY_RULES, request)) {
          expect(denial, `${request.method} ${request.path}`).toContain("retrying this route will not succeed");
        } else {
          expect(denial, `${request.method} ${request.path}`).toContain("This route is not available to agent runs.");
        }
      }
    });

    it("still refuses the writes only the steward policy adds", () => {
      for (const request of STEWARD_ONLY_ALLOWED) {
        const denial = agent(request);
        expect(denial, `${request.method} ${request.path}`).toContain('bridge policy "agent"');
        // The instruction-bundle writes hit the agent deny rule directly; the
        // skill writes match no agent deny rule (skills are a steward-only
        // allowance, not a denied family), so they get the plain wording.
        if (matchesDenyRule(AGENT_SANDBOX_CALLBACK_BRIDGE_DENY_RULES, request)) {
          expect(denial, `${request.method} ${request.path}`).toContain("retrying this route will not succeed");
        } else {
          expect(denial, `${request.method} ${request.path}`).toContain("This route is not available to agent runs.");
        }
      }
    });

    it("refuses case and trailing-slash variants the server router would still match", () => {
      for (const request of [
        { method: "GET", path: "/api/agents/me/secrets/" },
        { method: "GET", path: "/API/Agents/Me/Secrets" },
        { method: "GET", path: "/api/agents/me/SECRETS" },
        { method: "get", path: "/api/agents/me/Secrets/" },
        { method: "POST", path: "/api/agents/agent-1/KEYS" },
        { method: "PATCH", path: "/api/Agents/agent-1/" },
        { method: "PUT", path: "/api/agents/agent-2/Instructions-Bundle/file" },
        { method: "GET", path: "/api/Environments/env-1" },
        { method: "GET", path: "/api/heartbeat-runs/run-1/Provider-Trace" },
      ]) {
        expect(agent(request), `${request.method} ${request.path}`).toContain('bridge policy "agent"');
      }
      // The same variants of allowed routes still pass.
      expect(agent({ method: "GET", path: "/api/Issues/issue-1/" })).toBeNull();
      expect(agent({ method: "patch", path: "/api/issues/issue-1" })).toBeNull();
    });

    it("refuses percent-encoded paths, so an encoded name cannot slip past a deny rule", () => {
      for (const path of ["/api/agents/me/%73ecrets", "/api/agents/%6De/secrets", "/api/issues/issue%2D1"]) {
        expect(agent({ method: "GET", path })).toContain('bridge policy "agent"');
      }
    });

    it("refuses company-scoped paths for another company", () => {
      for (const request of [
        { method: "GET", path: `/api/companies/${OTHER_COMPANY}` },
        { method: "GET", path: `/api/companies/${OTHER_COMPANY}/issues` },
        { method: "POST", path: `/api/companies/${OTHER_COMPANY}/issues` },
        { method: "GET", path: `/api/companies/${OTHER_COMPANY}/heartbeat-runs` },
      ]) {
        expect(agent(request)).toContain("Runs can only reach their own company");
      }
      // The run's own company matches case-insensitively.
      expect(authorizeSandboxCallbackBridgeRequestForPolicy(
        { method: "GET", path: "/api/companies/ABCDEF/issues" },
        { policy: "agent", companyId: "abcdef" },
      )).toBeNull();
      // Without a bound company every company-scoped path is refused, so a
      // target that stamps the policy but not the company fails closed.
      for (const companyId of [undefined, null, "", "  "]) {
        for (const path of [`/api/companies/${COMPANY}`, `/api/companies/${COMPANY}/issues`]) {
          expect(authorizeSandboxCallbackBridgeRequestForPolicy(
            { method: "GET", path },
            { policy: "agent", companyId },
          ), `${String(companyId)} ${path}`).toContain("Runs can only reach their own company");
        }
        expect(authorizeSandboxCallbackBridgeRequestForPolicy(
          { method: "GET", path: "/api/issues/issue-1" },
          { policy: "agent", companyId },
        )).toBeNull();
      }
    });
  });

  describe("steward", () => {
    it("forwards everything the agent policy forwards except hire requests", () => {
      const hires = [...RESTRICTED_ALLOWED, ...AGENT_ONLY_ALLOWED].filter((request) => request.path.endsWith("/agent-hires"));
      expect(hires).toEqual([{ method: "POST", path: "/api/companies/co-1/agent-hires" }]);
      for (const request of [...RESTRICTED_ALLOWED, ...AGENT_ONLY_ALLOWED]) {
        if (hires.includes(request)) continue;
        expect(steward(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("refuses hire requests, which would place a new agent in the same environment", () => {
      for (const request of [
        { method: "POST", path: "/api/companies/co-1/agent-hires" },
        { method: "POST", path: "/api/companies/co-1/agent-hires/" },
        { method: "POST", path: "/API/Companies/co-1/Agent-Hires" },
        { method: "PUT", path: "/api/companies/co-1/agent-hires" },
      ]) {
        const denial = steward(request);
        expect(denial, `${request.method} ${request.path}`).toContain('bridge policy "steward"');
        expect(denial).toContain("retrying this route will not succeed");
      }
      expect(agent({ method: "POST", path: "/api/companies/co-1/agent-hires" })).toBeNull();
    });

    it("adds instruction-bundle writes and company skill create, file edits and file deletes", () => {
      for (const request of STEWARD_ONLY_ALLOWED) {
        expect(steward(request), `${request.method} ${request.path}`).toBeNull();
      }
      // Case and trailing-slash variants the server router matches pass too.
      expect(steward({ method: "put", path: "/api/Agents/agent-2/Instructions-Bundle/File/" })).toBeNull();
      expect(steward({ method: "PATCH", path: "/api/agents/agent-2/instructions-bundle/" })).toBeNull();
      expect(steward({ method: "delete", path: "/api/agents/agent-2/Instructions-Bundle/File/" })).toBeNull();
      expect(steward({ method: "DELETE", path: "/api/companies/co-1/Skills/skill-1/Files/" })).toBeNull();
    });

    it("refuses every other route the agent policy refuses, naming the steward policy", () => {
      const added = new Set(STEWARD_ONLY_ALLOWED.map((request) => `${request.method} ${request.path}`));
      const stillDenied = AGENT_DENIED.filter((request) => !added.has(`${request.method} ${request.path}`));
      // Only the three instruction writes leave the agent deny fixture.
      expect(AGENT_DENIED.length - stillDenied.length).toBe(3);
      for (const request of [...stillDenied, ...STEWARD_DENIED]) {
        const denial = steward(request);
        expect(denial, `${request.method} ${request.path}`).not.toBeNull();
        expect(denial).toContain('bridge policy "steward"');
        expect(denial).toContain(`${request.method.toUpperCase()} ${request.path}`);
      }
    });

    it("refuses encoded, case-folded and cross-company variants of its extra routes", () => {
      for (const request of [
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/%66ile" },
        { method: "PATCH", path: "/api/agents/agent-2/%69nstructions-bundle" },
        { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/%66ile" },
        { method: "GET", path: "/API/Agents/agent-2/SECRETS/" },
        { method: "PATCH", path: "/api/Agents/agent-2/" },
        { method: "POST", path: "/api/agents/agent-2/Config-Revisions/rev-1/rollback" },
        { method: "POST", path: "/api/agents/agent-2/TERMINATE" },
      ]) {
        expect(steward(request), `${request.method} ${request.path}`).toContain('bridge policy "steward"');
      }
      for (const request of [
        { method: "POST", path: `/api/companies/${OTHER_COMPANY}/skills` },
        { method: "PATCH", path: `/api/companies/${OTHER_COMPANY}/skills/skill-1/files` },
        { method: "DELETE", path: `/api/companies/${OTHER_COMPANY}/skills/skill-1/files` },
      ]) {
        expect(steward(request)).toContain("Runs can only reach their own company");
      }
      for (const companyId of [undefined, null, ""]) {
        expect(authorizeSandboxCallbackBridgeRequestForPolicy(
          { method: "POST", path: `/api/companies/${COMPANY}/skills` },
          { policy: "steward", companyId },
        )).toContain("Runs can only reach their own company");
      }
    });
  });

  describe("REST tool gateway", () => {
    it("forwards exactly the session, list, call and revoke routes under every policy", () => {
      for (const policy of ["restricted", "agent", "steward"] as const) {
        const authorize = createSandboxCallbackBridgeAuthorizer({ policy, companyId: COMPANY });
        for (const request of TOOL_GATEWAY_ALLOWED) {
          expect(authorize(request), `${policy} ${request.method} ${request.path}`).toBeNull();
        }
        for (const request of TOOL_GATEWAY_DENIED) {
          const denial = authorize(request);
          expect(denial, `${policy} ${request.method} ${request.path}`).not.toBeNull();
          expect(denial).toContain(`${request.method} ${request.path}`);
        }
      }
      // An unstamped bridge uses the restricted list, which carries them too.
      const authorizeDefault = createSandboxCallbackBridgeAuthorizer();
      for (const request of TOOL_GATEWAY_ALLOWED) {
        expect(authorizeDefault(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("forwards the session token header and nothing that only looks like it", () => {
      const forwarded = sanitizeSandboxCallbackBridgeHeaders({
        "X-Paperclip-Tool-Gateway-Token": "session-token",
        "content-type": "application/json",
        "x-paperclip-tool-gateway-token-extra": "dropped",
        "x-paperclip-tool-gateway": "dropped",
        "x-paperclip-tool-gateway-session": "dropped",
        "x-paperclip-run-id": "dropped",
        authorization: "Bearer dropped",
      });
      expect(forwarded).toEqual({
        "X-Paperclip-Tool-Gateway-Token": "session-token",
        "content-type": "application/json",
      });
      // Only this one header joins the allowlist.
      expect([...DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST]).toEqual([
        "accept",
        "content-type",
        "if-match",
        "if-none-match",
        "x-paperclip-github-capability",
        "x-paperclip-tool-gateway-token",
      ]);
      // The in-sandbox gateway filters with the same list before the host does.
      expect(getSandboxCallbackBridgeServerSource()).toContain(
        `const allowedHeaders = new Set(${JSON.stringify([...DEFAULT_SANDBOX_CALLBACK_BRIDGE_HEADER_ALLOWLIST])});`,
      );
    });
  });

  it("refuses non-canonical paths under every policy", () => {
    for (const request of NON_CANONICAL) {
      expect(describeNonCanonicalSandboxCallbackBridgePath(request.path), JSON.stringify(request.path)).not.toBeNull();
      for (const policy of ["restricted", "agent", "steward"] as const) {
        const denial = authorizeSandboxCallbackBridgeRequestForPolicy(request, { policy, companyId: COMPANY });
        expect(denial, `${policy} ${JSON.stringify(request.path)}`).toMatch(/^Route not allowed: GET /);
      }
    }
    for (const request of [
      ...RESTRICTED_ALLOWED, ...AGENT_ONLY_ALLOWED, ...AGENT_DENIED, ...STEWARD_ONLY_ALLOWED, ...STEWARD_DENIED,
      ...TOOL_GATEWAY_DENIED,
    ]) {
      expect(describeNonCanonicalSandboxCallbackBridgePath(request.path), request.path).toBeNull();
    }
  });
});

describe("sandbox callback bridge worker route policy", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runQueuedRequests(
    requests: RouteCase[],
    authorizeRequest?: ReturnType<typeof createSandboxCallbackBridgeAuthorizer>,
  ) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-policy-"));
    cleanupDirs.push(rootDir);
    const queueDir = path.posix.join(rootDir, "queue");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const forwarded: string[] = [];
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(),
      queueDir,
      ...(authorizeRequest ? { authorizeRequest } : {}),
      handleRequest: async (request) => {
        forwarded.push(`${request.method} ${request.path}`);
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      },
    });
    // Write the request files directly, the way a process inside the sandbox
    // could, bypassing the gateway's own URL parsing.
    for (const [index, request] of requests.entries()) {
      await writeFile(
        path.posix.join(directories.requestsDir, `req-${index}.json`),
        `${JSON.stringify({
          id: `req-${index}`,
          method: request.method,
          path: request.path,
          query: "",
          headers: {},
          body: "",
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
    }
    await worker.stop({ drainTimeoutMs: 2_000 });
    const responses = await Promise.all(requests.map(async (_request, index) => {
      const raw = await readFile(path.posix.join(directories.responsesDir, `req-${index}.json`), "utf8");
      const response = JSON.parse(raw) as { status: number; body: string };
      return { status: response.status, body: JSON.parse(response.body) as { error?: string } };
    }));
    return { forwarded, responses };
  }

  it("refuses a queued network-path or dot-segment request with the default authorizer", async () => {
    const { forwarded, responses } = await runQueuedRequests([
      { method: "GET", path: "//evil.example/api/agents/me" },
      { method: "GET", path: "/api/issues/%2e%2e/heartbeat-context" },
      { method: "GET", path: "/api/agents/me" },
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 200]);
    expect(responses[0]!.body.error).toMatch(/^Route not allowed: GET \/\/evil\.example\/api\/agents\/me \(/);
    expect(forwarded).toEqual(["GET /api/agents/me"]);
  });

  it("forwards agent-policy routes and returns the policy denial for the rest", async () => {
    const { forwarded, responses } = await runQueuedRequests(
      [
        { method: "GET", path: "/api/companies/co-1/heartbeat-runs" },
        { method: "GET", path: "/api/agents/me/secrets" },
        { method: "PATCH", path: "/api/agents/agent-1" },
        { method: "GET", path: "/api/companies/co-1/environments" },
      ],
      createSandboxCallbackBridgeAuthorizer({ policy: "agent", companyId: COMPANY }),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 403, 403, 403]);
    for (const response of responses.slice(1)) {
      expect(response.body.error).toContain('bridge policy "agent"');
    }
    expect(forwarded).toEqual(["GET /api/companies/co-1/heartbeat-runs"]);
  });

  it("forwards the steward additions only when the worker is bound to the steward policy", async () => {
    const requests: RouteCase[] = [
      { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file" },
      { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/file" },
      { method: "POST", path: "/api/companies/co-1/skills" },
      { method: "DELETE", path: "/api/companies/co-1/skills/skill-1/files" },
      { method: "POST", path: "/api/agents/agent-2/terminate" },
      { method: "POST", path: "/api/companies/co-1/agent-hires" },
    ];
    const asSteward = await runQueuedRequests(
      requests,
      createSandboxCallbackBridgeAuthorizer({ policy: "steward", companyId: COMPANY }),
    );
    expect(asSteward.responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 403, 403]);
    expect(asSteward.responses[4]!.body.error).toContain('bridge policy "steward"');
    expect(asSteward.responses[5]!.body.error).toContain('bridge policy "steward"');
    expect(asSteward.forwarded).toEqual([
      "PUT /api/agents/agent-2/instructions-bundle/file",
      "DELETE /api/agents/agent-2/instructions-bundle/file",
      "POST /api/companies/co-1/skills",
      "DELETE /api/companies/co-1/skills/skill-1/files",
    ]);

    const asAgent = await runQueuedRequests(
      requests,
      createSandboxCallbackBridgeAuthorizer({ policy: "agent", companyId: COMPANY }),
    );
    expect(asAgent.responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 200]);
    expect(asAgent.forwarded).toEqual(["POST /api/companies/co-1/agent-hires"]);
  });
});
