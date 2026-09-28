import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTER_ENV_TOO_LARGE_ERROR_CODE,
  AdapterEnvTooLargeError,
  ENV_PAYLOAD_INLINE_MAX_BYTES,
  PROCESS_SINGLE_STRING_MAX_BYTES,
  PROCESS_TOTAL_MAX_BYTES,
  assertProcessEnvelopeWithinLimits,
  createLocalEnvPayloadFileStore,
  createShellEnvPayloadFileStore,
  externalizeEnvPayloads,
  isAdapterEnvTooLargeError,
  isArgumentListTooLongError,
  omitOversizedEnvPayloads,
  paperclipEnvPayloadFileKey,
  readPaperclipEnvPayload,
  type EnvPayloadShellExec,
} from "./env-payload.js";
import { runChildProcess, type RunProcessResult } from "./server-utils.js";
import {
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** A workspace-hints payload well above the 128 KiB single-string kernel limit. */
function largePayload(bytes = 400 * 1024): string {
  const items = [];
  let size = 0;
  for (let index = 0; size < bytes; index += 1) {
    const notes = `workspace ${index} `.padEnd(2_000, "x");
    items.push({ workspaceId: `w${index}`, cwd: `/work/${index}`, notes });
    size += notes.length + 40;
  }
  return JSON.stringify(items);
}

/** Runs a shell script locally, the way an SSH host or a sandbox would. */
const localShellExec: EnvPayloadShellExec = (script, stdin) =>
  new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    // A script that exits without reading stdin (e.g. `rm -rf`) closes the pipe.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });

describe("process envelope guard", () => {
  it("names an oversized variable without printing its value", () => {
    const secretLookingValue = "v".repeat(PROCESS_SINGLE_STRING_MAX_BYTES + 10);
    let caught: unknown;
    try {
      assertProcessEnvelopeWithinLimits({
        command: "claude",
        args: ["--print"],
        env: { PATH: "/usr/bin", LARGE_BLOB: secretLookingValue },
        location: "local",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterEnvTooLargeError);
    const error = caught as AdapterEnvTooLargeError;
    expect(error.code).toBe(ADAPTER_ENV_TOO_LARGE_ERROR_CODE);
    expect(error.message).toMatch(/^adapter_env_too_large: environment variable LARGE_BLOB is \d+ bytes/);
    expect(error.message).not.toContain("vvvvvvvvvv");
    expect(error.details).toMatchObject({ reason: "single_string", largest: { kind: "environment", name: "LARGE_BLOB" } });
    expect(isAdapterEnvTooLargeError(error)).toBe(true);
    expect(isAdapterEnvTooLargeError(new Error(error.message))).toBe(true);
  });

  it("rejects an oversized command-line argument and an oversized total", () => {
    expect(() =>
      assertProcessEnvelopeWithinLimits({
        command: "sh",
        args: ["-c", "x".repeat(PROCESS_SINGLE_STRING_MAX_BYTES + 1)],
        env: {},
        location: "sandbox",
      }),
    ).toThrow(/command-line argv\[2\]/);
    const env: Record<string, string> = {};
    for (let index = 0; index * 100 * 1024 <= PROCESS_TOTAL_MAX_BYTES; index += 1) {
      env[`CHUNK_${index}`] = "y".repeat(100 * 1024);
    }
    expect(() => assertProcessEnvelopeWithinLimits({ command: "sh", args: [], env, location: "ssh" })).toThrow(
      /adapter_env_too_large: arguments and environment total \d+ bytes/,
    );
  });

  it("accepts ordinary environments and recognizes kernel E2BIG errors", () => {
    expect(() =>
      assertProcessEnvelopeWithinLimits({
        command: "claude",
        args: ["--print", "--verbose"],
        env: { PAPERCLIP_WORKSPACES_JSON: "x".repeat(ENV_PAYLOAD_INLINE_MAX_BYTES) },
        location: "local",
      }),
    ).not.toThrow();
    expect(isArgumentListTooLongError(Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }))).toBe(true);
    expect(isArgumentListTooLongError(new Error("sh: 1: claude: Argument list too long"))).toBe(true);
    expect(isArgumentListTooLongError(new Error("spawn ENOENT"))).toBe(false);
  });
});

describe("externalizeEnvPayloads", () => {
  it("keeps small payloads inline and does no I/O", async () => {
    const store = {
      location: "local" as const,
      writeFiles: async () => {
        throw new Error("must not write");
      },
      removeDirectory: async () => {},
    };
    const env = { PAPERCLIP_WORKSPACES_JSON: '[{"cwd":"/work"}]', PATH: "/usr/bin" };
    const result = await externalizeEnvPayloads(env, store);
    expect(result.env).toEqual(env);
    expect(result.files).toEqual([]);
    expect(result.directory).toBeNull();
  });

  it("moves an oversized payload into a private local file and removes it on cleanup", async () => {
    const scratch = await tempDir("paperclip-env-payload-scratch-");
    const payload = largePayload();
    const result = await externalizeEnvPayloads(
      { PAPERCLIP_WORKSPACES_JSON: payload, PAPERCLIP_TASK_ID: "task-1" },
      createLocalEnvPayloadFileStore(scratch),
    );
    expect(result.env.PAPERCLIP_WORKSPACES_JSON).toBeUndefined();
    expect(result.env.PAPERCLIP_TASK_ID).toBe("task-1");
    const filePath = result.env.PAPERCLIP_WORKSPACES_FILE!;
    expect(path.dirname(path.dirname(filePath))).toBe(scratch);
    expect(await readFile(filePath, "utf8")).toBe(payload);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    expect(readPaperclipEnvPayload("PAPERCLIP_WORKSPACES_JSON", result.env)).toBe(payload);
    await result.cleanup();
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(path.dirname(filePath))).toBe(false);
  });

  it("writes payload files on a remote target over stdin and removes them", async () => {
    const remoteScratch = await tempDir("paperclip-env-payload-remote-");
    const scripts: string[] = [];
    const recordingExec: EnvPayloadShellExec = async (script, stdin) => {
      scripts.push(script);
      return localShellExec(script, stdin);
    };
    const services = largePayload();
    const workspaces = JSON.stringify([{ cwd: "/w", notes: "n".repeat(ENV_PAYLOAD_INLINE_MAX_BYTES + 1) }]);
    const result = await externalizeEnvPayloads(
      { PAPERCLIP_RUNTIME_SERVICES_JSON: services, PAPERCLIP_WORKSPACES_JSON: workspaces },
      createShellEnvPayloadFileStore(recordingExec, remoteScratch),
    );
    expect(Object.keys(result.env).sort()).toEqual(["PAPERCLIP_RUNTIME_SERVICES_FILE", "PAPERCLIP_WORKSPACES_FILE"]);
    expect(await readFile(result.env.PAPERCLIP_RUNTIME_SERVICES_FILE!, "utf8")).toBe(services);
    expect(await readFile(result.env.PAPERCLIP_WORKSPACES_FILE!, "utf8")).toBe(workspaces);
    expect((await stat(result.env.PAPERCLIP_RUNTIME_SERVICES_FILE!)).mode & 0o777).toBe(0o600);
    expect((await stat(result.directory!)).mode & 0o777).toBe(0o700);
    // The content never appears on a command line.
    for (const script of scripts) expect(script.length).toBeLessThan(1_000);
    await result.cleanup();
    expect(existsSync(result.directory!)).toBe(false);
  });

  it("fails loudly when the remote write fails", async () => {
    const failingExec: EnvPayloadShellExec = async () => ({ exitCode: 1, stdout: "", stderr: "No space left on device" });
    await expect(
      externalizeEnvPayloads(
        { PAPERCLIP_WORKSPACES_JSON: largePayload() },
        createShellEnvPayloadFileStore(failingExec, "/tmp"),
      ),
    ).rejects.toThrow(/Could not write the paperclip-workspaces\.json payload file on the execution target \(exit code 1: No space left on device\)/);
  });

  it("leaves oversized payloads out for probes", () => {
    const env = { PAPERCLIP_WORKSPACES_JSON: largePayload(), PAPERCLIP_RUN_ID: "run-1" };
    expect(omitOversizedEnvPayloads(env)).toEqual({ PAPERCLIP_RUN_ID: "run-1" });
    const small = { PAPERCLIP_WORKSPACES_JSON: "[]" };
    expect(omitOversizedEnvPayloads(small)).toBe(small);
  });
});

describe("payload readers", () => {
  it("read the inline form and the file form alike", async () => {
    const dir = await tempDir("paperclip-env-payload-reader-");
    const payload = JSON.stringify([{ workspaceId: "w1", cwd: "/work" }]);
    const filePath = path.join(dir, "workspaces.json");
    await writeFile(filePath, payload, "utf8");
    expect(paperclipEnvPayloadFileKey("PAPERCLIP_WORKSPACES_JSON")).toBe("PAPERCLIP_WORKSPACES_FILE");
    expect(readPaperclipEnvPayload("PAPERCLIP_WORKSPACES_JSON", { PAPERCLIP_WORKSPACES_JSON: payload })).toBe(payload);
    expect(readPaperclipEnvPayload("PAPERCLIP_WORKSPACES_JSON", { PAPERCLIP_WORKSPACES_FILE: filePath })).toBe(payload);
    expect(
      readPaperclipEnvPayload("PAPERCLIP_WORKSPACES_JSON", { PAPERCLIP_WORKSPACES_FILE: path.join(dir, "missing.json") }),
    ).toBeNull();
    expect(readPaperclipEnvPayload("PAPERCLIP_WORKSPACES_JSON", {})).toBeNull();
  });
});

const READ_PAYLOAD_SCRIPT = [
  "const fs = require('node:fs');",
  "const file = process.env.PAPERCLIP_WORKSPACES_FILE;",
  "const text = process.env.PAPERCLIP_WORKSPACES_JSON ?? (file ? fs.readFileSync(file, 'utf8') : '');",
  "process.stdout.write(JSON.stringify({ inline: 'PAPERCLIP_WORKSPACES_JSON' in process.env, file: file ?? null, items: JSON.parse(text).length }));",
].join(" ");

describe("runChildProcess with an oversized payload variable", () => {
  it("delivers the payload as a file to a local process and removes the file afterwards", async () => {
    const scratch = await tempDir("paperclip-env-payload-run-");
    const payload = largePayload();
    const result = await runChildProcess("env-payload-local", process.execPath, ["-e", READ_PAYLOAD_SCRIPT], {
      cwd: scratch,
      env: { PAPERCLIP_WORKSPACES_JSON: payload, PAPERCLIP_RUN_SCRATCH_DIR: scratch },
      timeoutSec: 30,
      graceSec: 5,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const seen = JSON.parse(result.stdout) as { inline: boolean; file: string; items: number };
    expect(seen.inline).toBe(false);
    expect(seen.items).toBe(JSON.parse(payload).length);
    expect(seen.file.startsWith(`${scratch}${path.sep}`)).toBe(true);
    expect(existsSync(seen.file)).toBe(false);
  });

  it("fails with adapter_env_too_large instead of E2BIG for other oversized variables", async () => {
    const dir = await tempDir("paperclip-env-payload-guard-");
    await expect(
      runChildProcess("env-payload-guard", process.execPath, ["-e", "process.exit(0)"], {
        cwd: dir,
        env: { SOME_TOOL_CONFIG: "z".repeat(200 * 1024) },
        timeoutSec: 30,
        graceSec: 5,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/^adapter_env_too_large: environment variable SOME_TOOL_CONFIG is \d+ bytes/);
  });
});

describe("sandbox targets with an oversized payload variable", () => {
  function createRecordingSandbox(rootDir: string) {
    const calls: Array<{ command: string; args: string[]; envKeys: string[]; envBytes: number }> = [];
    const runner = {
      execute: async (input: {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
      }): Promise<RunProcessResult> => {
        const env = input.env ?? {};
        calls.push({
          command: input.command,
          args: input.args ?? [],
          envKeys: Object.keys(env).sort(),
          envBytes: Object.entries(env).reduce((sum, [key, value]) => sum + key.length + value.length, 0),
        });
        const command = input.command === "sh" || input.command === "bash" ? "/bin/sh" : input.command;
        const startedAt = new Date().toISOString();
        return await new Promise<RunProcessResult>((resolve, reject) => {
          const child = spawn(command, input.args ?? [], {
            cwd: input.cwd ?? rootDir,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += String(chunk)));
          child.stderr.on("data", (chunk) => (stderr += String(chunk)));
          child.on("error", reject);
          child.on("close", (code, signal) =>
            resolve({ exitCode: code, signal, timedOut: false, stdout, stderr, pid: child.pid ?? null, startedAt }),
          );
          child.stdin.on("error", () => {});
          child.stdin.end(input.stdin ?? "");
        });
      },
    };
    return { runner, calls };
  }

  it("writes the payload inside the sandbox and passes only its path", async () => {
    const rootDir = await tempDir("paperclip-env-payload-sandbox-");
    const { runner, calls } = createRecordingSandbox(rootDir);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };
    const payload = largePayload();
    const result = await runAdapterExecutionTargetProcess("env-payload-sandbox", target, process.execPath, ["-e", READ_PAYLOAD_SCRIPT], {
      cwd: rootDir,
      env: { PAPERCLIP_WORKSPACES_JSON: payload },
      timeoutSec: 30,
      graceSec: 5,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    const seen = JSON.parse(result.stdout) as { inline: boolean; file: string; items: number };
    expect(seen).toMatchObject({ inline: false, items: JSON.parse(payload).length });
    const agentCall = calls.find((call) => call.command === process.execPath)!;
    expect(agentCall.envKeys).toContain("PAPERCLIP_WORKSPACES_FILE");
    expect(agentCall.envKeys).not.toContain("PAPERCLIP_WORKSPACES_JSON");
    expect(agentCall.envBytes).toBeLessThan(4 * 1024);
    // Written before the agent starts, removed after it exits.
    expect(calls[0]!.args.join(" ")).toContain("cat >");
    expect(calls.at(-1)!.args.join(" ")).toContain("rm -rf");
    expect(existsSync(seen.file)).toBe(false);
  });

  it("does not stage payload files for helper shell commands", async () => {
    const rootDir = await tempDir("paperclip-env-payload-sandbox-shell-");
    const { runner, calls } = createRecordingSandbox(rootDir);
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "local-test",
      remoteCwd: rootDir,
      timeoutMs: 30_000,
      runner,
    };
    const result = await runAdapterExecutionTargetShellCommand("env-payload-shell", target, "command -v sh", {
      cwd: rootDir,
      env: { PAPERCLIP_WORKSPACES_JSON: largePayload(), PAPERCLIP_RUN_ID: "run-1" },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.envKeys).toEqual(["PAPERCLIP_RUN_ID"]);
  });
});
