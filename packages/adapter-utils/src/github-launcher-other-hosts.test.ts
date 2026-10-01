import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource, otherHostGitCredentialConfig } from "./github-launcher.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Entry = [key: string, value: string];

/** GIT_CONFIG_COUNT/KEY/VALUE variables for `entries`; an explicit count, or null for none. */
function gitConfigEnv(entries: Entry[], count: string | null = String(entries.length)): Record<string, string> {
  const env: Record<string, string> = count === null ? {} : { GIT_CONFIG_COUNT: count };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** The GIT_CONFIG entries a process would apply, in order. */
function gitConfigEntries(env: Record<string, string | undefined>): Entry[] {
  const count = Number(env.GIT_CONFIG_COUNT || "0");
  return Array.from({ length: count }, (_, index) =>
    [env[`GIT_CONFIG_KEY_${index}`] ?? "<missing>", env[`GIT_CONFIG_VALUE_${index}`] ?? "<missing>"] as Entry);
}

/** The test runner's own environment without any inherited Git command configuration. */
function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG")));
}

// A helper that answers only `get`, reading the token from the environment.
const tokenHelper = (variable: string) => `!f() { test "$1" = get && echo "password=$${variable}"; }; f`;

const kept: Entry[] = [
  ["credential.https://gitlab.com.helper", tokenHelper("OTHER_HOST_TOKEN")],
  ["credential.https://gitlab.com.username", "oauth2"],
  ["Credential.HTTPS://Git.Example.ORG:8443/group/repo.git.UseHttpPath", "true"],
  ["credential.https://ci-bot@git.example.org/.helper", "cache"],
  // Only github.com itself and its subdomains are GitHub hosts.
  ["credential.https://github.com.example.net.helper", "store"],
  ["credential.http://git.example.org.username", "reader"],
];

const dropped: Entry[] = [
  ["credential.helper", "!f() { echo password=unscoped; }; f"],
  ["credential.https://github.com.helper", "!f() { echo password=github; }; f"],
  ["credential.https://www.github.com.username", "someone"],
  ["credential.https://GitHub.COM.:443/org/repo.helper", "store"],
  ["credential.https://gist.github.com.helper", "store"],
  ["credential.https://user@github.com.helper", "store"],
  ["credential.https://*.com.helper", "store"],
  ["credential.https://*.example.org.helper", "store"],
  ["credential.https://git%68ub.com.helper", "store"],
  ["credential.https://.helper", "store"],
  ["credential.https://.username", "someone"],
  ["credential.gitlab.com.helper", "store"],
  ["credential.ssh://gitlab.com.helper", "store"],
  ["credential.https://gitlab.com.interactive", "false"],
  ["credential.https://gitlab.com/\nhost=github.com.helper", "store"],
  ["url.https://gitlab.com/.insteadOf", "https://github.com/"],
  ["core.askPass", "/usr/local/bin/askpass"],
  ["http.https://gitlab.com.extraHeader", "Authorization: Bearer value"],
];

// Interleave both groups so kept entries are found at arbitrary indexes.
const mixed: Entry[] = dropped.flatMap((entry, index) => (kept[index] ? [entry, kept[index]!] : [entry]));

describe("otherHostGitCredentialConfig", () => {
  it("keeps URL-scoped credential settings for hosts other than GitHub, in order", () => {
    expect(otherHostGitCredentialConfig(gitConfigEnv(mixed))).toEqual(kept);
  });

  it.each(dropped)("drops %j", (key, value) => {
    expect(otherHostGitCredentialConfig(gitConfigEnv([[key, value]]))).toEqual([]);
  });

  it("reads only complete pairs below GIT_CONFIG_COUNT", () => {
    const env = gitConfigEnv(kept.slice(0, 4), "3");
    delete env.GIT_CONFIG_KEY_1;
    env.GIT_CONFIG_KEY_9 = "credential.https://git.example.net.helper";
    env.GIT_CONFIG_VALUE_9 = "store";
    expect(otherHostGitCredentialConfig(env)).toEqual([kept[0], kept[2]]);
    delete env.GIT_CONFIG_VALUE_2;
    expect(otherHostGitCredentialConfig(env)).toEqual([kept[0]]);
  });

  it.each([null, "", "0", "-1", " 2", "2 ", "1e1", "0x2", "2.0", "1025", "99999"])(
    "keeps nothing for GIT_CONFIG_COUNT %j",
    (count) => {
      expect(otherHostGitCredentialConfig(gitConfigEnv(kept, count))).toEqual([]);
    },
  );
});

describe("githubBrokerEnvironment", () => {
  it("clears GitHub and unscoped Git configuration but renumbers other hosts' credential settings", () => {
    const input = {
      ...gitConfigEnv([
        ["credential.https://github.com.helper", "store"],
        kept[0]!,
        ["credential.helper", "store"],
        kept[1]!,
      ]),
      // Beyond the count: inert for Git, and must stay inert.
      GIT_CONFIG_KEY_7: "credential.https://git.example.net.helper",
      GIT_CONFIG_VALUE_7: "store",
    };
    const env = githubBrokerEnvironment(input, { url: "", token: "" });
    expect(gitConfigEntries(env)).toEqual([kept[0], kept[1]]);
    for (const index of [2, 3, 7]) {
      expect(env[`GIT_CONFIG_KEY_${index}`]).toBe("");
      expect(env[`GIT_CONFIG_VALUE_${index}`]).toBe("");
    }
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  it("still empties GIT_CONFIG_COUNT when nothing is kept", () => {
    const env = githubBrokerEnvironment(gitConfigEnv(dropped), { url: "", token: "" });
    expect(env.GIT_CONFIG_COUNT).toBe("");
    expect(Object.entries(env).filter(([key, value]) => /^GIT_CONFIG_(KEY|VALUE)_/.test(key) && value !== "")).toEqual([]);
  });
});

async function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

async function launcherFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-other-hosts-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "managed");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
  return { root, bin, git: path.join(bin, "git"), configDir: path.join(root, "gh-config") };
}

const fill = (host: string) => `protocol=https\nhost=${host}\n\n`;
// The username and password lines of `git credential fill` output.
const credentialLines = (output: string) => output.split("\n").filter((line) => /^(username|password)=/.test(line));

describe("managed git launcher with credentials for other hosts", () => {
  it("applies the same selection as otherHostGitCredentialConfig to an inherited environment", async () => {
    const fixture = await launcherFixture();
    const realBin = path.join(fixture.root, "real");
    await mkdir(realBin);
    // Stand-in for the real Git that reports the configuration it receives.
    await writeFile(path.join(realBin, "git"), `#!${process.execPath}
const env = process.env, entries = [];
for (let index = 0; index < Number(env.GIT_CONFIG_COUNT); index++) entries.push([env['GIT_CONFIG_KEY_' + index], env['GIT_CONFIG_VALUE_' + index]]);
process.stdout.write(JSON.stringify(entries));
`, { mode: 0o700 });
    const scenarios: Array<Record<string, string>> = [
      gitConfigEnv(mixed),
      { ...gitConfigEnv(kept, "3"), GIT_CONFIG_KEY_1: "core.askPass" },
      gitConfigEnv(kept, "1025"),
      gitConfigEnv(kept, "-1"),
      gitConfigEnv(kept, null),
      {},
    ];
    for (const inherited of scenarios) {
      const result = await run(fixture.git, ["config", "--list"], { cwd: fixture.root, env: {
        ...baseEnv(), ...inherited, PAPERCLIP_GITHUB_BROKER_TOKEN: "",
        GH_CONFIG_DIR: fixture.configDir, PATH: `${fixture.bin}:${realBin}:${process.env.PATH}`,
      } });
      expect(result.code, result.stderr).toBe(0);
      const entries = JSON.parse(result.stdout) as Entry[];
      // The launcher's own entries come first and still start with the helper reset.
      expect(entries[0]).toEqual(["credential.helper", ""]);
      expect(entries.slice(5)).toEqual(otherHostGitCredentialConfig(inherited));
    }
  });

  it("authenticates another host through a scoped helper while GitHub stays unauthenticated", async () => {
    const fixture = await launcherFixture();
    const inherited = {
      ...gitConfigEnv([
        ["credential.helper", "!f() { echo password=unscoped-secret; }; f"],
        ["credential.https://git.example.org.username", "oauth2"],
        ["credential.https://github.com.helper", "!f() { echo username=x; echo password=inherited-github-secret; }; f"],
        ["credential.https://git.example.org.helper", tokenHelper("OTHER_HOST_TOKEN")],
      ]),
      OTHER_HOST_TOKEN: "dummy-other-host-token",
      GH_TOKEN: "inherited-github-token",
    };
    const env = {
      ...baseEnv(), ...githubBrokerEnvironment(inherited, { url: "", token: "" }),
      GH_CONFIG_DIR: fixture.configDir, PATH: `${fixture.bin}:${process.env.PATH}`,
    };

    const other = await run(fixture.git, ["credential", "fill"], { cwd: fixture.root, env, input: fill("git.example.org") });
    expect(other.code, other.stderr).toBe(0);
    expect(credentialLines(other.stdout)).toEqual(["username=oauth2", "password=dummy-other-host-token"]);

    const github = await run(fixture.git, ["credential", "fill"], { cwd: fixture.root, env, input: fill("github.com") });
    expect(github.code).not.toBe(0);
    expect(github.stderr).toContain("terminal prompts disabled");
    expect(github.stdout + github.stderr).not.toMatch(/unscoped-secret|inherited-github-secret|inherited-github-token|dummy-other-host-token/);
  });

  it("appends other hosts' settings after brokered GitHub credentials", async () => {
    const fixture = await launcherFixture();
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: {
        PAPERCLIP_GIT_TOKEN: "managed-github-token",
        ...gitConfigEnv([
          ["credential.helper", ""],
          ["credential.https://github.com.helper", '!f() { test "$1" = get && echo username=x-access-token && echo "password=$PAPERCLIP_GIT_TOKEN"; }; f'],
        ]),
      } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const inherited = {
      ...gitConfigEnv([
        ["credential.https://git.example.org.username", "oauth2"],
        ["credential.https://git.example.org.helper", tokenHelper("OTHER_HOST_TOKEN")],
      ]),
      OTHER_HOST_TOKEN: "dummy-other-host-token",
    };
    const env = {
      ...baseEnv(), ...githubBrokerEnvironment(inherited, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      GH_CONFIG_DIR: fixture.configDir, PATH: `${fixture.bin}:${process.env.PATH}`,
    };

    const github = await run(fixture.git, ["credential", "fill"], { cwd: fixture.root, env, input: fill("github.com") });
    expect(github.code, github.stderr).toBe(0);
    expect(credentialLines(github.stdout)).toEqual(["username=x-access-token", "password=managed-github-token"]);

    const other = await run(fixture.git, ["credential", "fill"], { cwd: fixture.root, env, input: fill("git.example.org") });
    expect(other.code, other.stderr).toBe(0);
    expect(credentialLines(other.stdout)).toEqual(["username=oauth2", "password=dummy-other-host-token"]);
  });
});
