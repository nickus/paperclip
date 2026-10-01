import type { NextFunction, Request, Response } from "express";

/**
 * Bounds a single top-level string field of `req.body`.
 *
 * `payloadName` and `field` are only used to compose the error message
 * (`"${payloadName} ${field} is too long"`), so pass them as they read in
 * that sentence, e.g. `{ payloadName: "Comment", field: "body" }` ->
 * "Comment body is too long".
 */
export interface BodyFieldLengthPolicy {
  payloadName: string;
  field: string;
  maxLength: number;
  /**
   * Applied to the raw string before measuring it, when the route's schema
   * transforms the value before its own `.max()` check runs (for example
   * `multilineTextSchema`'s escaped-newline normalization). Omit it when the
   * field is validated as-is. Getting this wrong in either direction is a
   * real bug: skipping a shrinking transform rejects requests the schema
   * would accept (see `body-field-length.test.ts`), and applying a transform
   * the schema does not also apply would let oversized requests through.
   */
  normalize?: (value: string) => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject an oversized string field with a 400 that names the field, its
 * limit and the length that was actually sent.
 *
 * A bare Zod `.max()` on the field would do this too, but a failure there
 * falls through to the shared error handler's generic Zod branch, which
 * returns `{ error: "Validation error", details: [...zod issues] }` --
 * accurate, but without naming the limit the way an agent re-trying a
 * rejected edit or create needs. Run this middleware before the route's
 * `validate(...)` schema check (and after any unknown-field/alias
 * middleware, so an aliased field has already been normalized onto
 * `field`) to get a response an agent can act on without trial and error:
 * `{ error, field, maxLength, actualLength }`.
 */
export function rejectOversizedBodyField(policy: BodyFieldLengthPolicy) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isPlainObject(req.body)) {
      next();
      return;
    }
    const value = req.body[policy.field];
    if (typeof value === "string") {
      // Measure what the schema will actually validate (and what gets
      // persisted), not the raw wire value, so this never rejects a request
      // the schema would accept -- or reports a length nothing downstream
      // will see.
      const measured = policy.normalize ? policy.normalize(value) : value;
      if (measured.length > policy.maxLength) {
        res.status(400).json({
          error: `${policy.payloadName} ${policy.field} is too long`,
          field: policy.field,
          maxLength: policy.maxLength,
          actualLength: measured.length,
        });
        return;
      }
    }
    next();
  };
}
