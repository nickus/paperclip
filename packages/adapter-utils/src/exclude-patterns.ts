export function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

/**
 * Host-side equivalents of the entries every workspace archive leaves out at
 * any depth. Archives are built with `tar --exclude`, whose patterns are
 * unanchored: the `.git` entry (see GIT_ARCHIVE_EXCLUDES) and the AppleDouble
 * `._*` pattern that each archive command adds drop matching entries in every
 * subdirectory. A plain `.git` in a host exclude list only covers the top-level
 * entry, so a host snapshot also needs these to leave out the same paths the
 * archive does.
 */
export const NESTED_GIT_EXCLUDES = ["*/.git"] as const;
export const APPLEDOUBLE_EXCLUDES = ["*/._*"] as const;

const segmentGlobCache = new Map<string, RegExp>();

// A single path segment with `*` or `?` wildcards, which never match `/`.
function segmentGlobMatches(segment: string, glob: string): boolean {
  let pattern = segmentGlobCache.get(glob);
  if (!pattern) {
    const source = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    pattern = new RegExp(`^${source}$`);
    segmentGlobCache.set(glob, pattern);
  }
  return pattern.test(segment);
}

function pathContainsSegmentOrDescendant(relative: string, segment: string): boolean {
  if (!segment.includes("/") && /[*?]/.test(segment)) {
    return relative.split("/").some((part) => segmentGlobMatches(part, segment));
  }
  return relative === segment ||
    relative.startsWith(`${segment}/`) ||
    relative.endsWith(`/${segment}`) ||
    relative.includes(`/${segment}/`);
}

// Whether `pattern` excludes `relative` (a POSIX path relative to the synced
// root). `*/name` and `*/name/*` match `name` at any depth, with its
// descendants; `name` may be one segment with `*`/`?` wildcards, as in `*/._*`.
// `dir/*` matches the descendants of the top-level `dir`. Any other pattern is
// a literal path relative to the root, matched with its descendants.
export function excludePatternMatches(relative: string, pattern: string): boolean {
  if (pattern.startsWith("*/") && pattern.endsWith("/*")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2, -2));
  }
  if (pattern.startsWith("*/")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2));
  }
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return relative.startsWith(`${base}/`);
  }
  return isRelativePathOrDescendant(relative, pattern);
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}
