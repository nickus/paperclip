import { describe, expect, it } from "vitest";
import {
  normalizeBilledCostCents,
  normalizeLedgerBillingType,
  resolveCacheAdjustedCostUsd,
  resolveLedgerCostStatus,
} from "../services/heartbeat.js";

describe("heartbeat cost accounting", () => {
  it("marks token-bearing CLI usage without a reported cost as unpriced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: null,
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
    })).toBe("unpriced");
  });

  it("marks reported CLI cost as priced", () => {
    expect(resolveLedgerCostStatus({
      costUsd: 1.25,
      inputTokens: 2_090,
      cachedInputTokens: 300_000,
      outputTokens: 77_000,
    })).toBe("reported");
  });

  it("uses an explicit cache-adjusted provider cost when available", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: 0.92,
    })).toBe(0.92);
  });

  it("attributes provider-reported billed cost as cache-adjusted by default", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 1.25,
      cacheAdjustedCostUsd: null,
    })).toBe(1.25);
  });

  it("does not attribute invalid or unavailable costs", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: Number.NaN,
    })).toBeNull();
  });

  it("prices a run that only reports a cache-adjusted cost", () => {
    const billedCostUsd = resolveCacheAdjustedCostUsd({
      costUsd: null,
      cacheAdjustedCostUsd: 0.42,
    });
    expect(billedCostUsd).toBe(0.42);
    expect(resolveLedgerCostStatus({
      costUsd: billedCostUsd,
      inputTokens: 1_000,
      cachedInputTokens: 900_000,
      outputTokens: 5_000,
    })).toBe("reported");
  });

  it("bills the discounted amount when both nominal and cache-adjusted costs are reported", () => {
    expect(resolveCacheAdjustedCostUsd({
      costUsd: 3.1,
      cacheAdjustedCostUsd: 1.5,
    })).toBe(1.5);
  });

  // An adapter normally guesses billingType from the auth it detects. Some
  // deployments authenticate with a token that auto-detection reads as a
  // flat subscription but that is actually billed at standard API prices.
  // An adapter config override (e.g. claude_local's `billingType: "api"`)
  // reports "api"/"metered_api" instead of "subscription" for those runs so
  // the ledger bills the reported cost instead of forcing it to 0.
  describe("adapter billingType -> ledger classification", () => {
    it("normalizes an adapter-reported \"api\" billingType to metered_api", () => {
      expect(normalizeLedgerBillingType("api")).toBe("metered_api");
    });

    it("normalizes an adapter-reported \"subscription\" billingType to subscription_included", () => {
      expect(normalizeLedgerBillingType("subscription")).toBe("subscription_included");
    });

    it("bills the reported cost in cents for a metered_api run", () => {
      expect(normalizeBilledCostCents(1.25, "metered_api")).toBe(125);
    });

    it("bills the reported cost in cents for an api run (adapter billingType override)", () => {
      // This is the bug this override fixes: without it, a run on a
      // subscription-looking token that the Claude CLI actually billed at
      // API prices (total_cost_usd > 0) would be force-zeroed below because
      // its billingType resolved to subscription_included instead of
      // metered_api.
      expect(normalizeBilledCostCents(2.4, "metered_api")).toBe(240);
    });

    it("force-zeroes billed cost for subscription_included regardless of reported cost", () => {
      // This is the behavior being guarded against: a reported cost is
      // discarded whenever the run is classified as an included
      // subscription run, by design.
      expect(normalizeBilledCostCents(2.4, "subscription_included")).toBe(0);
    });
  });
});
