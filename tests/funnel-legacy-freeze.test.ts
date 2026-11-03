import { describe, expect, it, vi } from "vitest";

import {
  LegacyFunnelWriteError,
  assertLegacyFunnelModelNotFrozen,
  withFrozenLegacyFunnel,
} from "@/lib/funnel/legacy-freeze";
import {
  FROZEN_FUNNEL_MODELS,
} from "@/lib/funnel/legacy-freeze";

const frozen = (model: string) => ({
  [model]: {
    create: vi.fn().mockResolvedValue({ id: "x" }),
    findMany: vi.fn().mockResolvedValue([]),
  },
}) as never;
void frozen;

describe("legacy funnel freeze (plan §6)", () => {
  it("rejects writes to every frozen legacy funnel table", () => {
    for (const model of FROZEN_FUNNEL_MODELS) {
      expect(() => assertLegacyFunnelModelNotFrozen(model)).toThrow(LegacyFunnelWriteError);
      expect(() => assertLegacyFunnelModelNotFrozen(model)).toThrow(/frozen read-only/);
    }
  });

  it("does not freeze models outside the legacy funnel list", () => {
    expect(() => assertLegacyFunnelModelNotFrozen("evidenceRecord")).not.toThrow();
    expect(() => assertLegacyFunnelModelNotFrozen("site")).not.toThrow();
  });

  it("blocks write delegates through the proxied client and lets reads pass", async () => {
    const inner = {
      researchRun: {
        create: vi.fn().mockResolvedValue({ id: "x" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const db = withFrozenLegacyFunnel(inner as never) as unknown as typeof inner;
    await expect(db.researchRun.findMany()).resolves.toEqual([]);
    expect(inner.researchRun.findMany).toHaveBeenCalledTimes(1);
    expect(() => db.researchRun.create({ data: {} })).toThrow(LegacyFunnelWriteError);
    expect(inner.researchRun.create).not.toHaveBeenCalled();
  });

  it("leaves non-frozen models untouched by the proxy", async () => {
    const inner = {
      evidenceRecord: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
    };
    const db = withFrozenLegacyFunnel(inner as never) as unknown as typeof inner;
    await expect(db.evidenceRecord.create({ data: {} })).resolves.toEqual({ id: "e1" });
    expect(inner.evidenceRecord.create).toHaveBeenCalledTimes(1);
  });
});
