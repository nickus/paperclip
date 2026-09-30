import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { APPLEDOUBLE_EXCLUDES, NESTED_GIT_EXCLUDES } from "./exclude-patterns.js";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  buildListNestedGitCheckoutsCommand,
  NESTED_GIT_CHECKOUT_MAX_COUNT,
  parseNestedGitCheckoutList,
  restoreExcludesNestedGit,
  selectRemoteOnlyGitCheckouts,
} from "./nested-git-checkouts.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";

const execFileAsync = promisify(execFile);

describe("nested Git checkouts in a remote workspace", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("lists every nested checkout outside the pruned directories", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-nested-checkouts-"));
    cleanupDirs.push(workspaceDir);
    // The workspace's own `.git`, checkouts at several depths (one of them a
    // worktree-style `.git` file), and `.git` entries the listing must skip.
    for (const dir of [".git/modules/inner/.git", "service/.git", "libs/client/.git", "with space/.git"]) {
      await mkdir(path.join(workspaceDir, dir), { recursive: true });
    }
    for (const dir of ["node_modules/pkg/.git", ".paperclip-runtime/adapter/.git"]) {
      await mkdir(path.join(workspaceDir, dir), { recursive: true });
    }
    await mkdir(path.join(workspaceDir, "tools", "linked"), { recursive: true });
    await writeFile(path.join(workspaceDir, "tools", "linked", ".git"), "gitdir: ../../.git/worktrees/linked\n", "utf8");

    const { stdout } = await execFileAsync("sh", [
      "-c",
      buildListNestedGitCheckoutsCommand({ workspaceRemoteDir: workspaceDir, pruneNames: ["node_modules"] }),
    ]);

    expect(parseNestedGitCheckoutList(stdout).sort()).toEqual(["libs/client", "service", "tools/linked", "with space"]);
  });

  it("splits a checkout from its history only in a restore that drops nested .git entries", () => {
    // A Git-backed workspace's restore, as the SSH and sandbox runtimes build it.
    expect(restoreExcludesNestedGit([
      ...GIT_ARCHIVE_EXCLUDES,
      ...NESTED_GIT_EXCLUDES,
      ...APPLEDOUBLE_EXCLUDES,
      ".paperclip-runtime",
    ])).toBe(true);
    // A plain workspace's restore brings a nested checkout back whole.
    expect(restoreExcludesNestedGit([...APPLEDOUBLE_EXCLUDES, ".paperclip-runtime"])).toBe(false);
    expect(restoreExcludesNestedGit([...GIT_ARCHIVE_EXCLUDES])).toBe(false);
  });

  it("leaves out only checkouts at paths the host neither staged nor excludes, up to a fixed count", () => {
    const baseline: DirectorySnapshot = {
      exclude: [],
      entries: new Map([
        ["docs", { kind: "dir" }],
        ["docs/guide.md", { kind: "file", mode: 0o644, hash: "0" }],
      ]),
    };
    expect(selectRemoteOnlyGitCheckouts(["docs", "service", "cache/repo"], baseline, ["cache"])).toEqual(["service"]);

    const many = Array.from({ length: NESTED_GIT_CHECKOUT_MAX_COUNT + 5 }, (_, index) => `repo-${index}`);
    expect(selectRemoteOnlyGitCheckouts(many, baseline, [])).toHaveLength(NESTED_GIT_CHECKOUT_MAX_COUNT);
  });
});
