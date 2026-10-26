import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  read: vi.fn(), write: vi.fn(), accept: vi.fn(),
  authenticate: vi.fn(async () => ({ credentialId: "cred", servicePrincipalId: "caller", workspaceId: "workspace-1", projectId: "project-1", scopes: ["document:read", "document:write"] })),
  requireScope: vi.fn(), verifyOwner: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { project: { findFirst: mocks.projectFindFirst } } }));
vi.mock("@/lib/projects/business-knowledge", () => ({
  businessKnowledgeFieldsSchema: { parse: (value: unknown) => value },
  readBusinessKnowledge: mocks.read, writeBusinessKnowledge: mocks.write, acceptBusinessKnowledge: mocks.accept,
  BusinessKnowledgeError: class extends Error {},
}));
vi.mock("@/lib/auth/service-credentials", () => ({ authenticateServiceToken: mocks.authenticate, requireProjectScope: mocks.requireScope, ServiceAuthError: class extends Error { statusCode = 401; } }));
vi.mock("@/lib/auth/business-knowledge-owner-proof", () => ({ verifyBusinessKnowledgeOwnerProof: mocks.verifyOwner, BusinessKnowledgeOwnerProofError: class extends Error { statusCode = 401; } }));

import { GET, POST } from "@/app/api/projects/knowledge/route";

describe("business knowledge API selectors and acceptance authority", () => {
  it("rejects malformed view and revision selectors as contract validation errors", async () => {
    const response = await GET(new Request("https://crawlseo.test/api/projects/knowledge?workspaceId=workspace-1&projectId=project-1&documentId=business-profile&view=latest&revision=NaN", {
      headers: { authorization: "Bearer project-token" },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns forbidden for caller-claimed workspace admin without entering owner acceptance", async () => {
    const response = await POST(new Request("https://crawlseo.test/api/projects/knowledge", {
      method: "POST", headers: { authorization: "Bearer project-token", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "business-knowledge/1", kind: "document_accept", workspaceId: "workspace-1", projectId: "project-1",
        documentId: "business-profile", expectedRevision: 1, idempotencyKey: "accept-request-001", reason: "requested", actor: { type: "workspace_admin", id: "operator-1" } }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.verifyOwner).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
