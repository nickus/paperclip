import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "./error-handler.js";
import { rejectOversizedBodyField } from "./body-field-length.js";

function createApp(maxLength = 10) {
  const app = express();
  app.use(express.json());
  app.post(
    "/notes",
    rejectOversizedBodyField({ payloadName: "Note", field: "body", maxLength }),
    (req, res) => {
      res.json({ received: req.body });
    },
  );
  app.use(errorHandler);
  return app;
}

describe("rejectOversizedBodyField", () => {
  it("passes a field at or under the limit through unchanged", async () => {
    const res = await request(createApp(10)).post("/notes").send({ body: "0123456789" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toEqual({ body: "0123456789" });
  });

  it("rejects a field over the limit with the field, limit and actual length", async () => {
    const res = await request(createApp(10)).post("/notes").send({ body: "01234567890" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Note body is too long",
      field: "body",
      maxLength: 10,
      actualLength: 11,
    });
  });

  it("leaves a non-string field to schema validation", async () => {
    const res = await request(createApp(10)).post("/notes").send({ body: 12345 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toEqual({ body: 12345 });
  });

  it("leaves a missing field to schema validation", async () => {
    const res = await request(createApp(10)).post("/notes").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("leaves a non-object body to schema validation", async () => {
    const res = await request(createApp(10)).post("/notes").send([{ body: "01234567890" }]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toEqual([{ body: "01234567890" }]);
  });

  describe("normalize", () => {
    function createNormalizingApp(maxLength: number) {
      const app = express();
      app.use(express.json());
      app.post(
        "/notes",
        rejectOversizedBodyField({
          payloadName: "Note",
          field: "body",
          maxLength,
          // Mirrors a schema transform that only ever shortens the value
          // (e.g. `multilineTextSchema`'s escaped-newline collapsing).
          normalize: (value) => value.replace(/x/g, ""),
        }),
        (req, res) => {
          res.json({ received: req.body });
        },
      );
      app.use(errorHandler);
      return app;
    }

    it("passes a field whose raw length exceeds the limit but whose normalized length does not", async () => {
      // Raw is 12 chars (over a limit of 10); normalized (x's stripped) is 2.
      const res = await request(createNormalizingApp(10))
        .post("/notes")
        .send({ body: "xxxxxxxxxxab" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.received).toEqual({ body: "xxxxxxxxxxab" });
    });

    it("rejects using the normalized length, not the raw length, when still over the limit", async () => {
      // Raw is 13 chars; normalized (x's stripped) is 11, still over a
      // limit of 10.
      const res = await request(createNormalizingApp(10))
        .post("/notes")
        .send({ body: "xxabcdefghijk" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "Note body is too long",
        field: "body",
        maxLength: 10,
        actualLength: 11,
      });
    });
  });
});
