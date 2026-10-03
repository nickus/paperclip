export const PROJECT_MENTION_SCHEME = "project://";
export const AGENT_MENTION_SCHEME = "agent://";
export const USER_MENTION_SCHEME = "user://";
export const SKILL_MENTION_SCHEME = "skill://";
export const ROUTINE_MENTION_SCHEME = "routine://";
export const PIPELINE_MENTION_SCHEME = "pipeline://";

const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_RE = /^[0-9a-f]{3}$/i;
const HEX_COLOR_WITH_HASH_RE = /^#[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_WITH_HASH_RE = /^#[0-9a-f]{3}$/i;
const PROJECT_MENTION_LINK_RE = /\[[^\]]*]\((project:\/\/[^)\s]+)\)/gi;
const AGENT_MENTION_LINK_RE = /\[[^\]]*]\((agent:\/\/[^)\s]+)\)/gi;
const USER_MENTION_LINK_RE = /\[[^\]]*]\((user:\/\/[^)\s]+)\)/gi;
const SKILL_MENTION_LINK_RE = /\[[^\]]*]\((skill:\/\/[^)\s]+)\)/gi;
const ROUTINE_MENTION_LINK_RE = /\[[^\]]*]\((routine:\/\/[^)\s]+)\)/gi;
const PIPELINE_MENTION_LINK_RE = /\[[^\]]*]\((pipeline:\/\/[^)\s]+)\)/gi;
const AGENT_ICON_NAME_RE = /^[a-z0-9-]+$/i;
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface ParsedProjectMention {
  projectId: string;
  color: string | null;
}

export interface ParsedAgentMention {
  agentId: string;
  icon: string | null;
}

export interface ParsedUserMention {
  userId: string;
}

export interface ParsedSkillMention {
  skillId: string;
  slug: string | null;
}

export interface ParsedRoutineMention {
  routineId: string;
}

export interface ParsedPipelineMention {
  pipelineId: string;
  stageKey: string | null;
}

function normalizeHexColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (HEX_COLOR_WITH_HASH_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (HEX_COLOR_SHORT_WITH_HASH_RE.test(trimmed)) {
    const raw = trimmed.slice(1).toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  if (HEX_COLOR_SHORT_RE.test(trimmed)) {
    const raw = trimmed.toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  return null;
}

export function buildProjectMentionHref(projectId: string, color?: string | null): string {
  const trimmedProjectId = projectId.trim();
  const normalizedColor = normalizeHexColor(color ?? null);
  if (!normalizedColor) {
    return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}`;
  }
  return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}?c=${encodeURIComponent(normalizedColor.slice(1))}`;
}

export function parseProjectMentionHref(href: string): ParsedProjectMention | null {
  if (!href.startsWith(PROJECT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "project:") return null;

  const projectId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!projectId) return null;

  const color = normalizeHexColor(url.searchParams.get("c") ?? url.searchParams.get("color"));

  return {
    projectId,
    color,
  };
}

export function buildAgentMentionHref(agentId: string, icon?: string | null): string {
  const trimmedAgentId = agentId.trim();
  const normalizedIcon = normalizeAgentIcon(icon ?? null);
  if (!normalizedIcon) {
    return `${AGENT_MENTION_SCHEME}${trimmedAgentId}`;
  }
  return `${AGENT_MENTION_SCHEME}${trimmedAgentId}?i=${encodeURIComponent(normalizedIcon)}`;
}

export function parseAgentMentionHref(href: string): ParsedAgentMention | null {
  if (!href.startsWith(AGENT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "agent:") return null;

  const agentId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!agentId) return null;

  return {
    agentId,
    icon: normalizeAgentIcon(url.searchParams.get("i") ?? url.searchParams.get("icon")),
  };
}

export function buildUserMentionHref(userId: string): string {
  return `${USER_MENTION_SCHEME}${userId.trim()}`;
}

export function parseUserMentionHref(href: string): ParsedUserMention | null {
  if (!href.startsWith(USER_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "user:") return null;

  const userId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!userId) return null;

  return { userId };
}

export function buildSkillMentionHref(skillId: string, slug?: string | null): string {
  const trimmedSkillId = skillId.trim();
  const normalizedSlug = normalizeSkillSlug(slug ?? null);
  if (!normalizedSlug) {
    return `${SKILL_MENTION_SCHEME}${trimmedSkillId}`;
  }
  return `${SKILL_MENTION_SCHEME}${trimmedSkillId}?s=${encodeURIComponent(normalizedSlug)}`;
}

export function parseSkillMentionHref(href: string): ParsedSkillMention | null {
  if (!href.startsWith(SKILL_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "skill:") return null;

  const skillId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!skillId) return null;

  return {
    skillId,
    slug: normalizeSkillSlug(url.searchParams.get("s") ?? url.searchParams.get("slug")),
  };
}

export function buildRoutineMentionHref(routineId: string): string {
  return `${ROUTINE_MENTION_SCHEME}${routineId.trim()}`;
}

export function parseRoutineMentionHref(href: string): ParsedRoutineMention | null {
  if (!href.startsWith(ROUTINE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "routine:") return null;

  const routineId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!routineId) return null;

  return { routineId };
}

export function buildPipelineMentionHref(pipelineId: string, stageKey?: string | null): string {
  const trimmedPipelineId = pipelineId.trim();
  const normalizedStageKey = stageKey?.trim();
  if (!normalizedStageKey) return `${PIPELINE_MENTION_SCHEME}${trimmedPipelineId}`;
  return `${PIPELINE_MENTION_SCHEME}${trimmedPipelineId}?stage=${encodeURIComponent(normalizedStageKey)}`;
}

export function parsePipelineMentionHref(href: string): ParsedPipelineMention | null {
  if (!href.startsWith(PIPELINE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "pipeline:") return null;

  const pipelineId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!pipelineId) return null;

  const stageKey = url.searchParams.get("stage")?.trim() || null;
  return { pipelineId, stageKey };
}

export function extractProjectMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(PROJECT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseProjectMentionHref(match[1]);
    if (parsed) ids.add(parsed.projectId);
  }
  return [...ids];
}

export function extractAgentMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed) ids.add(parsed.agentId);
  }
  return [...ids];
}

export interface LinkablePlainMentionAgent {
  id: string;
  name: string;
}

export interface LinkPlainAgentMentionsResult {
  markdown: string;
  linkedAgentIds: string[];
}

// Matches a run of `` ` `` or `~` characters (3+) opening a fenced code block,
// optionally indented up to 3 spaces, same as CommonMark.
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// `[text](url)` and `![alt](url)` — also matches an already-structured mention link,
// so its text and href are both left alone.
const MARKDOWN_LINK_OR_IMAGE_RE = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const AUTOLINK_RE = /<[^<>\s]+>/g;
const BLOCKQUOTE_LINE_RE = /^[ \t]{0,3}>.*$/gm;
// Preceding/following characters that disqualify a bare "@Name" from being a plain mention:
// anything that could make it part of an email, URL, path, word or markdown link text.
const MENTION_PRECEDING_BOUNDARY = "(?<![A-Za-z0-9_./@[`-])";
const MENTION_FOLLOWING_BOUNDARY = "(?![A-Za-z0-9_-])";

function maskSpan(text: string, start: number, end: number): string {
  // Replaces everything in [start, end) with a neutral placeholder, except newlines, so
  // later passes can't match constructs that straddle an already-protected span while
  // every character offset stays identical to the original string.
  let out = text.slice(0, start);
  for (let i = start; i < end; i++) {
    out += text[i] === "\n" ? "\n" : "\u0000";
  }
  return out + text.slice(end);
}

// Finds fenced code blocks (``` or ~~~, either fence style) as [start, end) ranges. An
// unterminated fence swallows the rest of the document, which is the safe choice: content
// we can no longer parse the structure of should not be scanned for mentions either.
function findFencedCodeRanges(text: string): Array<[number, number]> {
  const lines = text.split("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN_RE.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const fenceChar = open[1][0] === "`" ? "`" : "~";
    const fenceLen = open[1].length;
    const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
    let closeLine = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        closeLine = j;
        break;
      }
    }
    if (closeLine === -1) {
      ranges.push([lineStarts[i], text.length]);
      break;
    }
    ranges.push([lineStarts[i], lineStarts[closeLine] + lines[closeLine].length]);
    i = closeLine + 1;
  }
  return ranges;
}

// Finds backtick-delimited inline code spans of any run length (`` `x` ``, ```` ``x`` ````,
// ...) as [start, end) ranges, with a hand-rolled scan rather than a backreference regex.
// A backreference-based pattern (`` /(`+)(?:(?!\1)[\s\S])*?\1/g `` ) re-scans from scratch,
// and backtracks the opening run length, for every backtick run that never finds a same-
// length closer later in the text; a comment body with many distinct, never-closing run
// lengths (e.g. runs of length 1, 2, 3, ... with no duplicate) drove that pattern well past
// quadratic — seconds on a ~300KB input, timing out past that. This scan instead walks the
// text once; for an opening run it scans forward only until the first run of the SAME length
// (a genuine closer) or gives up at end of text, and either way resumes right after what it
// just scanned, so no suffix of the text is ever rescanned from an earlier start.
function findInlineCodeSpanRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const openStart = i;
    let openEnd = i;
    while (openEnd < n && text[openEnd] === "`") openEnd++;
    const runLen = openEnd - openStart;

    let j = openEnd;
    let closeEnd = -1;
    while (j < n) {
      if (text[j] !== "`") {
        j++;
        continue;
      }
      const runStart2 = j;
      let runEnd2 = j;
      while (runEnd2 < n && text[runEnd2] === "`") runEnd2++;
      if (runEnd2 - runStart2 === runLen) {
        closeEnd = runEnd2;
        break;
      }
      j = runEnd2;
    }

    if (closeEnd === -1) {
      // No same-length run anywhere later: this run can't open a span. Resume right after
      // it — never re-examine the text we already scanned looking for a closer.
      i = openEnd;
      continue;
    }
    ranges.push([openStart, closeEnd]);
    i = closeEnd;
  }
  return ranges;
}

// Collects every span of `markdown` that a plain-text mention must never be read from or
// written into: fenced/inline code, HTML comments, markdown link and image syntax (which
// also covers an already-structured mention link), autolinks, and quoted lines. Ranges are
// found in sequence, masking each newly found span before looking for the next construct,
// so one category's delimiters can't be "seen" through another (e.g. a stray backtick
// inside an HTML comment can't start a bogus code span that leaks outside the comment).
function findProtectedRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let masked = markdown;

  const collect = (found: Array<[number, number]>) => {
    for (const [start, end] of found) {
      ranges.push([start, end]);
      masked = maskSpan(masked, start, end);
    }
  };

  collect(findFencedCodeRanges(masked));
  collect([...masked.matchAll(HTML_COMMENT_RE)].map((m) => [m.index, m.index + m[0].length]));
  collect(findInlineCodeSpanRanges(masked));
  collect([...masked.matchAll(MARKDOWN_LINK_OR_IMAGE_RE)].map((m) => [m.index, m.index + m[0].length]));
  collect([...masked.matchAll(AUTOLINK_RE)].map((m) => [m.index, m.index + m[0].length]));
  collect([...masked.matchAll(BLOCKQUOTE_LINE_RE)].map((m) => [m.index, m.index + m[0].length]));

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds a pattern that matches `name` with any run of whitespace standing in for each
// internal space, so "QA  Engineer" (extra space) or "QA\nEngineer" still counts as a match
// of the agent named "QA Engineer".
function agentNamePattern(name: string): string {
  return name.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
}

/**
 * Rewrites plain-text "@Agent Name" mentions in `markdown` into the canonical structured
 * link (`[@Agent Name](agent://<id>)`) that {@link extractAgentMentionIds} and the UI's
 * mention chip both already understand, so a machine (or human) author who forgets the
 * structured form still wakes the right agent.
 *
 * Matching rules:
 * - The "@" must start the text or be preceded by a character that can't be part of an
 *   email, URL, path, word or existing link text (letters, digits, "_", ".", "-", "/", "@",
 *   "[" and backtick are disqualifying; whitespace and other punctuation are fine).
 * - The name must equal an agent's name case-insensitively (internal whitespace runs count
 *   as one space), and must not be immediately followed by another letter, digit, "_" or
 *   "-" (so "@QA Engineer:" matches "QA Engineer" but "@QA Engineers" does not).
 * - When one candidate name is a prefix of another (e.g. "Architect" / "Architect
 *   Reviewer"), the longest matching name wins.
 * - A name shared by two or more agents (case-insensitively) is ambiguous and is left as
 *   plain text.
 * - Fenced and inline code, HTML comments, existing markdown links/images (including
 *   already-structured mentions), autolinks, and blockquote lines are never read from or
 *   rewritten, so quoting an older comment can't re-wake anyone.
 *
 * Pure and idempotent: running it again on its own output returns the same string, because
 * every mention it writes is itself a markdown link and is therefore left untouched the
 * next time around.
 */
export function linkPlainAgentMentions(
  markdown: string,
  agents: LinkablePlainMentionAgent[],
): LinkPlainAgentMentionsResult {
  if (!markdown || agents.length === 0) return { markdown, linkedAgentIds: [] };

  // Group agents by case-insensitive, whitespace-normalized name. A name shared by two or
  // more agents is ambiguous and must resolve to none of them, not an arbitrary one.
  const byNormalizedName = new Map<string, LinkablePlainMentionAgent>();
  const ambiguousNames = new Set<string>();
  for (const agent of agents) {
    const name = agent.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase().replace(/\s+/g, " ");
    if (ambiguousNames.has(key)) continue;
    if (byNormalizedName.has(key)) {
      byNormalizedName.delete(key);
      ambiguousNames.add(key);
      continue;
    }
    byNormalizedName.set(key, { id: agent.id, name });
  }
  if (byNormalizedName.size === 0) return { markdown, linkedAgentIds: [] };

  // Longest name first, so a name that is a prefix of another candidate (e.g. "Architect"
  // vs. "Architect Reviewer") never shadows the longer, more specific match.
  const candidates = [...byNormalizedName.values()].sort((a, b) => b.name.length - a.name.length);
  const alternation = candidates.map((agent) => agentNamePattern(agent.name)).join("|");
  const mentionRe = new RegExp(
    `${MENTION_PRECEDING_BOUNDARY}@(${alternation})${MENTION_FOLLOWING_BOUNDARY}`,
    "giu",
  );

  const protectedRanges = findProtectedRanges(markdown);
  const overlapsProtectedRange = (start: number, end: number) =>
    protectedRanges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);

  const linkedAgentIds = new Set<string>();
  let result = "";
  let lastIndex = 0;
  for (const match of markdown.matchAll(mentionRe)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlapsProtectedRange(start, end)) continue;
    const key = match[1].replace(/\s+/g, " ").toLowerCase();
    const agent = byNormalizedName.get(key);
    if (!agent) continue;
    result += markdown.slice(lastIndex, start);
    result += `[@${agent.name}](${buildAgentMentionHref(agent.id)})`;
    linkedAgentIds.add(agent.id);
    lastIndex = end;
  }
  result += markdown.slice(lastIndex);

  return { markdown: result, linkedAgentIds: [...linkedAgentIds] };
}

export function extractUserMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(USER_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseUserMentionHref(match[1]);
    if (parsed) ids.add(parsed.userId);
  }
  return [...ids];
}

export function extractSkillMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(SKILL_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseSkillMentionHref(match[1]);
    if (parsed) ids.add(parsed.skillId);
  }
  return [...ids];
}

export function extractRoutineMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(ROUTINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseRoutineMentionHref(match[1]);
    if (parsed) ids.add(parsed.routineId);
  }
  return [...ids];
}

export function extractPipelineMentions(markdown: string): ParsedPipelineMention[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  const mentions: ParsedPipelineMention[] = [];
  const re = new RegExp(PIPELINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parsePipelineMentionHref(match[1]);
    if (!parsed) continue;
    const key = `${parsed.pipelineId}:${parsed.stageKey ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(parsed);
  }
  return mentions;
}

function normalizeAgentIcon(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !AGENT_ICON_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeSkillSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !SKILL_SLUG_RE.test(trimmed)) return null;
  return trimmed;
}
