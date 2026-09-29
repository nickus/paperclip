import path from "node:path";

/**
 * Binds an instruction file write to the diff its change-consent card showed.
 *
 * A board user accepts a `request_confirmation` after reading the diff in its
 * `detailsMarkdown`. The write the card later allows must be that change, not
 * any change to the same agent. The card shows its change in fenced ```diff
 * blocks. A block may name its file with unified diff headers (`--- a/<path>`
 * followed by `+++ b/<path>`); lines before the first header of a block belong
 * to the bundle's entry file. A line starting with `+` is shown as added and a
 * line starting with `-` as removed; hunk headers, `diff --git` and `index`
 * lines and context lines are ignored.
 *
 * A write matches the card when it is the diff's change and nothing else:
 * comparing trimmed non-blank lines, each line's count in the file goes up or
 * down by exactly the number of times the diff shows it as added, less the
 * number of times it shows it as removed. So every line the write adds or
 * removes was shown, and the write cannot apply only part of what was shown.
 * A line that moves shows as both removed and added, which nets to no change.
 * A diff made against an older version of the file does not match.
 *
 * Only what the board user was shown counts: HTML comments, which the card
 * renderer drops, are skipped, and a fence inside one is not read. Line order
 * and indentation are not compared, so a write may still reorder or re-indent
 * lines the file already has.
 */

export interface DisplayedDiffSection {
  /**
   * The file paths the section's header names (with and without the `a/` or
   * `b/` prefix). Empty for lines before any header, which belong to the
   * bundle's entry file.
   */
  paths: string[];
  added: string[];
  removed: string[];
}

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})[ \t]*diff(?:[ \t].*)?$/i;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

function indentWidth(line: string) {
  return line.length - line.trimStart().length;
}

function stripIndent(line: string, width: number) {
  let index = 0;
  while (index < width && index < line.length && (line[index] === " " || line[index] === "\t")) index += 1;
  return line.slice(index);
}

function normalizeDisplayedPath(value: string) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\/+/, "");
}

function headerPaths(raw: string): string[] {
  let value = raw.split("\t")[0]!.trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
  if (!value || value === "/dev/null") return [];
  const candidates = new Set([normalizeDisplayedPath(value)]);
  // Git prefixes both sides with a/ and b/; a bundle may also have a real
  // directory with that name, so keep both spellings.
  if (value.startsWith("a/") || value.startsWith("b/")) candidates.add(normalizeDisplayedPath(value.slice(2)));
  return [...candidates].filter((candidate) => candidate.length > 0 && candidate !== ".");
}

function readDiffBlock(lines: string[], sections: DisplayedDiffSection[]) {
  let current: DisplayedDiffSection | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (line.startsWith("--- ") && next !== undefined && next.startsWith("+++ ")) {
      // New file: `--- /dev/null`, `+++ b/<path>`. Removed file: the other way round.
      const newPaths = headerPaths(next.slice(4));
      const paths = newPaths.length > 0 ? newPaths : headerPaths(line.slice(4));
      // A header that names no usable path still opens a section, bound to no
      // file, so the lines under it never count for the entry file.
      current = { paths: paths.length > 0 ? paths : ["/dev/null"], added: [], removed: [] };
      sections.push(current);
      index += 1;
      continue;
    }
    if (line.startsWith("@@") || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("\\")) {
      continue;
    }
    const marker = line[0];
    if (marker !== "+" && marker !== "-") continue;
    if (!current) {
      current = { paths: [], added: [], removed: [] };
      sections.push(current);
    }
    (marker === "+" ? current.added : current.removed).push(line.slice(1));
  }
}

/**
 * The file sections of every fenced ```diff block a card displays.
 *
 * The reading errs towards not counting a line: a line is read only when the
 * card renderer certainly shows it. Nothing after an HTML comment opener is
 * read until the comment closes, since the renderer drops comments. A fence
 * opened with indentation ends at the first non-blank line indented less,
 * where the list item or indented block that holds it ends.
 */
export function parseDisplayedDiff(markdown: string | null | undefined): DisplayedDiffSection[] {
  const sections: DisplayedDiffSection[] = [];
  if (!markdown) return sections;
  const lines = markdown.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const commentStart = line.indexOf("<!--");
    if (commentStart >= 0) {
      let closed = line.indexOf("-->", commentStart + 4) >= 0;
      index += 1;
      while (!closed && index < lines.length) {
        closed = lines[index]!.includes("-->");
        index += 1;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    const indent = open?.[1]?.length ?? 0;
    const fence = open?.[2] ?? "";
    // A backtick in a backtick fence's info string makes the line inline code.
    if (!open || (fence[0] === "`" && line.slice(indent + fence.length).includes("`"))) {
      index += 1;
      continue;
    }
    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      const bodyLine = lines[index]!;
      const close = FENCE_CLOSE.exec(bodyLine);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        index += 1;
        break;
      }
      if (indent > 0 && bodyLine.trim().length > 0 && indentWidth(bodyLine) < indent) break;
      body.push(stripIndent(bodyLine, indent));
      index += 1;
    }
    readDiffBlock(body, sections);
  }
  return sections;
}

function countLines(lines: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a write of `nextContent` to the bundle file `filePath` (normalized)
 * is the change the card's displayed diff shows. `previousContent` is the
 * file's content before the write, or null when the write creates it.
 */
export function displayedDiffCoversFileWrite(input: {
  detailsMarkdown: string | null | undefined;
  filePath: string;
  entryFile: string;
  previousContent: string | null;
  nextContent: string;
}): boolean {
  const seen = new Set<string>();
  const sections = parseDisplayedDiff(input.detailsMarkdown).filter((section) => {
    const applies = section.paths.length === 0 ? input.filePath === input.entryFile : section.paths.includes(input.filePath);
    if (!applies) return false;
    // A card that repeats the same diff (say, once more in a summary) shows
    // one change, not two.
    const key = JSON.stringify([section.added, section.removed]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (sections.length === 0) return false;

  const shownAdded = countLines(sections.flatMap((section) => section.added));
  const shownRemoved = countLines(sections.flatMap((section) => section.removed));
  const before = countLines((input.previousContent ?? "").split(/\r?\n/));
  const after = countLines(input.nextContent.split(/\r?\n/));

  const lines = new Set([...before.keys(), ...after.keys(), ...shownAdded.keys(), ...shownRemoved.keys()]);
  for (const line of lines) {
    const written = (after.get(line) ?? 0) - (before.get(line) ?? 0);
    const shown = (shownAdded.get(line) ?? 0) - (shownRemoved.get(line) ?? 0);
    if (written !== shown) return false;
  }
  return true;
}
