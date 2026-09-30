/**
 * Cursors name one output line: `<translator>@<version>/<sid>/<offset>.<k>`,
 * where `offset` is the byte offset of the source record in the run-log file
 * and `k` the index of the line among those emitted at that offset.
 */
export interface StreamJsonCursor {
  /** `<translator id>@<version>` */
  tag: string;
  sid: string;
  offset: number;
  k: number;
}

export function streamJsonTranslatorTag(translator: { id: string; version: number }): string {
  return `${translator.id}@${translator.version}`;
}

export function formatStreamJsonCursor(cursor: StreamJsonCursor): string {
  return `${cursor.tag}/${cursor.sid}/${cursor.offset}.${cursor.k}`;
}

const POSITION_RE = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,8})$/;

export function parseStreamJsonCursor(value: string): StreamJsonCursor | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  const [tag, sid, position] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_.-]{1,64}@[1-9]\d{0,8}$/.test(tag)) return null;
  if (!/^[A-Za-z0-9]{1,32}$/.test(sid)) return null;
  const match = POSITION_RE.exec(position);
  if (!match) return null;
  const offset = Number(match[1]);
  const k = Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(k)) return null;
  return { tag, sid, offset, k };
}

/** Orders two positions in one translation: negative when `a` comes first. */
export function compareStreamJsonPositions(
  a: { offset: number; k: number },
  b: { offset: number; k: number },
): number {
  return a.offset !== b.offset ? a.offset - b.offset : a.k - b.k;
}
