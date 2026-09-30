import { safeCutIndex, utf8ByteLength } from "./utf8.js";

type JsonContainer = Record<string, unknown> | unknown[];

interface StringLeaf {
  container: JsonContainer;
  key: string | number;
  length: number;
}

const MIN_KEPT_CHARS = 256;
// A cut only pays off when it removes more than the marker adds.
const MIN_CUT_LEAF_CHARS = MIN_KEPT_CHARS + 96;
const MAX_PASSES = 64;

function collectStringLeaves(value: unknown, out: StringLeaf[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === "string") out.push({ container: value, key: index, length: item.length });
      else collectStringLeaves(item, out);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") out.push({ container: value as Record<string, unknown>, key, length: item.length });
      else collectStringLeaves(item, out);
    }
  }
}

function cutMiddle(text: string, keep: number): string {
  const head = safeCutIndex(text, Math.floor(keep * 0.7));
  let tailStart = text.length - (keep - head);
  // Do not start the tail on the second half of a surrogate pair.
  if (safeCutIndex(text, tailStart) !== tailStart) tailStart += 1;
  const omitted = tailStart - head;
  return `${text.slice(0, head)}\n[paperclip: ${omitted} characters omitted]\n${text.slice(tailStart)}`;
}

/**
 * Serializes `value` to at most `maxBytes` UTF-8 bytes by cutting the middle
 * out of its longest string leaves (head 70%, tail 30%, with a marker), and
 * sets `paperclip.truncated = true` when anything was cut. Returns null when
 * the value cannot be made small enough that way. Deterministic: the same
 * value always shrinks the same way.
 */
export function serializeWithinLimit(
  value: Record<string, unknown>,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
  const text = JSON.stringify(value);
  let bytes = utf8ByteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };

  const copy = JSON.parse(text) as Record<string, unknown>;
  const paperclip =
    typeof copy.paperclip === "object" && copy.paperclip !== null && !Array.isArray(copy.paperclip)
      ? (copy.paperclip as Record<string, unknown>)
      : {};
  copy.paperclip = { ...paperclip, truncated: true };

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const serialized = JSON.stringify(copy);
    bytes = utf8ByteLength(serialized);
    if (bytes <= maxBytes) return { text: serialized, truncated: true };
    const leaves: StringLeaf[] = [];
    collectStringLeaves(copy, leaves);
    let longest: StringLeaf | null = null;
    for (const leaf of leaves) {
      if (leaf.length > MIN_CUT_LEAF_CHARS && (!longest || leaf.length > longest.length)) longest = leaf;
    }
    if (!longest) return null;
    // Each removed character saves at least one byte; the marker costs < 64.
    const keep = Math.max(MIN_KEPT_CHARS, longest.length - (bytes - maxBytes) - 64);
    const current = (longest.container as Record<string | number, unknown>)[longest.key] as string;
    (longest.container as Record<string | number, unknown>)[longest.key] = cutMiddle(current, keep);
  }
  return null;
}
