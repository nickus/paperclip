import { describe, expect, it } from "vitest";
import {
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
