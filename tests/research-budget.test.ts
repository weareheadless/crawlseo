import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findUnique: vi.fn() },
  $transaction: vi.fn(),
  researchPolicy: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  researchRun: { count: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  $queryRaw: vi.fn(),
  job: { findUnique: vi.fn(), create: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/connectors/events", () => ({ emitConnectorEvent: vi.fn() }));

import { createResearchRun, researchMonthBounds } from "@/lib/research/service";

const input = {
  title: "Monthly research",
  kind: "MARKET" as const,
  trigger: "MANUAL" as const,
  topics: ["topic"],
  language: "en",
  questions: [],
  recencyDays: 30,
  providers: ["reddit" as const],
};

describe("monthly research task budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.site.findUnique.mockResolvedValue({ id: "site-1", projectId: "project-1" });
    mockDb.$transaction.mockImplementation(async (callback) => callback({
      researchPolicy: mockDb.researchPolicy,
      project: mockDb.project,
      researchRun: mockDb.researchRun,
      $queryRaw: mockDb.$queryRaw,
    }));
    mockDb.researchPolicy.findUnique.mockResolvedValue({ monthlyBudget: 1 });
    mockDb.project.findUnique.mockResolvedValue({ researchBudgetTimeZone: "America/Cancun" });
    mockDb.researchRun.count.mockResolvedValue(0);
    mockDb.researchRun.create.mockResolvedValue({ id: "run-1" });
    mockDb.job.findUnique.mockResolvedValue(null);
    mockDb.job.create.mockResolvedValue({ id: "job-1" });
  });

  it("uses owner-local calendar months across daylight saving changes", () => {
    const bounds = researchMonthBounds(new Date("2026-03-20T12:00:00.000Z"), "America/New_York");
    expect(bounds.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-04-01T04:00:00.000Z");
  });

  it("locks the site and queues a run while under the cap", async () => {
    await expect(createResearchRun("site-1", input, "user-1")).resolves.toEqual({ id: "run-1" });
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDb.researchRun.create).toHaveBeenCalledTimes(1);
    expect(mockDb.job.create).toHaveBeenCalledTimes(1);
    const range = mockDb.researchRun.count.mock.calls[0][0].where.createdAt;
    expect(range.gte.getUTCHours()).toBe(5);
    expect(range.gte.getUTCDate()).toBe(1);
  });

  it("captures the authoritative policy revision on the research run", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ monthlyBudget: 2, revision: 7 });
    await createResearchRun("site-1", input, "user-1");
    expect(mockDb.researchRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ policyRevision: 7 }),
    }));
  });

  it("rejects providers outside the owner's current policy before creating work", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ monthlyBudget: 2, revision: 7,
      enabled: true, providers: ["news"], recencyDays: 30 });
    await expect(createResearchRun("site-1", input, "user-1")).rejects.toMatchObject({
      status: 409, message: "Requested providers are outside the current site policy: reddit",
    });
    expect(mockDb.researchRun.create).not.toHaveBeenCalled();
    expect(mockDb.job.create).not.toHaveBeenCalled();
  });

  it("clamps requested evidence age to the current policy's recency window", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ monthlyBudget: 2, revision: 7,
      enabled: true, providers: ["reddit", "news"], recencyDays: 14 });
    await createResearchRun("site-1", { ...input, recencyDays: 90 }, "user-1");
    expect(mockDb.researchRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ recencyDays: 14,
        brief: expect.objectContaining({ recency_days: 14 }) }),
    }));
  });

  it("does not create runs while the owner has disabled research", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ monthlyBudget: 2, revision: 7,
      enabled: false, providers: ["reddit"], recencyDays: 30 });
    await expect(createResearchRun("site-1", input, "user-1")).rejects.toMatchObject({
      status: 409, message: "Research is disabled by the current site policy",
    });
    expect(mockDb.researchRun.create).not.toHaveBeenCalled();
  });

  it("rejects at the cap before creating a run or queue job", async () => {
    mockDb.researchRun.count.mockResolvedValue(1);
    await expect(createResearchRun("site-1", input, "user-1")).rejects.toMatchObject({
      status: 429,
      message: "Monthly research task budget is exhausted",
    });
    expect(mockDb.researchRun.create).not.toHaveBeenCalled();
    expect(mockDb.job.create).not.toHaveBeenCalled();
  });

  it("treats a zero budget as no available research runs", async () => {
    mockDb.researchPolicy.findUnique.mockResolvedValue({ monthlyBudget: 0 });
    await expect(createResearchRun("site-1", input, "user-1")).rejects.toMatchObject({ status: 429 });
    expect(mockDb.researchRun.create).not.toHaveBeenCalled();
  });

  it("returns an existing scheduled run without spending another budget slot", async () => {
    const existing = { id: "scheduled-run" };
    mockDb.researchRun.findUnique.mockResolvedValue(existing);
    await expect(createResearchRun("site-1", { ...input, trigger: "SCHEDULED" }, "scheduler", "weekly:2026-10-19"))
      .resolves.toEqual(existing);
    expect(mockDb.researchRun.count).not.toHaveBeenCalled();
    expect(mockDb.researchRun.create).not.toHaveBeenCalled();
    expect(mockDb.job.create).toHaveBeenCalledTimes(1);
  });
});
