import { describe, expect, it } from "vitest";

import { coverCandidates } from "@/lib/delivery/unsplash";

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

  it("adds the business's own location when given one", () => {
    const candidates = coverCandidates("Atelier de tapisserie", "Saint-Pierre-en-Port, France");
    expect(candidates).toContain("Saint-Pierre-en-Port, France landscape");
  });

  it("carries no place names of its own", () => {
    const candidates = coverCandidates("SaaS analytics platform", null);
    expect(candidates.join(" ")).not.toMatch(/Cancun|Tulum|Riviera Maya|Normandie|Mexico/);
  });

  it("still returns a usable query for an empty title", () => {
    expect(coverCandidates("   ")).toEqual(["landscape"]);
  });
});
