import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Large JSON payloads must never travel in a child process's argv or env.
 *
 * Linux rejects any single argv or env string longer than MAX_ARG_STRLEN
 * (32 pages, 128 KiB) and the whole argv + env block beyond ARG_MAX, and it
 * does so with E2BIG before the program starts. Such a launch fails the same
 * way on every attempt, yet the failure looks like a transient spawn error.
 *
 * The wake payload itself travels in the prompt. The JSON variables that
 * adapters still export (PAPERCLIP_ENV_PAYLOAD_KEYS) stay inline whenever a
 * launch can carry them, so a reader that only knows the inline variable sees
 * exactly what it saw before for every launch that used to start. Only a
 * value above ENV_PAYLOAD_INLINE_MAX_BYTES, too large to pass inline, is
 * written to a private file on the machine that runs the process (mode 0600
 * in a 0700 directory); the variable is then replaced by `<NAME>_FILE`
 * (`PAPERCLIP_WORKSPACES_FILE`, ...) holding that file's path. The process
 * still gets the whole value instead of failing to start. readPaperclipEnvPayload
 * reads either form.
 *
 * assertProcessEnvelopeWithinLimits is the last-resort guard for everything
 * else, including prompts passed as command-line arguments: it names the
 * offending variable or argument (never its value) instead of letting the
 * kernel fail the spawn with an opaque E2BIG.
 */

/** A single argv or env string must stay below Linux's 128 KiB MAX_ARG_STRLEN. */
export const PROCESS_SINGLE_STRING_MAX_BYTES = 120 * 1024;
/**
 * Payload variables above this size are delivered as files. It sits just
 * below the single-string guard (leaving room for the `NAME=` prefix), so a
 * value moves to a file only when it could not have been passed inline.
 */
export const ENV_PAYLOAD_INLINE_MAX_BYTES = PROCESS_SINGLE_STRING_MAX_BYTES - 1024;
/** argv + env together must stay well below the common 2 MiB ARG_MAX. */
export const PROCESS_TOTAL_MAX_BYTES = 1.5 * 1024 * 1024;
/** Run error code for a process whose argv/env would exceed the kernel limits. */
export const ADAPTER_ENV_TOO_LARGE_ERROR_CODE = "adapter_env_too_large";

/** JSON payload variables that Paperclip may move from env into a file. */
export const PAPERCLIP_ENV_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "PAPERCLIP_WORKSPACES_JSON",
  "PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON",
  "PAPERCLIP_RUNTIME_SERVICES_JSON",
]);

const PAYLOAD_KEY_SET = new Set(PAPERCLIP_ENV_PAYLOAD_KEYS);
const POINTER_BYTES = 8;
const PAYLOAD_DIR_PREFIX = "paperclip-env-";

export function isPaperclipEnvPayloadKey(key: string): boolean {
  return PAYLOAD_KEY_SET.has(key);
}

/** `PAPERCLIP_WORKSPACES_JSON` -> `PAPERCLIP_WORKSPACES_FILE`. */
export function paperclipEnvPayloadFileKey(key: string): string {
  return key.endsWith("_JSON") ? `${key.slice(0, -"_JSON".length)}_FILE` : `${key}_FILE`;
}

function payloadFileName(key: string): string {
  const base = key.endsWith("_JSON") ? key.slice(0, -"_JSON".length) : key;
  return `${base.toLowerCase().replace(/_/g, "-")}.json`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// ---------------------------------------------------------------------------
// Last-resort size guard
// ---------------------------------------------------------------------------

export interface ProcessEnvelopeEntry {
  kind: "argument" | "environment";
  /** `argv[3]` for an argument, the variable name for an env entry. */
  name: string;
  bytes: number;
}

export interface ProcessEnvelopeMeasurement {
  /** Bytes the kernel copies for argv + env, including pointers and NULs. */
  totalBytes: number;
  largest: ProcessEnvelopeEntry | null;
}

export function measureProcessEnvelope(input: {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}): ProcessEnvelopeMeasurement {
  let totalBytes = 0;
  let largest: ProcessEnvelopeEntry | null = null;
  const consider = (entry: ProcessEnvelopeEntry) => {
    totalBytes += entry.bytes + POINTER_BYTES;
    if (!largest || entry.bytes > largest.bytes) largest = entry;
  };
  // argv[0] is the command itself; each string carries its NUL terminator.
  consider({ kind: "argument", name: "argv[0]", bytes: byteLength(input.command) + 1 });
  input.args.forEach((arg, index) => {
    consider({ kind: "argument", name: `argv[${index + 1}]`, bytes: byteLength(arg) + 1 });
  });
  for (const [key, value] of Object.entries(input.env)) {
    if (typeof value !== "string") continue;
    // "KEY=value\0"
    consider({ kind: "environment", name: key, bytes: byteLength(key) + byteLength(value) + 2 });
  }
  return { totalBytes, largest };
}

export interface AdapterEnvTooLargeDetails {
  /**
   * `single_string` / `total`: the guard refused to start the process.
   * `rejected`: the operating system refused it (E2BIG) below the guard's limits.
   */
  reason: "single_string" | "total" | "rejected";
  /** Where the process would have started, e.g. "local", "ssh", "sandbox". */
  location: string;
  /** The largest argv/env entry. Names only; values are never recorded. */
  largest: ProcessEnvelopeEntry | null;
  totalBytes: number;
  limitBytes: number;
}

export class AdapterEnvTooLargeError extends Error {
  readonly code = ADAPTER_ENV_TOO_LARGE_ERROR_CODE;
  readonly details: AdapterEnvTooLargeDetails;

  constructor(details: AdapterEnvTooLargeDetails) {
    const largest = details.largest;
    const subject = largest
      ? largest.kind === "environment"
        ? `environment variable ${largest.name}`
        : `command-line ${largest.name}`
      : "the command line";
    const advice = "Large data must be passed as a file or over stdin.";
    const message =
      details.reason === "single_string"
        ? `${ADAPTER_ENV_TOO_LARGE_ERROR_CODE}: ${subject} is ${largest?.bytes ?? 0} bytes; ` +
          `a single argument or environment string must stay under ${details.limitBytes} bytes, ` +
          `so the ${details.location} process was not started. ${advice}`
        : details.reason === "total"
          ? `${ADAPTER_ENV_TOO_LARGE_ERROR_CODE}: arguments and environment total ${details.totalBytes} bytes ` +
            `(largest: ${subject}, ${largest?.bytes ?? 0} bytes); the limit is ${details.limitBytes} bytes, ` +
            `so the ${details.location} process was not started. ${advice}`
          : `${ADAPTER_ENV_TOO_LARGE_ERROR_CODE}: the operating system refused to start the ${details.location} ` +
            `process because its arguments and environment are too large (E2BIG; total ${details.totalBytes} bytes, ` +
            `largest: ${subject}, ${largest?.bytes ?? 0} bytes). ${advice}`;
    super(message);
    this.name = "AdapterEnvTooLargeError";
    this.details = details;
  }
}

export function isAdapterEnvTooLargeError(error: unknown): boolean {
  if (error instanceof AdapterEnvTooLargeError) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === ADAPTER_ENV_TOO_LARGE_ERROR_CODE) return true;
  return typeof record.message === "string" && record.message.startsWith(`${ADAPTER_ENV_TOO_LARGE_ERROR_CODE}:`);
}

/** True for a kernel "argument list too long" failure (E2BIG), local or remote. */
export function isArgumentListTooLongError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  if (record.code === "E2BIG") return true;
  return typeof record.message === "string" && /\bE2BIG\b|argument list too long/i.test(record.message);
}

/**
 * Throws AdapterEnvTooLargeError when argv + env would exceed the kernel
 * limits. Call it right before a process starts, with the exact command, args
 * and env it will receive.
 */
export function assertProcessEnvelopeWithinLimits(input: {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  location: string;
  singleStringMaxBytes?: number;
  totalMaxBytes?: number;
}): ProcessEnvelopeMeasurement {
  const singleLimit = input.singleStringMaxBytes ?? PROCESS_SINGLE_STRING_MAX_BYTES;
  const totalLimit = input.totalMaxBytes ?? PROCESS_TOTAL_MAX_BYTES;
  const measurement = measureProcessEnvelope(input);
  if (measurement.largest && measurement.largest.bytes > singleLimit) {
    throw new AdapterEnvTooLargeError({
      reason: "single_string",
      location: input.location,
      largest: measurement.largest,
      totalBytes: measurement.totalBytes,
      limitBytes: singleLimit,
    });
  }
  if (measurement.totalBytes > totalLimit) {
    throw new AdapterEnvTooLargeError({
      reason: "total",
      location: input.location,
      largest: measurement.largest,
      totalBytes: measurement.totalBytes,
      limitBytes: totalLimit,
    });
  }
  return measurement;
}

// ---------------------------------------------------------------------------
// Moving large payload variables into files
// ---------------------------------------------------------------------------

export interface OversizedEnvPayload {
  key: string;
  fileKey: string;
  fileName: string;
  bytes: number;
}

/** Payload variables in `env` whose value exceeds `inlineMaxBytes`. */
export function findOversizedEnvPayloads(
  env: Readonly<Record<string, string | undefined>>,
  inlineMaxBytes: number = ENV_PAYLOAD_INLINE_MAX_BYTES,
): OversizedEnvPayload[] {
  const oversized: OversizedEnvPayload[] = [];
  for (const key of PAPERCLIP_ENV_PAYLOAD_KEYS) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const bytes = byteLength(value);
    if (bytes <= inlineMaxBytes) continue;
    oversized.push({ key, fileKey: paperclipEnvPayloadFileKey(key), fileName: payloadFileName(key), bytes });
  }
  return oversized;
}

/**
 * Drops oversized payload variables. For probes (`command -v`, version
 * checks) that never read the payload, so no file has to be written.
 */
export function omitOversizedEnvPayloads<T extends Record<string, string>>(
  env: T,
  inlineMaxBytes: number = ENV_PAYLOAD_INLINE_MAX_BYTES,
): T {
  const oversized = findOversizedEnvPayloads(env, inlineMaxBytes);
  if (oversized.length === 0) return env;
  const next = { ...env } as Record<string, string>;
  for (const payload of oversized) delete next[payload.key];
  return next as T;
}

/** Where payload files are written: this host or the execution target. */
export interface EnvPayloadFileStore {
  readonly location: "local" | "remote";
  /**
   * Creates a new private directory (0700), writes each file into it (0600)
   * and returns the directory's absolute path on the machine that runs the
   * process.
   */
  writeFiles(files: ReadonlyArray<{ name: string; content: string }>): Promise<string>;
  /** Best effort; never throws. */
  removeDirectory(dir: string): Promise<void>;
}

export interface ExternalizedEnvPayloads {
  /** The env to hand to the process: oversized payloads replaced by `<NAME>_FILE`. */
  env: Record<string, string>;
  files: Array<OversizedEnvPayload & { path: string }>;
  /** Directory holding the files on the machine that runs the process, if any. */
  directory: string | null;
  /** Removes the files. Call after the process has exited; never throws. */
  cleanup(): Promise<void>;
}

const NOOP_CLEANUP = async () => {};

/**
 * A run-log line per payload that was moved into a file, so an operator can
 * see why the process has `<NAME>_FILE` instead of `<NAME>_JSON`. Names and
 * sizes only; never the value or the path's contents.
 */
export function describeExternalizedEnvPayloads(files: ReadonlyArray<OversizedEnvPayload>): string {
  return files
    .map(
      (file) =>
        `[paperclip] ${file.key} is ${file.bytes} bytes, too large to pass inline; ` +
        `the process reads it from the file named by ${file.fileKey}.\n`,
    )
    .join("");
}

/**
 * The shared helper every adapter's process launch goes through: moves each
 * oversized payload variable of `env` into a file in `store` and replaces it
 * with `<NAME>_FILE`. Small payloads stay inline, so this is a no-op (and does
 * no I/O) for typical runs. The input env is not mutated.
 */
export async function externalizeEnvPayloads(
  env: Readonly<Record<string, string>>,
  store: EnvPayloadFileStore | (() => EnvPayloadFileStore),
  options: { inlineMaxBytes?: number } = {},
): Promise<ExternalizedEnvPayloads> {
  const oversized = findOversizedEnvPayloads(env, options.inlineMaxBytes);
  if (oversized.length === 0) {
    return { env: { ...env }, files: [], directory: null, cleanup: NOOP_CLEANUP };
  }
  const resolvedStore = typeof store === "function" ? store() : store;
  const directory = await resolvedStore.writeFiles(
    oversized.map((payload) => ({ name: payload.fileName, content: env[payload.key] ?? "" })),
  );
  const join = resolvedStore.location === "local" ? path.join : path.posix.join;
  const next: Record<string, string> = { ...env };
  const files = oversized.map((payload) => {
    const filePath = join(directory, payload.fileName);
    delete next[payload.key];
    next[payload.fileKey] = filePath;
    return { ...payload, path: filePath };
  });
  let cleaned = false;
  return {
    env: next,
    files,
    directory,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await resolvedStore.removeDirectory(directory);
    },
  };
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Payload files on this host. `baseDir` is typically the run's scratch
 * directory (removed with the run); the OS temp directory otherwise.
 */
export function createLocalEnvPayloadFileStore(baseDir?: string | null): EnvPayloadFileStore {
  return {
    location: "local",
    async writeFiles(files) {
      const base =
        baseDir && path.isAbsolute(baseDir) && isExistingDirectory(baseDir) ? baseDir : os.tmpdir();
      // mkdtemp creates the directory with mode 0700.
      const dir = await fs.mkdtemp(path.join(base, PAYLOAD_DIR_PREFIX));
      try {
        for (const file of files) {
          await fs.writeFile(path.join(dir, file.name), file.content, { mode: 0o600, flag: "wx" });
        }
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return dir;
    },
    async removeDirectory(dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type EnvPayloadShellExec = (
  script: string,
  stdin: string,
) => Promise<{ exitCode?: number | null; stdout: string; stderr?: string; timedOut?: boolean }>;

/**
 * Payload files on a remote target reached through a POSIX shell (an SSH host
 * or a sandbox). Each file's content goes over the command's stdin, never on a
 * command line. `baseDir` should be an absolute directory private to the run
 * (e.g. its scratch directory); without one the target's `$TMPDIR` (or /tmp)
 * is used. The script is kept on one line because an SSH login shell parses it
 * first.
 */
export function createShellEnvPayloadFileStore(
  exec: EnvPayloadShellExec,
  baseDir?: string | null,
): EnvPayloadFileStore {
  const describeFailure = (result: { exitCode?: number | null; stderr?: string; timedOut?: boolean }) =>
    result.timedOut
      ? "timed out"
      : `exit code ${result.exitCode ?? "unknown"}${result.stderr?.trim() ? `: ${result.stderr.trim().split(/\r?\n/)[0]}` : ""}`;
  return {
    location: "remote",
    async writeFiles(files) {
      if (files.length === 0) throw new Error("No payload files to write");
      const nonce = randomBytes(12).toString("hex");
      const base =
        baseDir && baseDir.startsWith("/") ? posixShellQuote(baseDir) : '"${TMPDIR:-/tmp}"';
      let dir: string | null = null;
      for (const [index, file] of files.entries()) {
        const script =
          index === 0
            ? [
                "umask 077",
                `__pc_base=${base}`,
                'mkdir -p -- "$__pc_base"',
                `__pc_dir="$__pc_base/${PAYLOAD_DIR_PREFIX}${nonce}"`,
                // Plain mkdir: never reuse a directory someone else created.
                'mkdir -- "$__pc_dir"',
                `cat > "$__pc_dir/${file.name}"`,
                "printf '%s\\n' \"$__pc_dir\"",
              ].join(" && ")
            : `umask 077 && cat > ${posixShellQuote(`${dir}/${file.name}`)}`;
        const result = await exec(script, file.content);
        if (result.timedOut || (result.exitCode ?? 0) !== 0) {
          if (dir) await exec(`rm -rf -- ${posixShellQuote(dir)}`, "").catch(() => undefined);
          throw new Error(`Could not write the ${file.name} payload file on the execution target (${describeFailure(result)}).`);
        }
        if (index === 0) {
          const reported = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1);
          if (!reported || !reported.startsWith("/") || !reported.endsWith(`/${PAYLOAD_DIR_PREFIX}${nonce}`)) {
            throw new Error(`Could not locate the ${file.name} payload file on the execution target.`);
          }
          dir = reported;
        }
      }
      return dir!;
    },
    async removeDirectory(dir) {
      if (!dir.startsWith("/") || !path.posix.basename(dir).startsWith(PAYLOAD_DIR_PREFIX)) return;
      await exec(`rm -rf -- ${posixShellQuote(dir)}`, "").catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Reads a Paperclip payload variable in either delivery form: the inline
 * `<NAME>_JSON` value, or the file named by `<NAME>_FILE`. Returns null when
 * neither is present or the file cannot be read.
 */
export function readPaperclipEnvPayload(
  key: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const inline = env[key];
  if (typeof inline === "string" && inline.length > 0) return inline;
  const filePath = env[paperclipEnvPayloadFileKey(key)];
  if (typeof filePath !== "string" || filePath.length === 0 || !existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
