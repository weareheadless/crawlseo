import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBusinessKnowledgeOwnerProof, verifyBusinessKnowledgeOwnerProof } from "@/lib/auth/business-knowledge-owner-proof";

describe("HelloAda owner acceptance proof", () => {
  beforeEach(() => vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "shared-provisioning-secret-for-tests"));

  it("binds owner, organization, project, document and exact revision", () => {
    const proof = createBusinessKnowledgeOwnerProof("helloada:owner-1", "project-1", "document-1", 4, "owner-1", { now: 1_800_000_000_000 });
    expect(verifyBusinessKnowledgeOwnerProof(proof, { externalOrganizationId: "helloada:owner-1", projectId: "project-1", documentId: "document-1", revision: 4 }, 1_800_000_001_000)).toEqual({ actorId: "owner-1" });
    expect(() => verifyBusinessKnowledgeOwnerProof(proof, { externalOrganizationId: "helloada:owner-1", projectId: "project-1", documentId: "document-1", revision: 5 }, 1_800_000_001_000)).toThrow(/does not match/);
  });

  it("rejects a signer claiming a different owner organization", () => {
    const proof = createBusinessKnowledgeOwnerProof("helloada:someone-else", "project-1", "document-1", 1, "owner-1", { now: 1_800_000_000_000 });
    expect(() => verifyBusinessKnowledgeOwnerProof(proof, { externalOrganizationId: "helloada:someone-else", projectId: "project-1", documentId: "document-1", revision: 1 }, 1_800_000_001_000)).toThrow(/canonical owner/);
  });
});
