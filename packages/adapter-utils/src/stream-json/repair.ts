// Deterministic repair of JSON lines damaged by log redaction.
//
// The env-assignment redaction replaces an unquoted `NAME_TOKEN=value` with
// `NAME_TOKEN=***REDACTED***`. Inside JSON-escaped text the unquoted value can
// swallow the backslash of a following escape, so `FOO_TOKEN=abc\"` becomes
// `FOO_TOKEN=***REDACTED***"` and the JSON string ends early. Other secret
// patterns can leave a marker right after an escaping backslash
// (`\***REDACTED***`), which is an invalid escape. These fixes put back the
// backslash that was eaten, or escape the dangling one. They run only on
// lines that fail to parse, and stop at the first spelling that parses.

const REDACTED = "***REDACTED***";
const REDACTED_PATTERN = String.raw`\*\*\*REDACTED\*\*\*`;

// `***REDACTED***"` where the quote cannot end a JSON string: the next
// character (after optional whitespace) is not `,`, `}`, `]` or `:`.
const EATEN_ESCAPED_QUOTE_RE = new RegExp(`${REDACTED_PATTERN}"(?!\\s*[,}\\]:])`, "g");
// A redaction marker preceded by an odd run of backslashes is an invalid
// escape (`\*`). An even run is a sequence of escaped backslashes and is valid.
const DANGLING_BACKSLASH_RE = new RegExp(`(\\\\+)${REDACTED_PATTERN}`, "g");

const TRUNCATION_MARKER_RE = /^\[paperclip truncated run log chunk: omitted (\d+) chars\]$/;

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export type ParsedLine =
  | { kind: "json"; text: string; value: unknown; repaired: boolean }
  | { kind: "invalid_json" }
  | { kind: "text" };

/**
 * Parses one stdout line. Lines that look like JSON objects and fail to parse
 * are repaired when the damage is the known redaction damage.
 */
export function parseStdoutLine(line: string): ParsedLine {
  const trimmed = line.trimStart();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return { kind: "text" };
  const direct = tryParse(line);
  if (direct.ok) return { kind: "json", text: line, value: direct.value, repaired: false };
  if (first !== "{" || !line.includes(REDACTED)) return { kind: "invalid_json" };

  let candidate = line.replace(EATEN_ESCAPED_QUOTE_RE, `${REDACTED}\\"`);
  if (candidate !== line) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return { kind: "json", text: candidate, value: parsed.value, repaired: true };
  }
  const next = candidate.replace(DANGLING_BACKSLASH_RE, (match, slashes: string) =>
    slashes.length % 2 === 1 ? `\\${match}` : match,
  );
  if (next !== candidate) {
    candidate = next;
    const parsed = tryParse(candidate);
    if (parsed.ok) return { kind: "json", text: candidate, value: parsed.value, repaired: true };
  }
  return { kind: "invalid_json" };
}

/** The number of omitted characters when `line` is the run-log truncation marker. */
export function readTruncationMarker(line: string): number | null {
  const match = TRUNCATION_MARKER_RE.exec(line.trim());
  return match ? Number(match[1]) : null;
}

/** Lines written by the Paperclip host itself (not by the adapter). */
export function isHostNoticeLine(line: string): boolean {
  return line.startsWith("[paperclip]");
}
