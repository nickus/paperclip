import { describe, expect, it } from "vitest";
import { sandboxRunPrivatePaths } from "./sandbox-run-private-paths.js";

describe("sandboxRunPrivatePaths", () => {
  it("names the run directory and launchers below the lease's working directory", () => {
    expect(sandboxRunPrivatePaths({ heartbeatRunId: "run-1", metadata: { remoteCwd: "/workspace" } })).toEqual([
      "/workspace/.paperclip-runtime/runs/run-1",
      "/workspace/.paperclip-runtime/github/run-1",
    ]);
  });

  it("names nothing without a run, a recorded working directory or a usable run id", () => {
    expect(sandboxRunPrivatePaths({ heartbeatRunId: null, metadata: { remoteCwd: "/workspace" } })).toEqual([]);
    expect(sandboxRunPrivatePaths({ heartbeatRunId: "run-1", metadata: {} })).toEqual([]);
    expect(sandboxRunPrivatePaths({ heartbeatRunId: "run-1", metadata: { remoteCwd: "workspace" } })).toEqual([]);
    expect(sandboxRunPrivatePaths({ heartbeatRunId: "../escape", metadata: { remoteCwd: "/workspace" } })).toEqual([]);
  });
});
