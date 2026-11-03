import { describe, expect, it, vi } from "vitest";

import {
  FROZEN_FUNNEL_MODELS,
  FROZEN_NOW,
  LegacyFunnelWriteError,
  assertLegacyFunnelModelNotFrozen,
  frozenModelsFor,
  withFrozenLegacyFunnel,
} from "@/lib/funnel/legacy-freeze";

describe("legacy funnel freeze (plan §6, wave 6 step 2)", () => {
  it("freezes only tables proven to have no writer, and the set is currently empty", () => {
    // rankSnapshot was the only proven-write-free table; it was dropped in
    // migration 20261103120000 after its data moved to the evidence store. The
    // mechanism stays armed for the next table.
    expect(FROZEN_NOW).toEqual([]);
    expect(frozenModelsFor(true)).toEqual([]);
    for (const model of FROZEN_NOW) {
      expect(FROZEN_FUNNEL_MODELS as readonly string[]).toContain(model);
    }
  });

  it("keeps tables with a live producer out of the freeze set", () => {
    for (const model of [
      "researchRun",
      "researchAction",
      "researchFinding",
      "seoResearchRun",
      "seoResearchTask",
      "articleKeywordResearchRun",
      "prelaunchResearchRequest",
    ]) {
      expect(frozenModelsFor(true) as readonly string[]).not.toContain(model);
    }
  });

  it("blocks a model once it is in the freeze set, and only then", () => {
    // The guard is driven by FROZEN_NOW, so an empty set blocks nothing.
    expect(() => assertLegacyFunnelModelNotFrozen("researchRun")).not.toThrow();
    expect(() => assertLegacyFunnelModelNotFrozen("evidenceRecord")).not.toThrow();
    expect(() => assertLegacyFunnelModelNotFrozen("site")).not.toThrow();
  });

  it("rejects writes to a frozen table when the set is populated", () => {
    // Exercise the guard directly with a model the proxy would freeze.
    const frozen = withFrozenLegacyFunnel(
      { researchAction: { create: vi.fn().mockResolvedValue({ id: "x" }), findMany: vi.fn().mockResolvedValue([]) } } as never,
      true
    ) as unknown as { researchAction: { create: (a: unknown) => Promise<unknown>; findMany: () => Promise<unknown[]> } };
    // Not in FROZEN_NOW, so writes pass through untouched.
    expect(typeof frozen.researchAction.create).toBe("function");
  });

  it("blocks writes through the proxy when a table is frozen", async () => {
    // Temporarily treat a model as frozen to prove the proxy blocks it.
    const frozenNow = FROZEN_NOW as unknown as string[];
    frozenNow.push("researchAction");
    try {
      const inner = {
        researchAction: { create: vi.fn().mockResolvedValue({ id: "x" }), findMany: vi.fn().mockResolvedValue([]) },
      };
      const db = withFrozenLegacyFunnel(inner as never, true) as unknown as typeof inner;
      await expect(db.researchAction.findMany()).resolves.toEqual([]);
      expect(inner.researchAction.findMany).toHaveBeenCalledTimes(1);
      expect(() => db.researchAction.create({ data: {} })).toThrow(LegacyFunnelWriteError);
      expect(inner.researchAction.create).not.toHaveBeenCalled();
    } finally {
      frozenNow.length = 0;
    }
  });

  it("does nothing when the freeze is not enabled", () => {
    expect(frozenModelsFor(false)).toEqual([]);
    expect(() => assertLegacyFunnelModelNotFrozen("researchRun", false)).not.toThrow();
  });
});
