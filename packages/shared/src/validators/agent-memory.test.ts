import { describe, expect, it } from "vitest";
import {
  agentMemoryConfirmInputSchema,
  agentMemoryDisputeInputSchema,
  agentMemoryTombstoneInputSchema,
  agentMemoryWriteInputSchema,
} from "./agent-memory.js";

describe("agentMemoryWriteInputSchema", () => {
  it("accepts a well-formed write", () => {
    const result = agentMemoryWriteInputSchema.safeParse({
      kind: "gotcha",
      key: "docker-rig-limit",
      body: "The build host refuses docker runs over 32 parallel containers",
    });
    expect(result.success).toBe(true);
  });

  it("defaults scope to 'agent' when omitted", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "a", body: "b" });
    expect(result.success && result.data.scope).toBe("agent");
  });

  it("rejects scope: 'company' (write path disabled in v1)", () => {
    const result = agentMemoryWriteInputSchema.safeParse({
      kind: "fact", key: "a", body: "b", scope: "company",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an uppercase key", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "Docker-Limit", body: "b" });
    expect(result.success).toBe(false);
  });

  it("rejects a key with spaces", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "docker limit", body: "b" });
    expect(result.success).toBe(false);
  });

  it("rejects a key starting with a non-alnum character", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "-docker-limit", body: "b" });
    expect(result.success).toBe(false);
  });

  it("accepts a key starting with a digit", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "3090-limit", body: "b" });
    expect(result.success).toBe(true);
  });

  it("accepts a key with underscores and hyphens", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "a_b-c", body: "b" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "opinion", key: "a", body: "b" });
    expect(result.success).toBe(false);
  });

  it("accepts a body at exactly 300 characters", () => {
    const body = `${"a".repeat(299)}.`;
    expect(body).toHaveLength(300);
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "a", body });
    expect(result.success).toBe(true);
  });

  it("rejects a body at 301 characters", () => {
    const body = `${"a".repeat(300)}.`;
    expect(body).toHaveLength(301);
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "a", body });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "a", body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field (strict)", () => {
    const result = agentMemoryWriteInputSchema.safeParse({ kind: "fact", key: "a", body: "b", extra: 1 });
    expect(result.success).toBe(false);
  });

  it("accepts the supersedes and forget hints as uuids", () => {
    const result = agentMemoryWriteInputSchema.safeParse({
      kind: "fact", key: "a", body: "b",
      supersedes: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
  });
});

describe("agentMemoryConfirmInputSchema", () => {
  it("requires baseVersion >= 1", () => {
    expect(agentMemoryConfirmInputSchema.safeParse({ baseVersion: 1 }).success).toBe(true);
    expect(agentMemoryConfirmInputSchema.safeParse({ baseVersion: 0 }).success).toBe(false);
    expect(agentMemoryConfirmInputSchema.safeParse({ baseVersion: 1.5 }).success).toBe(false);
  });
});

describe("agentMemoryDisputeInputSchema / agentMemoryTombstoneInputSchema", () => {
  it("require a non-empty reason", () => {
    expect(agentMemoryDisputeInputSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(agentMemoryDisputeInputSchema.safeParse({ reason: "looks wrong" }).success).toBe(true);
    expect(agentMemoryTombstoneInputSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(agentMemoryTombstoneInputSchema.safeParse({ reason: "stale" }).success).toBe(true);
  });
});
