import { describe, expect, it } from "vitest";
import {
  applyOverageToBillingType,
  parseClaudeBillingTypeOverride,
  resolveClaudeBillingTypeWithOverride,
} from "./billing.js";

describe("parseClaudeBillingTypeOverride", () => {
  it("defaults to auto when unset", () => {
    expect(parseClaudeBillingTypeOverride(undefined)).toBe("auto");
    expect(parseClaudeBillingTypeOverride(null)).toBe("auto");
    expect(parseClaudeBillingTypeOverride("")).toBe("auto");
  });

  it("accepts the documented values", () => {
    expect(parseClaudeBillingTypeOverride("auto")).toBe("auto");
    expect(parseClaudeBillingTypeOverride("api")).toBe("api");
    expect(parseClaudeBillingTypeOverride("subscription")).toBe("subscription");
  });

  it("rejects an unrecognized value with a clear message", () => {
    expect(() => parseClaudeBillingTypeOverride("flat_rate")).toThrow(
      'Invalid claude_local config "billingType": "flat_rate". Expected one of "auto", "api", "subscription".',
    );
    expect(() => parseClaudeBillingTypeOverride(42)).toThrow(/Invalid claude_local config "billingType"/);
  });
});

describe("resolveClaudeBillingTypeWithOverride", () => {
  it("passes the auto-detected value through unchanged for \"auto\"", () => {
    expect(resolveClaudeBillingTypeWithOverride("auto", "subscription")).toBe("subscription");
    expect(resolveClaudeBillingTypeWithOverride("auto", "api")).toBe("api");
    expect(resolveClaudeBillingTypeWithOverride("auto", "metered_api")).toBe("metered_api");
  });

  it("forces \"api\" regardless of the auto-detected value", () => {
    expect(resolveClaudeBillingTypeWithOverride("api", "subscription")).toBe("api");
    expect(resolveClaudeBillingTypeWithOverride("api", "metered_api")).toBe("api");
  });

  it("forces \"subscription\" regardless of the auto-detected value", () => {
    expect(resolveClaudeBillingTypeWithOverride("subscription", "api")).toBe("subscription");
    expect(resolveClaudeBillingTypeWithOverride("subscription", "metered_api")).toBe("subscription");
  });
});

describe("applyOverageToBillingType", () => {
  it("corrects an auto-detected subscription classification to api when overage was observed", () => {
    expect(applyOverageToBillingType("auto", "subscription", true)).toBe("api");
  });

  it("leaves an auto-detected subscription classification alone when no overage was observed", () => {
    expect(applyOverageToBillingType("auto", "subscription", false)).toBe("subscription");
  });

  it("leaves an auto-detected api/metered_api classification alone regardless of overage", () => {
    expect(applyOverageToBillingType("auto", "api", true)).toBe("api");
    expect(applyOverageToBillingType("auto", "metered_api", true)).toBe("metered_api");
  });

  it("never overrides an explicit subscription override, even with overage observed", () => {
    expect(applyOverageToBillingType("subscription", "subscription", true)).toBe("subscription");
  });

  it("is a no-op for an explicit api override", () => {
    expect(applyOverageToBillingType("api", "api", true)).toBe("api");
    expect(applyOverageToBillingType("api", "api", false)).toBe("api");
  });
});
