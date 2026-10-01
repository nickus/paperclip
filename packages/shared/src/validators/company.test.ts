import { describe, expect, it } from "vitest";
import {
  companyExecutionWorkspaceDefaultsSchema,
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "./company.js";
import { portabilityCompanyManifestEntrySchema } from "./company-portability.js";

describe("company schemas without the retired settings", () => {
  it("strips brandColor and attachmentMaxBytes from a create payload", () => {
    const parsed = createCompanySchema.parse({
      name: "Acme",
      brandColor: "#123456",
      attachmentMaxBytes: 25_000_000,
    });

    expect(parsed).not.toHaveProperty("brandColor");
    expect(parsed).not.toHaveProperty("attachmentMaxBytes");
    expect(parsed.name).toBe("Acme");
  });

  it("strips brandColor and attachmentMaxBytes from an update payload", () => {
    const parsed = updateCompanySchema.parse({
      description: "Updated",
      brandColor: "#123456",
      attachmentMaxBytes: 25_000_000,
    });

    expect(parsed).not.toHaveProperty("brandColor");
    expect(parsed).not.toHaveProperty("attachmentMaxBytes");
    expect(parsed.description).toBe("Updated");
  });

  it("rejects brandColor on the strict branding schema", () => {
    const result = updateCompanyBrandingSchema.safeParse({
      name: "Acme",
      brandColor: "#123456",
    });

    expect(result.success).toBe(false);
  });

  it("still accepts the remaining branding fields", () => {
    const result = updateCompanyBrandingSchema.safeParse({
      name: "Acme",
      description: null,
      logoAssetId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.success).toBe(true);
  });

  it("requires at least one branding field", () => {
    expect(updateCompanyBrandingSchema.safeParse({}).success).toBe(false);
  });
});

describe("portability company manifest tolerance", () => {
  it("accepts a legacy manifest entry carrying the retired keys and ignores them", () => {
    const parsed = portabilityCompanyManifestEntrySchema.parse({
      path: "company.md",
      name: "Acme",
      description: null,
      brandColor: "#5c5fff",
      logoPath: null,
      attachmentMaxBytes: 25_000_000,
      requireBoardApprovalForNewAgents: false,
    });

    expect(parsed).not.toHaveProperty("brandColor");
    expect(parsed).not.toHaveProperty("attachmentMaxBytes");
    expect(parsed.name).toBe("Acme");
  });
});

describe("company execution workspace defaults", () => {
  it("accepts each shared-workspace concurrency value on the update schema", () => {
    for (const value of ["auto", "serialize", "allow"] as const) {
      expect(
        updateCompanySchema.parse({ executionWorkspaceDefaults: { sharedWorkspaceConcurrency: value } })
          .executionWorkspaceDefaults,
      ).toEqual({ sharedWorkspaceConcurrency: value });
    }
  });

  it("accepts an empty object to clear the defaults and leaves the field out when absent", () => {
    expect(updateCompanySchema.parse({ executionWorkspaceDefaults: {} }).executionWorkspaceDefaults).toEqual({});
    expect(updateCompanySchema.parse({ name: "Acme" })).not.toHaveProperty("executionWorkspaceDefaults");
  });

  it.each([
    ["an unknown concurrency value", { sharedWorkspaceConcurrency: "parallel" }],
    ["a null concurrency value", { sharedWorkspaceConcurrency: null }],
    ["a non-string concurrency value", { sharedWorkspaceConcurrency: true }],
    ["a misspelled key", { sharedWorkspaceConcurency: "allow" }],
    ["a bare string", "allow"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(updateCompanySchema.safeParse({ executionWorkspaceDefaults: value }).success).toBe(false);
    expect(companyExecutionWorkspaceDefaultsSchema.safeParse(value).success).toBe(false);
  });

  it("is not a branding field", () => {
    expect(
      updateCompanyBrandingSchema.safeParse({
        name: "Acme",
        executionWorkspaceDefaults: { sharedWorkspaceConcurrency: "allow" },
      }).success,
    ).toBe(false);
  });
});
