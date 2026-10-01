import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQuotaWindows } from "./quota.js";

// Each test uses its own unique token so the module-level per-fingerprint
// cache in quota.ts never leaks state between tests in this file.
let tokenCounter = 0;
function freshToken(): string {
  tokenCounter += 1;
  return `sk-ant-oat01-test-token-${tokenCounter}`;
}

function usageBody(overrides: Record<string, unknown> = {}) {
  return {
    five_hour: { utilization: 0.1, resets_at: "2026-01-01T00:00:00.000Z" },
    seven_day: { utilization: 0.5, resets_at: "2026-01-02T00:00:00.000Z" },
    ...overrides,
  };
}

describe("getQuotaWindows company-aware polling (credentials cache/backoff)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns one labeled result per credential on a live success", async () => {
    const tokenA = freshToken();
    const tokenB = freshToken();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => usageBody() });

    const results = await getQuotaWindows({
      credentials: [
        { key: "a", label: "Claude login", env: { CLAUDE_CODE_OAUTH_TOKEN: tokenA } },
        { key: "b", label: "payments-bot token", env: { CLAUDE_CODE_OAUTH_TOKEN: tokenB } },
      ],
    });

    expect(Array.isArray(results)).toBe(true);
    const list = results as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ ok: true, label: "Claude login", stale: false });
    expect(list[1]).toMatchObject({ ok: true, label: "payments-bot token", stale: false });
  });

  it("serves the cached result without a second live fetch inside the fresh window", async () => {
    const token = freshToken();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => usageBody() });
    const credential = { key: "c", label: "Claude login", env: { CLAUDE_CODE_OAUTH_TOKEN: token } };

    await getQuotaWindows({ credentials: [credential] });
    expect(fetch).toHaveBeenCalledTimes(1);

    await getQuotaWindows({ credentials: [credential] });
    // Still within the ~120s fresh window: no second live call.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("after a 429, serves the last good result marked stale instead of retrying immediately", async () => {
    const token = freshToken();
    const mockFetch = fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => usageBody() });
    const credential = { key: "d", label: "Claude login", env: { CLAUDE_CODE_OAUTH_TOKEN: token } };

    const first = (await getQuotaWindows({ credentials: [credential] })) as Array<Record<string, unknown>>;
    expect(first[0]).toMatchObject({ ok: true, stale: false });

    // Move past the ~120s fresh window so the next call attempts a live read.
    vi.advanceTimersByTime(121_000);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { type: "rate_limit_error" } }) });

    const second = (await getQuotaWindows({ credentials: [credential] })) as Array<Record<string, unknown>>;
    expect(second[0]).toMatchObject({ ok: true, stale: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Still backed off: a third call within the backoff window must not hit fetch again.
    const third = (await getQuotaWindows({ credentials: [credential] })) as Array<Record<string, unknown>>;
    expect(third[0]).toMatchObject({ ok: true, stale: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to the passive run snapshot when there is no cached good result and the live read fails", async () => {
    const token = freshToken();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const credential = {
      key: "e",
      label: "Claude login",
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      passiveSnapshot: {
        observedAt: "2026-01-05T00:00:00.000Z",
        status: "rejected",
        rateLimitType: "seven_day",
        resetsAt: 1,
        overageStatus: null,
        overageResetsAt: null,
        isUsingOverage: true,
        overageInUse: true,
        windows: { seven_day: { utilization: 1, resetsAt: 1 } },
      },
    };

    const results = (await getQuotaWindows({ credentials: [credential] })) as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({
      ok: true,
      stale: true,
      overageInUse: true,
      observedAt: "2026-01-05T00:00:00.000Z",
    });
  });

  it("returns ok:false with a clear, non-secret error when nothing is available at all", async () => {
    const token = freshToken();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const credential = { key: "f", label: "Claude login", env: { CLAUDE_CODE_OAUTH_TOKEN: token } };

    const results = (await getQuotaWindows({ credentials: [credential] })) as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ ok: false, label: "Claude login" });
    expect(typeof results[0]!.error).toBe("string");
    expect(String(results[0]!.error)).not.toContain(token);
  });

  it("never includes the token in the returned error string on a fetch failure", async () => {
    const token = freshToken();
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(`boom while fetching ${token.slice(0, 3)}`));
    const credential = { key: "g", label: "Claude login", env: { CLAUDE_CODE_OAUTH_TOKEN: token } };

    const results = (await getQuotaWindows({ credentials: [credential] })) as Array<Record<string, unknown>>;
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(token);
  });
});
