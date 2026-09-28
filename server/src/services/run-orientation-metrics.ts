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
// field is not available (a different adapter, a missing/oversized stdout
// capture, or a stream with no tool calls at all), that field is `null`
// rather than a guess. Callers must treat this module as pure and cheap:
// no I/O, no throwing on malformed input, and a fixed cost cap on how much
// of a stdout capture is inspected.

export interface RunOrientationMetrics {
  // Number of distinct tool calls the run made before its first mutating
  // one (see `classifyMutatingToolCall`). 0 means the very first tool call
  // was already a mutation. `null` means either there is no tool-call data
  // to inspect, or the run never made a mutating call at all (there is no
  // "before" to report).
  stepsBeforeFirstMutation: number | null;
  // Output (generated) tokens the model produced before that same first
  // mutating tool call, summed from the run's own turn/step boundaries.
  // Same `null` conditions as `stepsBeforeFirstMutation`.
  genTokensBeforeFirstMutation: number | null;
  // Count of tool calls that loaded a skill. 0 is a real count (no skill
  // calls observed); `null` means there was no tool-call data to inspect.
  skillLoads: number | null;
  // Count of tool results whose error text matches the control-plane
  // denial the server itself returns to low-trust actors. Same `null`
  // condition as `skillLoads`.
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
// string.
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
 * Paperclip control-plane API. Read-only tool calls (search, read, list,
 * get-style control-plane calls, etc.) are not mutations.
 */
export function classifyMutatingToolCall(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return false;
  if (FILE_WRITE_TOOL_NAMES.has(normalized)) return true;
  const snake = toSnakeCase(toolName);
  if (!CONTROL_PLANE_TOOL_PREFIXES.some((prefix) => snake.startsWith(prefix))) return false;
  return MUTATING_VERB_TOKEN_PATTERN.test(snake);
}

// The coding-agent adapters expose skill loading as a dedicated tool, named
// "skill" (or a close variant) across the runtimes this fork ships. This is
// intentionally a narrow, exact allowlist rather than a path/content guess.
const SKILL_LOAD_TOOL_NAMES = new Set(["skill", "skills", "load_skill", "use_skill"]);

export function isSkillLoadToolCall(toolName: string): boolean {
  return SKILL_LOAD_TOOL_NAMES.has(normalizeToolName(toolName));
}

// The exact wording `assertLowTrustControlPlaneDenied` returns to a denied
// low-trust actor. Matched case-insensitively and loosely on the
// "control-plane"/"control plane" phrase so the classifier survives minor
// message rewording.
const CONTROL_PLANE_DENIAL_PATTERN = /control[-\s]?plane/i;

export function isControlPlaneDenialErrorText(errorText: string): boolean {
  return typeof errorText === "string" && CONTROL_PLANE_DENIAL_PATTERN.test(errorText);
}

// ---------------------------------------------------------------------------
// Normalized event stream + pure aggregation
// ---------------------------------------------------------------------------

export interface OrientationToolCallEvent {
  kind: "tool_call";
  callId: string;
  toolName: string;
}

export interface OrientationToolResultEvent {
  kind: "tool_result";
  callId: string;
  isError: boolean;
  errorText: string | null;
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
  const seenCallIds = new Set<string>();

  for (const event of events) {
    if (event.kind === "step_finish") {
      const inputTokens = Number.isFinite(event.inputTokens) ? event.inputTokens : 0;
      const outputTokens = Number.isFinite(event.outputTokens)
        ? Math.max(0, event.outputTokens)
        : 0;
      peakContextTokens =
        peakContextTokens === null ? inputTokens : Math.max(peakContextTokens, inputTokens);
      genTokensSoFar += outputTokens;
      continue;
    }

    if (event.kind === "tool_call") {
      if (seenCallIds.has(event.callId)) continue;
      seenCallIds.add(event.callId);

      if (isSkillLoadToolCall(event.toolName)) skillLoads += 1;

      if (firstMutationStepIndex === null && classifyMutatingToolCall(event.toolName)) {
        firstMutationStepIndex = distinctSteps;
        firstMutationGenTokens = genTokensSoFar;
      }
      distinctSteps += 1;
      continue;
    }

    // event.kind === "tool_result"
    if (event.isError && event.errorText && isControlPlaneDenialErrorText(event.errorText)) {
      controlPlaneDenials += 1;
    }
  }

  return {
    stepsBeforeFirstMutation: firstMutationStepIndex,
    genTokensBeforeFirstMutation: firstMutationGenTokens,
    skillLoads,
    controlPlaneDenials,
    peakContextTokens,
  };
}

// ---------------------------------------------------------------------------
// opencode_local: parsing its raw stdout into the normalized event stream
// ---------------------------------------------------------------------------

// Upper bound on how much of a stdout capture this module will parse. Keeps
// the finalize path cheap regardless of how large a run's log turns out to
// be; runs whose captured stdout exceeds this are reported with tool-call
// fields left null rather than partially scanned.
export const RUN_ORIENTATION_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

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
      events.push({ kind: "tool_call", callId, toolName });

      const state = asRecord(part.state);
      const status = asStr(state.status);
      if (status === "error") {
        const errorText = asStr(state.error).trim();
        events.push({ kind: "tool_result", callId, isError: true, errorText: errorText || null });
      } else if (status === "completed") {
        events.push({ kind: "tool_result", callId, isError: false, errorText: null });
      }
      continue;
    }

    if (type === "step_finish") {
      const part = asRecord(event.part);
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens.cache);
      events.push({
        kind: "step_finish",
        inputTokens: asNum(tokens.input, 0) + asNum(cache.read, 0),
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
  if (stdout.length > RUN_ORIENTATION_MAX_STDOUT_BYTES) return base;

  const events = parseOpenCodeStdoutForOrientation(stdout);
  const eventMetrics = computeRunOrientationMetricsFromEvents(events);
  return { ...base, ...eventMetrics };
}
