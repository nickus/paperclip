import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

// Covers issueService().isBacklogFromUnassignedCreationDefault directly: the
// signal the PATCH /issues/:id route uses to decide whether assigning an
// issue that create() parked in "backlog" for lack of an assignee should also
// move it to "todo" (see resolveCreateIssueStatusDefault and the route's
// assignment-time default). These assertions fail outright on the
// unpatched service, since the method does not exist there.
describeEmbeddedPostgres("issueService.isBacklogFromUnassignedCreationDefault", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-issue-backlog-default-",
    );
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unassigned issue",
      status: "backlog",
      priority: "medium",
    });
    return issueId;
  }

  it("is true for an issue still sitting in the unassigned-creation backlog default", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.created",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "backlog",
        statusDefaulted: true,
        statusDefaultReason: "unassigned_omitted_status",
      },
    });

    await expect(
      svc.isBacklogFromUnassignedCreationDefault(issueId),
    ).resolves.toBe(true);
  });

  it("is false when the issue was explicitly created in backlog", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.created",
      entityType: "issue",
      entityId: issueId,
      details: {
        status: "backlog",
        statusDefaulted: false,
        statusDefaultReason: "explicit",
      },
    });

    await expect(
      svc.isBacklogFromUnassignedCreationDefault(issueId),
    ).resolves.toBe(false);
  });

  it("is false once a user has explicitly chosen backlog for the issue since creation", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.created",
        entityType: "issue",
        entityId: issueId,
        details: {
          status: "backlog",
          statusDefaulted: true,
          statusDefaultReason: "unassigned_omitted_status",
        },
      },
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "backlog", statusExplicit: true },
      },
    ]);

    await expect(
      svc.isBacklogFromUnassignedCreationDefault(issueId),
    ).resolves.toBe(false);
  });

  it("is false for an issue with no issue.created activity on record", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);

    await expect(
      svc.isBacklogFromUnassignedCreationDefault(issueId),
    ).resolves.toBe(false);
  });
});
