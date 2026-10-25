import { describe, expect, it } from "vitest";
import { researchCadenceWindow } from "@/lib/research/schedule";

describe("research cadence windows", () => {
  it("uses owner-local daily boundaries across daylight saving", () => {
    const before = researchCadenceWindow("daily", new Date("2026-03-08T12:00:00Z"), "America/New_York");
    expect(before.key).toBe("daily:2026-03-08");
    expect(before.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(before.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("uses Monday based weeks and calendar months", () => {
    const weekly = researchCadenceWindow("weekly", new Date("2026-10-25T12:00:00Z"), "UTC");
    expect(weekly.key).toBe("weekly:2026-10-19");
    const monthly = researchCadenceWindow("monthly", new Date("2026-10-25T12:00:00Z"), "UTC");
    expect(monthly.key).toBe("monthly:2026-10-01");
    expect(monthly.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
