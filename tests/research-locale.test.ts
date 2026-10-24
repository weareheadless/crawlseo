import { describe, expect, it } from "vitest";
import { researchCountry } from "@/lib/research/locale";

describe("research country", () => {
  it("uses the French edition for Atelier's French market", () => {
    expect(researchCountry("France, Normandie", "fr")).toBe("FR");
    expect(researchCountry("", "fr")).toBe("FR");
  });

  it("keeps existing regional mappings", () => {
    expect(researchCountry("Mexico", "en")).toBe("MX");
    expect(researchCountry("Spain", "es")).toBe("ES");
    expect(researchCountry("United Kingdom", "en")).toBe("GB");
  });

  it("falls back to US when no market or language matches", () => {
    expect(researchCountry("Global", "en")).toBe("US");
    expect(researchCountry(null, null)).toBe("US");
  });
});
