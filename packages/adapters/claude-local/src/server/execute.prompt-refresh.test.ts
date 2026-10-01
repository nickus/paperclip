import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

// Stands in for the Claude CLI: answers --help with `cli.helpText`, records
// every real invocation, and keeps the session id of a --resume.
const { cli, runAdapterExecutionTargetProcess } = vi.hoisted(() => {
  const cli = {
    helpText: "",
    helpCalls: 0,
    runs: [] as string[][],
    // The prompt (stdin) of each run, in the same order.
    prompts: [] as string[],
    freshSessions: 0,
    // When set, a --resume fails as if the CLI had lost the session.
    loseResumedSession: false,
  };
  const ok = (stdout: string): RunProcessResult => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  });
  const runAdapterExecutionTargetProcess = vi.fn(
    async (
      _runId: string,
      _target: unknown,
      _command: string,
      args: string[],
      options?: { stdin?: string },
    ): Promise<RunProcessResult> => {
      if (args.includes("--help")) {
        cli.helpCalls += 1;
        return ok(cli.helpText);
      }
      if (args.includes("--version")) return ok("2.1.283 (Claude Code)\n");
      cli.runs.push(args);
      cli.prompts.push(options?.stdin ?? "");
      const resumeIndex = args.indexOf("--resume");
      const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
      if (resumed && cli.loseResumedSession) {
        return {
          ...ok(JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: `No conversation found with session ID: ${resumed}`,
          })),
          exitCode: 1,
        };
      }
      cli.freshSessions += resumed ? 0 : 1;
      const sessionId = resumed ?? `00000000-0000-4000-8000-${String(cli.freshSessions).padStart(12, "0")}`;
      return ok([
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
        JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: "done" }] } }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: sessionId,
          result: "done",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"));
    },
  );
  return { cli, runAdapterExecutionTargetProcess };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { withPaperclipWakeSessionConfigChanges } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";

const HELP_WITH_SNAPSHOT = [
  "Usage: claude [options] [command] [prompt]",
  "  --append-system-prompt-file <file>  Append a system prompt file",
  "  --system-prompt-snapshot <on|off>   Record the system prompt once per conversation",
].join("\n");
const HELP_WITHOUT_SNAPSHOT = [
  "Usage: claude [options] [command] [prompt]",
  "  --append-system-prompt-file <file>  Append a system prompt file",
].join("\n");

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

describe("claude_local resume after an instructions change", () => {
  let root: string;
  let workspace: string;
  let instructionsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-prompt-refresh-"));
    workspace = path.join(root, "workspace");
    instructionsPath = path.join(root, "AGENTS.md");
    await mkdir(workspace, { recursive: true });
    vi.stubEnv("HOME", root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "");
    cli.helpText = HELP_WITH_SNAPSHOT;
    cli.helpCalls = 0;
    cli.runs = [];
    cli.prompts = [];
    cli.freshSessions = 0;
    cli.loseResumedSession = false;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    await rm(root, { recursive: true, force: true });
  });

  // One heartbeat with the given instructions; the session params go through
  // the codec both ways, as they do when the server stores them.
  async function run(input: {
    instructions: string;
    sessionParams: Record<string, unknown> | null;
    config?: Record<string, unknown>;
    context?: Record<string, unknown>;
  }) {
    await writeFile(instructionsPath, input.instructions, "utf8");
    const logs: string[] = [];
    const runsBefore = cli.runs.length;
    const result = await execute({
      runId: `run-${runsBefore + 1}`,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: sessionCodec.deserialize(sessionCodec.serialize(input.sessionParams)),
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "claude",
        cwd: workspace,
        instructionsFilePath: instructionsPath,
        promptTemplate: "Continue your work.",
        ...input.config,
      },
      context: input.context ?? {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    const args = cli.runs[cli.runs.length - 1] ?? [];
    const instructionsFile = argValue(args, "--append-system-prompt-file");
    return {
      result,
      args,
      attempts: cli.runs.length - runsBefore,
      prompt: cli.prompts[cli.prompts.length - 1] ?? "",
      log: logs.join(""),
      instructionsSent: instructionsFile ? await readFile(instructionsFile, "utf8") : null,
    };
  }

  it("resumes on the recorded prompt and passes the current instructions again while they are unchanged", async () => {
    const first = await run({ instructions: "Version one.\n", sessionParams: null });
    const second = await run({ instructions: "Version one.\n", sessionParams: first.result.sessionParams ?? null });

    expect(argValue(second.args, "--resume")).toBe(first.result.sessionId);
    // A plain resume keeps the recorded system prompt, so the prompt cache holds.
    expect(second.args).not.toContain("--system-prompt-snapshot");
    // The instructions still go along, for the prompt rendered after the
    // conversation is compacted, and so does the current skills directory.
    expect(second.instructionsSent).toContain("Version one.");
    expect(argValue(second.args, "--add-dir")).toBeTruthy();
    expect(second.log).not.toContain("without passing the agent instructions again");
    expect(cli.helpCalls).toBe(1);
    expect(second.result.sessionParams).not.toHaveProperty("promptSnapshotBundleKey");
    expect(second.result.sessionParams?.promptBundleKey).toBe(first.result.sessionParams?.promptBundleKey);
  });

  it("keeps a plain resume without the instructions file when the CLI does not advertise the snapshot flag", async () => {
    cli.helpText = HELP_WITHOUT_SNAPSHOT;
    const first = await run({ instructions: "Version one.\n", sessionParams: null });
    const second = await run({ instructions: "Version one.\n", sessionParams: first.result.sessionParams ?? null });

    expect(argValue(second.args, "--resume")).toBe(first.result.sessionId);
    expect(second.args).not.toContain("--system-prompt-snapshot");
    expect(second.args).not.toContain("--append-system-prompt-file");
    const notice =
      `[paperclip] Resuming Claude session "${first.result.sessionId}" without passing the agent instructions again: ` +
      "the Claude CLI does not advertise --system-prompt-snapshot.";
    expect(second.log.split(notice)).toHaveLength(2);
    // A new session does not need the notice.
    expect(first.log).not.toContain("without passing the agent instructions again");
  });

  it("keeps a plain resume without the instructions file when the CLI support cannot be confirmed", async () => {
    const config = { command: "/opt/tools/claude-wrapper" };
    const first = await run({ instructions: "Version one.\n", sessionParams: null, config });
    const second = await run({ instructions: "Version one.\n", sessionParams: first.result.sessionParams ?? null, config });

    expect(argValue(second.args, "--resume")).toBe(first.result.sessionId);
    expect(second.args).not.toContain("--append-system-prompt-file");
    expect(second.log).toContain(
      "without passing the agent instructions again: could not confirm that the Claude CLI supports --system-prompt-snapshot.",
    );
  });

  it("does not probe the CLI for a plain resume without instructions to pass", async () => {
    const config = { instructionsFilePath: "", paperclipRuntimeSkills: [] };
    const first = await run({ instructions: "Version one.\n", sessionParams: null, config });
    const second = await run({ instructions: "Version one.\n", sessionParams: first.result.sessionParams ?? null, config });

    expect(argValue(second.args, "--resume")).toBe(first.result.sessionId);
    expect(second.args).not.toContain("--append-system-prompt-file");
    expect(second.log).not.toContain("without passing the agent instructions again");
    expect(cli.helpCalls).toBe(0);
  });

  it("keeps the session and runs on the new instructions when the CLI supports the snapshot flag", async () => {
    const first = await run({ instructions: "Version one.\n", sessionParams: null });
    const second = await run({ instructions: "Version two.\n", sessionParams: first.result.sessionParams ?? null });

    expect(argValue(second.args, "--resume")).toBe(first.result.sessionId);
    expect(argValue(second.args, "--system-prompt-snapshot")).toBe("off");
    expect(second.instructionsSent).toContain("Version two.");
    expect(argValue(second.args, "--add-dir")).toBeTruthy();
    expect(second.log).toContain(
      `[paperclip] Instructions or skills changed since Claude session "${first.result.sessionId}"; resuming it with the current versions.`,
    );
    const firstKey = first.result.sessionParams?.promptBundleKey;
    expect(second.result.sessionParams?.promptBundleKey).not.toBe(firstKey);
    // The session's recorded prompt still holds the first bundle.
    expect(second.result.sessionParams?.promptSnapshotBundleKey).toBe(firstKey);
  });

  it("starts a fresh session when the CLI does not advertise the snapshot flag", async () => {
    cli.helpText = HELP_WITHOUT_SNAPSHOT;
    const first = await run({ instructions: "Version one.\n", sessionParams: null });
    const second = await run({ instructions: "Version two.\n", sessionParams: first.result.sessionParams ?? null });

    expect(second.args).not.toContain("--resume");
    expect(second.args).not.toContain("--system-prompt-snapshot");
    expect(second.instructionsSent).toContain("Version two.");
    expect(second.result.sessionId).not.toBe(first.result.sessionId);
    expect(second.log).toContain("will not be resumed with");
    expect(second.log).toContain("does not advertise --system-prompt-snapshot");
    expect(second.result.sessionParams).not.toHaveProperty("promptSnapshotBundleKey");
  });

  it("starts a fresh session when the CLI support cannot be confirmed", async () => {
    const first = await run({
      instructions: "Version one.\n",
      sessionParams: null,
      config: { command: "/opt/tools/claude-wrapper" },
    });
    const second = await run({
      instructions: "Version two.\n",
      sessionParams: first.result.sessionParams ?? null,
      config: { command: "/opt/tools/claude-wrapper" },
    });

    expect(second.args).not.toContain("--resume");
    expect(second.args).not.toContain("--system-prompt-snapshot");
    expect(second.log).toContain("could not confirm that the Claude CLI supports --system-prompt-snapshot");
  });

  it("starts a fresh session when resetSessionOnPromptChange is set", async () => {
    const config = { resetSessionOnPromptChange: true };
    const first = await run({ instructions: "Version one.\n", sessionParams: null, config });
    const second = await run({ instructions: "Version two.\n", sessionParams: first.result.sessionParams ?? null, config });

    expect(second.args).not.toContain("--resume");
    expect(second.args).not.toContain("--system-prompt-snapshot");
    expect(second.instructionsSent).toContain("Version two.");
    expect(second.log).toContain("resetSessionOnPromptChange is enabled");
    expect(cli.helpCalls).toBe(0);
  });

  it("keeps refreshing across later runs and repeated changes until the recorded bundle matches again", async () => {
    const v1 = await run({ instructions: "Version one.\n", sessionParams: null });
    const sessionId = v1.result.sessionId;
    const v1Key = v1.result.sessionParams?.promptBundleKey;

    const v2 = await run({ instructions: "Version two.\n", sessionParams: v1.result.sessionParams ?? null });
    // Same instructions as the previous run, but the session's recorded prompt
    // is still version one, so a plain resume would replay it.
    const v2Again = await run({ instructions: "Version two.\n", sessionParams: v2.result.sessionParams ?? null });
    const v3 = await run({ instructions: "Version three.\n", sessionParams: v2Again.result.sessionParams ?? null });

    for (const step of [v2, v2Again, v3]) {
      expect(argValue(step.args, "--resume")).toBe(sessionId);
      expect(argValue(step.args, "--system-prompt-snapshot")).toBe("off");
      expect(step.result.sessionParams?.promptSnapshotBundleKey).toBe(v1Key);
    }
    expect(v2Again.instructionsSent).toContain("Version two.");
    expect(v3.instructionsSent).toContain("Version three.");
    expect(v3.result.sessionParams?.promptBundleKey).not.toBe(v2.result.sessionParams?.promptBundleKey);

    // Back on the recorded bundle: a plain resume runs on it again.
    const back = await run({ instructions: "Version one.\n", sessionParams: v3.result.sessionParams ?? null });
    expect(argValue(back.args, "--resume")).toBe(sessionId);
    expect(back.args).not.toContain("--system-prompt-snapshot");
    expect(back.instructionsSent).toContain("Version one.");
    expect(back.result.sessionParams?.promptBundleKey).toBe(v1Key);
    expect(back.result.sessionParams).not.toHaveProperty("promptSnapshotBundleKey");
    // One --help probe served every run.
    expect(cli.helpCalls).toBe(1);
  });

  it("records the current bundle when a refreshed resume falls back to a fresh session", async () => {
    const first = await run({ instructions: "Version one.\n", sessionParams: null });
    cli.loseResumedSession = true;
    const second = await run({ instructions: "Version two.\n", sessionParams: first.result.sessionParams ?? null });

    expect(second.attempts).toBe(2);
    expect(argValue(cli.runs[cli.runs.length - 2] ?? [], "--system-prompt-snapshot")).toBe("off");
    expect(second.args).not.toContain("--resume");
    expect(second.args).not.toContain("--system-prompt-snapshot");
    expect(second.instructionsSent).toContain("Version two.");
    expect(second.result.sessionId).not.toBe(first.result.sessionId);
    expect(second.result.sessionParams?.promptBundleKey).not.toBe(first.result.sessionParams?.promptBundleKey);
    expect(second.result.sessionParams).not.toHaveProperty("promptSnapshotBundleKey");
  });

  describe("wake prompt", () => {
    const CHANGE_NOTE = "Changed since your previous turn on this task: your instructions.";
    // An issue wake on a session the server kept across an instructions edit.
    const context = {
      issueId: "issue-1",
      paperclipWake: withPaperclipWakeSessionConfigChanges(
        {
          reason: "issue_commented",
          issue: { id: "issue-1", identifier: "T-1", title: "Task", status: "in_progress", priority: "medium" },
          comments: [{ id: "comment-1", body: "Please continue.", authorType: "user" }],
          commentIds: ["comment-1"],
        },
        ["your instructions"],
      ),
    };

    it("names the configuration changes to a resumed session only", async () => {
      const fresh = await run({ instructions: "Version one.\n", sessionParams: null, context });
      expect(fresh.prompt).toContain("Please continue.");
      expect(fresh.prompt).not.toContain(CHANGE_NOTE);
      expect(fresh.prompt).toContain("Continue your work.");

      const plain = await run({ instructions: "Version one.\n", sessionParams: fresh.result.sessionParams ?? null, context });
      expect(argValue(plain.args, "--resume")).toBe(fresh.result.sessionId);
      expect(plain.prompt).toContain(CHANGE_NOTE);
      expect(plain.prompt).toContain("## Paperclip Resume Delta");

      const refreshed = await run({ instructions: "Version two.\n", sessionParams: plain.result.sessionParams ?? null, context });
      expect(argValue(refreshed.args, "--system-prompt-snapshot")).toBe("off");
      expect(refreshed.prompt).toContain(CHANGE_NOTE);
    });

    it("leaves the note out when the adapter starts a new session instead", async () => {
      cli.helpText = HELP_WITHOUT_SNAPSHOT;
      const first = await run({ instructions: "Version one.\n", sessionParams: null, context });
      const second = await run({ instructions: "Version two.\n", sessionParams: first.result.sessionParams ?? null, context });

      expect(second.args).not.toContain("--resume");
      expect(second.prompt).not.toContain(CHANGE_NOTE);
      expect(second.prompt).not.toContain("## Paperclip Resume Delta");
      expect(second.prompt).toContain("Continue your work.");
    });

    it("gives the retry after a lost session the prompt of a new session", async () => {
      const config = { bootstrapPromptTemplate: "Read the repository first." };
      const first = await run({ instructions: "Version one.\n", sessionParams: null, config, context });
      cli.loseResumedSession = true;
      const second = await run({ instructions: "Version one.\n", sessionParams: first.result.sessionParams ?? null, config, context });

      expect(second.attempts).toBe(2);
      const resumedPrompt = cli.prompts[cli.prompts.length - 2] ?? "";
      expect(resumedPrompt).toContain(CHANGE_NOTE);
      expect(resumedPrompt).toContain("## Paperclip Resume Delta");
      expect(resumedPrompt).not.toContain("Read the repository first.");

      expect(second.args).not.toContain("--resume");
      expect(second.prompt).not.toContain(CHANGE_NOTE);
      expect(second.prompt).not.toContain("## Paperclip Resume Delta");
      expect(second.prompt).toContain("## Paperclip Wake Payload");
      expect(second.prompt).toContain("Read the repository first.");
      expect(second.prompt).toContain("Continue your work.");
    });
  });

  it("does not probe or resume when the session is from another working directory", async () => {
    const first = await run({ instructions: "Version one.\n", sessionParams: null });
    const otherCwd = path.join(root, "elsewhere");
    await mkdir(otherCwd, { recursive: true });
    const second = await run({
      instructions: "Version two.\n",
      sessionParams: { ...(first.result.sessionParams ?? {}), cwd: otherCwd },
    });

    expect(second.args).not.toContain("--resume");
    expect(second.args).not.toContain("--system-prompt-snapshot");
    expect(cli.helpCalls).toBe(0);
  });

  it("round-trips the recorded bundle key through the session codec", () => {
    const params = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      cwd: "/work",
      promptBundleKey: "bundle-2",
      promptSnapshotBundleKey: "bundle-1",
    };
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toMatchObject(params);
  });
});
