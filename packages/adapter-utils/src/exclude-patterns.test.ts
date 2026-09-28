import { describe, expect, it } from "vitest";
import {
  APPLEDOUBLE_EXCLUDES,
  excludePatternMatches,
  NESTED_GIT_EXCLUDES,
  shouldExcludePath,
} from "./exclude-patterns.js";

describe("exclude patterns", () => {
  it("matches a plain entry only at the top level, with its descendants", () => {
    expect(shouldExcludePath(".git", [".git"])).toBe(true);
    expect(shouldExcludePath(".git/HEAD", [".git"])).toBe(true);
    expect(shouldExcludePath("third_party/lib/.git/HEAD", [".git"])).toBe(false);
    expect(shouldExcludePath("._notes.md", [".git"])).toBe(false);
  });

  it("matches .git and AppleDouble sidecars at any depth like an unanchored tar exclude", () => {
    const exclude = [...NESTED_GIT_EXCLUDES, ...APPLEDOUBLE_EXCLUDES];
    for (const relative of [
      ".git",
      ".git/config",
      "third_party/lib/.git",
      "third_party/lib/.git/objects/ab/cdef",
      "._top",
      "docs/._notes.md",
      "docs/._resources/data.bin",
    ]) {
      expect(shouldExcludePath(relative, exclude), relative).toBe(true);
    }
    for (const relative of [
      "third_party/lib/index.js",
      "docs/notes.md",
      "docs/a._b",
      "docs/.github/workflows/ci.yml",
      "src/my.git/file",
    ]) {
      expect(shouldExcludePath(relative, exclude), relative).toBe(false);
    }
  });

  it("treats a wildcard segment as one path segment and keeps literal segments literal", () => {
    expect(excludePatternMatches("a/cache-1/x", "*/cache-?")).toBe(true);
    expect(excludePatternMatches("a/cache-10/x", "*/cache-?")).toBe(false);
    expect(excludePatternMatches("a/b/c", "*/a*c")).toBe(false);
    expect(excludePatternMatches("pkg/dist/index.js", "*/dist/*")).toBe(true);
    expect(excludePatternMatches("pkg/distance/index.js", "*/dist/*")).toBe(false);
    expect(excludePatternMatches("a.b/c", "*/a+b")).toBe(false);
  });
});
