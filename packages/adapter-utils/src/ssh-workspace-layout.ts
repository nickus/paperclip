import path from "node:path";

/**
 * Remote directory layout of the SSH lane, relative to the environment's
 * working directory (`remoteCwd`):
 *
 *   <remoteCwd>/.paperclip-runtime/
 *   ├── .stage.lock                flock(1) lock held while a workspace is staged
 *   ├── workspaces/<key>/          stable per (agent, task, host workspace)
 *   │   ├── workspace/             the agent's working directory
 *   │   ├── .last-used             touched when a run stages it (GC clock)
 *   │   └── .last-run              run id that staged workspace/
 *   └── runs/<runId>/              per run
 *       ├── <adapterKey>/          runtime root: skills, config, bridge files
 *       ├── scratch/               run scratch and temp directory
 *       └── workspace/             previous contents of a stable workspace,
 *                                  or the whole workspace without a key
 *
 * The stable workspace path lets an agent CLI find the session it saved in an
 * earlier run of the same task, because CLIs key their session stores by the
 * working directory. Everything that must stay private to one run lives under
 * `runs/<runId>`.
 *
 * Paperclip removes neither `runs/` nor `workspaces/`; the host's operator
 * does. A cleanup of idle entries that runs concurrently with Paperclip should
 * take `.stage.lock` (flock(1), exclusive) while it decides what to remove and
 * moves it out of the tree, then delete it after releasing the lock. The stage
 * script holds the same lock and marks the slot as used first, so such a
 * cleanup never removes a slot or run directory while a run is staging it.
 */
export const SSH_RUNTIME_DIR_NAME = ".paperclip-runtime";

/** Lock file under the runtime directory; see the layout comment above. */
export const SSH_STAGE_LOCK_FILE_NAME = ".stage.lock";

const WORKSPACE_REUSE_KEY_PATTERN = /^[0-9a-f]{32}$/;
const RUN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A workspace reuse key is exactly 32 lowercase hex characters. */
export function isSshWorkspaceReuseKey(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_REUSE_KEY_PATTERN.test(value);
}

/** True when a run id can name a directory without escaping `runs/`. */
export function isSshRunIdPathSegment(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_SEGMENT_PATTERN.test(value) && !value.includes("..");
}

function requireRunIdSegment(runId: string): string {
  if (!isSshRunIdPathSegment(runId)) throw new Error("Invalid run id for an SSH run directory");
  return runId;
}

function requireWorkspaceReuseKey(key: string): string {
  if (!isSshWorkspaceReuseKey(key)) throw new Error("Invalid SSH workspace reuse key");
  return key;
}

export function sshRuntimeDir(baseRemoteDir: string): string {
  return path.posix.join(baseRemoteDir, SSH_RUNTIME_DIR_NAME);
}

export function sshStageLockPath(baseRemoteDir: string): string {
  return path.posix.join(sshRuntimeDir(baseRemoteDir), SSH_STAGE_LOCK_FILE_NAME);
}

export function sshRunsRootDir(baseRemoteDir: string): string {
  return path.posix.join(sshRuntimeDir(baseRemoteDir), "runs");
}

export function sshRunDir(baseRemoteDir: string, runId: string): string {
  return path.posix.join(sshRunsRootDir(baseRemoteDir), requireRunIdSegment(runId));
}

/** Per-run scratch directory; the server creates it and points the temp env vars at it. */
export function sshRunScratchDir(baseRemoteDir: string, runId: string): string {
  return path.posix.join(sshRunDir(baseRemoteDir, runId), "scratch");
}

export function sshReusableWorkspaceSlotDir(baseRemoteDir: string, key: string): string {
  return path.posix.join(sshRuntimeDir(baseRemoteDir), "workspaces", requireWorkspaceReuseKey(key));
}

export function sshReusableWorkspaceDir(baseRemoteDir: string, key: string): string {
  return path.posix.join(sshReusableWorkspaceSlotDir(baseRemoteDir, key), "workspace");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Shell script that prepares the stable workspace of `key` for `runId`.
 *
 * The workspace sync replaces the remote contents from the host copy on every
 * run, so the previous contents carry nothing forward. They are moved into
 * `runs/<previous run>/workspace` instead of being deleted: that keeps them
 * for the same recovery window as a per-run workspace, and a process left
 * over from the previous run keeps writing into the moved directory instead of
 * the new one. The new run then starts from an empty directory at the same
 * path.
 *
 * When the host has flock(1), the script holds `.stage.lock` for its whole
 * duration (waiting at most 30 s for it), and it marks the slot as used before
 * it changes anything in it.
 */
export function buildSshReusableWorkspaceStageScript(input: {
  baseRemoteDir: string;
  key: string;
  runId: string;
}): string {
  const runtimeDir = sshRuntimeDir(input.baseRemoteDir);
  const runsRoot = sshRunsRootDir(input.baseRemoteDir);
  const runDir = sshRunDir(input.baseRemoteDir, input.runId);
  const slotDir = sshReusableWorkspaceSlotDir(input.baseRemoteDir, input.key);
  return [
    "set -e",
    `runs=${shellQuote(runsRoot)}`,
    `slot=${shellQuote(slotDir)}`,
    'ws="$slot/workspace"',
    `mkdir -p ${shellQuote(runtimeDir)}`,
    // Exclusive with a host cleanup of idle directories that takes this lock.
    // The lock is released when the script exits.
    "if command -v flock >/dev/null 2>&1; then",
    `  exec 9>>${shellQuote(sshStageLockPath(input.baseRemoteDir))}`,
    '  flock -w 30 9 || { echo "Timed out waiting for the SSH workspace stage lock" >&2; exit 1; }',
    "fi",
    `mkdir -p ${shellQuote(runDir)} "$slot"`,
    // Mark the slot as used before changing it; this also narrows the window
    // for a cleanup that checks the mark without taking the lock.
    'touch "$slot/.last-used"',
    'if [ -e "$ws" ] || [ -L "$ws" ]; then',
    // The recorded run id names a directory, so keep only safe characters.
    `  prev=$(head -c 128 "$slot/.last-run" 2>/dev/null | tr -cd 'A-Za-z0-9._-' || true)`,
    '  case "$prev" in ""|.*|-*) prev="unknown-$(date +%s)-$$" ;; esac',
    '  mkdir -p "$runs/$prev"',
    '  dest="$runs/$prev/workspace"',
    '  if [ -e "$dest" ] || [ -L "$dest" ]; then dest="$runs/$prev/workspace-$(date +%s)-$$"; fi',
    '  mv "$ws" "$dest"',
    "fi",
    'mkdir "$ws"',
    `printf '%s\\n' ${shellQuote(input.runId)} > "$slot/.last-run"`,
  ].join("\n");
}
