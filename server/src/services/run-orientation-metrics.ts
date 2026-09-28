// Run orientation metrics: a small, best-effort summary of how much an agent
// run explored before it made its first change. It is computed once, at run
// finalize time, purely from data the server already has for the run:
//
//   - the opencode_local adapter's raw event stream (its full stdout is
//     already carried on `adapterResult.resultJson.stdout`), which reports
//     tool calls, their outcomes, and per-turn token usage; and
//   - the session-resume state the finalize path already resolves for every
//     adapter (whether this run continued an existing session, and why it
//     woke up).
//
// Every field is independently optional. When the evidence needed for a
// field is not available (a different adapter, a missing/possibly-truncated
// stdout capture, or a stream with no tool calls at all), that field is
// `null` rather than a guess. Callers must treat this module as pure and
// cheap: no I/O, no throwing on malformed input, and a fixed cost cap on how
// much of a stdout capture is inspected.
//
// opencode_local agents reach Paperclip's own API through `bash`/curl (see
// skills/paperclip/SKILL.md), not through a dedicated MCP tool, and a
// control-plane rejection of that call comes back as a normal HTTP response
// body rather than a failed tool call. So, in addition to classifying named
// tools, this module does a narrow, best-effort read of a shell tool's own
// command and completed output — see `classifyMutatingBashCommand` and the
// denial handling in `computeRunOrientationMetricsFromEvents`.

import { MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";

export interface RunOrientationMetrics {
  // Number of distinct tool calls the run made before its first mutating
  // one (see `classifyMutatingToolCall`). 0 means the very first tool call
  // was already a mutation. `null` means either there is no tool-call data
  // to inspect, or the run never made a confirmed mutating call at all
  // (there is no "before" to report).
  stepsBeforeFirstMutation: number | null;
  // Output (generated) tokens the model produced before, and during, that
  // same first mutating tool call's own step — i.e. everything the model
  // generated up to and including the reasoning and arguments that produced
  // the mutation. Same `null` conditions as `stepsBeforeFirstMutation`.
  genTokensBeforeFirstMutation: number | null;
  // Count of tool calls that loaded a skill. 0 is a real count (no skill
  // calls observed); `null` means there was no tool-call data to inspect.
  skillLoads: number | null;
  // Count of tool results carrying the control-plane denial the server
  // itself returns to low-trust actors. Same `null` condition as
  // `skillLoads`.
  controlPlaneDenials: number | null;
  // Whether this run continued an existing provider/task session rather
  // than starting fresh. `null` only when the caller could not resolve
  // this at all (it is normally always known at finalize time).
  sessionResumed: boolean | null;
  // Why the run woke up on that resumed session (the run's wake reason).
  // `null` when the session was not resumed, or the reason is unknown.
  sessionResumeReason: string | null;
  // The largest single-turn input ("context") token count seen across the
  // run's steps. `null` when there is no per-step usage data to inspect.
  peakContextTokens: number | null;
}

export const NULL_RUN_ORIENTATION_METRICS: Readonly<RunOrientationMetrics> = Object.freeze({
  stepsBeforeFirstMutation: null,
  genTokensBeforeFirstMutation: null,
  skillLoads: null,
  controlPlaneDenials: null,
  sessionResumed: null,
  sessionResumeReason: null,
  peakContextTokens: null,
});

// ---------------------------------------------------------------------------
// Tool-call classification
// ---------------------------------------------------------------------------

// Built-in coding-agent tool names that write to the filesystem. Kept as an
// explicit allowlist (rather than a verb guess) because these tools are a
// small, well-known set shared across the local coding-agent adapters, and a
// false positive here would misclassify ordinary read/search tool calls.
const FILE_WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "patch",
  "apply_patch",
  "create_file",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "notebook_edit",
]);

// Tool names that address Paperclip's own control-plane API (as opposed to a
// third-party MCP tool). Naming conventions vary slightly by adapter/runtime,
// so this matches on a normalized (snake_case) prefix rather than one exact
// string. Only adapters that actually expose the Paperclip API as an MCP
// server (e.g. paperclip_runner) surface tool names like this; opencode_local
// agents reach the same API through a shell tool instead (see
// `classifyMutatingBashCommand`).
const CONTROL_PLANE_TOOL_PREFIXES = ["paperclip_", "mcp_paperclip", "mcp__paperclip"];

// A mutating call against the control plane is one whose name carries a
// write-shaped verb. Mirrors the verb list Paperclip's own MCP tool risk
// classifier uses for third-party connectors, plus "comment"/"add", which
// this codebase's control-plane tool names use for issue comments and
// child-resource creation. Matched as a standalone `_`-delimited token (see
// `toSnakeCase`), not merely a substring, so e.g. "postmortem" does not match
// "post".
const MUTATING_VERBS = [
  "create", "update", "add", "write", "delete", "remove", "destroy",
  "unpublish", "mutate", "set", "send", "publish", "post", "patch", "mark",
  "archive", "merge", "assign", "close", "reopen", "approve", "reject",
  "cancel", "comment",
];
const MUTATING_VERB_TOKEN_PATTERN = new RegExp(
  `(^|_)(${MUTATING_VERBS.join("|")})(_|$)`,
);

// Shell-like tool names whose `input.command` (see `classifyMutatingBashCommand`)
// and completed `output` (see the denial handling in
// `computeRunOrientationMetricsFromEvents`) this module is willing to inspect.
// Narrow and exact, like the allowlists above: this fork's coding-agent
// adapters name the shell tool "bash".
const SHELL_TOOL_NAMES = new Set(["bash"]);

function normalizeToolName(toolName: string): string {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
}

// Normalizes camelCase/kebab-case/dot-separated tool names onto underscores,
// so both the control-plane prefix check and the verb-token check line up
// regardless of naming style (e.g. "updateIssue", "update-issue" and
// "update.issue" all normalize to "update_issue"). Must run on the
// *original*-case input: it relies on a lowercase-to-uppercase transition to
// find camelCase humps, which an already-lowercased string has lost.
function toSnakeCase(toolName: string): string {
  if (typeof toolName !== "string") return "";
  return toolName
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.\-:]+/g, "_");
}

export function isControlPlaneToolName(toolName: string): boolean {
  const snake = toSnakeCase(toolName);
  if (!snake) return false;
  return CONTROL_PLANE_TOOL_PREFIXES.some((prefix) => snake.startsWith(prefix));
}

/**
 * "Mutation" = the first tool call that writes files, or calls a mutating
 * Paperclip control-plane API by name. Read-only tool calls (search, read,
 * list, get-style control-plane calls, etc.) are not mutations. This does
 * not cover a mutating Paperclip API call made through a shell tool (curl) —
 * see `classifyMutatingBashCommand` for that path.
 */
export function classifyMutatingToolCall(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return false;
  if (FILE_WRITE_TOOL_NAMES.has(normalized)) return true;
  const snake = toSnakeCase(toolName);
  if (!CONTROL_PLANE_TOOL_PREFIXES.some((prefix) => snake.startsWith(prefix))) return false;
  return MUTATING_VERB_TOKEN_PATTERN.test(snake);
}

// A dry run never mutates, whatever else the command line contains.
const DRY_RUN_FLAG_PATTERN = /--dry-run\b/;
// The repo's own helper (`scripts/paperclip-issue-update.sh`) always writes
// once invoked (absent --dry-run, handled above): it patches issue status
// and/or posts a comment.
const PAPERCLIP_ISSUE_UPDATE_HELPER_PATTERN = /paperclip-issue-update\.sh/;
// The Paperclip API base URL every adapter is given as an env var (see
// skills/paperclip/SKILL.md). A command that never references it isn't
// talking to Paperclip's control plane at all.
const PAPERCLIP_API_URL_REFERENCE_PATTERN = /\$\{?PAPERCLIP_API_URL\}?/;
const HTTP_WRITE_METHOD_PATTERN =
  /(?:-X|--request)\s*['"]?(?:POST|PATCH|PUT|DELETE)['"]?/i;
const HTTP_DATA_FLAG_PATTERN =
  /(?:^|\s)(?:-d\b|--data\b|--data-raw\b|--data-binary\b|--data-urlencode\b)/;

/**
 * Best-effort detection of a mutating Paperclip API call made from a shell
 * tool's command text, rather than a dedicated tool name (see
 * `classifyMutatingToolCall`). opencode_local agents call the Paperclip API
 * with curl (per skills/paperclip/SKILL.md), so a bash tool call is only a
 * control-plane mutation when its command both references the Paperclip API
 * URL (or invokes the repo's own update helper script) and carries an HTTP
 * write method or a request body. This is text matching, not a shell parse,
 * so it can both miss unusual invocations and (rarely) match a command that
 * merely echoes one — the same best-effort tradeoff as the tool-name
 * allowlists above.
 */
export function classifyMutatingBashCommand(
  command: string | null | undefined,
): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  if (DRY_RUN_FLAG_PATTERN.test(command)) return false;
  if (PAPERCLIP_ISSUE_UPDATE_HELPER_PATTERN.test(command)) return true;
  if (!PAPERCLIP_API_URL_REFERENCE_PATTERN.test(command)) return false;
  return HTTP_WRITE_METHOD_PATTERN.test(command) || HTTP_DATA_FLAG_PATTERN.test(command);
}

// The coding-agent adapters expose skill loading as a dedicated tool, named
// "skill" (or a close variant) across the runtimes this fork ships. This is
// intentionally a narrow, exact allowlist rather than a path/content guess.
const SKILL_LOAD_TOOL_NAMES = new Set(["skill", "skills", "load_skill", "use_skill"]);

export function isSkillLoadToolCall(toolName: string): boolean {
  return SKILL_LOAD_TOOL_NAMES.has(normalizeToolName(toolName));
}

// The exact wording `assertLowTrustControlPlaneDenied` returns to a denied
// low-trust actor (server/src/routes/issues.ts). Matched as a
// case-insensitive *substring*, not a loose "mentions control plane"
// pattern: opencode_local agents only ever surface this text embedded in a
// bash/curl tool's own reported output (a 403 JSON body), never as a
// distinct error class, so a looser pattern would also count unrelated tool
// errors that merely mention "control plane" (e.g. from cluster-management
// tooling) as a Paperclip denial.
const CONTROL_PLANE_DENIAL_TEXT =
  "Low-trust actors cannot use this control-plane surface";

export function isControlPlaneDenialErrorText(text: string): boolean {
  return (
    typeof text === "string" &&
    text.toLowerCase().includes(CONTROL_PLANE_DENIAL_TEXT.toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Normalized event stream + pure aggregation
// ---------------------------------------------------------------------------

export interface OrientationToolCallEvent {
  kind: "tool_call";
  callId: string;
  toolName: string;
  // The tool's own `command` argument, for shell-like tools only (see
  // `SHELL_TOOL_NAMES`) — used solely to detect a mutating Paperclip API
  // call made through curl (`classifyMutatingBashCommand`). `null` when not
  // applicable or not present.
  command: string | null;
}

export interface OrientationToolResultEvent {
  kind: "tool_result";
  callId: string;
  // The originating call's tool name, carried onto the result so aggregation
  // can decide whether this completed call's own output is safe to scan for
  // an embedded control-plane denial (see `computeRunOrientationMetricsFromEvents`).
  toolName: string;
  isError: boolean;
  errorText: string | null;
  // The tool's own reported output when it completed without an
  // opencode-level error. Only populated for shell-like tools (see
  // `SHELL_TOOL_NAMES`): that is the only case this module needs it for
  // (an HTTP response body a control-plane rejection can hide inside).
  outputText: string | null;
}

export interface OrientationStepFinishEvent {
  kind: "step_finish";
  inputTokens: number;
  outputTokens: number;
}

export type OrientationEvent =
  | OrientationToolCallEvent
  | OrientationToolResultEvent
  | OrientationStepFinishEvent;

export type RunOrientationEventMetrics = Pick<
  RunOrientationMetrics,
  | "stepsBeforeFirstMutation"
  | "genTokensBeforeFirstMutation"
  | "skillLoads"
  | "controlPlaneDenials"
  | "peakContextTokens"
>;

/**
 * Aggregates an already-normalized, ordered event stream into the
 * tool-call-derived subset of the metrics. Pure and adapter-agnostic: any
 * adapter can feed this once it has a way to produce `OrientationEvent[]`.
 */
export function computeRunOrientationMetricsFromEvents(
  events: readonly OrientationEvent[],
): RunOrientationEventMetrics {
  let genTokensSoFar = 0;
  let peakContextTokens: number | null = null;
  let distinctSteps = 0;
  let skillLoads = 0;
  let controlPlaneDenials = 0;
  let firstMutationStepIndex: number | null = null;
  let firstMutationGenTokens: number | null = null;
  // True from the moment the first mutation is confirmed (its tool_result
  // arrived without an error) until the step_finish that closes out the
  // step the mutating call happened in. That step's own output tokens — the
  // reasoning and tool-call arguments that produced the mutation itself —
  // are folded into `firstMutationGenTokens` exactly once when that
  // step_finish arrives, so the count isn't systematically short by exactly
  // the step where orientation ends.
  let firstMutationStepTokensPending = false;
  const seenCallIds = new Set<string>();
  // Tool calls classified as a plausible first mutation, keyed by call id,
  // waiting on their own tool_result to confirm the call actually succeeded
  // — an attempted write that errored (e.g. an edit whose anchor text wasn't
  // found) isn't a mutation. Resolved as each tool_result arrives, which is
  // call order for the single-threaded coding-agent adapters this module
  // parses (one tool call in flight at a time).
  const pendingMutationCandidates = new Map<
    string,
    { stepIndex: number; genTokensAtCall: number }
  >();

  for (const event of events) {
    if (event.kind === "step_finish") {
      const inputTokens = Number.isFinite(event.inputTokens) ? event.inputTokens : 0;
      const outputTokens = Number.isFinite(event.outputTokens)
        ? Math.max(0, event.outputTokens)
        : 0;
      peakContextTokens =
        peakContextTokens === null ? inputTokens : Math.max(peakContextTokens, inputTokens);
      genTokensSoFar += outputTokens;
      if (firstMutationStepTokensPending) {
        firstMutationGenTokens = (firstMutationGenTokens ?? 0) + outputTokens;
        firstMutationStepTokensPending = false;
      }
      continue;
    }

    if (event.kind === "tool_call") {
      if (seenCallIds.has(event.callId)) continue;
      seenCallIds.add(event.callId);

      if (isSkillLoadToolCall(event.toolName)) skillLoads += 1;

      if (firstMutationStepIndex === null && !pendingMutationCandidates.has(event.callId)) {
        const isShellLike = SHELL_TOOL_NAMES.has(normalizeToolName(event.toolName));
        const isMutationCandidate =
          classifyMutatingToolCall(event.toolName) ||
          (isShellLike && classifyMutatingBashCommand(event.command));
        if (isMutationCandidate) {
          pendingMutationCandidates.set(event.callId, {
            stepIndex: distinctSteps,
            genTokensAtCall: genTokensSoFar,
          });
        }
      }
      distinctSteps += 1;
      continue;
    }

    // event.kind === "tool_result"
    //
    // A control-plane denial always looks like a normal error to a
    // dedicated control-plane tool, but only looks like ordinary completed
    // output to a shell tool that curled the API directly (see the module
    // header) — a curl invocation that got a 403 body back still exits 0.
    // So this has to be resolved *before* confirming a pending mutation
    // candidate below: a bash call the control plane denied is not a
    // mutation, even though opencode itself reports it as a successful
    // (non-error) tool call.
    const isShellLike = SHELL_TOOL_NAMES.has(normalizeToolName(event.toolName));
    const isDeniedShellOutput =
      isShellLike && !event.isError && isControlPlaneDenialErrorText(event.outputText ?? "");
    const textToScan = event.isError ? event.errorText : isShellLike ? event.outputText : null;
    if (textToScan && isControlPlaneDenialErrorText(textToScan)) {
      controlPlaneDenials += 1;
    }

    const candidate = pendingMutationCandidates.get(event.callId);
    if (candidate) {
      pendingMutationCandidates.delete(event.callId);
      if (!event.isError && !isDeniedShellOutput && firstMutationStepIndex === null) {
        firstMutationStepIndex = candidate.stepIndex;
        firstMutationGenTokens = candidate.genTokensAtCall;
        firstMutationStepTokensPending = true;
      }
    }
  }

  return {
    stepsBeforeFirstMutation: firstMutationStepIndex,
    // If the mutating step's own step_finish never arrived (the stream ends
    // mid-turn -- a cancelled or timed-out run), `firstMutationGenTokens`
    // only covers the fully-closed steps before the mutation and is missing
    // the "during" component the field's contract promises. Report `null`
    // rather than that understated number: a caller cannot tell "no more
    // tokens were generated" from "we stopped listening before finding out".
    genTokensBeforeFirstMutation: firstMutationStepTokensPending ? null : firstMutationGenTokens,
    skillLoads,
    controlPlaneDenials,
    peakContextTokens,
  };
}

// ---------------------------------------------------------------------------
// opencode_local: parsing its raw stdout into the normalized event stream
// ---------------------------------------------------------------------------

// Upper bound on how much of a stdout capture this module will parse, kept
// equal to (imported from, not duplicating) the cap the adapter's own
// capture already enforces — see `deriveRunOrientationMetrics` for why that
// matters.
export const RUN_ORIENTATION_MAX_STDOUT_BYTES = MAX_CAPTURE_BYTES;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNum(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Re-parses the opencode_local adapter's own raw JSONL stdout (already
 * captured on `adapterResult.resultJson.stdout`) into the normalized
 * orientation event stream. Mirrors the field names the adapter's own
 * parsers (`parseOpenCodeJsonl`, `parseOpenCodeStdoutLine`) already rely on,
 * without depending on those modules directly. Malformed lines are skipped,
 * never thrown.
 */
export function parseOpenCodeStdoutForOrientation(stdout: string): OrientationEvent[] {
  const events: OrientationEvent[] = [];
  if (typeof stdout !== "string" || stdout.length === 0) return events;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    const type = asStr(event.type);

    if (type === "tool_use") {
      const part = asRecord(event.part);
      const toolName = asStr(part.tool);
      if (!toolName) continue;
      const callId = asStr(part.callID) || asStr(part.id) || toolName;
      const state = asRecord(part.state);
      const input = asRecord(state.input);
      const command = typeof input.command === "string" ? input.command : null;
      events.push({ kind: "tool_call", callId, toolName, command });

      const status = asStr(state.status);
      if (status === "error") {
        const errorText = asStr(state.error).trim();
        events.push({
          kind: "tool_result",
          callId,
          toolName,
          isError: true,
          errorText: errorText || null,
          outputText: null,
        });
      } else if (status === "completed") {
        const outputText = asStr(state.output).trim();
        events.push({
          kind: "tool_result",
          callId,
          toolName,
          isError: false,
          errorText: null,
          outputText: outputText || null,
        });
      }
      continue;
    }

    if (type === "step_finish") {
      const part = asRecord(event.part);
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens.cache);
      events.push({
        kind: "step_finish",
        // Anthropic-style caching splits a turn's input into three buckets:
        // freshly-processed tokens (`input`), tokens reused from cache
        // (`cache.read`), and tokens newly written to cache this turn
        // (`cache.write`) — all three were part of that turn's context, so
        // all three count toward its size.
        inputTokens: asNum(tokens.input, 0) + asNum(cache.read, 0) + asNum(cache.write, 0),
        outputTokens: asNum(tokens.output, 0) + asNum(tokens.reasoning, 0),
      });
      continue;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Orchestration: adapter-agnostic entry point used at run finalize
// ---------------------------------------------------------------------------

export interface DeriveRunOrientationMetricsInput {
  adapterType: string | null | undefined;
  // `adapterResult.resultJson` as already computed by the finalize path
  // (holds `.stdout` for opencode_local; other adapters may leave this
  // empty, in which case only the session fields are populated).
  adapterResultJson: Record<string, unknown> | null | undefined;
  // Whether the finalize path resolved this run as continuing an existing
  // session (already computed for every adapter at finalize time).
  sessionResumed: boolean;
  // The run's wake reason, used as the resume reason when applicable.
  sessionResumeReason: string | null;
}

/**
 * Computes the full metrics object for a finished run. Never throws: any
 * unexpected shape in the input simply leaves the affected fields null.
 * Callers still wrap this in try/catch, per the "never fail the run on
 * metrics" rule, since a future change here should fail closed rather than
 * take the finalize path down with it.
 */
export function deriveRunOrientationMetrics(
  input: DeriveRunOrientationMetricsInput,
): RunOrientationMetrics {
  const sessionResumed = input.sessionResumed === true;
  const base: RunOrientationMetrics = {
    ...NULL_RUN_ORIENTATION_METRICS,
    sessionResumed,
    sessionResumeReason: sessionResumed
      ? (input.sessionResumeReason || null)
      : null,
  };

  if (input.adapterType !== "opencode_local") return base;

  const stdout = input.adapterResultJson?.stdout;
  if (typeof stdout !== "string" || stdout.length === 0) return base;
  // The adapter's stdout capture is tail-truncated to exactly this cap once
  // it grows past it (`appendWithCap` keeps only the *last* N characters),
  // so its length can never exceed the cap — only ever reach it. A `>`
  // check here would therefore never actually fire, and a long run
  // would silently be measured from wherever the kept tail happens to
  // start, as if that were the whole run. `>=` treats "exactly at the cap"
  // as "possibly truncated" and reports null instead, which can only ever
  // be over-cautious (a stream whose real length exactly equals the cap is
  // vanishingly unlikely, and reporting null for it is still a safe,
  // honest "don't know" rather than a wrong number presented as a real one).
  if (stdout.length >= RUN_ORIENTATION_MAX_STDOUT_BYTES) return base;

  const events = parseOpenCodeStdoutForOrientation(stdout);
  const eventMetrics = computeRunOrientationMetricsFromEvents(events);
  return { ...base, ...eventMetrics };
}
