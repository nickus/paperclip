import { STREAM_JSON_CONTRACT, type StreamJsonTranslator } from "./types.js";

const TRANSLATOR_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Why `value` is not a usable stream-json translator, or null when it is.
 * Hosts ignore an invalid translator (with a warning) instead of rejecting
 * the adapter that declared it.
 */
export function describeInvalidStreamJsonTranslator(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "must be an object";
  const candidate = value as Partial<Record<keyof StreamJsonTranslator, unknown>>;
  if (candidate.contract !== STREAM_JSON_CONTRACT) {
    return `unsupported contract ${JSON.stringify(candidate.contract)} (supported: ${STREAM_JSON_CONTRACT})`;
  }
  if (typeof candidate.id !== "string" || !TRANSLATOR_ID_RE.test(candidate.id)) {
    return "id must match [A-Za-z0-9_.-]{1,64}";
  }
  if (typeof candidate.version !== "number" || !Number.isSafeInteger(candidate.version) || candidate.version < 1 || candidate.version > 999_999_999) {
    return "version must be a positive integer";
  }
  if (typeof candidate.create !== "function") return "create must be a function";
  return null;
}

export function isStreamJsonTranslator(value: unknown): value is StreamJsonTranslator {
  return describeInvalidStreamJsonTranslator(value) === null;
}
