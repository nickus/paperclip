import { shouldExcludePath } from "./exclude-patterns.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";

// Git checkouts that a run creates inside a remote workspace (an agent's
// `git clone`), and the restore that must leave them out.
//
// A workspace restore that drops nested `.git` entries (see
// NESTED_GIT_EXCLUDES) would bring such a checkout back to the host as its
// working tree alone: a plain directory, frozen at the run's checkout, that
// every later run is staged with as "not a git repository". The sandbox and
// SSH restores list the checkouts in the remote workspace with
// buildListNestedGitCheckoutsCommand, parse the listing with
// parseNestedGitCheckoutList, and leave out of the host merge the checkouts
// that selectRemoteOnlyGitCheckouts returns.

// Bounds on the listing: it is remote output, so the host reads a fixed amount
// of it and acts on a fixed number of checkouts. A checkout past either bound
// is restored as before.
export const NESTED_GIT_CHECKOUT_LIST_MAX_BYTES = 64 * 1024;
export const NESTED_GIT_CHECKOUT_MAX_COUNT = 128;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Whether a restore with these excludes drops the `.git` of a nested
 * checkout, and so would split the checkout from its history. A restore that
 * keeps nested `.git` entries brings a checkout back whole.
 */
export function restoreExcludesNestedGit(exclude: readonly string[]): boolean {
  return shouldExcludePath("checkout/.git", exclude);
}

/**
 * A POSIX shell command that prints the `.git` entry of every Git checkout
 * nested in `workspaceRemoteDir` (`./<path>/.git`, NUL-terminated) to stdout.
 * It does not descend into a `.git`, the workspace's `.paperclip-runtime`, or
 * a directory named in `pruneNames`. Best effort: an unreadable directory is
 * skipped, and the output is cut at NESTED_GIT_CHECKOUT_LIST_MAX_BYTES (the
 * parser drops a cut, unterminated entry).
 */
export function buildListNestedGitCheckoutsCommand(input: {
  workspaceRemoteDir: string;
  pruneNames?: readonly string[];
}): string {
  const pruneTests = [
    "-path ./.paperclip-runtime",
    ...(input.pruneNames ?? []).map((name) => `-name ${shellQuote(name)}`),
  ].join(" -o ");
  return (
    `cd -- ${shellQuote(input.workspaceRemoteDir)} && ` +
    `{ find . -mindepth 1 \\( ${pruneTests} \\) -prune -o -name .git -prune -print0 2>/dev/null; true; } | ` +
    `head -c ${NESTED_GIT_CHECKOUT_LIST_MAX_BYTES}`
  );
}

/**
 * The workspace-relative directory of each checkout in a listing printed by
 * buildListNestedGitCheckoutsCommand. Only NUL-terminated `./<path>/.git`
 * entries count, so the workspace root's own `.git` and an entry cut by the
 * size bound are dropped. So is a path with an empty, `.` or `..` segment, or
 * with a glob character: each result becomes a literal restore exclude.
 */
export function parseNestedGitCheckoutList(listing: string): string[] {
  const entries = listing.split("\0");
  entries.pop();
  const checkouts = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith("./") || !entry.endsWith("/.git")) continue;
    const relative = entry.slice(2, -"/.git".length);
    if (!relative || /[*?[\\]/.test(relative)) continue;
    if (relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) continue;
    checkouts.add(relative);
  }
  return [...checkouts];
}

/**
 * The listed checkouts the restore leaves out of the host merge. A checkout at
 * a path the host staged (one in `baseline`), or at one the restore already
 * leaves out, is kept: a host directory that the run turned into a repository
 * still holds host work and is restored as before. The host baseline holds
 * nothing under a returned path, so leaving it out of the merge never deletes
 * host files.
 */
export function selectRemoteOnlyGitCheckouts(
  listed: readonly string[],
  baseline: DirectorySnapshot,
  restoreExclude: readonly string[],
): string[] {
  return listed
    .filter((relative) => !baseline.entries.has(relative) && !shouldExcludePath(relative, restoreExclude))
    .slice(0, NESTED_GIT_CHECKOUT_MAX_COUNT);
}

/** The run-log line that names the checkouts a restore left out. */
export function describeUnrestoredGitCheckouts(checkouts: readonly string[], location: string): string {
  return (
    `[paperclip] Git checkouts created in the ${location} were not restored to the workspace, ` +
    `because their Git history cannot leave the ${location}: ${JSON.stringify(checkouts)}. ` +
    `Push their work to a remote to keep it. To give every run a checkout of a repository, ` +
    `add it to the project.\n`
  );
}
