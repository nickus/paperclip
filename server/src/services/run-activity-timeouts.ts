// Activity-based run limits.
//
// A run has two independent limits:
//
// - The inactivity timeout (`adapterConfig.idleTimeoutSec`) stops a run that
//   has produced no output or progress signal for that long. It is measured
//   from the latest log chunk, adapter event or runtime progress report, so a
//   slow but steady run is never stopped by it.
// - The hard time cap (`adapterConfig.timeoutSec`, enforced by the adapter
//   process runners) is a safety net, not a work budget. When a run reaches
//   it while it is still producing output, the server records the stop as a
//   checkpoint and queues a bounded continuation of the same task instead of
//   treating the stop as a failure that needs manual reconciliation.
//
//   steady run:
//     output  |   |    |   |     |    |   |    |
//     idle    <- restarts on every signal ->          never fires
//     cap     --------------------------------------X checkpoint, continue
//
//   stalled run:
//     output  |  |
//     idle          <---- idleTimeoutSec ---->X       stop (timeout)

/** Default inactivity window when `adapterConfig.idleTimeoutSec` is unset. */
export const DEFAULT_RUN_IDLE_TIMEOUT_SEC = 900;
/** Run error code for a run stopped by the inactivity timeout. */
export const RUN_IDLE_TIMEOUT_ERROR_CODE = "idle_timeout";
/** Run error code and stop reason for a hard-cap stop taken as a checkpoint. */
export const RUN_TIME_CAP_CHECKPOINT_ERROR_CODE = "time_cap_checkpoint";
/** Wake reason of the automatic continuation after a time-cap checkpoint. */
export const TIME_CAP_CONTINUATION_WAKE_REASON = "time_cap_continuation";

const TIME_CAP_CONTINUATION_DEFAULT_MAX_ATTEMPTS = 3;
const TIME_CAP_CONTINUATION_MAX_ATTEMPTS_CAP = 10;
const TIME_CAP_CONTINUATION_DEFAULT_DELAY_MS = 1_000;
const TIME_CAP_CONTINUATION_MAX_DELAY_MS = 5 * 60 * 1000;
// Lines the platform itself writes into a run log start with this prefix at
// column 0. They are not evidence that the provider is still working.
const PLATFORM_LOG_LINE_PREFIX = "[paperclip] ";
// Adapters that run an arbitrary command or call a webhook rather than an
// agent session. A long quiet spell is normal for them, so the idle timer is
// off unless their config sets it.
const IDLE_TIMEOUT_OPT_IN_ADAPTER_TYPES = new Set(["process", "http"]);

export type RunIdleTimeoutSource = "configured" | "default" | "disabled";

export interface RunIdleTimeoutPolicy {
  /** Inactivity window in seconds; 0 means the idle timer is disabled. */
  idleTimeoutSec: number;
  source: RunIdleTimeoutSource;
}

export interface TimeCapContinuationPolicy {
  enabled: boolean;
  maxAttempts: number;
  delayMs: number;
}

export interface RunActivitySnapshot {
  /** When the watchdog started, i.e. when the adapter was dispatched. */
  startedAt: number;
  /** Latest output or progress signal of any kind. */
  lastActivityAt: number;
  /** Latest output that did not come from the platform itself. */
  lastProviderActivityAt: number | null;
  /** When the idle timer stopped the run, or null while it has not. */
  idleFiredAt: number | null;
}

export interface RunActivityWatchdog {
  /**
   * Record an output or progress signal. "provider" is output the agent
   * process or adapter produced; "platform" is a status line or progress
   * report the platform wrote for the run.
   */
  recordActivity(kind: "provider" | "platform"): void;
  /** Stop the idle timer. Later activity is ignored. */
  stop(): void;
  snapshot(): RunActivitySnapshot;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolve `adapterConfig.idleTimeoutSec`. A positive value sets the window
 * (at least one second), a negative value disables the idle timer, and an
 * absent or zero value uses the default. Zero cannot mean "disabled" for the
 * same reason as `timeoutSec`: config forms persist 0 for untouched fields.
 * The default is off for command and webhook adapters (see above).
 */
export function resolveRunIdleTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): RunIdleTimeoutPolicy {
  const configured = readFiniteNumber(adapterConfig?.idleTimeoutSec);
  if (configured !== null && configured > 0) {
    return { idleTimeoutSec: Math.max(1, configured), source: "configured" };
  }
  if (
    (configured !== null && configured < 0) ||
    IDLE_TIMEOUT_OPT_IN_ADAPTER_TYPES.has(adapterType)
  ) {
    return { idleTimeoutSec: 0, source: "disabled" };
  }
  return { idleTimeoutSec: DEFAULT_RUN_IDLE_TIMEOUT_SEC, source: "default" };
}

/**
 * Resolve `runtimeConfig.heartbeat.timeCapContinuation`. Continuations after a
 * time-cap checkpoint are on by default and bounded per continuation chain.
 */
export function resolveTimeCapContinuationPolicy(
  runtimeConfig: unknown,
): TimeCapContinuationPolicy {
  const configured = readObject(
    readObject(readObject(runtimeConfig).heartbeat).timeCapContinuation,
  );
  const maxAttempts = Math.floor(
    readFiniteNumber(configured.maxAttempts) ??
      TIME_CAP_CONTINUATION_DEFAULT_MAX_ATTEMPTS,
  );
  const delayMs = Math.floor(
    readFiniteNumber(configured.delayMs) ?? TIME_CAP_CONTINUATION_DEFAULT_DELAY_MS,
  );
  return {
    enabled: configured.enabled !== false,
    maxAttempts: Math.max(
      0,
      Math.min(TIME_CAP_CONTINUATION_MAX_ATTEMPTS_CAP, maxAttempts),
    ),
    delayMs: Math.max(0, Math.min(TIME_CAP_CONTINUATION_MAX_DELAY_MS, delayMs)),
  };
}

/**
 * True when a log chunk carries no provider output: every non-empty line is a
 * platform status line (or the chunk is blank).
 *
 * Platform lines share the log stream with provider output and are told
 * apart only by their text, so this is a heuristic. The match is kept narrow
 * (the exact prefix at the very start of the line, so indented, quoted or
 * JSON-embedded copies count as provider output), but a provider that prints
 * lines starting with that exact prefix is still read as platform output.
 * The effect is limited: every chunk still resets the idle timer, so such a
 * run is never stopped as idle. It only matters when a run reaches the hard
 * time cap and every chunk it produced for a whole activity window looked
 * like this; `classifyTimeCapStop` then sees no recent provider output and
 * the stop keeps the ordinary timeout behavior instead of a checkpoint.
 */
export function isPlatformOnlyLogChunk(chunk: string): boolean {
  // Fast path for ordinary output, which is most chunks.
  if (!chunk.includes(PLATFORM_LOG_LINE_PREFIX)) return chunk.trim().length === 0;
  for (const line of chunk.split("\n")) {
    // No trimming before the prefix check: any leading character, including
    // whitespace, makes the line provider output.
    if (line.trim().length > 0 && !line.startsWith(PLATFORM_LOG_LINE_PREFIX)) {
      return false;
    }
  }
  return true;
}

/**
 * Track a run's output and progress signals and call `onIdle` when none
 * arrived for `idleTimeoutMs`. `onIdle` returns whether it stopped the run:
 * after a stop the watchdog is done; otherwise it watches the next window,
 * so a run that could not be stopped yet (no process started) is checked
 * again later. With `idleTimeoutMs <= 0` it only tracks activity. The timer
 * re-arms lazily for the remaining window instead of being reset on every
 * chunk, so a chatty run costs one timer per window.
 */
export function createRunActivityWatchdog(input: {
  idleTimeoutMs: number;
  onIdle: (snapshot: RunActivitySnapshot) => boolean;
  now?: () => number;
}): RunActivityWatchdog {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let lastActivityAt = startedAt;
  let lastProviderActivityAt: number | null = null;
  let idleFiredAt: number | null = null;
  // Start of the current quiet window: the latest activity, or the latest
  // idle check that could not stop the run.
  let windowStartAt = startedAt;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const snapshot = (): RunActivitySnapshot => ({
    startedAt,
    lastActivityAt,
    lastProviderActivityAt,
    idleFiredAt,
  });
  const arm = (delayMs: number) => {
    timer = setTimeout(check, Math.max(0, delayMs));
    // A pending idle check must never keep the server process alive.
    (timer as { unref?: () => void }).unref?.();
  };
  const check = () => {
    timer = null;
    if (stopped || idleFiredAt !== null) return;
    const silentMs = now() - windowStartAt;
    if (silentMs < input.idleTimeoutMs) {
      // Activity arrived since the timer was armed: wait out the rest.
      arm(input.idleTimeoutMs - silentMs);
      return;
    }
    const firedAt = now();
    let stoppedRun = false;
    try {
      stoppedRun = input.onIdle({ ...snapshot(), idleFiredAt: firedAt });
    } catch {
      // The caller owns error reporting; a throwing handler must not leave
      // an unhandled exception on the timer.
    }
    if (stoppedRun) {
      idleFiredAt = firedAt;
      return;
    }
    windowStartAt = firedAt;
    arm(input.idleTimeoutMs);
  };
  if (input.idleTimeoutMs > 0) arm(input.idleTimeoutMs);

  return {
    recordActivity(kind) {
      if (stopped) return;
      const at = now();
      if (kind === "provider") lastProviderActivityAt = at;
      if (idleFiredAt === null) {
        lastActivityAt = at;
        windowStartAt = at;
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    snapshot,
  };
}

export interface TimeCapStopClassification {
  /** The run was still producing provider output when the cap stopped it. */
  productive: boolean;
  runDurationMs: number;
  /** Provider silence before the stop, or null when it produced none. */
  providerSilenceMs: number | null;
}

/**
 * Decide whether a hard-cap stop interrupted productive work. The run must
 * have lasted at least one inactivity window (a cap shorter than that acts
 * as a request timeout, not a safety net) and its latest provider output
 * must be no older than that window when it stopped. An earlier quiet spell
 * does not matter; only the activity leading up to the stop does.
 *
 * This is a heuristic on the activity the watchdog saw. Provider output that
 * looks like platform status lines (see `isPlatformOnlyLogChunk`) does not
 * count, so a run whose only recent output was such lines is classified as
 * not productive and keeps the ordinary timeout behavior.
 */
export function classifyTimeCapStop(input: {
  snapshot: RunActivitySnapshot;
  stoppedAt: number;
  windowSec: number;
}): TimeCapStopClassification {
  const windowMs = Math.max(1, input.windowSec) * 1000;
  const runDurationMs = Math.max(0, input.stoppedAt - input.snapshot.startedAt);
  const lastProvider = input.snapshot.lastProviderActivityAt;
  const providerSilenceMs =
    lastProvider === null ? null : Math.max(0, input.stoppedAt - lastProvider);
  return {
    productive:
      runDurationMs >= windowMs &&
      providerSilenceMs !== null &&
      providerSilenceMs <= windowMs,
    runDurationMs,
    providerSilenceMs,
  };
}

function describeIdleTimeoutSource(policy: RunIdleTimeoutPolicy): string {
  return policy.source === "configured"
    ? "configured via adapterConfig.idleTimeoutSec"
    : "default";
}

export function formatRunIdleTimeoutMessage(policy: RunIdleTimeoutPolicy): string {
  return (
    `Run stopped after ${policy.idleTimeoutSec}s without output or progress ` +
    `(idleTimeoutSec=${policy.idleTimeoutSec}, ${describeIdleTimeoutSource(policy)}). ` +
    `Set adapterConfig.idleTimeoutSec to change the window, or a negative value to disable it.`
  );
}

export function formatRunIdleTimeoutUnenforcedMessage(
  policy: RunIdleTimeoutPolicy,
): string {
  return (
    `No output or progress for ${policy.idleTimeoutSec}s ` +
    `(idleTimeoutSec=${policy.idleTimeoutSec}, ${describeIdleTimeoutSource(policy)}), ` +
    `but this run has no process the platform can stop; it continues until it ends or reaches its hard time cap.`
  );
}

export function formatTimeCapCheckpointMessage(input: {
  attempt: number;
  maxAttempts: number;
  adapterMessage: string | null | undefined;
}): string {
  const adapterMessage = input.adapterMessage?.trim();
  return (
    "Run reached its hard time cap while still making progress. The platform stopped the process " +
    "as a checkpoint; the task continues automatically from the workspace state " +
    `(continuation ${input.attempt}/${input.maxAttempts}). ` +
    "adapterConfig.timeoutSec is a safety cap, not a work budget." +
    (adapterMessage ? ` Adapter: ${adapterMessage}` : "")
  );
}

export function buildTimeCapContinuationInstruction(reachedAt: string): string {
  return (
    `Your previous run reached the time cap at ${reachedAt}; continue from the workspace state. ` +
    "The platform stopped that run's process, so changes it had not written yet are missing. " +
    "Inspect the workspace before editing, keep the work that is already there, and do not repeat steps that already landed."
  );
}
