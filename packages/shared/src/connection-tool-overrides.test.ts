import { describe, expect, it } from "vitest";
import {
  exposedToolNameProblem,
  readConnectionAgentPresentation,
  readConnectionToolOverrides,
} from "./connection-tool-overrides.js";

describe("connection tool overrides", () => {
  it("reads overrides keyed by upstream tool name", () => {
    expect(readConnectionToolOverrides({
      toolOverrides: {
        search: { name: "find_tickets", description: "  Find tickets.  " },
        list: { description: "List tickets." },
      },
    })).toEqual(new Map([
      ["search", { name: "find_tickets", description: "Find tickets." }],
      ["list", { name: null, description: "List tickets." }],
    ]));
  });

  it("ignores stored overrides that would not pass validation", () => {
    expect(readConnectionToolOverrides({
      toolOverrides: {
        a: { name: "bad name" },
        b: { name: "search_tools", description: "Kept description." },
        c: "not an object",
        d: { name: 42 },
      },
    })).toEqual(new Map([["b", { name: null, description: "Kept description." }]]));
    expect(readConnectionToolOverrides({ toolOverrides: ["search"] }).size).toBe(0);
    expect(readConnectionToolOverrides(null).size).toBe(0);
  });

  it("drops an exposed name that two tools of one connection claim", () => {
    expect(readConnectionToolOverrides({
      toolOverrides: {
        search: { name: "find" },
        lookup: { name: "Find", description: "Look up." },
        other: { name: "other" },
      },
    })).toEqual(new Map([
      ["lookup", { name: null, description: "Look up." }],
      ["other", { name: "other", description: null }],
    ]));
  });

  it("explains why a name cannot be exposed", () => {
    expect(exposedToolNameProblem("find_tickets")).toBeNull();
    expect(exposedToolNameProblem("x".repeat(64))).toBeNull();
    expect(exposedToolNameProblem("x".repeat(65))).toContain("at most 64");
    expect(exposedToolNameProblem("mcp.tickets:search")).toContain("letters, digits");
    expect(exposedToolNameProblem("paperclip_get_prompt")).toContain("reserved");
  });

  it("reads the connection name and description shown to agents", () => {
    expect(readConnectionAgentPresentation({ agentDisplayName: " Ticket desk ", agentDescription: "Tickets." }))
      .toEqual({ name: "Ticket desk", description: "Tickets." });
    expect(readConnectionAgentPresentation({ agentDisplayName: "", agentDescription: 7 }))
      .toEqual({ name: null, description: null });
  });
});
