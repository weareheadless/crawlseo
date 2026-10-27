import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  getUserId: vi.fn(async () => "operator-2"),
  read: vi.fn(), write: vi.fn(), accept: vi.fn(),
  authenticate: vi.fn(async () => ({ credentialId: "cred", servicePrincipalId: "caller", workspaceId: "workspace-1", projectId: "project-1", scopes: ["document:read", "document:write"] })),
  requireScope: vi.fn(), verifyOwner: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { project: { findFirst: mocks.projectFindFirst } } }));
vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: mocks.getUserId }));
vi.mock("@/lib/projects/business-knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects/business-knowledge")>();
  return { ...actual, readBusinessKnowledge: mocks.read, writeBusinessKnowledge: mocks.write, acceptBusinessKnowledge: mocks.accept };
});
vi.mock("@/lib/auth/service-credentials", () => ({ authenticateServiceToken: mocks.authenticate, requireProjectScope: mocks.requireScope, ServiceAuthError: class extends Error { statusCode = 401; } }));
vi.mock("@/lib/auth/business-knowledge-owner-proof", () => ({ verifyBusinessKnowledgeOwnerProof: mocks.verifyOwner, BusinessKnowledgeOwnerProofError: class extends Error { statusCode = 401; } }));

import { GET, POST } from "@/app/api/projects/knowledge/route";
import { POST as correctionPOST } from "@/app/api/projects/knowledge/correction/route";

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

  it("refuses correction of a domainless project without provable user ownership", async () => {
    mocks.projectFindFirst.mockImplementationOnce(async () => ({ id: "project-1", workspaceId: "workspace-1", sites: [] }));
    const response = await correctionPOST(new Request("https://crawlseo.test/api/projects/knowledge/correction", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", projectId: "project-1", documentId: "business-profile", expectedRevision: 0,
        idempotencyKey: "domainless-correction-01", reason: "Correct facts", changes: { businessName: { value: "Acme", publicationUse: "internal_only",
          provenance: { kind: "owner_input", sourceId: "source-1", originSystem: "helloada", originRecordId: "record-1", originRevision: null,
            actor: { type: "owner", id: "owner-1" }, status: "owner_confirmed", recordedAt: "2026-10-26T00:00:00Z", observedAt: "2026-10-26T00:00:00Z", evidenceUri: "https://example.test/source" } } } }),
    }));
    expect(response.status).toBe(404);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
