import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatsApi } from "./heartbeats";
import {
  createTenantSessionRecoveryCoordinator,
  tenantSessionRecovery,
} from "@/lib/tenant-session-recovery";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("heartbeatsApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("requests summary rows for hot-path history consumers", async () => {
    await heartbeatsApi.list("company-1", undefined, 200, { summary: true });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?limit=200&summary=true");
  });

  it("keeps full row requests as the default for run-history screens", async () => {
    await heartbeatsApi.list("company-1", "agent-1", 25);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/heartbeat-runs?agentId=agent-1&limit=25");
  });
});

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("keeps the legacy numeric minCount signature", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", 4);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=4");
  });

  it("passes minCount and limit options to the company live-runs endpoint", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", { minCount: 50, limit: 50 });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50&limit=50");
  });
});

describe("heartbeatsApi.log", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("requests the run log with the given offset and limitBytes", async () => {
    mockApi.get.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "hello\n",
      nextOffset: 6,
    });

    await heartbeatsApi.log("run-1", 0, 1000);

    expect(mockApi.get).toHaveBeenCalledWith(
      "/heartbeat-runs/run-1/log?offset=0&limitBytes=1000",
      undefined,
    );
  });

  it("decodes the before-first-chunk and caught-up-terminal pages as non-null strings with no nextOffset", async () => {
    // Mirrors what the server now sends for a run that has no log yet: a
    // just-created run still echoes `nextOffset`, a terminal run (cancelled
    // while queued, failed before streaming started) omits it so a caller
    // paging on its presence stops instead of polling forever.
    mockApi.get.mockResolvedValue({
      runId: "run-2",
      store: "",
      logRef: "",
      content: "",
    });

    const result = await heartbeatsApi.log("run-2");

    expect(result.store).toBe("");
    expect(result.logRef).toBe("");
    expect(result.nextOffset).toBeUndefined();
  });
});

describe("heartbeatsApi.downloadProviderTrace", () => {
  it("initiates tenant-session recovery for a direct trace download", async () => {
    const reload = vi.fn();
    const recovery = createTenantSessionRecoveryCoordinator(reload);
    vi.spyOn(tenantSessionRecovery, "recoverIfNeeded").mockImplementation(recovery.recoverIfNeeded);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "tenant_session_required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const request = heartbeatsApi.downloadProviderTrace("run-1");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    let settled = false;
    void request.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});
