import { describe, expect, it } from "vitest";

import { mapStaleness } from "@/lib/research/map-staleness";

/**
 * A topic map is a projection of the evidence that existed when it ran. These
 * tests are the three things a reader needs to be able to tell apart:
 *
 *   the map read the latest bundle   -> current
 *   a newer bundle exists than it read -> stale
 *   there is no bundle at all        -> no-bundle, which is not "no demand"
 */

describe("map staleness", () => {
  it("is current when the map consumed the latest completed bundle", () => {
    expect(mapStaleness({ mapBundleRunId: "bundle-a", latestBundleRunId: "bundle-a" })).toBe("current");
  });

  it("is stale when a later bundle exists than the one the map read", () => {
    expect(mapStaleness({ mapBundleRunId: "bundle-a", latestBundleRunId: "bundle-b" })).toBe("stale");
  });

  it("is no-bundle when no completed bundle exists, which is not the same as no demand", () => {
    expect(mapStaleness({ mapBundleRunId: null, latestBundleRunId: null })).toBe("no-bundle");
  });

  it("uses time to clear a legacy map that finished after the bundle", () => {
    // Maps written before this contract carry no `inputs.bundleRunId`. Time is
    // the other fact we have: a map that finished after the newest bundle cannot
    // have missed it, and calling it stale would put a rebuild banner on a site
    // whose map is already correct. Measured on atelier-harmonie, whose map was
    // built after its bundle and is reported current.
    expect(
      mapStaleness({
        mapBundleRunId: null,
        latestBundleRunId: "bundle-b",
        mapCreatedAt: new Date("2026-11-05T12:20:00Z"),
        latestBundleCompletedAt: new Date("2026-11-05T05:57:00Z"),
      })
    ).toBe("current");
  });

  it("reports a legacy map that finished before the bundle as stale", () => {
    // astridrincon: map 14:52, bundle 17:03 the same day.
    expect(
      mapStaleness({
        mapBundleRunId: null,
        latestBundleRunId: "bundle-b",
        mapCreatedAt: new Date("2026-11-21T14:52:00Z"),
        latestBundleCompletedAt: new Date("2026-11-21T17:03:00Z"),
      })
    ).toBe("stale");
  });

  it("does not let a legacy map with no recorded input and no times claim freshness", () => {
    // Neither the id nor the time proves freshness. Unknown is stale, never
    // current: the cost is a rebuild prompt, the alternative is an empty board
    // presented as a finding.
    expect(mapStaleness({ mapBundleRunId: null, latestBundleRunId: "bundle-b" })).toBe("stale");
  });

  it("treats a map built before any bundle as no-bundle until one completes", () => {
    expect(mapStaleness({ mapBundleRunId: null, latestBundleRunId: null })).toBe("no-bundle");
  });
});
