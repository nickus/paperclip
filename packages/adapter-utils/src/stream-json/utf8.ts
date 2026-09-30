/**
 * Number of bytes `value` occupies in UTF-8. Lone surrogates count as the
 * three-byte replacement character, which is how TextEncoder encodes them.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair is one four-byte code point.
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** A cut index at or below `index` that does not split a surrogate pair. */
export function safeCutIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= value.length) return value.length;
  const before = value.charCodeAt(index - 1);
  // Cutting after a high surrogate would leave half a code point on each side.
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index;
}
