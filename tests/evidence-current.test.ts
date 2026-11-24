import { describe, expect, it } from "vitest";

import { latestSample, rankOf, RANK_PRECEDENCE } from "@/lib/funnel/evidence";

/**
 * CMP-011: one place decides "current", and one rule decides which rank wins.
 *
 * The rank precedence used to be written four times, all spelled
 * `provider:position ?? first_party:position`, while `first_party` is the site's
 * own measured Search Console rank and a provider rank is a single sample.
 */

describe("rankOf", () => {
  it("prefers the first-party rank over a sampled provider rank", () => {
    expect(rankOf({ "provider:position": { value: 3 }, "first_party:position": { value: 7 } })).toBe(7);
  });

  it("falls back to the provider rank when there is no first-party one", () => {
    expect(rankOf({ "provider:position": { value: 3 } })).toBe(3);
  });

  it("declares its preference in one place", () => {
    expect(RANK_PRECEDENCE[0]).toBe("first_party:position");
  });

  it("returns null rather than a default when neither is present", () => {
    expect(rankOf({})).toBeNull();
    expect(rankOf(null)).toBeNull();
    expect(rankOf({ "provider:position": { value: null } })).toBeNull();
  });

  it("ignores a non-finite value", () => {
    expect(rankOf({ "first_party:position": { value: Number.NaN } })).toBeNull();
  });
});

describe("latestSample", () => {
  const row = (id: string, observedAt: string) => ({ id, observedAt: new Date(observedAt) });

  it("returns nothing for an empty list", () => {
    expect(latestSample([])).toEqual([]);
  });

  it("keeps every row at the newest instant and drops older ones", () => {
    const rows = [row("a", "2026-11-20T00:00:00Z"), row("b", "2026-11-23T00:00:00Z"), row("c", "2026-11-21T00:00:00Z"), row("d", "2026-11-23T00:00:00Z")];
    expect(latestSample(rows).map((entry) => entry.id)).toEqual(["b", "d"]);
  });
});
