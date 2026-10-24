import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_CADENCE,
  normalizeResearchCadence,
} from "@/lib/research/policy";

describe("research cadence", () => {
  it("defaults new or invalid policies to weekly", () => {
    expect(DEFAULT_RESEARCH_CADENCE).toBe("weekly");
    expect(normalizeResearchCadence(undefined)).toBe("weekly");
    expect(normalizeResearchCadence("unexpected")).toBe("weekly");
  });

  it("keeps explicit valid cadences", () => {
    expect(normalizeResearchCadence("daily")).toBe("daily");
    expect(normalizeResearchCadence("weekly")).toBe("weekly");
    expect(normalizeResearchCadence("monthly")).toBe("monthly");
    expect(normalizeResearchCadence("manual")).toBe("manual");
  });
});
