/**
 * Stop every process a run left behind in a reusable sandbox, without touching
 * the sandbox itself.
 *
 * Releasing a reusable lease keeps the pod (and its filesystem) for the next
 * run, but the host still needs proof that the run's remote execution ended
 * before it records a "stopped" termination receipt. This module execs a POSIX
 * sh script in the agent container that walks /proc and terminates everything
 * except:
 *   - PID 1 (tini),
 *   - the keepalive chain under PID 1 (`sleep infinity`, or the
 *     `/bin/sh -c sleep infinity` wrapper and its `sleep infinity` child),
 *   - the script itself and its own direct children,
 *   - zombies (already dead; tini reaps them).
 * It sends TERM, polls for up to `termWaitSec` seconds, sends KILL to what is
 * left, and exits 0 only when a final scan finds nothing left.
 *
 * The script only uses shell builtins plus `tr` and `sleep`, which busybox and
 * coreutils images both provide.
 */

/**
 * Positional arguments: $1 = proc root (default /proc), $2 = kill command
 * (default: the shell builtin), $3 = TERM wait in seconds (default 5),
 * $4 = pid to treat as "self" (default $$). The overrides exist for tests that
 * run the script against a fake /proc tree.
 */
export const PROCESS_RESET_SCRIPT = `
PROC_ROOT="\${1:-/proc}"
KILL_CMD="\${2:-kill}"
TERM_WAIT="\${3:-5}"
SELF="\${4:-$$}"
KEEP=" "
TARGETS=""

# Sets STATE and PARENT from <dir>/stat. The command name is in parentheses and
# may itself contain spaces or parentheses, so parse from the last ") ".
read_stat() {
  STAT=""
  [ -r "$1/stat" ] || return 1
  IFS= read -r STAT 2>/dev/null < "$1/stat" || [ -n "$STAT" ] || return 1
  REST=\${STAT##*") "}
  STATE=\${REST%% *}
  REST=\${REST#* }
  PARENT=\${REST%% *}
  [ -n "$STATE" ] && [ -n "$PARENT" ]
}

# Sets CMDLINE to the NUL-separated argv joined with single spaces.
read_cmdline() {
  CMDLINE=$(tr '\\000' ' ' 2>/dev/null < "$1/cmdline") || CMDLINE=""
  CMDLINE=\${CMDLINE% }
}

is_keepalive() {
  case "$1" in
    "sleep infinity"|"/bin/sleep infinity"|"/usr/bin/sleep infinity") return 0 ;;
    "/bin/sh -c sleep infinity"|"sh -c sleep infinity") return 0 ;;
  esac
  return 1
}

scan() {
  KEEP=" "
  TARGETS=""
  # Keepalive processes started by PID 1.
  for d in "$PROC_ROOT"/[0-9]*; do
    read_stat "$d" || continue
    [ "$PARENT" = 1 ] || continue
    [ "$STATE" = Z ] && continue
    read_cmdline "$d"
    is_keepalive "$CMDLINE" && KEEP="$KEEP\${d##*/} "
  done
  # A 'sleep infinity' whose parent is a protected keepalive shell.
  for d in "$PROC_ROOT"/[0-9]*; do
    read_stat "$d" || continue
    case "$KEEP" in *" $PARENT "*) ;; *) continue ;; esac
    read_cmdline "$d"
    case "$CMDLINE" in
      "sleep infinity"|"/bin/sleep infinity"|"/usr/bin/sleep infinity") KEEP="$KEEP\${d##*/} " ;;
    esac
  done
  for d in "$PROC_ROOT"/[0-9]*; do
    pid=\${d##*/}
    [ "$pid" = 1 ] && continue
    [ "$pid" = "$SELF" ] && continue
    read_stat "$d" || continue
    [ "$STATE" = Z ] && continue
    [ "$PARENT" = "$SELF" ] && continue
    case "$KEEP" in *" $pid "*) continue ;; esac
    TARGETS="$TARGETS $pid"
  done
}

scan
if [ -z "$TARGETS" ]; then
  echo "paperclip-process-reset: ok stopped=0"
  exit 0
fi
set -- $TARGETS
STOPPED=$#
$KILL_CMD -TERM $TARGETS 2>/dev/null
i=0
while [ "$i" -lt "$TERM_WAIT" ]; do
  scan
  [ -z "$TARGETS" ] && break
  sleep 1
  i=$((i + 1))
done
scan
if [ -n "$TARGETS" ]; then
  $KILL_CMD -KILL $TARGETS 2>/dev/null
  i=0
  while [ "$i" -lt 3 ]; do
    scan
    [ -z "$TARGETS" ] && break
    sleep 1
    i=$((i + 1))
  done
fi
scan
if [ -n "$TARGETS" ]; then
  echo "paperclip-process-reset: failed remaining=$TARGETS" >&2
  exit 1
fi
echo "paperclip-process-reset: ok stopped=$STOPPED"
exit 0
`;

export interface ProcessResetOptions {
  procRoot?: string;
  killCommand?: string;
  termWaitSec?: number;
  selfPid?: string;
}

/** argv for the reset exec; the overrides are only for tests. */
export function buildProcessResetCommand(options: ProcessResetOptions = {}): string[] {
  const argv = ["/bin/sh", "-c", PROCESS_RESET_SCRIPT, "paperclip-process-reset"];
  const positional = [
    options.procRoot ?? "",
    options.killCommand ?? "",
    options.termWaitSec !== undefined ? String(options.termWaitSec) : "",
    options.selfPid ?? "",
  ];
  // Trailing empty arguments fall back to the script defaults.
  while (positional.length > 0 && positional[positional.length - 1] === "") positional.pop();
  return [...argv, ...positional];
}

/** Budget for the reset exec: TERM wait (5s) + KILL wait (3s) + exec overhead. */
export const PROCESS_RESET_TIMEOUT_MS = 15_000;

export type PodCommandExec = (
  command: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface ProcessResetResult {
  ok: boolean;
  detail: string;
  /** The exec itself failed (nothing ran or its result was lost), as opposed to the script reporting a failure. */
  execFailed: boolean;
}

/** Run the reset script through `exec`; any exec failure counts as "not verified". */
export async function resetSandboxProcesses(
  exec: PodCommandExec,
  options: ProcessResetOptions & { timeoutMs?: number } = {},
): Promise<ProcessResetResult> {
  try {
    const result = await exec(buildProcessResetCommand(options), options.timeoutMs ?? PROCESS_RESET_TIMEOUT_MS);
    const detail = `${result.stdout}${result.stderr}`.trim();
    return {
      ok: result.exitCode === 0 && /paperclip-process-reset: ok\b/.test(result.stdout),
      detail,
      execFailed: false,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err), execFailed: true };
  }
}
