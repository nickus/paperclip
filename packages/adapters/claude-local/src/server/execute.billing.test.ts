import { describe, expect, it } from "vitest";
import { resolveClaudeBillingType } from "./execute.js";

describe("resolveClaudeBillingType (CLI engine)", () => {
  it("auto-detects api from an ANTHROPIC_API_KEY", () => {
    expect(resolveClaudeBillingType({}, { ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("api");
  });

  it("auto-detects subscription when no API key or Bedrock auth is present", () => {
    expect(resolveClaudeBillingType({}, {})).toBe("subscription");
  });

  it("auto-detects metered_api for Bedrock auth", () => {
    expect(resolveClaudeBillingType({}, { CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("metered_api");
    expect(
      resolveClaudeBillingType({}, { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" }),
    ).toBe("metered_api");
  });

  it('billingType: "api" forces api billing for a run that would otherwise auto-detect as subscription', () => {
    // This is the deployment this override targets: an OAuth/long-lived
    // token with no ANTHROPIC_API_KEY, which auto-detection reads as a flat
    // subscription, but which the account is actually billed for at
    // standard API prices (the CLI still reports a real total_cost_usd).
    expect(resolveClaudeBillingType({ billingType: "api" }, {})).toBe("api");
  });

  it('billingType: "subscription" forces subscription billing even with an ANTHROPIC_API_KEY present', () => {
    expect(
      resolveClaudeBillingType({ billingType: "subscription" }, { ANTHROPIC_API_KEY: "sk-ant-test" }),
    ).toBe("subscription");
  });

  it('billingType: "auto" (explicit) behaves like unset', () => {
    expect(resolveClaudeBillingType({ billingType: "auto" }, { ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("api");
    expect(resolveClaudeBillingType({ billingType: "auto" }, {})).toBe("subscription");
  });

  it("rejects an unrecognized billingType value with a clear message", () => {
    expect(() => resolveClaudeBillingType({ billingType: "flat_rate" }, {})).toThrow(
      /Invalid claude_local config "billingType"/,
    );
  });
});
