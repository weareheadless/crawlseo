import { describe, expect, it } from "vitest";

import { coverCandidates, primaryPlace } from "@/lib/delivery/unsplash";

/**
 * The cover fallback used to carry a hardcoded list of places (Cancun, Tulum,
 * Normandie, Mexico). That is one client's market baked into a shared path; the
 * caller now supplies the business's own location.
 */
describe("unsplash cover candidates", () => {
  it("tries the query, a shortened form, and a generic fallback", () => {
    expect(coverCandidates("Restauration d'un fauteuil ancien en Normandie")).toEqual([
      "Restauration d'un fauteuil ancien en Normandie",
      "Restauration d un fauteuil ancien en",
      "landscape",
    ]);
  });

  it("searches the specific place before the article wording", () => {
    const candidates = coverCandidates("Atelier de tapisserie", "Saint-Pierre-en-Port, France");
    expect(candidates[1]).toBe("Saint-Pierre-en-Port");
    expect(candidates).toContain("Saint-Pierre-en-Port landscape");
    // The market description is not an image query.
    expect(candidates).not.toContain("Saint-Pierre-en-Port, France");
  });

  it("uses the first place of a market description", () => {
    expect(primaryPlace("Playa Del Carmen, Tulum & Riviera Maya")).toBe("Playa Del Carmen");
    expect(primaryPlace("Lisbon")).toBe("Lisbon");
    expect(primaryPlace(null)).toBe("");
  });

  it("does not repeat the place when the topic already names it", () => {
    const candidates = coverCandidates("Banks in Playa del Carmen", "Playa Del Carmen, Tulum & Riviera Maya");
    expect(candidates[0]).toBe("Playa Del Carmen");
    expect(candidates).not.toContain("Banks in Playa del Carmen Playa Del Carmen");
  });

  it("carries no place names of its own", () => {
    const candidates = coverCandidates("SaaS analytics platform", null);
    expect(candidates.join(" ")).not.toMatch(/Cancun|Tulum|Riviera Maya|Normandie|Mexico/);
  });

  it("still returns a usable query for an empty title", () => {
    expect(coverCandidates("   ")).toEqual(["landscape"]);
  });
});
