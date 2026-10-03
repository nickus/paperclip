import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractSkillMentionIds,
  extractUserMentionIds,
  linkPlainAgentMentions,
  parseAgentMentionHref,
  parseProjectMentionHref,
  parseRoutineMentionHref,
  parseSkillMentionHref,
  parseUserMentionHref,
  type LinkablePlainMentionAgent,
} from "./project-mentions.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Paperclip App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
  });

  it("round-trips user mentions", () => {
    const href = buildUserMentionHref("user-123");
    expect(parseUserMentionHref(href)).toEqual({
      userId: "user-123",
    });
    expect(extractUserMentionIds(`[@Taylor](${href})`)).toEqual(["user-123"]);
  });

  it("round-trips skill mentions with slug metadata", () => {
    const href = buildSkillMentionHref("skill-123", "release-changelog");
    expect(parseSkillMentionHref(href)).toEqual({
      skillId: "skill-123",
      slug: "release-changelog",
    });
    expect(extractSkillMentionIds(`[/release-changelog](${href})`)).toEqual(["skill-123"]);
  });

  it("round-trips routine mentions", () => {
    const href = buildRoutineMentionHref("routine-123");
    expect(parseRoutineMentionHref(href)).toEqual({
      routineId: "routine-123",
    });
    expect(extractRoutineMentionIds(`[/routine:Weekly review](${href})`)).toEqual(["routine-123"]);
  });
});

describe("linkPlainAgentMentions", () => {
  const PM: LinkablePlainMentionAgent = { id: "agent-pm", name: "Product Manager" };
  const QA: LinkablePlainMentionAgent = { id: "agent-qa", name: "QA Engineer" };
  const QA_HARNESS: LinkablePlainMentionAgent = { id: "agent-qa-harness", name: "QA Harness Engineer" };
  const ARCHITECT: LinkablePlainMentionAgent = { id: "agent-architect", name: "Architect" };
  const ARCHITECT_REVIEWER: LinkablePlainMentionAgent = { id: "agent-architect-reviewer", name: "Architect Reviewer" };

  function pmLink(): string {
    return `[@Product Manager](${buildAgentMentionHref(PM.id)})`;
  }

  it("links a plain-text mention of an agent's exact name", () => {
    const result = linkPlainAgentMentions("please file this with @Product Manager", [PM]);
    expect(result.markdown).toBe(`please file this with ${pmLink()}`);
    expect(result.linkedAgentIds).toEqual([PM.id]);
  });

  it.each([":", ",", ".", ")"])("links a mention followed by trailing %j punctuation", (punct) => {
    const result = linkPlainAgentMentions(`@Product Manager${punct} thanks`, [PM]);
    expect(result.markdown).toBe(`${pmLink()}${punct} thanks`);
  });

  it("matches agent names case-insensitively", () => {
    const result = linkPlainAgentMentions("ping @product MANAGER please", [PM]);
    expect(result.markdown).toBe(`ping ${pmLink()} please`);
  });

  it("does not match a longer word that merely starts with the agent name", () => {
    const result = linkPlainAgentMentions("@QA Engineers should look at this", [QA]);
    expect(result.markdown).toBe("@QA Engineers should look at this");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("prefers the longest matching name when one name prefixes another", () => {
    const harnessResult = linkPlainAgentMentions("@QA Harness Engineer, please check", [QA, QA_HARNESS]);
    expect(harnessResult.markdown).toBe(
      `[@QA Harness Engineer](${buildAgentMentionHref(QA_HARNESS.id)}), please check`,
    );
    expect(harnessResult.linkedAgentIds).toEqual([QA_HARNESS.id]);

    const reviewerResult = linkPlainAgentMentions(
      "@Architect Reviewer approved, cc @Architect",
      [ARCHITECT, ARCHITECT_REVIEWER],
    );
    expect(reviewerResult.markdown).toBe(
      `[@Architect Reviewer](${buildAgentMentionHref(ARCHITECT_REVIEWER.id)}) approved, cc [@Architect](${buildAgentMentionHref(ARCHITECT.id)})`,
    );
    expect(reviewerResult.linkedAgentIds.sort()).toEqual([ARCHITECT.id, ARCHITECT_REVIEWER.id].sort());
  });

  it("leaves a name shared by two or more agents as plain text", () => {
    const duplicate: LinkablePlainMentionAgent = { id: "agent-other-qa", name: "qa engineer" };
    const result = linkPlainAgentMentions("@QA Engineer please pick this up", [QA, duplicate]);
    expect(result.markdown).toBe("@QA Engineer please pick this up");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("does not match an '@' that is part of an email address", () => {
    const result = linkPlainAgentMentions(
      "contact pm@Product Manager or user@example.com for details",
      [PM],
    );
    expect(result.markdown).toBe("contact pm@Product Manager or user@example.com for details");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("does not match inside an inline code span", () => {
    const result = linkPlainAgentMentions("run `@Product Manager` as a literal example", [PM]);
    expect(result.markdown).toBe("run `@Product Manager` as a literal example");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it.each(["```", "~~~"])("does not match inside a %s fenced code block", (fence) => {
    const markdown = `before\n${fence}\n@Product Manager\n${fence}\nafter @Product Manager`;
    const result = linkPlainAgentMentions(markdown, [PM]);
    expect(result.markdown).toBe(`before\n${fence}\n@Product Manager\n${fence}\nafter ${pmLink()}`);
    expect(result.linkedAgentIds).toEqual([PM.id]);
  });

  it("does not re-link an already-structured mention link", () => {
    const already = pmLink();
    const result = linkPlainAgentMentions(already, [PM]);
    expect(result.markdown).toBe(already);
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("does not match inside the text of a regular markdown link", () => {
    const result = linkPlainAgentMentions("[ask @Product Manager](https://example.com/issues/1)", [PM]);
    expect(result.markdown).toBe("[ask @Product Manager](https://example.com/issues/1)");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("does not match inside image alt text", () => {
    const result = linkPlainAgentMentions("![@Product Manager avatar](https://example.com/a.png)", [PM]);
    expect(result.markdown).toBe("![@Product Manager avatar](https://example.com/a.png)");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("does not match inside an autolink", () => {
    const scout: LinkablePlainMentionAgent = { id: "agent-scout", name: "Scout" };
    const result = linkPlainAgentMentions("see <@Scout> for the raw reference", [scout]);
    expect(result.markdown).toBe("see <@Scout> for the raw reference");
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("does not match on a blockquote line", () => {
    const markdown = "> earlier, @Product Manager said this\nnew reply to @Product Manager";
    const result = linkPlainAgentMentions(markdown, [PM]);
    expect(result.markdown).toBe(`> earlier, @Product Manager said this\nnew reply to ${pmLink()}`);
    expect(result.linkedAgentIds).toEqual([PM.id]);
  });

  it("escapes regex metacharacters in an agent name", () => {
    const weird: LinkablePlainMentionAgent = { id: "agent-weird", name: "Q&A (Lead)" };
    const result = linkPlainAgentMentions("ping @Q&A (Lead) about this", [weird]);
    expect(result.markdown).toBe(`ping [@Q&A (Lead)](${buildAgentMentionHref(weird.id)}) about this`);
    expect(result.linkedAgentIds).toEqual([weird.id]);
  });

  it("matches a unicode agent name", () => {
    const unicode: LinkablePlainMentionAgent = { id: "agent-unicode", name: "Ágéntö 文档" };
    const result = linkPlainAgentMentions("cc @Ágéntö 文档 for review", [unicode]);
    expect(result.markdown).toBe(`cc [@Ágéntö 文档](${buildAgentMentionHref(unicode.id)}) for review`);
    expect(result.linkedAgentIds).toEqual([unicode.id]);
  });

  it("links multiple distinct mentions in one body", () => {
    const result = linkPlainAgentMentions("@Product Manager and @QA Engineer, please sync", [PM, QA]);
    expect(result.markdown).toBe(
      `${pmLink()} and [@QA Engineer](${buildAgentMentionHref(QA.id)}), please sync`,
    );
    expect(result.linkedAgentIds.sort()).toEqual([PM.id, QA.id].sort());
  });

  it("is idempotent", () => {
    const once = linkPlainAgentMentions("@Product Manager please file @QA Engineer too", [PM, QA]);
    const twice = linkPlainAgentMentions(once.markdown, [PM, QA]);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.linkedAgentIds).toEqual([]);
  });

  it("returns the body unchanged when there are no agents", () => {
    const markdown = "@Product Manager please take a look";
    const result = linkPlainAgentMentions(markdown, []);
    expect(result.markdown).toBe(markdown);
    expect(result.linkedAgentIds).toEqual([]);
  });

  it("stays fast on a large body with many '@' characters and ~100 agents", () => {
    const agents: LinkablePlainMentionAgent[] = Array.from({ length: 100 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent Number ${i}`,
    }));
    // ~200KB of prose sprinkled with plain "@word" tokens that don't match any agent name,
    // plus a few genuine mentions, to exercise the mention scan itself at scale.
    const chunk = "lorem ipsum @nobody dolor sit amet user@example.com more-@text-here ";
    const body = chunk.repeat(Math.ceil(200_000 / chunk.length)) + " cc @Agent Number 42 and @Agent Number 7";

    const start = Date.now();
    const result = linkPlainAgentMentions(body, agents);
    const elapsedMs = Date.now() - start;

    expect(result.linkedAgentIds.sort()).toEqual(["agent-42", "agent-7"].sort());
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("stays fast on a body with many distinct, never-closing backtick run lengths", () => {
    // Regression for a catastrophic-backtracking footgun: a backreference-based inline-code
    // regex (`` /(`+)(?:(?!\1)[\s\S])*?\1/g `` ) rescans the remaining text, and backtracks
    // the opening run length, for every backtick run that never finds a same-length closer.
    // A body built from runs of strictly decreasing, pairwise-distinct backtick-run lengths
    // never closes any of them, which drove that pattern well past quadratic (seconds on a
    // ~300KB body, timing out past that). This must stay fast regardless of implementation.
    const parts: string[] = [];
    for (let len = 700; len >= 1; len--) {
      parts.push("`".repeat(len), "x");
    }
    const body = `@Product Manager ${parts.join("")} @Product Manager`;

    const start = Date.now();
    const result = linkPlainAgentMentions(body, [PM]);
    const elapsedMs = Date.now() - start;

    expect(result.linkedAgentIds).toEqual([PM.id]);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
