import { afterEach, describe, expect, it } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";
import { registerServerAdapter, setOverridePaused, unregisterServerAdapter } from "../adapters/registry.js";
import {
  CONVERSATION_ADAPTER_TYPES,
  conversationAdapterTypes,
  isConversationAdapter,
} from "./conversation-continuation.js";

const EXTERNAL_TYPE = "external_session_test";

function adapter(type: string, capabilities: Partial<ServerAdapterModule> = {}): ServerAdapterModule {
  return {
    type,
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date(0).toISOString() }),
    ...capabilities,
  };
}

describe("conversation adapter capability", () => {
  afterEach(() => {
    unregisterServerAdapter(EXTERNAL_TYPE);
    // Restores the built-in module an override replaced.
    unregisterServerAdapter("claude_local");
    setOverridePaused("claude_local", false);
  });

  it("keeps the built-in conversation adapters and leaves process and webhook adapters out", () => {
    for (const type of CONVERSATION_ADAPTER_TYPES) expect(isConversationAdapter(type)).toBe(true);
    expect(isConversationAdapter("process")).toBe(false);
    expect(isConversationAdapter("http")).toBe(false);
    expect(isConversationAdapter(EXTERNAL_TYPE)).toBe(false);
    expect(conversationAdapterTypes()).toEqual(expect.arrayContaining([...CONVERSATION_ADAPTER_TYPES]));
    expect(conversationAdapterTypes()).not.toContain("process");
  });

  it("accepts an external adapter that declares the capability", () => {
    registerServerAdapter(adapter(EXTERNAL_TYPE, { supportsConversationContinuation: true }));
    expect(isConversationAdapter(EXTERNAL_TYPE)).toBe(true);
    expect(conversationAdapterTypes()).toContain(EXTERNAL_TYPE);

    // Uninstalling the plugin withdraws it again.
    unregisterServerAdapter(EXTERNAL_TYPE);
    expect(isConversationAdapter(EXTERNAL_TYPE)).toBe(false);
    expect(conversationAdapterTypes()).not.toContain(EXTERNAL_TYPE);
  });

  it("does not accept an external adapter that leaves the capability unset", () => {
    registerServerAdapter(adapter(EXTERNAL_TYPE, { sessionCodec: { deserialize: () => null, serialize: () => null } }));
    expect(isConversationAdapter(EXTERNAL_TYPE)).toBe(false);
    expect(conversationAdapterTypes()).not.toContain(EXTERNAL_TYPE);
  });

  it("lets an override of a built-in type opt out, and reads the built-in while the override is paused", () => {
    registerServerAdapter(adapter("claude_local", { supportsConversationContinuation: false }));
    expect(isConversationAdapter("claude_local")).toBe(false);
    expect(conversationAdapterTypes()).not.toContain("claude_local");

    setOverridePaused("claude_local", true);
    expect(isConversationAdapter("claude_local")).toBe(true);
    expect(conversationAdapterTypes()).toContain("claude_local");
  });
});
