import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// A stand-in pod: the mocked `Exec.exec` runs the exact argv that execInPod
// would hand to the Kubernetes exec API, on a local shell, and feeds it the
// exact stdin bytes execInPod streams. That proves end to end that the env
// reaches the command and the caller's stdin is untouched, while the argv the
// pod would see carries no env value.
type StatusCb = (status: {
  status: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

const pod = vi.hoisted(() => ({
  commands: [] as string[][],
  // Replaces argv[0] ("/bin/sh") to run the same script under another shell.
  shell: null as string[] | null,
}));

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      pod.commands.push(command);
      const argv = pod.shell && command[0] === "/bin/sh" ? [...pod.shell, ...command.slice(1)] : command;
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (stdin && child.stdin) {
        // The pod's command may exit before reading all of stdin.
        child.stdin.on("error", () => undefined);
        stdin.pipe(child.stdin);
      }
      child.stdout.pipe(stdout);
      child.stderr.pipe(stderr);
      child.on("close", (code) => {
        statusCb(
          code === 0
            ? { status: "Success" }
            : { status: "Failure", details: { causes: [{ reason: "ExitCode", message: String(code) }] } },
        );
      });
      return { close() {} };
    }
  }
  return { Exec };
});

const { execInPod, wrapCommandWithEnv } = await import("../../src/pod-exec.js");

const KC = {} as never;

async function runInPod(command: string[], env: Record<string, string> | undefined, stdin?: string) {
  const wrapped = wrapCommandWithEnv(command, env, stdin);
  pod.commands.length = 0;
  const result = await execInPod(
    KC,
    "ns",
    "pod",
    "agent",
    wrapped.command,
    wrapped.stdin,
    10_000,
    undefined,
    undefined,
    { keepaliveIntervalMs: 0 },
  );
  expect(pod.commands).toHaveLength(1);
  return { ...result, argv: pod.commands[0]! };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SECRET = "test-secret-0123456789abcdef";
// Values that stress the prologue: quotes, a newline, a value that looks like
// the line-count header, shell syntax that must stay inert, and non-ASCII.
const TRICKY = {
  QUOTED: "a'b\"c",
  MULTILINE: "line one\nline two\n",
  LOOKS_LIKE_HEADER: "3\n",
  INERT: "$(echo pwned) `echo pwned` ; exit 9",
  UNICODE: "grüße ✓",
};

describe("wrapCommandWithEnv", () => {
  it("returns the command and stdin unchanged when there is no env", () => {
    expect(wrapCommandWithEnv(["opencode", "run"], undefined)).toEqual({ command: ["opencode", "run"], stdin: undefined });
    expect(wrapCommandWithEnv(["opencode", "run"], {}, "prompt")).toEqual({ command: ["opencode", "run"], stdin: "prompt" });
  });

  it("keeps every env value out of the command line and sends it over stdin", () => {
    const out = wrapCommandWithEnv(
      ["opencode", "run", "--model", "anthropic/x"],
      { XDG_CONFIG_HOME: "/tmp/cfg", ANTHROPIC_API_KEY: SECRET, ...TRICKY },
      "the prompt",
    );
    const argv = out.command.join("\0");
    expect(occurrences(argv, SECRET)).toBe(0);
    expect(occurrences(argv, "/tmp/cfg")).toBe(0);
    for (const value of Object.values(TRICKY)) {
      expect(occurrences(argv, value)).toBe(0);
    }
    const stdin = Buffer.from(out.stdin as Buffer).toString("utf-8");
    expect(occurrences(stdin, SECRET)).toBe(1);
    expect(stdin.endsWith("the prompt")).toBe(true);
    expect(out.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(out.command[2]).toContain("exec 'opencode' 'run' '--model' 'anthropic/x'");
  });

  it("never propagates PATH (would break command resolution in the sandbox image)", () => {
    const out = wrapCommandWithEnv(["opencode"], { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" });
    const stdin = Buffer.from(out.stdin as Buffer).toString("utf-8");
    expect(stdin).not.toContain("PATH=");
    expect(stdin).toContain("export XDG_CONFIG_HOME='/c'");
  });

  it("skips invalid identifiers and non-string values", () => {
    const out = wrapCommandWithEnv(["opencode"], {
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    const stdin = Buffer.from(out.stdin as Buffer).toString("utf-8");
    expect(stdin).toContain("export GOOD_KEY='y'");
    expect(stdin).not.toContain("BAD-KEY");
    expect(stdin).not.toContain("NUMERIC");
    expect(wrapCommandWithEnv(["opencode"], { "BAD-KEY": "x", PATH: "/p" })).toEqual({ command: ["opencode"], stdin: undefined });
  });
});

const hasBash = existsSync("/bin/bash") || existsSync("/usr/bin/bash");
const shells: Array<[string, string[] | null, boolean]> = [
  ["/bin/sh", null, true],
  ["bash in POSIX mode", ["bash", "--posix"], hasBash],
  ["bash", ["bash"], hasBash],
];

describe.each(shells)("env over stdin through execInPod (%s)", (_label, shell, available) => {
  const maybeIt = available ? it : it.skip;
  const withShell = async <T>(fn: () => Promise<T>) => {
    pod.shell = shell;
    try {
      return await fn();
    } finally {
      pod.shell = null;
    }
  };

  maybeIt("delivers the env and the caller's stdin, and the pod's argv carries no value", async () => {
    const env = { ANTHROPIC_API_KEY: SECRET, ...TRICKY };
    const script =
      'for v in "$ANTHROPIC_API_KEY" "$QUOTED" "$MULTILINE" "$LOOKS_LIKE_HEADER" "$INERT" "$UNICODE"; do printf "[%s]" "$v"; done; printf "|"; cat';
    const payload = "caller stdin\nsecond line\n";
    const result = await withShell(() => runInPod(["sh", "-c", script], env, payload));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const expectedValues = [SECRET, ...Object.values(TRICKY)].map((value) => `[${value}]`).join("");
    expect(result.stdout).toBe(`${expectedValues}|${payload}`);
    const argv = result.argv.join("\0");
    for (const value of [SECRET, ...Object.values(TRICKY)]) {
      expect(occurrences(argv, value)).toBe(0);
    }
  });

  maybeIt("gives a command that reads stdin an immediate EOF when the caller sent none", async () => {
    const result = await withShell(() => runInPod(["sh", "-c", "cat; echo \"done:$TOKEN\""], { TOKEN: SECRET }));
    expect(result).toMatchObject({ exitCode: 0, stdout: `done:${SECRET}\n`, stderr: "" });
    expect(occurrences(result.argv.join("\0"), SECRET)).toBe(0);
  });

  maybeIt("keeps the command's exit status and does not export the reader's own variables", async () => {
    const result = await withShell(() =>
      runInPod(["sh", "-c", 'env | grep -c "^__pc_env" ; exit 7'], { TOKEN: SECRET }),
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toBe("0");
  });
});
