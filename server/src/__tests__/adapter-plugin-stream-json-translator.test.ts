import { describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

const { validateAdapterModule } = await import("../adapters/plugin-loader.js");

function pluginModule(extra: Record<string, unknown>) {
  return {
    createServerAdapter: () => ({
      type: "example_local",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({ adapterType: "example_local", status: "pass", checks: [], testedAt: "" }),
      ...extra,
    }),
  };
}

const translator = {
  contract: 1,
  id: "example_local",
  version: 3,
  create: () => ({ line() {} }),
};

describe("external adapter stream-json translators", () => {
  it("keeps a valid translator", () => {
    const adapter = validateAdapterModule(pluginModule({ streamJsonTranslator: translator }), "example-adapter");
    expect(adapter.streamJsonTranslator).toBe(translator);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...translator, contract: 2 }, "unsupported contract"],
    [{ ...translator, version: 0 }, "version must be a positive integer"],
    [{ ...translator, create: undefined }, "create must be a function"],
    ["not an object", "must be an object"],
  ])("drops an invalid translator (%#) but keeps the adapter", (value, problem) => {
    mockLogger.warn.mockClear();
    const adapter = validateAdapterModule(pluginModule({ streamJsonTranslator: value }), "example-adapter");
    expect(adapter.type).toBe("example_local");
    expect(adapter.streamJsonTranslator).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "example-adapter", type: "example_local", problem: expect.stringContaining(problem) }),
      expect.stringContaining("invalid stream-json translator"),
    );
  });
});
