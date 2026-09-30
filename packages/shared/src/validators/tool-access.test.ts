import { describe, expect, it } from "vitest";
import {
  connectionTokenRequestSchema,
  connectToolAppSchema,
  createToolMcpGatewayTokenSchema,
  createToolConnectionSchema,
  startConnectionAuthorizationSchema,
  toolCredentialSecretRefSchema,
  toolRedactedValueSummarySchema,
  toolTransportConfigSchema,
  updateToolConnectionSchema,
} from "./tool-access.js";
import {
  readConfiguredToolContentRetention,
  strictestToolContentRetention,
} from "../tool-content-retention.js";

describe("tool access validators", () => {
  it("treats a gateway token owner note as optional", () => {
    const parsed = createToolMcpGatewayTokenSchema.parse({
      name: "cursor-client",
      clientLabel: "cursor-client",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });

    expect(parsed.ownerNote).toBe("");
  });

  it("defaults connection token subjects to app", () => {
    expect(connectionTokenRequestSchema.parse({})).toEqual({ subject: { type: "app" } });
  });

  it("accepts user subjects, grant selection, and authorization input", () => {
    const request = connectionTokenRequestSchema.parse({
      subject: { type: "user", userId: "user-123" },
      grantId: "11111111-1111-4111-8111-111111111111",
    });
    expect(request.subject).toEqual({ type: "user", userId: "user-123" });
    expect(startConnectionAuthorizationSchema.parse({ subjectUserId: "user-123", scopes: ["read"] })).toEqual({
      subjectUserId: "user-123",
      scopes: ["read"],
    });
  });

  it("accepts multi-key credential annotations", () => {
    const parsed = toolCredentialSecretRefSchema.parse({
      secretId: "11111111-1111-4111-8111-111111111111",
      configPath: "credentials.apiKey",
      keyScope: "production",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(parsed.keyScope).toBe("production");
  });
  it("rejects raw credential-looking fields in transport config", () => {
    const parsed = toolTransportConfigSchema.safeParse({
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer raw-token",
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it("accepts a bounded default tool-call timeout on connection config", () => {
    for (const toolTimeoutMs of [1_000, 45_000, 300_000]) {
      expect(toolTransportConfigSchema.safeParse({ url: "https://example.test/mcp", toolTimeoutMs }).success).toBe(true);
    }
    expect(createToolConnectionSchema.parse({
      name: "Slow answers",
      transport: "mcp_remote",
      config: { url: "https://example.test/mcp", toolTimeoutMs: 120_000 },
    }).config).toEqual({ url: "https://example.test/mcp", toolTimeoutMs: 120_000 });
    expect(updateToolConnectionSchema.parse({
      config: { url: "https://example.test/mcp", toolTimeoutMs: 300_000 },
    }).config?.toolTimeoutMs).toBe(300_000);
  });

  it("accepts a content retention mode on connection config", () => {
    for (const contentRetention of ["summary", "none"]) {
      expect(toolTransportConfigSchema.safeParse({ url: "https://example.test/mcp", contentRetention }).success).toBe(true);
    }
    expect(createToolConnectionSchema.parse({
      name: "Private notes",
      transport: "mcp_remote",
      config: { url: "https://example.test/mcp", contentRetention: "none" },
    }).config).toEqual({ url: "https://example.test/mcp", contentRetention: "none" });
    expect(updateToolConnectionSchema.parse({
      config: { url: "https://example.test/mcp", contentRetention: "none" },
    }).config?.contentRetention).toBe("none");
  });

  it("rejects unknown content retention modes", () => {
    for (const contentRetention of ["full", "None", "", true, null, 0]) {
      const parsed = toolTransportConfigSchema.safeParse({ url: "https://example.test/mcp", contentRetention });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path).toEqual(["contentRetention"]);
      }
    }
    expect(updateToolConnectionSchema.safeParse({
      config: { url: "https://example.test/mcp", contentRetention: "off" },
    }).success).toBe(false);
  });

  it("reads a connection's content retention and fails closed on unrecognized stored values", () => {
    expect(readConfiguredToolContentRetention({ url: "https://example.test/mcp" })).toBeNull();
    expect(readConfiguredToolContentRetention(null)).toBeNull();
    expect(readConfiguredToolContentRetention({ contentRetention: "summary" })).toBe("summary");
    expect(readConfiguredToolContentRetention({ contentRetention: "none" })).toBe("none");
    // Written before validation or around the API: keep less, not more.
    expect(readConfiguredToolContentRetention({ contentRetention: "off" })).toBe("none");
    expect(readConfiguredToolContentRetention({ contentRetention: null })).toBe("none");
    expect(readConfiguredToolContentRetention({ contentRetention: 0 })).toBe("none");
    // An undefined value is how an absent key looks before it is serialized.
    expect(readConfiguredToolContentRetention({ contentRetention: undefined })).toBeNull();
    expect(strictestToolContentRetention("summary", null)).toBe("summary");
    expect(strictestToolContentRetention("summary", "none")).toBe("none");
  });

  it("keeps the no-content marker on a redacted value summary", () => {
    expect(toolRedactedValueSummarySchema.parse({
      summary: "",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      contentRetention: "none",
    })).toMatchObject({ summary: "", contentRetention: "none" });
    expect(toolRedactedValueSummarySchema.safeParse({ summary: "", contentRetention: "summary" }).success).toBe(false);
  });

  it("rejects out-of-range or non-integer default tool-call timeouts", () => {
    for (const toolTimeoutMs of [0, 999, 300_001, 1_500.5, "60000", null]) {
      const parsed = toolTransportConfigSchema.safeParse({ url: "https://example.test/mcp", toolTimeoutMs });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path).toEqual(["toolTimeoutMs"]);
      }
    }
    expect(updateToolConnectionSchema.safeParse({
      config: { url: "https://example.test/mcp", toolTimeoutMs: 600_000 },
    }).success).toBe(false);
  });

  it("keeps app method configuration separate from secrets", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      connectionMethodKey: "mcp-api-key",
      configValues: { projectId: "12345", readOnly: true, features: "insights" },
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      configValues: { projectId: "12345", apiKey: "phx_raw" },
    }).success).toBe(false);
  });

  it("accepts only UUID connection request links during app setup", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      interactionId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      interactionId: "not-an-interaction",
    }).success).toBe(false);
  });

  it("accepts a curated provider-generated URL while still requiring a source", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "zapier",
      connectionMethodKey: "generated-url",
      link: "https://mcp.zapier.com/api/v1/connect?token=secret-token",
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({}).success).toBe(false);
  });

  // PAP-17087: the guided generic flow and paste-config both reach the connect
  // endpoint, so unsafe header names/values are rejected once at this boundary.
  it("accepts generic advanced-authentication input for a pasted URL", () => {
    const parsed = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "custom_headers",
      credentialValues: {
        "headers.X-Api-Key": "phx_abc123",
        "headers.X-PostHog-Project-Id": "12345",
      },
    });
    expect(parsed.success).toBe(true);

    const manualClient = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "oauth",
      oauthClient: { clientId: "client-abc", clientSecret: "shhh" },
    });
    expect(manualClient.success).toBe(true);

    expect(connectToolAppSchema.safeParse({
      galleryKey: "asana",
      oauthClient: { clientId: "customer-client", clientSecret: "customer-secret" },
    }).success).toBe(true);
  });

  it("rejects header credentials Paperclip refuses to send", () => {
    for (const configPath of ["headers.Host", "headers.Cookie", "headers.Transfer-Encoding", "headers.Sec-Fetch-Mode"]) {
      const parsed = connectToolAppSchema.safeParse({
        link: "https://mcp.example.test/mcp",
        credentialValues: { [configPath]: "value" },
      });
      expect(parsed.success, configPath).toBe(false);
    }
  });

  it("rejects header names and values that could split the outbound request", () => {
    const badName = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      credentialValues: { "headers.X-Bad\r\nX-Injected": "value" },
    });
    expect(badName.success).toBe(false);

    const badValue = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      credentialValues: { "headers.X-Api-Key": "abc\r\nX-Injected: 1" },
    });
    expect(badValue.success).toBe(false);
    if (!badValue.success) {
      // The message names the header but must never echo the rejected value.
      const message = badValue.error.issues[0]?.message ?? "";
      expect(message).toContain("X-Api-Key");
      expect(message).not.toContain("X-Injected");
    }
  });

  it("keeps generic auth-mode selection off curated apps while allowing owned OAuth clients", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      authMode: "bearer",
    }).success).toBe(false);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      oauthClient: { clientId: "client-abc" },
    }).success).toBe(true);
  });

  it("allows only curated app setup to resume an exact draft", () => {
    const resumeConnectionId = "11111111-1111-4111-8111-111111111111";
    expect(connectToolAppSchema.safeParse({
      galleryKey: "notion",
      resumeConnectionId,
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      resumeConnectionId,
    }).success).toBe(false);
  });

  it("accepts secret references for connection credentials", () => {
    const parsed = createToolConnectionSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      name: "GitHub fixture",
      connectionKind: "managed",
      transportConfig: { url: "https://example.test/mcp" },
      credentialSecretRefs: [
        {
          secretId: "22222222-2222-4222-8222-222222222222",
          configPath: "headers.Authorization",
          versionSelector: "latest",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps invocation payload summaries redacted and bounded", () => {
    const parsed = toolRedactedValueSummarySchema.parse({
      summary: "Redacted arguments: 2 fields omitted.",
      sha256: "a".repeat(64),
      redactedFields: ["headers.Authorization", "body.token"],
    });

    expect(parsed.redactedFields).toEqual(["headers.Authorization", "body.token"]);
  });
});
