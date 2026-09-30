import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorHandler } from "./error-handler.js";
import { validate } from "./validate.js";
import { rejectUnknownBodyFields, type UnknownBodyFieldPolicy } from "./unknown-body-fields.js";

const noteSchema = z.object({
  body: z.string().min(1),
  assigneeAgentId: z.string().optional(),
  blockedByIssueIds: z.array(z.string()).optional(),
});

function createApp(policy: Partial<UnknownBodyFieldPolicy> = {}) {
  const app = express();
  app.use(express.json());
  app.post(
    "/notes",
    rejectUnknownBodyFields({
      payloadName: "note",
      acceptedFields: Object.keys(noteSchema.shape),
      ...policy,
    }),
    validate(noteSchema),
    (req, res) => {
      res.json({ received: req.body });
    },
  );
  app.use(errorHandler);
  return app;
}

describe("rejectUnknownBodyFields", () => {
  it("passes a body with only accepted fields through unchanged", async () => {
    const res = await request(createApp()).post("/notes").send({ body: "hello", assigneeAgentId: "a-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toEqual({ body: "hello", assigneeAgentId: "a-1" });
  });

  it("rejects unknown fields with the accepted fields and a did-you-mean hint", async () => {
    const res = await request(createApp({ hints: { blockedBy: "blockedByIssueIds" } }))
      .post("/notes")
      .send({ body: "hello", blockedBy: ["issue-1"], assignee_agent_id: "a-1", zzz: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Unknown fields in note: blockedBy (did you mean blockedByIssueIds?), " +
        "assignee_agent_id (did you mean assigneeAgentId?), zzz",
    );
    expect(res.body.code).toBe("unknown_fields");
    expect(res.body.remediation).toContain("accepted fields: assigneeAgentId, blockedByIssueIds, body.");
    expect(res.body.details).toMatchObject({
      unknownFields: ["blockedBy", "assignee_agent_id", "zzz"],
      suggestions: { blockedBy: "blockedByIssueIds", assignee_agent_id: "assigneeAgentId" },
      acceptedFields: ["assigneeAgentId", "blockedByIssueIds", "body"],
    });
  });

  it("suggests the nearest field for a small typo", async () => {
    const res = await request(createApp()).post("/notes").send({ body: "hello", blockedByIssueId: ["issue-1"] });

    expect(res.status).toBe(400);
    expect(res.body.details.suggestions).toEqual({ blockedByIssueId: "blockedByIssueIds" });
  });

  it("renames an alias to its canonical field when the canonical field is absent", async () => {
    const res = await request(createApp({ aliases: { text: "body" } })).post("/notes").send({ text: "hello" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toEqual({ body: "hello" });
  });

  it("reports an alias sent together with its canonical field instead of picking one", async () => {
    const res = await request(createApp({ aliases: { text: "body" }, hints: { text: "body (send the text once)" } }))
      .post("/notes")
      .send({ body: "hello", text: "hello again" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown field in note: text (did you mean body (send the text once)?)");
  });

  it("does not treat inherited object properties as hints", async () => {
    const res = await request(createApp({ hints: {} })).post("/notes").send({ body: "hello", toString: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown field in note: toString");
    expect(res.body.details.suggestions).toEqual({});
  });

  it("bounds the number of reported unknown fields", async () => {
    const extra = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`extra${index}`, index]));
    const res = await request(createApp()).post("/notes").send({ body: "hello", ...extra });

    expect(res.status).toBe(400);
    expect(res.body.details.unknownFields).toHaveLength(20);
    expect(res.body.error).toMatch(/, and 10 more$/);
  });

  it("leaves non-object bodies to schema validation", async () => {
    const res = await request(createApp()).post("/notes").send([{ body: "hello" }]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });
});
