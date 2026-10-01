import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockAgentService = vi.hoisted(() => ({ list: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  resolveEnvBindings: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));
vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));
// Keep readClaudeOAuthBinding / isFixedClaudeOAuthBinding real (pure
// functions over an adapter config object) and replace only the DB-backed
// secretService factory.
vi.mock("../services/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secrets.js")>();
  return { ...actual, secretService: () => mockSecretService };
});

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows, type QuotaActorContext } from "../services/quota-windows.js";

const actor: QuotaActorContext = {
  actorType: "user",
  actorId: "board-user",
  actorSource: "local_implicit",
  responsibleUserId: "board-user",
};

function makeDb(resultRows: Array<{ resultJson: unknown }> = []) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(resultRows),
  };
  return { select: vi.fn().mockReturnValue(chain) } as never;
}

function agentRow(overrides: Partial<{ id: string; adapterType: string; adapterConfig: Record<string, unknown> }>) {
  return {
    id: "agent-1",
    adapterType: "claude_local",
    adapterConfig: {},
    ...overrides,
  };
}

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockAgentService.list.mockReset();
    mockSecretService.resolveEnvBindings.mockReset();
    mockSecretService.getById.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    mockAgentService.list.mockResolvedValue([
      agentRow({ id: "agent-1", adapterType: "codex_local" }),
      agentRow({ id: "agent-2", adapterType: "claude_local" }),
    ]);
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows(makeDb(), "company-1", actor);
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });

  it("does not poll or show a provider the company has no agents for", async () => {
    mockAgentService.list.mockResolvedValue([
      agentRow({ id: "agent-1", adapterType: "claude_local" }),
    ]);
    const codexGetQuotaWindows = vi.fn().mockResolvedValue({ provider: "openai", ok: true, windows: [] });
    const claudeGetQuotaWindows = vi.fn().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: codexGetQuotaWindows },
      { type: "claude_local", getQuotaWindows: claudeGetQuotaWindows },
    ] as never);

    await fetchAllQuotaWindows(makeDb(), "company-1", actor);

    expect(codexGetQuotaWindows).not.toHaveBeenCalled();
    expect(claudeGetQuotaWindows).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when the company has no agents using any adapter that supports quota polling", async () => {
    mockAgentService.list.mockResolvedValue([]);
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: vi.fn() },
    ] as never);

    const results = await fetchAllQuotaWindows(makeDb(), "company-1", actor);
    expect(results).toEqual([]);
  });

  it("builds one credential for a fixed user_secret_ref binding and one host-login fallback for an unbound agent, and flattens the adapter's per-credential array", async () => {
    mockAgentService.list.mockResolvedValue([
      agentRow({
        id: "agent-bound",
        adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } } },
      }),
      agentRow({ id: "agent-unbound", adapterConfig: {} }),
    ]);
    mockSecretService.resolveEnvBindings.mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token" },
      secretKeys: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
      manifest: [],
    });
    const claudeGetQuotaWindows = vi.fn().mockImplementation(async (ctx) => {
      return ctx.credentials.map((c: { key: string; label: string }) => ({
        provider: "anthropic",
        ok: true,
        windows: [],
        label: c.label,
      }));
    });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: claudeGetQuotaWindows },
    ] as never);

    const results = await fetchAllQuotaWindows(makeDb(), "company-1", actor);

    expect(claudeGetQuotaWindows).toHaveBeenCalledTimes(1);
    const ctx = claudeGetQuotaWindows.mock.calls[0][0];
    const labels = ctx.credentials.map((c: { label: string }) => c.label).sort();
    expect(labels).toEqual(["Claude login", "Server login"]);
    // The resolved credential never carries a secret reference, only the
    // resolved value — never leaked back to the caller as anything but the
    // literal env var the adapter asked for.
    const loginCredential = ctx.credentials.find((c: { label: string }) => c.label === "Claude login");
    expect(loginCredential.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test-token");

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.label).sort()).toEqual(["Claude login", "Server login"]);
  });

  it("dedupes two agents sharing the same company secret_ref binding into one credential, labeled with the secret's name", async () => {
    const binding = { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" };
    mockAgentService.list.mockResolvedValue([
      agentRow({ id: "agent-a", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: binding } } }),
      agentRow({ id: "agent-b", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: binding } } }),
    ]);
    mockSecretService.getById.mockResolvedValue({ id: binding.secretId, name: "payments-bot token" });
    mockSecretService.resolveEnvBindings.mockResolvedValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-shared" },
      secretKeys: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
      manifest: [],
    });
    const claudeGetQuotaWindows = vi.fn().mockImplementation(async (ctx) =>
      ctx.credentials.map((c: { label: string }) => ({ provider: "anthropic", ok: true, windows: [], label: c.label })),
    );
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: claudeGetQuotaWindows },
    ] as never);

    await fetchAllQuotaWindows(makeDb(), "company-1", actor);

    const ctx = claudeGetQuotaWindows.mock.calls[0][0];
    expect(ctx.credentials).toHaveLength(1);
    expect(ctx.credentials[0].label).toBe("payments-bot token");
    // Only resolved once even though two agents share the binding.
    expect(mockSecretService.resolveEnvBindings).toHaveBeenCalledTimes(1);
  });

  it("never 500s when a binding cannot be resolved; it becomes a credential with no token instead", async () => {
    mockAgentService.list.mockResolvedValue([
      agentRow({
        id: "agent-bound",
        adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "22222222-2222-2222-2222-222222222222" } } },
      }),
    ]);
    mockSecretService.getById.mockRejectedValue(new Error("not found"));
    mockSecretService.resolveEnvBindings.mockRejectedValue(new Error("secret binding missing"));
    const claudeGetQuotaWindows = vi.fn().mockImplementation(async (ctx) =>
      ctx.credentials.map((c: { env: Record<string, string> }) => ({
        provider: "anthropic",
        ok: Object.keys(c.env).length > 0,
        windows: [],
        error: Object.keys(c.env).length > 0 ? undefined : "no token",
      })),
    );
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: claudeGetQuotaWindows },
    ] as never);

    const results = await fetchAllQuotaWindows(makeDb(), "company-1", actor);

    const ctx = claudeGetQuotaWindows.mock.calls[0][0];
    expect(ctx.credentials).toHaveLength(1);
    expect(ctx.credentials[0].env).toEqual({});
    expect(results).toEqual([{ provider: "anthropic", ok: false, windows: [], error: "no token" }]);
  });
});
