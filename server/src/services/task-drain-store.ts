import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * The on-disk copy of a task drain started with `persistAcrossRestart`.
 *
 * A task drain lives in process memory, so a restart normally ends it. That
 * is the right default for a drain that exists only to let active runs finish
 * before a restart. An operator who also needs the new process to hold run
 * admission (for example, to check an upgrade before any agent starts work)
 * asks for that explicitly; the drain is then saved next to the other durable
 * instance state, and server startup applies it again before it schedules any
 * work. Stopping the drain removes the file.
 */
export type SavedTaskDrain = {
  startedAt: Date;
  expiresAt: Date | null;
};

const SAVED_TASK_DRAIN_VERSION = 1;

export function resolveTaskDrainStatePath(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "data", "task-drain.json");
}

export async function saveTaskDrain(
  drain: SavedTaskDrain,
  filePath: string = resolveTaskDrainStatePath(),
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify({
    version: SAVED_TASK_DRAIN_VERSION,
    startedAt: drain.startedAt.toISOString(),
    expiresAt: drain.expiresAt?.toISOString() ?? null,
  });
  // Write a sibling file and rename it over the target, so a crash mid-write
  // never leaves a truncated file for the next startup to read.
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${body}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

/** Remove the saved drain. Returns false when there was none. */
export async function clearSavedTaskDrain(
  filePath: string = resolveTaskDrainStatePath(),
): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type LoadedTaskDrain =
  | { kind: "none" }
  | { kind: "expired"; drain: SavedTaskDrain }
  | { kind: "active"; drain: SavedTaskDrain }
  | { kind: "unreadable"; drain: SavedTaskDrain; error: string };

/**
 * Read the drain a previous process saved. An expired drain is removed. A
 * file that exists but cannot be read or parsed still names an operator's
 * explicit hold, so it fails closed: the caller gets an open-ended drain
 * starting now, which a stop request clears along with the file.
 */
export async function loadSavedTaskDrain(
  now: Date = new Date(),
  filePath: string = resolveTaskDrainStatePath(),
): Promise<LoadedTaskDrain> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return {
      kind: "unreadable",
      drain: { startedAt: now, expiresAt: null },
      error: (err as NodeJS.ErrnoException).code ?? "read_failed",
    };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  const startedAt = parseDate(parsed?.startedAt);
  const expiresAt = parsed?.expiresAt === null ? null : parseDate(parsed?.expiresAt);
  if (
    !parsed ||
    parsed.version !== SAVED_TASK_DRAIN_VERSION ||
    !startedAt ||
    (parsed.expiresAt !== null && !expiresAt)
  ) {
    return {
      kind: "unreadable",
      drain: { startedAt: now, expiresAt: null },
      error: "malformed",
    };
  }

  const drain = { startedAt, expiresAt };
  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    // An expired drain holds nothing, so a failed removal must not stop the
    // server from starting; the next startup tries again.
    await clearSavedTaskDrain(filePath).catch(() => false);
    return { kind: "expired", drain };
  }
  return { kind: "active", drain };
}

type StartupLogger = {
  warn(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
};

/**
 * Server startup: apply the drain a previous process saved, before anything
 * can schedule work. Returns what it found.
 */
export async function restoreSavedTaskDrainOnStartup(input: {
  applyTaskDrain: (drain: SavedTaskDrain & { persistAcrossRestart: true }) => void;
  logger: StartupLogger;
  now?: Date;
  filePath?: string;
}): Promise<LoadedTaskDrain["kind"]> {
  const saved = await loadSavedTaskDrain(input.now, input.filePath);
  if (saved.kind === "active" || saved.kind === "unreadable") {
    input.applyTaskDrain({ ...saved.drain, persistAcrossRestart: true });
    input.logger.warn(
      {
        startedAt: saved.drain.startedAt,
        expiresAt: saved.drain.expiresAt,
        ...(saved.kind === "unreadable" ? { savedStateError: saved.error } : {}),
      },
      saved.kind === "unreadable"
        ? "saved task drain could not be read; holding run admission until the drain is stopped"
        : "restored the saved task drain; run admission stays held until the drain is stopped",
    );
  } else if (saved.kind === "expired") {
    input.logger.info(
      { expiresAt: saved.drain.expiresAt },
      "removed an expired saved task drain",
    );
  }
  return saved.kind;
}
