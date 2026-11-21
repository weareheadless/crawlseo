import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => {
  const tx = {
    researchFinding: { create: vi.fn(), update: vi.fn() },
    researchRun: { update: vi.fn() },
  };
  return {
    tx,
    researchFinding: { findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { createResearchFinding } from "@/lib/research/service";

/**
 * The synthesizer names the forms buyers type (`demand_queries`) and the topic
 * map, the bundle reserve and the join runner all read them back. The write path
 * accepted the field and silently dropped it, so every finding stored an empty
 * array and the research-to-measurement loop had nothing to measure.
 */
describe("research finding demand forms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.researchFinding.findFirst.mockResolvedValue(null);
    mockDb.tx.researchFinding.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "finding-1", ...data }));
  });

  it("persists the demand forms the synthesizer proposed", async () => {
    await createResearchFinding(
      "run-1",
      {
        type: "CONTENT_GAP",
        theme: "Bridal hair trials",
        primaryQuery: "peinado novia playa del carmen",
        demandQueries: ["peinado novia playa del carmen", "prueba de peinado novia"],
        summary: "Brides ask for a trial before the wedding day.",
        confidence: 70,
      },
      ["source-1"],
    );

    expect(mockDb.tx.researchFinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        demandQueries: ["peinado novia playa del carmen", "prueba de peinado novia"],
      }),
    });
  });

  it("fills the demand forms on a retried finding instead of keeping the gap", async () => {
    mockDb.researchFinding.findFirst.mockResolvedValue({
      id: "finding-1",
      demandQueries: [],
    });

    await createResearchFinding(
      "run-1",
      {
        type: "CONTENT_GAP",
        theme: "Bridal hair trials",
        demandQueries: ["prueba de peinado novia"],
        summary: "Brides ask for a trial before the wedding day.",
        confidence: 70,
      },
      ["source-1"],
    );

    expect(mockDb.researchFinding.update).toHaveBeenCalledWith({
      where: { id: "finding-1" },
      data: { demandQueries: ["prueba de peinado novia"] },
    });
    expect(mockDb.tx.researchFinding.create).not.toHaveBeenCalled();
  });

  it("keeps the forms a finding already has", async () => {
    mockDb.researchFinding.findFirst.mockResolvedValue({
      id: "finding-1",
      demandQueries: ["prueba de peinado novia"],
    });

    await createResearchFinding(
      "run-1",
      {
        type: "CONTENT_GAP",
        theme: "Bridal hair trials",
        demandQueries: ["otra forma"],
        summary: "Brides ask for a trial before the wedding day.",
        confidence: 70,
      },
      ["source-1"],
    );

    expect(mockDb.researchFinding.update).not.toHaveBeenCalled();
  });
});
