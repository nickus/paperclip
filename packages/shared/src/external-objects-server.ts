import { createHash } from "node:crypto";
import { parseIssueReferenceHref } from "./issue-references.js";
import type {
  ExternalObjectCanonicalIdentity,
  ExternalObjectCanonicalUrl,
  ExternalObjectMentionSource,
  ExternalObjectUrlCanonicalizationOptions,
  ExternalObjectUrlMatch,
} from "./external-objects.js";

const EXTERNAL_URL_TOKEN_RE = /https?:\/\/[^\s<>()]+/gi;

function preserveNewlinesAsWhitespace(value: string) {
  return value.replace(/[^\n]/g, " ");
}

function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";

  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const remaining = markdown.slice(index);
    const fenceMatch = /^(?:```+|~~~+)/.exec(remaining);
    const atLineStart = index === 0 || markdown[index - 1] === "\n";

    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!;
      const blockStart = index;
      index += fence.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;

      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n";
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }

      output += preserveNewlinesAsWhitespace(markdown.slice(blockStart, index));
      continue;
    }

    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index));
      continue;
    }

    output += markdown[index]!;
    index += 1;
  }

  return output;
}

const TRAILING_TRIM_CHARS = ".,!?;:)]";

function trimTrailingPunctuation(token: string): string {
  // '(' and '[' are never trimmed by this function, so their counts over the
  // whole token stay constant while we walk backwards; ')' and ']' only ever
  // get removed (never added), so a running count avoids re-scanning the
  // shrinking string on every iteration (that used to make this O(n^2) on
  // input like a URL followed by many trailing ')' characters).
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  for (let i = 0; i < token.length; i += 1) {
    switch (token[i]) {
      case "(": openParen += 1; break;
      case ")": closeParen += 1; break;
      case "[": openBracket += 1; break;
      case "]": closeBracket += 1; break;
    }
  }

  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    if (!TRAILING_TRIM_CHARS.includes(last)) break;

    if (last === ")") {
      if (openParen >= closeParen) break;
      closeParen -= 1;
    } else if (last === "]") {
      if (openBracket >= closeBracket) break;
      closeBracket -= 1;
    }
    end -= 1;
  }
  return token.slice(0, end);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePathname(pathname: string): string {
  return pathname || "/";
}

export function findExternalObjectUrlMatches(markdown: string): ExternalObjectUrlMatch[] {
  if (!markdown) return [];

  const scrubbed = stripMarkdownCode(markdown);
  const matches: ExternalObjectUrlMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(EXTERNAL_URL_TOKEN_RE);

  while ((match = re.exec(scrubbed)) !== null) {
    const matchedText = trimTrailingPunctuation(match[0]);
    if (!matchedText || parseIssueReferenceHref(matchedText)) continue;

    matches.push({
      index: match.index,
      length: matchedText.length,
      matchedText,
    });
  }

  return matches;
}

export function canonicalizeExternalObjectUrl(
  value: string,
  options: ExternalObjectUrlCanonicalizationOptions = {},
): ExternalObjectCanonicalUrl | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const scheme = url.protocol === "https:" ? "https" : "http";
  const path = normalizePathname(url.pathname);
  const sanitizedCanonicalUrl = `${scheme}://${url.host.toLowerCase()}${path}`;
  const identityQueryParams = new Set(options.identityQueryParams ?? []);
  const queryParamHashes: Record<string, string> = {};

  for (const key of [...identityQueryParams].sort()) {
    const values = url.searchParams.getAll(key);
    if (values.length === 0) continue;
    queryParamHashes[key] = sha256Hex(values.join("\u0000"));
  }

  const canonicalIdentity: ExternalObjectCanonicalIdentity = {
    scheme,
    host: url.host.toLowerCase(),
    path,
    ...(Object.keys(queryParamHashes).length > 0 ? { queryParamHashes } : {}),
  };

  return {
    sanitizedCanonicalUrl,
    sanitizedDisplayUrl: sanitizedCanonicalUrl,
    canonicalIdentity,
    canonicalIdentityHash: sha256Hex(stableStringify(canonicalIdentity)),
    redactedMatchedText: sanitizedCanonicalUrl,
  };
}

export function extractExternalObjectCanonicalUrls(
  markdown: string,
  options: ExternalObjectUrlCanonicalizationOptions = {},
): ExternalObjectCanonicalUrl[] {
  const seen = new Set<string>();
  const ordered: ExternalObjectCanonicalUrl[] = [];

  for (const match of findExternalObjectUrlMatches(markdown)) {
    const canonical = canonicalizeExternalObjectUrl(match.matchedText, options);
    if (!canonical || seen.has(canonical.canonicalIdentityHash)) continue;
    seen.add(canonical.canonicalIdentityHash);
    ordered.push(canonical);
  }

  return ordered;
}

export function buildExternalObjectScopedIdentityKey(args: {
  companyId: string;
  providerKey: string;
  objectType: string;
  canonicalIdentityHash: string;
}): string {
  return [args.companyId, args.providerKey, args.objectType, args.canonicalIdentityHash].join(":");
}

export function buildExternalObjectMentionSourceKey(source: Required<Pick<
  ExternalObjectMentionSource,
  "companyId" | "sourceIssueId" | "sourceKind"
>> & ExternalObjectMentionSource): string {
  return [
    source.companyId,
    source.sourceIssueId,
    source.sourceKind,
    source.sourceRecordId ?? "",
    source.documentKey ?? "",
    source.propertyKey ?? "",
  ].join(":");
}
