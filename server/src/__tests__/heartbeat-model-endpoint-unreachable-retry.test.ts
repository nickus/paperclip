import { describe, expect, it } from "vitest";
import { computeModelEndpointUnreachableRetryDelayMs } from "../services/heartbeat.ts";

describe("computeModelEndpointUnreachableRetryDelayMs", () => {
  it("starts at 5 minutes on the first attempt", () => {
    expect(computeModelEndpointUnreachableRetryDelayMs(1)).toBe(5 * 60_000);
  });

  it("doubles on each subsequent attempt", () => {
    expect(computeModelEndpointUnreachableRetryDelayMs(2)).toBe(10 * 60_000);
    expect(computeModelEndpointUnreachableRetryDelayMs(3)).toBe(20 * 60_000);
    expect(computeModelEndpointUnreachableRetryDelayMs(4)).toBe(40 * 60_000);
  });

  it("caps at 60 minutes and stays capped thereafter", () => {
    expect(computeModelEndpointUnreachableRetryDelayMs(5)).toBe(60 * 60_000);
    expect(computeModelEndpointUnreachableRetryDelayMs(6)).toBe(60 * 60_000);
    expect(computeModelEndpointUnreachableRetryDelayMs(50)).toBe(60 * 60_000);
  });

  it("treats a non-positive or non-integer attempt as the first attempt", () => {
    expect(computeModelEndpointUnreachableRetryDelayMs(0)).toBe(5 * 60_000);
    expect(computeModelEndpointUnreachableRetryDelayMs(-3)).toBe(5 * 60_000);
    expect(computeModelEndpointUnreachableRetryDelayMs(1.5)).toBe(5 * 60_000);
  });
});
