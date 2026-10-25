import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  connectorBinding: { findUnique: vi.fn() },
  researchAction: { findFirst: vi.fn(), update: vi.fn() },
  connectorExecutionState: { findUnique: vi.fn(), upsert: vi.fn() },
  connectorOperationReceipt: { findUnique: vi.fn(), create: vi.fn() },
  connectorContextSnapshot: { findFirst: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  emitConnectorEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: mocks.emitConnectorEvent }));

import { ConnectorError, operateOnAction, recordExecutionStatus } from "@/lib/connectors/service";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", workspaceId: "workspace-1",
  projectId: "project-1", scopes: ["connector:write"] };
const action = { id: "action-1", projectId: "project-1", siteId: "site-1", revision: 4,
  targetUrl: "https://example.com/page", preparationStatus: "READY", status: "PROPOSED",
  site: { id: "site-1", domain: "example.com" } };
const approvedReceipt = { candidateRef: "candidate:action-1:4", receiptId: "receipt-1",
  targetUrl: "https://example.com/page", publishedAt: "2026-10-25T00:00:00.000Z", contentHash: "a".repeat(64) };

describe("connector owner approval and publication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", domain: "example.com",
      project: { id: "project-1", externalProjectId: "external-1", workspaceId: "workspace-1" },
      connectorBinding: { projectId: "project-1", generation: 2, status: "ACTIVE", executor: "helloada" } });
    mocks.connectorBinding.findUnique.mockResolvedValue({ projectId: "project-1", generation: 2,
      status: "ACTIVE", executor: "helloada" });
    mocks.$queryRaw.mockResolvedValue([]);
    mocks.researchAction.findFirst.mockResolvedValue(action);
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "owner_decision", ownerDecision: "declined",
      candidateRef: "candidate:action-1:4", publicationReceipt: null });
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorBinding: { findUnique: mocks.connectorBinding.findUnique },
      connectorOperationReceipt: { findUnique: mocks.connectorOperationReceipt.findUnique, create: mocks.connectorOperationReceipt.create },
      connectorContextSnapshot: mocks.connectorContextSnapshot,
      researchAction: { findFirst: vi.fn().mockResolvedValue({ revision: 4, preparationStatus: "READY" }), update: mocks.researchAction.update },
      connectorExecutionState: { findUnique: mocks.connectorExecutionState.findUnique, upsert: mocks.connectorExecutionState.upsert },
    }));
    mocks.connectorOperationReceipt.findUnique.mockResolvedValue(null);
    mocks.connectorContextSnapshot.findFirst.mockResolvedValue({ capabilities: { reviewOrigin: "https://helloada.example" } });
  });

  it("rejects publication after the owner declined the exact candidate", async () => {
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "publication-after-decline", status: "publication_verified",
      publicationReceipt: approvedReceipt,
    })).rejects.toBeInstanceOf(ConnectorError);

    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
    expect(mocks.connectorOperationReceipt.create).not.toHaveBeenCalled();
    expect(mocks.emitConnectorEvent).not.toHaveBeenCalled();
  });

  it("does not allow a later callback to reverse an owner decision", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "owner_decision", ownerDecision: "approved",
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/review/1", publicationReceipt: null });
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "reverse-owner-decision", status: "owner_decision", ownerDecision: "declined",
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/review/1",
    })).rejects.toMatchObject({ message: "An owner decision cannot be reversed for the same Action revision" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });

  it("rejects an owner decision for a different review path on the same workspace", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "preparation_ready", ownerDecision: null,
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/admin/initiative/1",
      reviewPackageHash: "b".repeat(64), publicationReceipt: null });
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "owner-wrong-review-path", status: "owner_decision", ownerDecision: "approved",
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/admin/initiative/2",
      detail: { reviewPackageHash: "b".repeat(64) },
    })).rejects.toMatchObject({ message: "Owner decision review does not match the ready candidate" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });

  it("binds an owner decision to the review package hash accepted at readiness", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "preparation_ready", ownerDecision: null,
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/admin/initiative/1",
      reviewPackageHash: "b".repeat(64), publicationReceipt: null });
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "owner-wrong-review-package", status: "owner_decision", ownerDecision: "approved",
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/admin/initiative/1",
      detail: { reviewPackageHash: "c".repeat(64) },
    })).rejects.toMatchObject({ message: "Owner decision does not match the ready review package" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });

  it("persists the review package hash from the ready report", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue(null);
    mocks.connectorExecutionState.upsert.mockResolvedValue({ candidateRef: approvedReceipt.candidateRef,
      reviewUrl: "https://helloada.example/admin/initiative/1", reviewPackageHash: "d".repeat(64) });
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorBinding: { findUnique: mocks.connectorBinding.findUnique },
      connectorOperationReceipt: { findUnique: mocks.connectorOperationReceipt.findUnique,
        create: mocks.connectorOperationReceipt.create },
      researchAction: { findFirst: vi.fn().mockResolvedValue({ revision: 4, preparationStatus: "QUEUED",
        preparationRequestId: "ready-with-review-package" }),
        update: mocks.researchAction.update },
      connectorExecutionState: { findUnique: mocks.connectorExecutionState.findUnique, upsert: mocks.connectorExecutionState.upsert },
    }));

    await recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "ready-report-id", preparationRequestId: "ready-with-review-package", status: "preparation_ready",
      candidateRef: approvedReceipt.candidateRef, reviewUrl: "https://helloada.example/admin/initiative/1",
      detail: { reviewPackageHash: "d".repeat(64) },
    });

    expect(mocks.connectorExecutionState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ reviewPackageHash: "d".repeat(64) }),
      update: expect.objectContaining({ reviewPackageHash: "d".repeat(64) }),
    }));
  });

  it("rejects a delayed preparation report from before the current retry", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue(null);
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorBinding: { findUnique: mocks.connectorBinding.findUnique },
      connectorOperationReceipt: { findUnique: mocks.connectorOperationReceipt.findUnique,
        create: mocks.connectorOperationReceipt.create },
      researchAction: { findFirst: vi.fn().mockResolvedValue({ revision: 4, preparationStatus: "QUEUED",
        preparationRequestId: "retry-attempt-2" }), update: mocks.researchAction.update },
      connectorExecutionState: { findUnique: mocks.connectorExecutionState.findUnique, upsert: mocks.connectorExecutionState.upsert },
    }));

    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "late-first-attempt", preparationRequestId: "retry-attempt-1",
      status: "preparation_blocked", detail: { error: "old attempt timed out" },
    })).rejects.toMatchObject({ message: "Preparation report does not match the current accepted attempt" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });

  it("allows a new preparation attempt after a blocked attempt and publishes its fence", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "preparation_blocked", ownerDecision: null });
    mocks.connectorContextSnapshot.findFirst.mockResolvedValue({
      observedAt: new Date(), canonicalOrigin: "https://example.com/",
      websiteInventory: [{ url: "https://example.com/page" }], capabilities: { supported: ["content.prepare"] },
    });
    const retryAction = { ...action, preparationStatus: "BLOCKED", requiredCapabilities: ["content.prepare"],
      evidence: { source_ids: ["source-1"] }, acceptanceCriteria: null, finding: null };
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorBinding: { findUnique: mocks.connectorBinding.findUnique },
      connectorOperationReceipt: { findUnique: mocks.connectorOperationReceipt.findUnique,
        create: mocks.connectorOperationReceipt.create },
      connectorContextSnapshot: mocks.connectorContextSnapshot,
      researchSource: { findMany: vi.fn().mockResolvedValue([{ id: "source-1", retrievedAt: new Date(), run: { recencyDays: 30 } }]) },
      researchPolicy: { findUnique: vi.fn().mockResolvedValue(null) },
      researchAction: { findFirst: vi.fn().mockResolvedValue(retryAction), update: mocks.researchAction.update },
      connectorExecutionState: { findUnique: mocks.connectorExecutionState.findUnique },
    }));

    await operateOnAction(principal, { actionId: "action-1", operation: "accept_preparation",
      expectedRevision: 4, generation: 2, idempotencyKey: "retry-attempt-2" });

    expect(mocks.researchAction.update).toHaveBeenCalledWith(expect.objectContaining({ data: {
      preparationStatus: "QUEUED", preparationRequestId: "retry-attempt-2",
    } }));
    expect(mocks.emitConnectorEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "preparation.requested", payload: expect.objectContaining({ preparationRequestId: "retry-attempt-2" }),
    }));
  });

  it("does not queue another preparation attempt while one is already queued", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue(null);
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorBinding: { findUnique: mocks.connectorBinding.findUnique },
      connectorOperationReceipt: { findUnique: mocks.connectorOperationReceipt.findUnique,
        create: mocks.connectorOperationReceipt.create },
      researchAction: { findFirst: vi.fn().mockResolvedValue({ ...action, preparationStatus: "QUEUED" }),
        update: mocks.researchAction.update },
      connectorExecutionState: { findUnique: mocks.connectorExecutionState.findUnique },
    }));

    await expect(operateOnAction(principal, { actionId: "action-1", operation: "accept_preparation",
      expectedRevision: 4, generation: 2, idempotencyKey: "duplicate-live-attempt" }))
      .rejects.toMatchObject({ message: "Preparation can only start from an unstarted or blocked state" });
    expect(mocks.researchAction.update).not.toHaveBeenCalled();
    expect(mocks.emitConnectorEvent).not.toHaveBeenCalled();
  });

  it("uses the Action's site binding when the project has multiple sites", async () => {
    const sites = [
      { id: "site-1", projectId: "project-1", domain: "first.example", project: { id: "project-1" },
        connectorBinding: { projectId: "project-1", generation: 2, status: "ACTIVE", executor: "helloada" } },
      { id: "site-2", projectId: "project-1", domain: "example.com", project: { id: "project-1" },
        connectorBinding: { projectId: "project-1", generation: 7, status: "ACTIVE", executor: "helloada" } },
    ];
    mocks.site.findFirst.mockImplementation(async ({ where }) => sites.find((site) => !where.id || site.id === where.id));
    mocks.connectorBinding.findUnique.mockResolvedValue({ projectId: "project-1", generation: 7,
      status: "ACTIVE", executor: "helloada" });
    mocks.researchAction.findFirst.mockResolvedValue({ ...action, siteId: "site-2", site: { id: "site-2", domain: "example.com" },
      finding: { evidenceSourceIds: [] } });
    mocks.connectorExecutionState.findUnique.mockResolvedValue(null);
    mocks.connectorOperationReceipt.findUnique.mockResolvedValue(null);
    mocks.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.$queryRaw,
      connectorBinding: { findUnique: mocks.connectorBinding.findUnique },
      connectorOperationReceipt: { findUnique: mocks.connectorOperationReceipt.findUnique,
        create: mocks.connectorOperationReceipt.create },
      researchAction: { findFirst: vi.fn().mockResolvedValue({ ...action, siteId: "site-2", preparationStatus: "NONE" }),
        update: mocks.researchAction.update },
      connectorExecutionState: { findUnique: mocks.connectorExecutionState.findUnique },
    }));

    await operateOnAction(principal, { actionId: "action-1", operation: "decline_preparation",
      expectedRevision: 4, generation: 7, idempotencyKey: "site-two-decline" });

    expect(mocks.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: "project-1", id: "site-2" },
    }));
    expect(mocks.emitConnectorEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: "site-2", actionId: "action-1",
    }));
  });

  it("refuses preparation and execution reports for an unimplemented platform binding", async () => {
    mocks.site.findFirst.mockResolvedValue({ id: "site-1", projectId: "project-1", project: { id: "project-1" },
      connectorBinding: { projectId: "project-1", generation: 2, status: "ACTIVE", executor: "webflow" } });
    await expect(operateOnAction(principal, { actionId: "action-1", operation: "accept_preparation",
      expectedRevision: 4, generation: 2, idempotencyKey: "webflow-prepare" })).rejects.toMatchObject({ status: 409 });
    await expect(recordExecutionStatus(principal, { actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "webflow-ready", status: "preparation_blocked" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.$transaction).not.toHaveBeenCalled();
    expect(mocks.researchAction.update).not.toHaveBeenCalled();
  });

  it("requires an approved decision and exact candidate before accepting a publication receipt", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "owner_decision", ownerDecision: "approved",
      candidateRef: "candidate:action-1:other-revision", publicationReceipt: null });
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "publication-wrong-candidate", status: "publication_verified",
      publicationReceipt: approvedReceipt,
    })).rejects.toMatchObject({ message: "Publication receipt must identify the exact approved candidate, target, time, and content hash" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });

  it("rejects publication timestamps without an explicit UTC timezone", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "owner_decision", ownerDecision: "approved",
      candidateRef: approvedReceipt.candidateRef, publicationReceipt: null });
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "publication-local-time", status: "publication_verified",
      publicationReceipt: { ...approvedReceipt, publishedAt: "2026-10-25T00:00:00" },
    })).rejects.toMatchObject({ message: "Publication receipt must identify the exact approved candidate, target, time, and content hash" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });

  it("does not replace a verified publication receipt on a later callback", async () => {
    mocks.connectorExecutionState.findUnique.mockResolvedValue({ status: "publication_verified", ownerDecision: "approved",
      candidateRef: approvedReceipt.candidateRef, publicationReceipt: approvedReceipt });
    await expect(recordExecutionStatus(principal, {
      actionId: "action-1", actionRevision: 4, generation: 2,
      idempotencyKey: "replace-publication-receipt", status: "publication_verified",
      publicationReceipt: { ...approvedReceipt, receiptId: "receipt-replaced" },
    })).rejects.toMatchObject({ message: "A verified publication receipt cannot be replaced" });
    expect(mocks.connectorExecutionState.upsert).not.toHaveBeenCalled();
  });
});
