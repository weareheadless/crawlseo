import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  db: {
    articleKeywordResearchRun: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    site: { findFirst: vi.fn() }, seoResearchPolicy: { findUnique: vi.fn() },
    projectApiKeyGrant: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  enqueueJob: vi.fn(),
  connectorBudget: vi.fn(), reserveConnectorBudget: vi.fn(), settleConnectorBudget: vi.fn(),
  executeDataForSeoKeywordOverview: vi.fn(), executeDataForSeoOrganicSerp: vi.fn(), executeDataForSeoRelatedKeywords: vi.fn(),
  resolveDataForSeoLocale: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/connectors/service", () => ({
  connectorBudget: mocks.connectorBudget,
  reserveConnectorBudget: mocks.reserveConnectorBudget,
  settleConnectorBudget: mocks.settleConnectorBudget,
}));
vi.mock("@/lib/dataforseo/client", () => ({
  executeDataForSeoKeywordOverview: mocks.executeDataForSeoKeywordOverview,
  executeDataForSeoOrganicSerp: mocks.executeDataForSeoOrganicSerp,
  executeDataForSeoRelatedKeywords: mocks.executeDataForSeoRelatedKeywords,
  resolveDataForSeoLocale: mocks.resolveDataForSeoLocale,
}));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: mocks.enqueueJob }));

import { requestArticleKeywordResearch, runArticleKeywordResearch } from "@/lib/dataforseo/article-research";

describe("paid article research budget lifecycle", () => {
  const run = {
    id: "article-run-1", projectId: "project-1", siteId: "site-1", kind: "KEYWORD_OVERVIEW",
    status: "REQUESTED", providerLanguageCode: "en", providerLocationCode: 2840,
    language: "en", country: "US", queries: ["candidate one", "candidate two", "candidate three", "candidate four", "candidate five"],
    seed: "candidate one",
  };
  const tx = {
    $queryRaw: vi.fn(), seoResearchPolicy: { findUnique: vi.fn() },
    articleKeywordResearchRun: { updateMany: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.articleKeywordResearchRun.findFirst.mockResolvedValue(run);
    mocks.db.site.findFirst.mockResolvedValue({ id: "site-1" });
    mocks.db.seoResearchPolicy.findUnique.mockResolvedValue({ articleResearchEnabled: true, articleTaskLimitPerMonth: 5, articleMinIntervalDays: 0 });
    mocks.db.projectApiKeyGrant.findFirst.mockResolvedValue({ apiKeyId: "key-1", providerCredential: null });
    mocks.enqueueJob.mockResolvedValue({ id: "job-1" });
    mocks.db.articleKeywordResearchRun.update.mockImplementation(async ({ data }) => ({ ...run, ...data }));
    mocks.db.articleKeywordResearchRun.updateMany.mockResolvedValue({ count: 1 });
    tx.seoResearchPolicy.findUnique.mockResolvedValue({ articleResearchEnabled: true });
    tx.articleKeywordResearchRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.db.$transaction.mockImplementation(async (callback) => callback(tx));
    mocks.connectorBudget.mockResolvedValue({ configured: true, allowanceMicros: "1000000", remainingMicros: "1000000",
      maxOperationMicros: "100000", currency: "USD", period: "2026-10", policyRevision: 3 });
    mocks.reserveConnectorBudget.mockResolvedValue({ id: "reservation-1", status: "RESERVED" });
    mocks.settleConnectorBudget.mockResolvedValue({ id: "reservation-1" });
    mocks.executeDataForSeoKeywordOverview.mockResolvedValue({ providerTaskId: "provider-1", costMicros: 22000, result: { rows: [] } });
  });

  it("honors an existing exact idempotency key without requiring a fresh budget", async () => {
    const input = {
      projectId: "project-1", ideaKey: "idea-1", ideaSummary: "Summary", queries: [
        "candidate one", "candidate two", "candidate three", "candidate four", "candidate five",
      ], language: "en", country: "US", idempotencyKey: "request-1",
    };
    const requestHash = createHash("sha256").update(JSON.stringify({
      ideaKey: input.ideaKey, ideaSummary: input.ideaSummary, queries: input.queries,
      language: input.language, country: input.country, idempotencyKey: input.idempotencyKey,
    }), "utf8").digest("hex");
    mocks.db.articleKeywordResearchRun.findUnique.mockResolvedValue({
      id: "existing-run", siteId: "site-1", status: "COMPLETED", requestHash,
    });
    mocks.connectorBudget.mockRejectedValue(new Error("budget unavailable"));
    await expect(requestArticleKeywordResearch(input)).resolves.toMatchObject({
      run_id: "existing-run", existing: true, status: "completed",
    });
    expect(mocks.connectorBudget).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
  });

  it("checks allowance and ceiling before dispatch and settles actual provider cost", async () => {
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.reserveConnectorBudget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      idempotencyKey: "article-research:article-run-1:keyword_overview", amountMicros: "100000", currency: "USD",
    }));
    expect(mocks.reserveConnectorBudget.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.$transaction.mock.invocationCallOrder[0]);
    expect(mocks.executeDataForSeoKeywordOverview).toHaveBeenCalledTimes(1);
    expect(mocks.settleConnectorBudget).toHaveBeenCalledWith(expect.any(Object), "reservation-1", expect.objectContaining({
      status: "settled", actualCostMicros: "22000", providerTaskId: "provider-1",
    }));
  });

  it.each([
    { budget: { configured: false, allowanceMicros: null, remainingMicros: null, maxOperationMicros: null, currency: "USD" }, code: "POSITIVE_MONTHLY_MONETARY_ALLOWANCE" },
    { budget: { configured: true, allowanceMicros: "1000000", remainingMicros: "1000000", maxOperationMicros: "100000", currency: "MXN" }, code: "REQUIRES_A_USD" },
  ])("does not queue provider work if budget policy is missing or incompatible", async ({ budget, code }) => {
    mocks.connectorBudget.mockResolvedValue(budget);
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.reserveConnectorBudget).not.toHaveBeenCalled();
    expect(mocks.executeDataForSeoKeywordOverview).not.toHaveBeenCalled();
    expect(mocks.db.articleKeywordResearchRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: expect.stringContaining(code) }),
    }));
  });

  it("lets the reservation ledger reject exhausted monthly allowance before dispatch", async () => {
    mocks.connectorBudget.mockResolvedValue({ configured: true, allowanceMicros: "1000000", remainingMicros: "0",
      maxOperationMicros: "100000", currency: "USD", period: "2026-10", policyRevision: 3 });
    mocks.reserveConnectorBudget.mockRejectedValue(new Error("Monetary research allowance is exhausted"));
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.reserveConnectorBudget).toHaveBeenCalled();
    expect(mocks.executeDataForSeoKeywordOverview).not.toHaveBeenCalled();
    expect(mocks.db.articleKeywordResearchRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED" }),
    }));
  });

  it("does not dispatch again when an existing deterministic reservation is uncertain", async () => {
    mocks.connectorBudget.mockResolvedValue({ configured: true, allowanceMicros: "1000000", remainingMicros: "0",
      maxOperationMicros: "100000", currency: "USD", period: "2026-10", policyRevision: 3 });
    mocks.reserveConnectorBudget.mockResolvedValue({ id: "reservation-1", status: "UNCERTAIN", providerTaskId: "provider-1", actualCostMicros: null });
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.executeDataForSeoKeywordOverview).not.toHaveBeenCalled();
    expect(mocks.db.articleKeywordResearchRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNCERTAIN", providerTaskId: "provider-1" }),
    }));
  });

  it("does not release a reservation based on another worker's failed run", async () => {
    tx.articleKeywordResearchRun.updateMany.mockResolvedValue({ count: 0 });
    mocks.db.articleKeywordResearchRun.findFirst.mockResolvedValue({ ...run, status: "FAILED" });
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.settleConnectorBudget).not.toHaveBeenCalledWith(expect.any(Object), "reservation-1", expect.objectContaining({ status: "released" }));
    expect(mocks.executeDataForSeoKeywordOverview).not.toHaveBeenCalled();
  });

  it("allows only one concurrent worker to claim and dispatch a reserved run", async () => {
    mocks.connectorBudget.mockResolvedValue({ configured: true, allowanceMicros: "1000000", remainingMicros: "0",
      maxOperationMicros: "100000", currency: "USD", period: "2026-10", policyRevision: 3 });
    tx.articleKeywordResearchRun.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await Promise.all([
      runArticleKeywordResearch("project-1", "site-1", run.id),
      runArticleKeywordResearch("project-1", "site-1", run.id),
    ]);
    expect(mocks.reserveConnectorBudget).toHaveBeenCalledTimes(2);
    expect(mocks.reserveConnectorBudget.mock.calls[0][1].idempotencyKey).toBe(mocks.reserveConnectorBudget.mock.calls[1][1].idempotencyKey);
    expect(mocks.executeDataForSeoKeywordOverview).toHaveBeenCalledTimes(1);
  });

  it("keeps uncertain provider dispatches held and refuses a later retry", async () => {
    mocks.executeDataForSeoKeywordOverview.mockRejectedValueOnce(new Error("network timeout after dispatch"));
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.settleConnectorBudget).toHaveBeenCalledWith(expect.any(Object), "reservation-1", expect.objectContaining({ status: "uncertain" }));
    mocks.db.articleKeywordResearchRun.findFirst.mockResolvedValue({ ...run, status: "UNCERTAIN" });
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.executeDataForSeoKeywordOverview).toHaveBeenCalledTimes(1);
  });

  it("persists a known provider receipt as uncertain if settlement cannot be recorded", async () => {
    mocks.settleConnectorBudget.mockRejectedValue(new Error("ledger unavailable"));
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.settleConnectorBudget).toHaveBeenCalledTimes(2);
    expect(mocks.db.articleKeywordResearchRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNCERTAIN", costMicros: 22000, providerTaskId: "provider-1" }),
    }));
    mocks.db.articleKeywordResearchRun.findFirst.mockResolvedValue({ ...run, status: "UNCERTAIN" });
    await runArticleKeywordResearch("project-1", "site-1", run.id);
    expect(mocks.executeDataForSeoKeywordOverview).toHaveBeenCalledTimes(1);
  });
});
