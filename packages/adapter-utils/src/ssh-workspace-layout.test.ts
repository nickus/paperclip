import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshReusableWorkspaceStageScript,
  isSshRunIdPathSegment,
  isSshWorkspaceReuseKey,
  remoteRunGitHubLauncherDir,
  sshReusableWorkspaceDir,
  sshReusableWorkspaceSlotDir,
  sshRunDir,
  sshRunScratchDir,
  sshRunsRootDir,
  sshRuntimeDir,
  sshStageLockPath,
} from "./ssh-workspace-layout.js";

const KEY = "0123456789abcdef0123456789abcdef";

function hasFlock(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v flock"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The stage script is plain POSIX sh, so it runs against a local directory
// exactly as it runs on the SSH host.
async function runScript(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("sh", ["-c", script], (error, _stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve();
    });
  });
}

describe("ssh workspace layout", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeBase(): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-layout-"));
    cleanupDirs.push(base);
    return base;
  }

  it("validates reuse keys and run id path segments", () => {
    expect(isSshWorkspaceReuseKey(KEY)).toBe(true);
    expect(isSshWorkspaceReuseKey(KEY.toUpperCase())).toBe(false);
    expect(isSshWorkspaceReuseKey(`${KEY}0`)).toBe(false);
    expect(isSshWorkspaceReuseKey("../../etc")).toBe(false);
    expect(isSshWorkspaceReuseKey(null)).toBe(false);

    expect(isSshRunIdPathSegment("3f0c2a1e-5b7d-4c8e-9f10-112233445566")).toBe(true);
    expect(isSshRunIdPathSegment("run-1")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "../x", "x..y", "-rf", ".hidden", "a b"]) {
      expect(isSshRunIdPathSegment(bad)).toBe(false);
    }
  });

  it("derives the per-run and stable paths under the runtime directory", () => {
    expect(sshRunsRootDir("/home/agent/work")).toBe("/home/agent/work/.paperclip-runtime/runs");
    expect(sshRunDir("/home/agent/work", "run-1")).toBe("/home/agent/work/.paperclip-runtime/runs/run-1");
    expect(sshRunScratchDir("/home/agent/work", "run-1")).toBe(
      "/home/agent/work/.paperclip-runtime/runs/run-1/scratch",
    );
    expect(sshReusableWorkspaceSlotDir("/home/agent/work", KEY)).toBe(
      `/home/agent/work/.paperclip-runtime/workspaces/${KEY}`,
    );
    expect(sshReusableWorkspaceDir("/home/agent/work", KEY)).toBe(
      `/home/agent/work/.paperclip-runtime/workspaces/${KEY}/workspace`,
    );
    expect(remoteRunGitHubLauncherDir("/home/agent/work", "run-1")).toBe(
      "/home/agent/work/.paperclip-runtime/github/run-1",
    );
    expect(() => sshRunScratchDir("/w", "../x")).toThrow();
    expect(() => remoteRunGitHubLauncherDir("/w", "../x")).toThrow();
    expect(() => sshReusableWorkspaceDir("/w", "../x")).toThrow();
  });

  it("stages the same workspace path for consecutive runs and moves the previous contents aside", async () => {
    const base = await makeBase();
    const workspace = sshReusableWorkspaceDir(base, KEY);
    const slot = sshReusableWorkspaceSlotDir(base, KEY);

    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-1" }));
    expect((await stat(workspace)).isDirectory()).toBe(true);
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(path.join(slot, ".last-run"), "utf8")).toBe("run-1\n");
    expect((await stat(path.join(slot, ".last-used"))).isFile()).toBe(true);
    expect((await stat(sshRunDir(base, "run-1"))).isDirectory()).toBe(true);

    await writeFile(path.join(workspace, "notes.md"), "from run 1\n", "utf8");

    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-2" }));
    // Same path, fresh contents; run 1's files now live under its run directory.
    expect(await readdir(workspace)).toEqual([]);
    expect(await readFile(path.join(sshRunDir(base, "run-1"), "workspace", "notes.md"), "utf8")).toBe(
      "from run 1\n",
    );
    expect(await readFile(path.join(slot, ".last-run"), "utf8")).toBe("run-2\n");
  });

  it("recreates a removed previous run directory and never overwrites an existing moved copy", async () => {
    const base = await makeBase();
    const workspace = sshReusableWorkspaceDir(base, KEY);

    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-1" }));
    await writeFile(path.join(workspace, "a.txt"), "a\n", "utf8");
    // The run-directory GC already removed run 1.
    await rm(sshRunDir(base, "run-1"), { recursive: true, force: true });
    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-2" }));
    expect(await readFile(path.join(sshRunDir(base, "run-1"), "workspace", "a.txt"), "utf8")).toBe("a\n");

    // A retried stage of the same run finds its own moved copy in place.
    await writeFile(path.join(workspace, "b.txt"), "b\n", "utf8");
    await mkdir(path.join(sshRunDir(base, "run-2"), "workspace"), { recursive: true });
    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-3" }));
    const run2Entries = await readdir(sshRunDir(base, "run-2"));
    const movedCopy = run2Entries.find((entry) => entry.startsWith("workspace-"));
    expect(movedCopy).toBeDefined();
    expect(await readFile(path.join(sshRunDir(base, "run-2"), movedCopy!, "b.txt"), "utf8")).toBe("b\n");
  });

  it.skipIf(!hasFlock())("waits for the stage lock that a host cleanup holds", async () => {
    const base = await makeBase();
    const slot = sshReusableWorkspaceSlotDir(base, KEY);
    await mkdir(sshRuntimeDir(base), { recursive: true });

    // Stand-in for a cleanup: holds the lock, then reports whether the slot
    // appeared while it held it.
    const holder = spawn(
      "flock",
      [sshStageLockPath(base), "sh", "-c", 'echo held; sleep 1; if [ -e "$1" ]; then echo slot-present; else echo slot-absent; fi', "sh", slot],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let holderOutput = "";
    const held = new Promise<void>((resolve) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        holderOutput += chunk.toString("utf8");
        if (holderOutput.includes("held")) resolve();
      });
    });
    const holderDone = new Promise<number | null>((resolve) => holder.on("close", resolve));
    await held;

    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-1" }));
    expect(await holderDone).toBe(0);
    expect(holderOutput).toContain("slot-absent");
    expect((await stat(sshReusableWorkspaceDir(base, KEY))).isDirectory()).toBe(true);
    expect((await stat(path.join(slot, ".last-used"))).isFile()).toBe(true);
  });

  it("keeps a tampered .last-run record inside the runs directory", async () => {
    const base = await makeBase();
    const workspace = sshReusableWorkspaceDir(base, KEY);
    const slot = sshReusableWorkspaceSlotDir(base, KEY);

    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-1" }));
    await writeFile(path.join(workspace, "c.txt"), "c\n", "utf8");
    await writeFile(path.join(slot, ".last-run"), "../../outside\n", "utf8");
    await runScript(buildSshReusableWorkspaceStageScript({ baseRemoteDir: base, key: KEY, runId: "run-2" }));

    expect(await readdir(base)).toEqual([".paperclip-runtime"]);
    const runs = await readdir(sshRunsRootDir(base));
    const orphan = runs.find((entry) => entry.startsWith("unknown-"));
    expect(orphan).toBeDefined();
    expect(await readFile(path.join(sshRunsRootDir(base), orphan!, "workspace", "c.txt"), "utf8")).toBe("c\n");
  });
});
