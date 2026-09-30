import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSavedTaskDrain,
  loadSavedTaskDrain,
  restoreSavedTaskDrainOnStartup,
  saveTaskDrain,
} from "../services/task-drain-store.ts";

describe("task drain store", () => {
  let dir = "";
  let filePath = "";
  const now = new Date("2026-03-01T12:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "task-drain-store-"));
    // The data directory does not exist yet; saving creates it.
    filePath = path.join(dir, "data", "task-drain.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves a drain that a later load returns as active", async () => {
    const drain = { startedAt: new Date("2026-03-01T11:00:00.000Z"), expiresAt: new Date("2026-03-01T13:00:00.000Z") };
    await saveTaskDrain(drain, filePath);

    expect(await loadSavedTaskDrain(now, filePath)).toEqual({ kind: "active", drain });
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      startedAt: "2026-03-01T11:00:00.000Z",
      expiresAt: "2026-03-01T13:00:00.000Z",
    });
  });

  it("keeps an open-ended drain", async () => {
    const drain = { startedAt: new Date("2026-03-01T11:00:00.000Z"), expiresAt: null };
    await saveTaskDrain(drain, filePath);

    expect(await loadSavedTaskDrain(now, filePath)).toEqual({ kind: "active", drain });
  });

  it("reports no drain when nothing was saved, and clearing it is a no-op", async () => {
    expect(await loadSavedTaskDrain(now, filePath)).toEqual({ kind: "none" });
    expect(await clearSavedTaskDrain(filePath)).toBe(false);
  });

  it("clears a saved drain", async () => {
    await saveTaskDrain({ startedAt: now, expiresAt: null }, filePath);

    expect(await clearSavedTaskDrain(filePath)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(await loadSavedTaskDrain(now, filePath)).toEqual({ kind: "none" });
  });

  it("removes a drain whose TTL ran out while the server was down", async () => {
    const drain = { startedAt: new Date("2026-03-01T10:00:00.000Z"), expiresAt: new Date("2026-03-01T11:00:00.000Z") };
    await saveTaskDrain(drain, filePath);

    expect(await loadSavedTaskDrain(now, filePath)).toEqual({ kind: "expired", drain });
    expect(existsSync(filePath)).toBe(false);
  });

  it("still reports an expired drain when its file cannot be removed", async () => {
    // Removing a file from a read-only directory fails, except for root.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const drain = { startedAt: new Date("2026-03-01T10:00:00.000Z"), expiresAt: new Date("2026-03-01T11:00:00.000Z") };
    await saveTaskDrain(drain, filePath);
    chmodSync(path.dirname(filePath), 0o500);
    try {
      expect(await loadSavedTaskDrain(now, filePath)).toEqual({ kind: "expired", drain });
    } finally {
      chmodSync(path.dirname(filePath), 0o700);
    }
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown version", JSON.stringify({ version: 2, startedAt: "2026-03-01T11:00:00.000Z", expiresAt: null })],
    ["a bad start time", JSON.stringify({ version: 1, startedAt: "yesterday", expiresAt: null })],
    ["a bad expiry", JSON.stringify({ version: 1, startedAt: "2026-03-01T11:00:00.000Z", expiresAt: 5 })],
  ])("holds admission open-ended when the saved file has %s", async (_label, body) => {
    await saveTaskDrain({ startedAt: now, expiresAt: null }, filePath);
    writeFileSync(filePath, body);

    expect(await loadSavedTaskDrain(now, filePath)).toEqual({
      kind: "unreadable",
      drain: { startedAt: now, expiresAt: null },
      error: "malformed",
    });
    // An operator's explicit hold is kept until a stop request removes it.
    expect(existsSync(filePath)).toBe(true);
  });

  describe("restore on startup", () => {
    const logger = () => ({ warn: vi.fn(), info: vi.fn() });

    it("applies a saved drain, marked to persist across the next restart", async () => {
      const drain = { startedAt: new Date("2026-03-01T11:00:00.000Z"), expiresAt: null };
      await saveTaskDrain(drain, filePath);
      const applyTaskDrain = vi.fn();
      const log = logger();

      const kind = await restoreSavedTaskDrainOnStartup({ applyTaskDrain, logger: log, now, filePath });

      expect(kind).toBe("active");
      expect(applyTaskDrain).toHaveBeenCalledWith({ ...drain, persistAcrossRestart: true });
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it("applies an open-ended drain when the saved file is unreadable", async () => {
      await saveTaskDrain({ startedAt: now, expiresAt: null }, filePath);
      writeFileSync(filePath, "{");
      const applyTaskDrain = vi.fn();

      const kind = await restoreSavedTaskDrainOnStartup({ applyTaskDrain, logger: logger(), now, filePath });

      expect(kind).toBe("unreadable");
      expect(applyTaskDrain).toHaveBeenCalledWith({ startedAt: now, expiresAt: null, persistAcrossRestart: true });
    });

    it.each(["none", "expired"] as const)("applies nothing when the saved drain is %s", async (state) => {
      if (state === "expired") {
        await saveTaskDrain({ startedAt: new Date("2026-03-01T10:00:00.000Z"), expiresAt: new Date("2026-03-01T11:00:00.000Z") }, filePath);
      }
      const applyTaskDrain = vi.fn();

      const kind = await restoreSavedTaskDrainOnStartup({ applyTaskDrain, logger: logger(), now, filePath });

      expect(kind).toBe(state);
      expect(applyTaskDrain).not.toHaveBeenCalled();
    });
  });
});
