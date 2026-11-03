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
  it("freezes only the tables proven to have no scheduled writer", () => {
    // The full legacy list is documented, but the freeze is per-table: freezing
    // a table whose producer still runs would break that producer.
    expect(FROZEN_NOW).toEqual(["rankSnapshot"]);
    for (const model of FROZEN_NOW) {
      expect(FROZEN_FUNNEL_MODELS as readonly string[]).toContain(model);
    }
    // Tables still written by the research pipeline must not be frozen.
    for (const model of ["researchRun", "researchAction", "seoResearchRun", "articleKeywordResearchRun", "prelaunchResearchRequest"]) {
      expect(frozenModelsFor(true) as readonly string[]).not.toContain(model);
    }
  });

  it("rejects writes to every currently frozen table", () => {
    for (const model of FROZEN_NOW) {
      expect(() => assertLegacyFunnelModelNotFrozen(model)).toThrow(LegacyFunnelWriteError);
      expect(() => assertLegacyFunnelModelNotFrozen(model)).toThrow(/frozen read-only/);
    }
  });

  it("does not freeze models that still have a producer", () => {
    expect(() => assertLegacyFunnelModelNotFrozen("researchRun")).not.toThrow();
    expect(() => assertLegacyFunnelModelNotFrozen("researchAction")).not.toThrow();
    expect(() => assertLegacyFunnelModelNotFrozen("evidenceRecord")).not.toThrow();
    expect(() => assertLegacyFunnelModelNotFrozen("site")).not.toThrow();
  });

  it("blocks write delegates through the proxied client and lets reads pass", async () => {
    const inner = {
      rankSnapshot: {
        create: vi.fn().mockResolvedValue({ id: "x" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const db = withFrozenLegacyFunnel(inner as never) as unknown as typeof inner;
    await expect(db.rankSnapshot.findMany()).resolves.toEqual([]);
    expect(inner.rankSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(() => db.rankSnapshot.create({ data: {} })).toThrow(LegacyFunnelWriteError);
    expect(inner.rankSnapshot.create).not.toHaveBeenCalled();
  });

  it("leaves non-frozen models untouched by the proxy", async () => {
    const inner = {
      evidenceRecord: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      researchRun: { create: vi.fn().mockResolvedValue({ id: "r1" }) },
    };
    const db = withFrozenLegacyFunnel(inner as never) as unknown as typeof inner;
    await expect(db.evidenceRecord.create({ data: {} })).resolves.toEqual({ id: "e1" });
    await expect(db.researchRun.create({ data: {} })).resolves.toEqual({ id: "r1" });
  });

  it("does nothing when the freeze is not enabled", () => {
    expect(frozenModelsFor(false)).toEqual([]);
    expect(() => assertLegacyFunnelModelNotFrozen("rankSnapshot", false)).not.toThrow();
  });
});
