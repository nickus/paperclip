import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeSandboxCallbackBridgeRequestForPolicy,
  createFileSystemSandboxCallbackBridgeQueueClient,
  createSandboxCallbackBridgeAuthorizer,
  describeNonCanonicalSandboxCallbackBridgePath,
  normalizeSandboxCallbackBridgePolicy,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
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

const INSTRUCTION_WRITES_POLICY = "agent-with-instruction-writes" as const;

function agentWithInstructionWrites(request: RouteCase) {
  return authorizeSandboxCallbackBridgeRequestForPolicy(request, {
    policy: INSTRUCTION_WRITES_POLICY,
    companyId: COMPANY,
  });
}

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
  // Instruction writes (the first two are what `agent-with-instruction-writes` adds).
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
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/" },
  // Methods outside the listed ones.
  { method: "OPTIONS", path: "/api/issues/issue-1" },
  { method: "HEAD", path: "/api/issues/issue-1" },
  { method: "TRACE", path: "/api/issues/issue-1" },
];

// The only routes `agent-with-instruction-writes` forwards beyond `agent`.
const INSTRUCTION_WRITES: RouteCase[] = [
  { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file" },
  { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle" },
];

function isInstructionWrite(request: RouteCase) {
  return INSTRUCTION_WRITES.some((write) => write.method === request.method && write.path === request.path);
}

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
  it("reads only the exact wider policy names as wider policies", () => {
    expect(normalizeSandboxCallbackBridgePolicy("agent")).toBe("agent");
    expect(normalizeSandboxCallbackBridgePolicy(INSTRUCTION_WRITES_POLICY)).toBe(INSTRUCTION_WRITES_POLICY);
    for (const value of [
      undefined,
      null,
      "",
      "restricted",
      "AGENT",
      "Agent",
      " agent",
      "open",
      "Agent-With-Instruction-Writes",
      " agent-with-instruction-writes",
      "agent-with-instruction-writes ",
      "agent-with-instructions",
      "instruction-writes",
      1,
      true,
      {},
    ]) {
      expect(normalizeSandboxCallbackBridgePolicy(value), JSON.stringify(value)).toBe("restricted");
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
      for (const request of [...AGENT_ONLY_ALLOWED, ...AGENT_DENIED]) {
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
        expect(denial).toContain("retrying this route will not succeed");
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

  describe("agent-with-instruction-writes", () => {
    it("forwards everything the agent policy forwards", () => {
      for (const request of [...RESTRICTED_ALLOWED, ...AGENT_ONLY_ALLOWED]) {
        expect(agentWithInstructionWrites(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("forwards the instruction bundle update and file write, which the agent policy refuses", () => {
      for (const request of INSTRUCTION_WRITES) {
        expect(agent(request), `${request.method} ${request.path}`).toContain('bridge policy "agent"');
        expect(restricted(request)).toBe(`Route not allowed: ${request.method} ${request.path}`);
        expect(agentWithInstructionWrites(request), `${request.method} ${request.path}`).toBeNull();
      }
      // Case and trailing-slash variants the server router matches pass too.
      for (const request of [
        { method: "put", path: "/api/agents/agent-2/Instructions-Bundle/file" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file/" },
        { method: "PATCH", path: "/API/Agents/agent-2/instructions-bundle/" },
      ]) {
        expect(agentWithInstructionWrites(request), `${request.method} ${request.path}`).toBeNull();
      }
    });

    it("refuses everything else the agent policy refuses, naming the policy", () => {
      const denied = AGENT_DENIED.filter((request) => !isInstructionWrite(request));
      expect(denied.length).toBe(AGENT_DENIED.length - INSTRUCTION_WRITES.length);
      for (const request of denied) {
        const denial = agentWithInstructionWrites(request);
        expect(denial, `${request.method} ${request.path}`).not.toBeNull();
        expect(denial).toContain(`bridge policy "${INSTRUCTION_WRITES_POLICY}"`);
        expect(denial).toContain(`${request.method.toUpperCase()} ${request.path}`);
        expect(denial).toContain("retrying this route will not succeed");
      }
    });

    it("keeps refusing instruction file deletes and every other instruction bundle write", () => {
      for (const request of [
        { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/file" },
        { method: "DELETE", path: "/api/agents/agent-2/Instructions-Bundle/file/" },
        { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle" },
        { method: "POST", path: "/api/agents/agent-2/instructions-bundle" },
        { method: "POST", path: "/api/agents/agent-2/instructions-bundle/file" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle" },
        { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle/file" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/files" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file/extra" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/other" },
        { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle/file/AGENTS.md" },
        // The neighbouring agent configuration writes stay closed.
        { method: "PATCH", path: "/api/agents/agent-2" },
        { method: "PATCH", path: "/api/agents/agent-2/instructions-path/extra" },
        { method: "POST", path: "/api/agents/agent-2/config-revisions/rev-1/rollback" },
        { method: "PATCH", path: "/api/agents/agent-2/permissions" },
      ]) {
        expect(agentWithInstructionWrites(request), `${request.method} ${request.path}`)
          .toContain(`bridge policy "${INSTRUCTION_WRITES_POLICY}"`);
      }
    });

    it("keeps the other deny rules in force on the opened instruction routes", () => {
      for (const request of [
        // A path segment that names secrets is refused before anything is lifted.
        { method: "PUT", path: "/api/agents/secret-agent/instructions-bundle/file" },
        { method: "PATCH", path: "/api/agents/my-secrets/instructions-bundle" },
        // Encoded characters are refused outright.
        { method: "PUT", path: "/api/agents/agent-2/instructions%2Dbundle/file" },
        { method: "PATCH", path: "/api/agents/agent%2D2/instructions-bundle" },
      ]) {
        expect(agentWithInstructionWrites(request), `${request.method} ${request.path}`)
          .toContain(`bridge policy "${INSTRUCTION_WRITES_POLICY}"`);
      }
      for (const request of [
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/../file" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle//file" },
        { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file?path=AGENTS.md" },
      ]) {
        expect(agentWithInstructionWrites(request), request.path).toMatch(/^Route not allowed: PUT /);
      }
    });

    it("refuses company-scoped paths for another company", () => {
      expect(agentWithInstructionWrites({ method: "GET", path: `/api/companies/${OTHER_COMPANY}/issues` }))
        .toContain("Runs can only reach their own company");
      expect(agentWithInstructionWrites({ method: "GET", path: `/api/companies/${COMPANY}/issues` })).toBeNull();
    });
  });

  it("refuses non-canonical paths under every policy", () => {
    for (const request of NON_CANONICAL) {
      expect(describeNonCanonicalSandboxCallbackBridgePath(request.path), JSON.stringify(request.path)).not.toBeNull();
      for (const policy of ["restricted", "agent", INSTRUCTION_WRITES_POLICY] as const) {
        const denial = authorizeSandboxCallbackBridgeRequestForPolicy(request, { policy, companyId: COMPANY });
        expect(denial, `${policy} ${JSON.stringify(request.path)}`).toMatch(/^Route not allowed: GET /);
      }
    }
    for (const request of [...RESTRICTED_ALLOWED, ...AGENT_ONLY_ALLOWED, ...AGENT_DENIED]) {
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

  it("forwards instruction bundle writes only under agent-with-instruction-writes, never file deletes", async () => {
    const requests: RouteCase[] = [
      { method: "PUT", path: "/api/agents/agent-2/instructions-bundle/file" },
      { method: "PATCH", path: "/api/agents/agent-2/instructions-bundle" },
      { method: "DELETE", path: "/api/agents/agent-2/instructions-bundle/file" },
    ];
    const opened = await runQueuedRequests(
      requests,
      createSandboxCallbackBridgeAuthorizer({ policy: INSTRUCTION_WRITES_POLICY, companyId: COMPANY }),
    );
    expect(opened.responses.map((response) => response.status)).toEqual([200, 200, 403]);
    expect(opened.responses[2]!.body.error).toContain(`bridge policy "${INSTRUCTION_WRITES_POLICY}"`);
    expect(opened.forwarded).toEqual([
      "PUT /api/agents/agent-2/instructions-bundle/file",
      "PATCH /api/agents/agent-2/instructions-bundle",
    ]);

    const closed = await runQueuedRequests(
      requests,
      createSandboxCallbackBridgeAuthorizer({ policy: "agent", companyId: COMPANY }),
    );
    expect(closed.responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(closed.forwarded).toEqual([]);
  });
});
