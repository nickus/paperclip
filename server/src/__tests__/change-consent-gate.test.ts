import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  agentInstructionsChangeTargetKey,
  changeConsentGateService,
  instructionsFileChangeMatchesWrite,
  instructionsFileContentSha256,
  isChangeConsentTargetKey,
  skillChangeTargetKey,
} from "../services/change-consent-gate.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("changeConsentGateService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reflection-coach-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedGateFixture() {
    const companyId = randomUUID();
    const coachId = randomUUID();
    const sourceRunId = randomUUID();
    const proposalIssueId = randomUUID();
    const skillId = randomUUID();
    const targetKey = skillChangeTargetKey(skillId);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: coachId,
      companyId,
      name: "Reflection Coach",
      role: "general",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateSkills: true },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: coachId,
      status: "succeeded",
    });
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review Reflection Coach proposal",
      status: "in_review",
      priority: "medium",
      identifier: "PAP-1",
      issueNumber: 1,
      createdByAgentId: coachId,
    });

    return { companyId, coachId, sourceRunId, proposalIssueId, skillId, targetKey };
  }

  it("rejects Reflection Coach skill mutation without an accepted bound interaction", async () => {
    const { companyId, coachId, targetKey } = await seedGateFixture();

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  it("rejects accepted interactions from the same run as the apply mutation", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: sourceRunId,
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  it("allows a previous-run accepted interaction with a displayed diff for the bound target", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });
    const actorRunId = randomUUID();

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId,
      targetKeys: [targetKey],
    })).resolves.toBe(true);

    const [stored] = await db
      .select({ result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));

    expect(stored?.result).toMatchObject({
      consumedByRunId: actorRunId,
      outcome: "accepted",
      version: 1,
    });
    expect((stored?.result as { consumedAt?: unknown } | undefined)?.consumedAt).toEqual(expect.any(String));
  });

  it("rejects reusing an accepted interaction after it is consumed by a mutation", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).resolves.toBe(true);

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  it("allows legacy Reflection Coach target keys for durable accepted interactions", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, skillId, targetKey } = await seedGateFixture();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: `reflection-coach:company-skill:${skillId}`, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).resolves.toBe(true);
  });
  it("recognizes change-consent target keys, including the legacy spellings", () => {
    for (const key of [
      "agent:agent-1:instructions",
      "agent:agent-1:profile",
      "skill:skill-1",
      "skill-slug:review",
      "skill-import:https://example.test/skills",
      "skills:scan-projects",
      "reflection-coach:agent-instructions:agent-1",
    ]) {
      expect(isChangeConsentTargetKey(key), key).toBe(true);
    }
    for (const key of ["", "agent:agent-1", "agent:agent-1:budget", "native_completion_review", "plan", null, 1]) {
      expect(isChangeConsentTargetKey(key), String(key)).toBe(false);
    }
  });

  it("rejects a card resolved by an agent, including the creator itself, or by the system", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    const resolutions = [
      // The creating agent accepted its own card.
      { resolvedByAgentId: coachId, resolvedByUserId: null },
      // A system resolution names nobody.
      { resolvedByAgentId: null, resolvedByUserId: null },
      // An agent id always disqualifies the row, even next to a user id.
      { resolvedByAgentId: coachId, resolvedByUserId: "board-user" },
    ];
    for (const resolution of resolutions) {
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId,
        issueId: proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId,
        createdByAgentId: coachId,
        payload: {
          version: 1,
          prompt: "Apply this skill diff?",
          detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
          target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
        },
        result: { version: 1, outcome: "accepted" },
        ...resolution,
        resolvedAt: new Date(),
      });
    }

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });

    const stored = await db
      .select({ result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.companyId, companyId));
    expect(stored).toHaveLength(resolutions.length);
    for (const row of stored) {
      expect(row.result).not.toHaveProperty("consumedByRunId");
    }
  });

  it("counts only a board user's acceptance of a card created through the interaction service", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId } = await seedGateFixture();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId,
      name: "Target agent",
      role: "general",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const targetKey = agentInstructionsChangeTargetKey(targetAgentId);
    const interactions = issueThreadInteractionService(db);
    const issue = { id: proposalIssueId, companyId, goalId: null, projectId: null };
    const cardInput = {
      kind: "request_confirmation" as const,
      continuationPolicy: "wake_assignee_on_accept" as const,
      // Asking for the widest policy does not let an agent resolve the card.
      resolverPolicy: "anyone" as const,
      sourceRunId,
      payload: {
        version: 1 as const,
        prompt: "Apply this instructions change?",
        detailsMarkdown: "```diff\n-old rule\n+new rule\n```",
        target: { type: "custom" as const, key: targetKey },
        instructionsFileChange: {
          path: "AGENTS.md",
          contentSha256: createHash("sha256").update("new rule\n").digest("hex"),
        },
      },
    };
    const coachInProposalRun = { agentId: coachId, runId: sourceRunId };

    const card = await interactions.create(issue, cardInput, coachInProposalRun);
    expect(card).toMatchObject({
      status: "pending",
      effectiveResolverPolicy: "human_only",
      effectiveResolverPolicySource: "governed_action",
    });
    await expect(interactions.acceptInteraction(issue, card.id, {}, coachInProposalRun)).rejects.toMatchObject({
      status: 403,
      details: { code: "interaction_human_only" },
    });

    // A card stored before the clamp keeps the `anyone` policy, so its creator
    // can still accept it. That acceptance is not consent.
    await db
      .update(issueThreadInteractions)
      .set({ effectiveResolverPolicy: "anyone", effectiveResolverPolicySource: "requested" })
      .where(eq(issueThreadInteractions.id, card.id));
    const selfAccepted = await interactions.acceptInteraction(issue, card.id, {}, coachInProposalRun);
    expect(selfAccepted.interaction).toMatchObject({
      status: "accepted",
      resolvedByAgentId: coachId,
      resolvedByUserId: null,
    });
    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });

    // The same change accepted by a board user is consent for a later run.
    const secondCard = await interactions.create(
      issue,
      { ...cardInput, payload: { ...cardInput.payload, prompt: "Apply this instructions change (again)?" } },
      coachInProposalRun,
    );
    const boardAccepted = await interactions.acceptInteraction(issue, secondCard.id, {}, { userId: "board-user" });
    expect(boardAccepted.interaction).toMatchObject({ status: "accepted", resolvedByUserId: "board-user" });
    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).resolves.toBe(true);
  });
  describe("a card bound to an agent's instructions names the write it allows", () => {
    async function seedInstructionsCardFixture() {
      const fixture = await seedGateFixture();
      const targetAgentId = randomUUID();
      await db.insert(agents).values({
        id: targetAgentId,
        companyId: fixture.companyId,
        name: "Target agent",
        role: "general",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const issue = { id: fixture.proposalIssueId, companyId: fixture.companyId, goalId: null, projectId: null };
      const create = (payload: Record<string, unknown>) =>
        issueThreadInteractionService(db).create(
          issue,
          {
            kind: "request_confirmation",
            continuationPolicy: "wake_assignee_on_accept",
            sourceRunId: fixture.sourceRunId,
            payload: {
              version: 1,
              prompt: "Apply this instructions change?",
              detailsMarkdown: "```diff\n--- a/AGENTS.md\n+++ b/AGENTS.md\n+New rule.\n```",
              target: { type: "custom", key: agentInstructionsChangeTargetKey(targetAgentId) },
              ...payload,
            },
          } as never,
          { agentId: fixture.coachId, runId: fixture.sourceRunId },
        );
      return { ...fixture, targetAgentId, create };
    }

    const newRuleSha256 = instructionsFileContentSha256("New rule.\n");

    it("refuses a card that does not name its write, or names one it cannot allow", async () => {
      const { create } = await seedInstructionsCardFixture();

      await expect(create({})).rejects.toMatchObject({
        status: 422,
        details: { code: "instructions_file_change_required" },
      });
      await expect(create({
        instructionsFileChange: { path: "../outside.md", contentSha256: newRuleSha256 },
      })).rejects.toMatchObject({ status: 422 });
      await expect(create({
        instructionsFileChange: { path: "promptTemplate.legacy.md", contentSha256: newRuleSha256 },
      })).rejects.toMatchObject({
        status: 422,
        details: { code: "instructions_file_change_legacy_prompt_template" },
      });
      // The card's diff must show the named file.
      await expect(create({
        instructionsFileChange: { path: "TOOLS.md", contentSha256: newRuleSha256 },
      })).rejects.toMatchObject({
        status: 422,
        details: { code: "instructions_file_change_diff_required" },
      });
      await expect(create({
        detailsMarkdown: "Adds a new rule.",
        instructionsFileChange: { path: "AGENTS.md", contentSha256: newRuleSha256 },
      })).rejects.toMatchObject({
        status: 422,
        details: { code: "instructions_file_change_diff_required" },
      });
      // A hash that is not a SHA-256 fails validation.
      await expect(create({
        instructionsFileChange: { path: "AGENTS.md", contentSha256: "abc123" },
      })).rejects.toThrow(/contentSha256/);
    });

    it("refuses a proposal on a card for another target", async () => {
      const { create, skillId } = await seedInstructionsCardFixture();

      await expect(create({
        target: { type: "custom", key: skillChangeTargetKey(skillId) },
        instructionsFileChange: { path: "AGENTS.md", contentSha256: newRuleSha256 },
      })).rejects.toMatchObject({
        status: 422,
        details: { code: "instructions_file_change_target_required" },
      });
    });

    it("stores the proposal normalized, as the write route compares it", async () => {
      const { create } = await seedInstructionsCardFixture();

      const card = await create({
        instructionsFileChange: { path: " ./docs/../AGENTS.md ", contentSha256: newRuleSha256.toUpperCase() },
      });

      expect(card.payload).toMatchObject({
        instructionsFileChange: {
          version: 1,
          path: "AGENTS.md",
          contentSha256: newRuleSha256,
          clearLegacyPromptTemplate: false,
        },
      });
      const write = { path: "AGENTS.md", contentSha256: newRuleSha256, clearLegacyPromptTemplate: false };
      const proposal = (card.payload as { instructionsFileChange?: Parameters<typeof instructionsFileChangeMatchesWrite>[0] })
        .instructionsFileChange;
      expect(instructionsFileChangeMatchesWrite(proposal, write)).toBe(true);
      expect(instructionsFileChangeMatchesWrite(proposal, { ...write, path: "TOOLS.md" })).toBe(false);
      expect(instructionsFileChangeMatchesWrite(proposal, {
        ...write,
        contentSha256: instructionsFileContentSha256("New rule. \n"),
      })).toBe(false);
      expect(instructionsFileChangeMatchesWrite(proposal, { ...write, clearLegacyPromptTemplate: true })).toBe(false);
      expect(instructionsFileChangeMatchesWrite(undefined, write)).toBe(false);
    });
  });
});
