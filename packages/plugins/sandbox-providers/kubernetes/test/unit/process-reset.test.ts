import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROCESS_RESET_SCRIPT,
  buildProcessResetCommand,
  resetSandboxProcesses,
} from "../../src/process-reset.js";

const execFileAsync = promisify(execFile);

// The script is run for real by the system /bin/sh against a fake /proc tree.
// The fake `kill` records its arguments and removes the signalled entries
// (unless the entry is marked to survive that signal).
const FAKE_KILL = `#!/bin/sh
sig=$1; shift
echo "$sig $*" >> "$FAKE_PROC/../kill.log"
for p in "$@"; do
  if [ -e "$FAKE_PROC/$p/survive$sig" ]; then continue; fi
  rm -rf "$FAKE_PROC/$p"
done
`;

const SELF = "990";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

interface FakeProcess {
  pid: number;
  comm: string;
  state?: string;
  ppid: number;
  argv: string[];
  survive?: Array<"-TERM" | "-KILL">;
}

async function fakeProc(processes: FakeProcess[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "process-reset-"));
  roots.push(root);
  const proc = path.join(root, "proc");
  await mkdir(proc);
  for (const p of processes) {
    const dir = path.join(proc, String(p.pid));
    await mkdir(dir);
    await writeFile(path.join(dir, "stat"), `${p.pid} (${p.comm}) ${p.state ?? "S"} ${p.ppid} 1 1 0\n`);
    await writeFile(path.join(dir, "cmdline"), p.argv.map((arg) => `${arg}\0`).join(""));
    for (const sig of p.survive ?? []) await writeFile(path.join(dir, `survive${sig}`), "");
  }
  const kill = path.join(root, "kill.sh");
  await writeFile(kill, FAKE_KILL);
  await chmod(kill, 0o755);
  return { root, proc, kill };
}

async function runReset(fake: { proc: string; kill: string }) {
  const [shell, ...args] = buildProcessResetCommand({
    procRoot: fake.proc,
    killCommand: fake.kill,
    termWaitSec: 1,
    selfPid: SELF,
  });
  try {
    const { stdout, stderr } = await execFileAsync(shell!, args, { env: { ...process.env, FAKE_PROC: fake.proc } });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

// PID 1 is tini running `/bin/sh -c "sleep infinity"` (the sandbox keepalive).
const KEEPALIVE: FakeProcess[] = [
  { pid: 1, comm: "tini", ppid: 0, argv: ["/usr/bin/tini", "--", "/bin/sh", "-c", "sleep infinity"] },
  { pid: 7, comm: "sh", ppid: 1, argv: ["/bin/sh", "-c", "sleep infinity"] },
  { pid: 8, comm: "sleep", ppid: 7, argv: ["sleep", "infinity"] },
];

describe("process reset script", () => {
  it("stops the run's leftovers and keeps the keepalive chain, itself and zombies", async () => {
    const fake = await fakeProc([
      ...KEEPALIVE,
      // The agent CLI exec'd by the host, with a child; a comm with spaces and parens.
      { pid: 20, comm: "node (agent) x", ppid: 0, argv: ["node", "agent.js"] },
      { pid: 21, comm: "bash", ppid: 20, argv: ["bash", "-c", "make"] },
      // A background dev server orphaned to PID 1: not a keepalive, so it goes.
      { pid: 30, comm: "sh", ppid: 1, argv: ["sh", "-c", "npm run dev"] },
      { pid: 31, comm: "defunct", state: "Z", ppid: 1, argv: [] },
      // The script itself and a helper it spawned.
      { pid: Number(SELF), comm: "sh", ppid: 0, argv: ["/bin/sh", "-c", "..."] },
      { pid: 991, comm: "tr", ppid: Number(SELF), argv: ["tr"] },
    ]);

    const result = await runReset(fake);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("paperclip-process-reset: ok stopped=3");
    expect((await readFile(path.join(fake.root, "kill.log"), "utf8")).trim()).toBe("-TERM 20 21 30");
    expect((await readdir(fake.proc)).sort()).toEqual(["1", "31", "7", "8", "990", "991"]);
  });

  it("escalates to KILL for a process that ignores TERM", async () => {
    const fake = await fakeProc([
      ...KEEPALIVE,
      { pid: 40, comm: "stubborn", ppid: 1, argv: ["stubborn"], survive: ["-TERM"] },
    ]);

    const result = await runReset(fake);

    expect(result.exitCode).toBe(0);
    expect((await readFile(path.join(fake.root, "kill.log"), "utf8")).trim().split("\n")).toEqual([
      "-TERM 40",
      "-KILL 40",
    ]);
  });

  it("fails when a process survives KILL, so the lease is torn down instead", async () => {
    const fake = await fakeProc([
      ...KEEPALIVE,
      { pid: 50, comm: "stuck", state: "D", ppid: 0, argv: ["stuck"], survive: ["-TERM", "-KILL"] },
    ]);

    const result = await runReset(fake);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("remaining= 50");
  }, 15_000);

  it("reports ok without signalling anything when only the keepalive runs", async () => {
    const fake = await fakeProc(KEEPALIVE);
    const result = await runReset(fake);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stopped=0");
  });
});

describe("resetSandboxProcesses", () => {
  it("runs the script with default arguments in production", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "paperclip-process-reset: ok stopped=2\n", stderr: "" }));
    await expect(resetSandboxProcesses(exec)).resolves.toEqual({
      ok: true,
      detail: "paperclip-process-reset: ok stopped=2",
      execFailed: false,
    });
    expect(exec).toHaveBeenCalledWith(
      ["/bin/sh", "-c", PROCESS_RESET_SCRIPT, "paperclip-process-reset"],
      15_000,
    );
  });

  it("treats a non-zero exit, missing confirmation or exec error as unverified", async () => {
    await expect(
      resetSandboxProcesses(async () => ({ exitCode: 1, stdout: "", stderr: "paperclip-process-reset: failed remaining= 5" })),
    ).resolves.toMatchObject({ ok: false, execFailed: false });
    await expect(resetSandboxProcesses(async () => ({ exitCode: 0, stdout: "", stderr: "" }))).resolves.toMatchObject({
      ok: false,
      execFailed: false,
    });
    await expect(
      resetSandboxProcesses(async () => {
        throw new Error("exec connection dropped");
      }),
    ).resolves.toEqual({ ok: false, detail: "exec connection dropped", execFailed: true });
  });
});
