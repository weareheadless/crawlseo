import { describe, expect, it } from "vitest";

import { pickDerivedKeyword } from "@/lib/dataforseo/collection";

/**
 * A gap finding names a phrase Labs may not know ("retapisser un siège
 * soi-même"); the how-leg join needs a keyword it can measure.
 */
describe("keyword derivation from a phrase Labs does not know", () => {
  it("keeps the candidate that stays closest to the seed", () => {
    const chosen = pickDerivedKeyword("retapisser un siège soi-même", [
      { keyword: "abat jour sur mesure", volume: 900 },
      { keyword: "retapisser un siege", volume: 120 },
      { keyword: "retapisser siege", volume: 40 },
    ]);
    expect(chosen?.keyword).toBe("retapisser un siege");
    expect(chosen?.retained).toBeGreaterThan(0);
    expect(chosen?.specificity).toBe("narrowed");
  });

  it("ignores candidates with no measurable demand", () => {
    expect(pickDerivedKeyword("abat-jour", [{ keyword: "abat-jour", volume: null }, { keyword: "abat jour", volume: 0 }])).toBeNull();
  });

  it("falls back to the highest volume when nothing shares a token", () => {
    const chosen = pickDerivedKeyword("xyzzy", [
      { keyword: "tapisserie siege", volume: 300 },
      { keyword: "tapisserie chaise", volume: 800 },
    ]);
    expect(chosen?.keyword).toBe("tapisserie chaise");
  });
});

describe("specificity, not volume, decides", () => {
  /**
   * Regression: "abat-jour" is one hyphenated word, but the old token counter
   * split it on the hyphen, counted two tokens, and let its 49,500/month volume
   * beat the phrase the finding actually named. A chair-upholstery pain point was
   * filed under a lighting head term.
   */
  it("does not reduce a phrase to a single hyphenated head term", () => {
    const chosen = pickDerivedKeyword("abat-jour ne tient pas droit", [
      { keyword: "abat-jour", volume: 49_500 },
      { keyword: "abat-jour pour lampe", volume: 14_800 },
    ]);
    // "abat-jour pour lampe" keeps one of four words: a different query.
    expect(chosen).toBeNull();
  });

  it("accepts a candidate that keeps at least half the phrase", () => {
    const chosen = pickDerivedKeyword("abat-jour ne tient pas droit", [
      { keyword: "abat-jour", volume: 49_500 },
      { keyword: "abat jour ne tient pas droit", volume: 40 },
    ]);
    expect(chosen?.keyword).toBe("abat jour ne tient pas droit");
    expect(chosen?.specificity).toBe("exact");
  });

  it("returns nothing rather than a head term when only one exists", () => {
    expect(pickDerivedKeyword("abat-jour ne tient pas droit", [
      { keyword: "abat-jour", volume: 49_500 },
      { keyword: "luminaire", volume: 12_000 },
    ])).toBeNull();
  });

  it("prefers demand among candidates that keep every seed word", () => {
    const chosen = pickDerivedKeyword("restauration de sièges", [
      { keyword: "restauration de sieges anciens", volume: 90 },
      { keyword: "restauration sieges", volume: 2_400 },
    ]);
    expect(chosen?.keyword).toBe("restauration sieges");
    expect(chosen?.dropped).toBe(0);
  });

  it("keeps the exact phrase over a longer long-tail", () => {
    const chosen = pickDerivedKeyword("restauration meuble ancien", [
      { keyword: "restauration meuble ancien", volume: 720 },
      { keyword: "restauration meuble ancien autour de moi", volume: 20 },
    ]);
    expect(chosen?.keyword).toBe("restauration meuble ancien");
    expect(chosen?.specificity).toBe("exact");
  });
});
