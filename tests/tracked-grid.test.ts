import { describe, expect, it } from "vitest";

import { BUNDLE_SERP_CAP, selectWatchList } from "@/lib/funnel/serp-watch-list";
import { DEFAULT_GRID_SIZE, hubFromIdentity, orderGridMembers } from "@/lib/funnel/tracked-grid";

/**
 * CMP-004's two decisions: which queries are on the grid, and which one SERP per
 * month is bought for.
 *
 * Neither decides what a topic means. The grid is the cluster's declared hub plus
 * measured demand; the watch list is live work first, then the declared grid.
 */
describe("CMP-004 tracked grid selection", () => {
  it("puts the cluster's declared hub first", () => {
    const ordered = orderGridMembers(
      [
        { query: "cheap villas", volume: 9000, impressions: 0 },
        { query: "villas in playa del carmen", volume: 100, impressions: 10 },
      ],
      { hub: "villas in playa del carmen", size: 2 }
    );
    expect(ordered.selected[0]).toBe("villas in playa del carmen");
  });

  it("orders the rest by measured demand, volume before impressions", () => {
    const ordered = orderGridMembers(
      [
        { query: "small", volume: 10, impressions: 5000 },
        { query: "big", volume: 800, impressions: 1 },
        { query: "none", volume: 0, impressions: 0 },
      ],
      { size: 3 }
    );
    expect(ordered.selected).toEqual(["big", "small", "none"]);
  });

  it("takes the declared hub only when it is really a member", () => {
    const members = [{ query: "villas in playa del carmen" }];
    expect(hubFromIdentity("serp:villas in playa del carmen", members)).toBe("villas in playa del carmen");
    // A hub that is not a member is not silently invented.
    expect(hubFromIdentity("serp:some other phrase", members)).toBe(null);
    // A curated or hashed identity names no member.
    expect(hubFromIdentity("curated:my-cluster", members)).toBe(null);
    expect(hubFromIdentity("knowledge:9f8a7b", members)).toBe(null);
    expect(hubFromIdentity(null, members)).toBe(null);
  });

  it("caps the grid and reports what it left off, with the reason", () => {
    const members = Array.from({ length: DEFAULT_GRID_SIZE + 2 }, (_, index) => ({
      query: `query ${index}`,
      volume: 100 - index,
      impressions: 0,
    }));
    const ordered = orderGridMembers(members, { size: DEFAULT_GRID_SIZE });
    expect(ordered.selected).toHaveLength(DEFAULT_GRID_SIZE);
    expect(ordered.untracked).toHaveLength(2);
    expect(ordered.untracked.every((row) => row.reason === "beyond_grid_size")).toBe(true);
  });

  it("names an unmeasured member as such rather than pretending it is a demand", () => {
    const ordered = orderGridMembers(
      [
        { query: "measured", volume: 5, impressions: 0 },
        { query: "unmeasured", volume: 0, impressions: 0 },
      ],
      { size: 1 }
    );
    expect(ordered.selected).toEqual(["measured"]);
    expect(ordered.untracked).toEqual([{ query: "unmeasured", reason: "no_measured_demand" }]);
  });

  it("dedupes members that differ only in case or spacing", () => {
    const ordered = orderGridMembers(
      [
        { query: "Villas In Playa", volume: 10, impressions: 0 },
        { query: "villas in playa ", volume: 10, impressions: 0 },
      ],
      { size: 5 }
    );
    expect(ordered.selected).toHaveLength(1);
  });

  it("is deterministic for members with identical demand", () => {
    const first = orderGridMembers(
      [
        { query: "b", volume: 1, impressions: 1 },
        { query: "a", volume: 1, impressions: 1 },
      ],
      { size: 2 }
    );
    const second = orderGridMembers(
      [
        { query: "a", volume: 1, impressions: 1 },
        { query: "b", volume: 1, impressions: 1 },
      ],
      { size: 2 }
    );
    expect(first.selected).toEqual(second.selected);
    expect(first.selected).toEqual(["a", "b"]);
  });
});

describe("CMP-004 monthly watch list", () => {
  const base = { perCallMicros: 4000, alreadySampled: new Set<string>() };

  it("never exceeds the bundle's own SERP cap", () => {
    const watch = selectWatchList({
      ...base,
      opportunityQueries: Array.from({ length: 40 }, (_, index) => `live ${index}`),
      gridQueries: Array.from({ length: 40 }, (_, index) => `grid ${index}`),
    });
    expect(watch.cap).toBe(BUNDLE_SERP_CAP);
    expect(watch.selected).toHaveLength(BUNDLE_SERP_CAP);
    expect(watch.capReached).toBe(true);
    expect(watch.omitted).toBe(80 - BUNDLE_SERP_CAP);
  });

  it("refuses a cap larger than the bundle allows", () => {
    const watch = selectWatchList({ ...base, opportunityQueries: ["one"], gridQueries: [], cap: 500 });
    expect(watch.cap).toBe(BUNDLE_SERP_CAP);
  });

  it("buys the queries with live work before the declared grid", () => {
    const watch = selectWatchList({ ...base, opportunityQueries: ["live query"], gridQueries: ["grid query"], cap: 1 });
    expect(watch.selected).toEqual(["live query"]);
  });

  it("buys nothing for a query this month already sampled", () => {
    const watch = selectWatchList({
      ...base,
      alreadySampled: new Set(["live query"]),
      opportunityQueries: ["live query"],
      gridQueries: ["grid query"],
    });
    expect(watch.selected).toEqual(["grid query"]);
    expect(watch.reused).toBe(1);
  });

  it("is idempotent: a second run in the same month selects nothing", () => {
    const first = selectWatchList({ ...base, opportunityQueries: ["a"], gridQueries: ["b"] });
    const second = selectWatchList({
      ...base,
      alreadySampled: new Set(first.selected.map((query) => query.toLowerCase())),
      opportunityQueries: ["a"],
      gridQueries: ["b"],
    });
    expect(second.selected).toEqual([]);
    expect(second.estimatedMicros).toBe(0);
    expect(second.reused).toBe(2);
  });

  it("reports the cost of exactly what it selected", () => {
    const watch = selectWatchList({ ...base, opportunityQueries: ["a", "b"], gridQueries: [] });
    expect(watch.selected).toHaveLength(2);
    expect(watch.estimatedMicros).toBe(8000);
  });

  it("counts a duplicate query once, whichever list it came from", () => {
    const watch = selectWatchList({ ...base, opportunityQueries: ["same query"], gridQueries: ["Same Query"] });
    expect(watch.selected).toHaveLength(1);
  });

  it("reports an unusable row instead of buying a blank query", () => {
    const watch = selectWatchList({ ...base, opportunityQueries: ["  "], gridQueries: ["real"] });
    expect(watch.invalid).toBe(1);
    expect(watch.selected).toEqual(["real"]);
  });
});
