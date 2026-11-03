import { describe, expect, it } from "vitest";

import { pickDerivedKeyword } from "@/lib/dataforseo/collection";

/**
 * A gap finding names a phrase Labs may not know ("retapisser un siège
 * soi-même"); the how-leg join needs a keyword it can measure.
 */
describe("keyword derivation from a phrase Labs does not know", () => {
  it("prefers a candidate sharing a token with the seed, then volume", () => {
    const chosen = pickDerivedKeyword("retapisser un siège soi-même", [
      { keyword: "abat jour sur mesure", volume: 900 },
      { keyword: "retapisser un siege", volume: 120 },
      { keyword: "retapisser siege", volume: 40 },
    ]);
    expect(chosen?.keyword).toBe("retapisser un siege");
    expect(chosen?.shared).toBeGreaterThan(0);
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
