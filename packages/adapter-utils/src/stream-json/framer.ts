/** A complete stdout line, or the report of a line that exceeded the pending cap. */
export type FramedLine =
  | { kind: "line"; text: string }
  | { kind: "overflow"; droppedChars: number };

/**
 * Joins stdout text across records into complete lines. Adapter output can
 * split a line over several chunks, so a line completes in the record that
 * carries its newline. `\r\n` endings are accepted.
 *
 * A pending line longer than `maxPendingChars` is dropped (and reported once
 * it ends) so memory stays bounded.
 */
export class LineFramer {
  private pending = "";
  private dropping = false;
  private droppedChars = 0;

  constructor(private readonly maxPendingChars: number) {}

  /** Characters held for an unterminated line. */
  get pendingChars(): number {
    return this.pending.length;
  }

  push(text: string): FramedLine[] {
    const out: FramedLine[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      const piece = text.slice(start, newline);
      start = newline + 1;
      if (this.dropping) {
        out.push({ kind: "overflow", droppedChars: this.droppedChars + piece.length });
        this.dropping = false;
        this.droppedChars = 0;
        continue;
      }
      const line = this.pending + piece;
      this.pending = "";
      out.push({ kind: "line", text: line.endsWith("\r") ? line.slice(0, -1) : line });
    }
    const rest = text.slice(start);
    if (this.dropping) {
      this.droppedChars += rest.length;
    } else if (this.pending.length + rest.length > this.maxPendingChars) {
      // Keep nothing of an oversized line; report it when it ends.
      this.dropping = true;
      this.droppedChars = this.pending.length + rest.length;
      this.pending = "";
    } else {
      this.pending += rest;
    }
    return out;
  }

  /** The unterminated tail at the end of the run, if any. */
  flush(): FramedLine | null {
    if (this.dropping) {
      const dropped = this.droppedChars;
      this.dropping = false;
      this.droppedChars = 0;
      return { kind: "overflow", droppedChars: dropped };
    }
    if (this.pending.length === 0) return null;
    const line = this.pending;
    this.pending = "";
    return { kind: "line", text: line.endsWith("\r") ? line.slice(0, -1) : line };
  }
}
