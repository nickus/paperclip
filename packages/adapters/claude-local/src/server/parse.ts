import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

// The legacy login-prompt markers. The Claude CLI prints these words when it
// asks the user to log in. The detector matches them against any probe output
// line, which includes the raw stdout and stderr. This scope is pre-existing.
const CLAUDE_LOGIN_PROMPT_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;

// The token-failure markers. An assistant or model event can print these same
// words as ordinary prose, so the detector matches them only against the parsed
// terminal result fields of a failed run. See detectClaudeLoginRequired.
const CLAUDE_AUTH_TOKEN_FAILURE_RE =
  /(?:authentication[_\s-](?:failed|error)|failed\s+to\s+authenticate|invalid\s+bearer\s+token|(?:invalid|expired|revoked)[\s\S]{0,40}(?:bearer|oauth|access)\s+token|(?:bearer|oauth|access)\s+token[\s\S]{0,40}(?:is\s+)?(?:invalid|expired|revoked))/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached)/i;
const CLAUDE_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|servicequotaexceededexception)/i;
const CLAUDE_MODEL_NOT_FOUND_RE =
  /(?:\b404\b[\s\S]{0,120})?(?:model[\s_-]*(?:not[\s_-]*found|does not exist|unknown|invalid)|unknown[\s_-]*model)/i;
const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

/**
 * Sum the per-model usage ledger from a Claude CLI result event. The result
 * event's top-level `usage` reflects only the main-loop message chain, so it
 * undercounts output tokens whenever subagents or sidechains ran; `modelUsage`
 * is the CLI's authoritative per-model accounting (it is what backs /cost).
 * Cache-creation tokens are billed prompt tokens, so they count as input.
 */
export function claudeModelUsageTotals(modelUsage: unknown): UsageSummary | null {
  const byModel = parseObject(modelUsage);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawEntry = false;
  for (const value of Object.values(byModel)) {
    const entry = parseObject(value);
    if (Object.keys(entry).length === 0) continue;
    sawEntry = true;
    inputTokens += asNumber(entry.inputTokens, 0) + asNumber(entry.cacheCreationInputTokens, 0);
    outputTokens += asNumber(entry.outputTokens, 0);
    cachedInputTokens += asNumber(entry.cacheReadInputTokens, 0);
  }
  if (!sawEntry) return null;
  return { inputTokens, outputTokens, cachedInputTokens };
}

/** one normalized rate-limit window, e.g. the "five_hour" or "seven_day" entry */
export interface ClaudeRateLimitWindowSnapshot {
  /** fraction of the window consumed, 0-1, null when not reported */
  utilization: number | null;
  /** epoch seconds when the window resets, null when not reported */
  resetsAt: number | null;
}

/**
 * A normalized snapshot of the Claude CLI's own `rate_limit_event` stream-json
 * event. Every field is optional on the wire (see normalizeClaudeRateLimitInfo),
 * so every field here can be null; only `observedAt` is always set, by the
 * caller that captured the event.
 */
export interface ClaudeRateLimitSnapshot {
  /** ISO timestamp the caller stamped when this snapshot was captured. */
  observedAt: string;
  status: string | null;
  rateLimitType: string | null;
  resetsAt: number | null;
  overageStatus: string | null;
  overageResetsAt: number | null;
  /** True when the LAST event of the run reported overage in use. */
  isUsingOverage: boolean;
  /** True when ANY event of the run reported overage in use, even if a
   *  later event in the same run did not (e.g. the window reset mid-run). */
  overageInUse: boolean;
  windows: {
    five_hour?: ClaudeRateLimitWindowSnapshot;
    seven_day?: ClaudeRateLimitWindowSnapshot;
  };
}

function asFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeClaudeRateLimitWindow(value: unknown): ClaudeRateLimitWindowSnapshot | null {
  const obj = parseObject(value);
  if (Object.keys(obj).length === 0) return null;
  const window = {
    utilization: asFiniteNumberOrNull(obj.utilization),
    resetsAt: asFiniteNumberOrNull(obj.resetsAt),
  };
  // Both fields missing/non-numeric: nothing usable came through.
  if (window.utilization == null && window.resetsAt == null) return null;
  return window;
}

function rateLimitWindowBucket(rateLimitType: string): "five_hour" | "seven_day" | null {
  const normalized = rateLimitType.trim().toLowerCase();
  if (normalized.startsWith("five_hour")) return "five_hour";
  if (normalized.startsWith("seven_day")) return "seven_day";
  return null;
}

/**
 * Normalize one `rate_limit_event`'s `rate_limit_info` payload into the
 * shared snapshot shape the server and UI consume. Handles both the current
 * shape (a `unifiedWindows` object keyed by window name) and the older,
 * lighter shape some CLI versions emit (one flat window keyed by
 * `rateLimitType`, e.g. "seven_day_overage_included"). Every field is
 * optional on the wire, so every read here is defensive: a missing or
 * malformed field becomes null/false/empty rather than throwing.
 */
export function normalizeClaudeRateLimitInfo(
  rateLimitInfo: unknown,
  observedAt: string,
): ClaudeRateLimitSnapshot | null {
  const info = parseObject(rateLimitInfo);
  if (Object.keys(info).length === 0) return null;

  const windows: ClaudeRateLimitSnapshot["windows"] = {};
  const unifiedWindows = parseObject(info.unifiedWindows);
  const fiveHour = normalizeClaudeRateLimitWindow(unifiedWindows.five_hour);
  if (fiveHour) windows.five_hour = fiveHour;
  const sevenDay = normalizeClaudeRateLimitWindow(unifiedWindows.seven_day);
  if (sevenDay) windows.seven_day = sevenDay;

  // Older/lighter events carry one flat window instead of `unifiedWindows`.
  if (windows.five_hour == null && windows.seven_day == null) {
    const rateLimitType = asString(info.rateLimitType, "");
    const bucket = rateLimitType ? rateLimitWindowBucket(rateLimitType) : null;
    if (bucket) {
      const flatWindow = normalizeClaudeRateLimitWindow({
        utilization: info.utilization,
        resetsAt: info.resetsAt,
      });
      if (flatWindow) windows[bucket] = flatWindow;
    }
  }

  return {
    observedAt,
    status: asString(info.status, "") || null,
    rateLimitType: asString(info.rateLimitType, "") || null,
    resetsAt: asFiniteNumberOrNull(info.resetsAt),
    overageStatus: asString(info.overageStatus, "") || null,
    overageResetsAt: asFiniteNumberOrNull(info.overageResetsAt),
    isUsingOverage: asBoolean(info.isUsingOverage, false),
    overageInUse: asBoolean(info.overageInUse, false),
    windows,
  };
}

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  // The LAST rate_limit_event seen wins for the point-in-time snapshot, but
  // overage state is sticky for the run: once any event reports it in use,
  // the run billed at least some tokens at API overage prices even if a
  // later event (e.g. after the window rolled over) no longer shows it.
  let lastRateLimitInfo: unknown = null;
  let everOverageInUse = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "rate_limit_event") {
      lastRateLimitInfo = event.rate_limit_info;
      const info = parseObject(event.rate_limit_info);
      if (asBoolean(info.isUsingOverage, false) || asBoolean(info.overageInUse, false)) {
        everOverageInUse = true;
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  const claudeRateLimit = (() => {
    const snapshot = lastRateLimitInfo
      ? normalizeClaudeRateLimitInfo(lastRateLimitInfo, new Date().toISOString())
      : null;
    if (snapshot && everOverageInUse) snapshot.overageInUse = true;
    return snapshot;
  })();

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      usageBasis: null as "per_run" | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
      claudeRateLimit,
    };
  }

  const modelUsageTotals = claudeModelUsageTotals(finalResult.modelUsage);
  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = modelUsageTotals ?? {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    // modelUsage covers exactly this CLI invocation, so mark it per-run to
    // keep the server from applying its session-cumulative delta heuristic.
    usageBasis: "per_run" as const,
    summary,
    resultJson: finalResult,
    claudeRateLimit,
  };
}

/**
 * A successful result event for which Claude ran no model turn. A resumed
 * session emits one when the CLI first reports background tasks that a
 * previous process left behind (`task_notification` events): it answers those
 * notifications with an empty zero-turn result and only then starts the turn
 * for the prompt. Such a result does not end the invocation.
 */
export function isClaudeNoopTurnResult(event: Record<string, unknown>): boolean {
  return (
    asString(event.type, "") === "result" &&
    asString(event.subtype, "").trim().toLowerCase() === "success" &&
    !asBoolean(event.is_error, false) &&
    event.num_turns === 0
  );
}

/**
 * Whether the stream-json output contains the result that ends the prompt's
 * turn. Used to decide when a Claude process that keeps running (for example
 * because a background task it started is still alive) can be cleaned up.
 * A zero-turn result (see isClaudeNoopTurnResult) does not count: the prompt's
 * turn is still to come.
 */
export function hasClaudeTerminalResult(stdout: string): boolean {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event || asString(event.type, "") !== "result") continue;
    if (!isClaudeNoopTurnResult(event)) return true;
  }
  return false;
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

// Collect the parsed terminal result fields that carry an auth failure. The
// CLI writes the token-failure text to the result event, so the detector reads
// the result string, the top-level error field, and the errors array. It never
// reads the raw stdout, so an assistant event cannot inject a token marker.
function collectClaudeTerminalText(parsed: Record<string, unknown>): string {
  return [
    asString(parsed.result, ""),
    asString(parsed.error, ""),
    ...extractClaudeErrorMessages(parsed),
  ]
    .map((field) => field.trim())
    .filter(Boolean)
    .join("\n");
}

// Report whether the parsed terminal result marks the run as an auth failure.
// The token-failure markers apply only to a failed run. A successful probe
// whose answer text repeats an auth phrase does not classify as login required.
function claudeResultIndicatesAuthFailure(parsed: Record<string, unknown>): boolean {
  if (asBoolean(parsed.is_error, false)) return true;
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype.startsWith("error")) return true;
  const status =
    asNumber(parsed.api_error_status, 0) || asNumber(parsed.error_status, 0);
  if (status === 401 || status === 403) return true;
  if (asString(parsed.error, "").trim()) return true;
  return extractClaudeErrorMessages(parsed).length > 0;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const parsed = input.parsed ?? null;
  const resultText = asString(parsed?.result, "").trim();

  // The legacy login-prompt markers keep their broad scope. They match against
  // every output line, which includes the parsed result, the parsed errors, and
  // the raw stdout and stderr.
  const promptLines = [resultText, ...extractClaudeErrorMessages(parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const loginPrompt = promptLines.some((line) => CLAUDE_LOGIN_PROMPT_RE.test(line));

  // The token-failure markers match only against the parsed terminal fields of
  // a failed run. The raw stdout is untrusted, so a model that prints a token
  // phrase, or a successful run that repeats one, does not flip the classifier.
  const tokenFailure =
    parsed !== null &&
    claudeResultIndicatesAuthFailure(parsed) &&
    CLAUDE_AUTH_TOKEN_FAILURE_RE.test(collectClaudeTerminalText(parsed));

  return {
    requiresLogin: loginPrompt || tokenFailure,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeModelNotFoundError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  const messages = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
  ];
  return messages.some((message) => CLAUDE_MODEL_NOT_FOUND_RE.test(message));
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit" ||
    reason === "turn_limit_exhausted",
  );
}

export function isClaudeRefusalResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  // A policy refusal exits the CLI cleanly (exitCode=0, is_error=false), so it
  // must be detected from the structured fields rather than the failure flag.
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "model_refusal" || subtype === "refusal") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) => reason === "refusal");
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found|not a valid UUID|--resume requires a valid session|is not a UUID|does not match any session title/i.test(
      msg,
    ),
  );
}

export function isClaudePoisonedPreviousMessageIdError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /diagnostics\.previous_message_id.*starts with `msg_`/i.test(msg),
  );
}

export function isClaudeImageProcessingError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /could not process image/i.test(msg),
  );
}

function buildClaudeTransientHaystack(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractClaudeRetryNotBefore(
  input: {
    parsed?: Record<string, unknown> | null;
    stdout?: string | null;
    stderr?: string | null;
    errorMessage?: string | null;
  },
  now = new Date(),
): Date | null {
  const haystack = buildClaudeTransientHaystack(input);
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

export function isClaudeTransientUpstreamError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  // Deterministic failures are handled by their own classifiers.
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  if (isClaudeProviderQuotaError(input)) return false;
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack);
}

export function isClaudeProviderQuotaError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  return CLAUDE_PROVIDER_QUOTA_RE.test(haystack);
}
