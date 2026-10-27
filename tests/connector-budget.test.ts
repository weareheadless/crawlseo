import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findFirst: vi.fn() },
  project: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  researchBudgetReservation: {
    findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { ConnectorError, reserveConnectorBudget, reserveProjectConnectorBudget, projectConnectorBudget, settleConnectorBudget, updateConnectorBudgetPolicy } from "@/lib/connectors/service";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", workspaceId: "workspace-1", projectId: "project-1", scopes: ["connector:read", "connector:write"] };
const site = { id: "site-1", projectId: "project-1", domain: "example.com", project: { id: "project-1", externalProjectId: "external-1", workspaceId: "workspace-1" }, connectorBinding: { projectId: "project-1", status: "ACTIVE", generation: 1, executor: "helloada" } };
const month = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
};

describe("project research budget ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findFirst.mockResolvedValue(site);
    mockDb.project.findUnique.mockResolvedValue({ monthlyResearchAllowanceMicros: BigInt(100_000), maxResearchOperationMicros: BigInt(100_000), researchBudgetCurrency: "USD", researchBudgetTimeZone: "UTC", researchBudgetRevision: 4 });
    mockDb.researchBudgetReservation.findUnique.mockResolvedValue(null);
    mockDb.researchBudgetReservation.findMany.mockResolvedValue([]);
    mockDb.researchBudgetReservation.create.mockImplementation(async ({ data }) => ({ id: "reservation-1", ...data }));
    mockDb.$transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mockDb.$queryRaw,
      project: mockDb.project,
      researchBudgetReservation: mockDb.researchBudgetReservation,
    }));
  });

  const input = (overrides = {}) => ({ siteId: "site-1", period: month(), policyRevision: 4,
    idempotencyKey: "research:run:1", amountMicros: "25000", currency: "USD", operation: "seo_monthly_research", ...overrides });

  it("stores a per-operation ceiling within the monthly allowance", async () => {
    mockDb.project.update.mockResolvedValue({ monthlyResearchAllowanceMicros: BigInt(100_000), maxResearchOperationMicros: BigInt(40_000),
      researchBudgetCurrency: "USD", researchBudgetTimeZone: "UTC", researchBudgetRevision: 5 });
    await expect(updateConnectorBudgetPolicy(principal, { siteId: "site-1", expectedRevision: 4,
      monthlyAllowanceMicros: "100000", maxOperationMicros: "40000", currency: "USD", timeZone: "UTC" }))
      .resolves.toMatchObject({ monthlyAllowanceMicros: "100000", maxOperationMicros: "40000", policyRevision: 5 });
  });

  it("rejects a per-operation ceiling above the monthly allowance", async () => {
    await expect(updateConnectorBudgetPolicy(principal, { siteId: "site-1", expectedRevision: 4,
      monthlyAllowanceMicros: "100000", maxOperationMicros: "100001", currency: "USD", timeZone: "UTC" }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.project.update).not.toHaveBeenCalled();
  });

  it("reserves against the project policy while holding its row lock", async () => {
    const result = await reserveConnectorBudget(principal, input());
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.researchBudgetReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      projectId: "project-1", siteId: "site-1", amountMicros: BigInt(25_000), status: "RESERVED",
    }) });
    expect(result.id).toBe("reservation-1");
  });

  it("holds work when the actual plus reserved amount exceeds allowance", async () => {
    mockDb.researchBudgetReservation.findMany.mockResolvedValue([
      { status: "SETTLED", amountMicros: BigInt(80_000), actualCostMicros: BigInt(80_000) },
      { status: "UNCERTAIN", amountMicros: BigInt(15_000), actualCostMicros: null },
    ]);
    await expect(reserveConnectorBudget(principal, input({ amountMicros: "10000" }))).rejects.toMatchObject({ status: 429 });
    expect(mockDb.researchBudgetReservation.create).not.toHaveBeenCalled();
  });

  it("rejects a reservation above the configured operation ceiling", async () => {
    await expect(reserveConnectorBudget(principal, input({ amountMicros: "100001" })))
      .rejects.toMatchObject({ status: 429 });
    expect(mockDb.researchBudgetReservation.create).not.toHaveBeenCalled();
  });

  it("returns an exact duplicate reservation without creating another row", async () => {
    mockDb.project.findUnique.mockResolvedValue({ monthlyResearchAllowanceMicros: BigInt(0), maxResearchOperationMicros: BigInt(1),
      researchBudgetCurrency: "USD", researchBudgetTimeZone: "UTC", researchBudgetRevision: 99 });
    mockDb.researchBudgetReservation.findUnique.mockResolvedValue({ id: "reservation-1", projectId: "project-1", siteId: "site-1",
      period: month(), policyRevision: 4, amountMicros: BigInt(25_000), currency: "USD", operation: "seo_monthly_research",
      detail: { helloAda: { notes: "same", runId: "run-1" }, period: month() }, status: "RESERVED" });
    await expect(reserveConnectorBudget(principal, input({ detail: { period: month(), helloAda: { runId: "run-1", notes: "same" } } })))
      .resolves.toMatchObject({ id: "reservation-1", status: "RESERVED" });
    expect(mockDb.researchBudgetReservation.create).not.toHaveBeenCalled();
  });

  it("does not reuse a released idempotency key for a new paid dispatch", async () => {
    mockDb.researchBudgetReservation.findUnique.mockResolvedValue({ id: "reservation-1", projectId: "project-1", siteId: "site-1",
      period: month(), policyRevision: 4, amountMicros: BigInt(25_000), currency: "USD", operation: "seo_monthly_research",
      detail: null, status: "RELEASED" });
    await expect(reserveConnectorBudget(principal, input())).rejects.toMatchObject({ status: 409 });
    expect(mockDb.researchBudgetReservation.create).not.toHaveBeenCalled();
  });

  it("denies a site outside the authenticated project", async () => {
    mockDb.site.findFirst.mockResolvedValue(null);
    await expect(reserveConnectorBudget(principal, input({ siteId: "other-site" }))).rejects.toMatchObject({ status: 404 });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("settles only the exact project reservation with actual provider cost", async () => {
    mockDb.researchBudgetReservation.findFirst.mockResolvedValue({ id: "reservation-1", projectId: "project-1", status: "RESERVED", actualCostMicros: null, providerTaskId: "task-1" });
    mockDb.researchBudgetReservation.updateMany.mockResolvedValue({ count: 1 });
    mockDb.researchBudgetReservation.findUnique.mockResolvedValue({ id: "reservation-1", status: "SETTLED", actualCostMicros: BigInt(19_000) });
    await expect(settleConnectorBudget(principal, "reservation-1", { status: "settled", actualCostMicros: "19000", providerTaskId: "task-1" }))
      .resolves.toMatchObject({ id: "reservation-1", status: "SETTLED", actualCostMicros: BigInt(19_000) });
    expect(mockDb.researchBudgetReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "reservation-1", projectId: "project-1", status: "RESERVED" },
    }));
  });

  it("preserves all existing site-scoped reservation terminal states", async () => {
    for (const status of ["settled", "released", "uncertain"] as const) {
      mockDb.researchBudgetReservation.findFirst.mockResolvedValueOnce({ id: `r-${status}`, projectId: "project-1", status: "RESERVED", actualCostMicros: null, providerTaskId: null });
      mockDb.researchBudgetReservation.updateMany.mockResolvedValueOnce({ count: 1 });
      mockDb.researchBudgetReservation.findUnique.mockResolvedValueOnce({ id: `r-${status}`, status: status.toUpperCase() });
      expect(await settleConnectorBudget(principal, `r-${status}`, { status, ...(status === "settled" ? { actualCostMicros: "1200" } : {}) })).toMatchObject({ status: status.toUpperCase() });
    }
    expect(mockDb.researchBudgetReservation.updateMany).toHaveBeenCalledTimes(3);
  });

  it("reserves project-scope without resolving or inventing a Site and supports settlement", async () => {
    mockDb.researchBudgetReservation.findUnique.mockResolvedValue(null);
    const result = await reserveProjectConnectorBudget(principal, { period: month(), policyRevision: 4, idempotencyKey: "prelaunch:task", amountMicros: "25000", currency: "USD", operation: "dataforseo:keyword_seed" });
    expect(result).toMatchObject({ siteId: null, projectId: "project-1", status: "RESERVED" });
    expect(mockDb.site.findFirst).not.toHaveBeenCalled();
    expect(mockDb.researchBudgetReservation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ projectId: "project-1", siteId: null, status: "RESERVED" }) });
  });

  it("counts uncertain project reservations against remaining allowance", async () => {
    mockDb.researchBudgetReservation.findMany.mockResolvedValue([{ status: "UNCERTAIN", amountMicros: BigInt(25000), actualCostMicros: null }]);
    mockDb.project.findUnique.mockResolvedValue({ monthlyResearchAllowanceMicros: BigInt(100000), maxResearchOperationMicros: BigInt(30000), researchBudgetCurrency: "USD", researchBudgetTimeZone: "UTC", researchBudgetRevision: 4 });
    expect(await projectConnectorBudget(principal)).toMatchObject({ siteId: null, committedMicros: "25000", remainingMicros: "75000" });
  });
});
