import { describe, expect, it } from "vitest";

import {
  countrySplit,
  MAX_MEASURED_MARKETS,
  MARKET_COVERAGE_FLOOR,
  MARKET_SHARE_FLOOR,
  measureMarket,
  MIN_MEASURABLE_IMPRESSIONS,
} from "@/lib/research/measured-market";

/**
 * A site with no stated country could not buy any evidence, because the bundle refuses
 * to run without a market. But Search Console has been recording the country on every
 * impression all along; `readQueryPagePerformance` queries it only to discard it.
 *
 * These are the real splits, measured 2026-11-25, and the judgement each one deserves.
 * The acceptance bar this file enforces is the plan's own: *if alaguillotine's answer is
 * "rank for these queries in the US" off 98 impressions, the floor is wrong.*
 */

const split = (entries: [string, number][]) => entries.map(([country, impressions]) => ({ country, impressions }));

describe("a market is only measurable when the share means something", () => {
  it("refuses a market when too few impressions were measured to have one", () => {
    // Below the volume floor a share is a rounding, not a signal.
    const market = measureMarket(
      split([
        ["usa", 48],
        ["fra", 16],
        ["deu", 12],
        ["zaf", 8],
        ["are", 7],
      ])
    );
    expect(market.countries).toEqual([]);
    expect(market.impressions).toBe(91);
    expect(market.blockedReason).toContain("91 impressions");
    expect(market.blockedReason).toContain(String(MIN_MEASURABLE_IMPRESSIONS));
    // The split is still reported: "no market" is a conclusion, not a deletion.
    expect(market.shares[0]).toMatchObject({ country: "usa", impressions: 48 });
  });

  it("refuses alaguillotine's real audience: enough volume, no market", () => {
    // The case the plan's acceptance bar names, measured properly. 136 impressions is
    // above the volume floor and USA carries 35% — above the share floor — so a naive
    // rule would buy US SERPs and then report "rank for X in the US" off 48 impressions
    // of a 31-country audience.
    //
    // This is why the coverage floor exists: a country can clear every share test and
    // still be a minority of the audience. Below half, naming it measures a fraction and
    // calls it the whole.
    const real: [string, number][] = [
      ["usa", 48], ["fra", 16], ["deu", 12], ["zaf", 8], ["bgd", 7], ["are", 7],
      ["gbr", 6], ["can", 5], ["esp", 4], ["aus", 3],
      // the remaining 21 countries carry the rest
      ...Array.from({ length: 21 }, (_, i) => [`c${i}`, 1] as [string, number]),
    ];
    const market = measureMarket(split(real.map(([c, n]) => [c, n] as [string, number])));
    expect(market.impressions).toBeGreaterThanOrEqual(MIN_MEASURABLE_IMPRESSIONS);
    expect(market.shares[0].share).toBeGreaterThanOrEqual(MARKET_SHARE_FLOOR);
    expect(market.countries).toEqual([]);
    expect(market.coverage).toBeLessThan(MARKET_COVERAGE_FLOOR);
    expect(market.blockedReason).toContain("scattered");
  });

  it("names susimacdonald's two markets from a real audience", () => {
    // 57% US, 27% MX: both above the floor, together 84% of the audience. This is
    // genuinely two markets rather than one market and its noise, and it is the case the
    // coverage floor must not refuse.
    const market = measureMarket(
      split([
        ["usa", 39372],
        ["mex", 18551],
        ["can", 8238],
        ["gbr", 1524],
        ["idn", 839],
      ])
    );
    expect(market.countries).toEqual(["usa", "mex"]);
    expect(market.dropped).toEqual([]);
    expect(market.blockedReason).toBeNull();
    expect(market.coverage).toBeGreaterThanOrEqual(MARKET_COVERAGE_FLOOR);
  });

  it("names one market when the second is below the floor", () => {
    // casamigo: 76% US, then 19% MX — under the 25% floor, so MX is not a market to buy
    // separately on this evidence.
    const market = measureMarket(
      split([
        ["usa", 171],
        ["mex", 42],
        ["can", 7],
        ["zaf", 4],
        ["bgd", 2],
      ])
    );
    expect(market.countries).toEqual(["usa"]);
    expect(market.coverage).toBeGreaterThan(MARKET_COVERAGE_FLOOR);
    expect(market.dropped).toEqual([]);
  });

  it("names one market for a site with a single audience country", () => {
    const market = measureMarket(split([["fra", 6343], ["bel", 169]]));
    expect(market.countries).toEqual(["fra"]);
    expect(market.coverage).toBeGreaterThan(0.9);
  });
});

describe("the cap is stated and the drop is named", () => {
  it("keeps the strongest markets and reports what the cap dropped", () => {
    // Three markets at 33% each: all clear the floor, the cap buys two, and the third is
    // named rather than omitted. This is the shape of a site that genuinely sells into
    // three places.
    const market = measureMarket(
      split([
        ["usa", 400],
        ["gbr", 400],
        ["aus", 400],
      ])
    );
    expect(market.countries.length).toBeLessThanOrEqual(MAX_MEASURED_MARKETS);
    expect(market.countries).toEqual(["aus", "gbr"]);
    expect(market.dropped.map((entry) => entry.country)).toEqual(["usa"]);
    // The invariant that matters: every qualifying country is either bought or named.
    const qualifying = market.shares.filter((entry) => entry.share >= MARKET_SHARE_FLOOR);
    expect(market.countries.length + market.dropped.length).toBe(qualifying.length);
  });

  it("refuses a four-way split even when the top country clears the share floor", () => {
    // 40% is above the 25% floor and still a minority of the audience. Naming it would
    // report two fifths as the whole, which is the defect the coverage floor prevents.
    const market = measureMarket(
      split([
        ["usa", 500],
        ["gbr", 300],
        ["aus", 250],
        ["can", 200],
      ])
    );
    expect(market.shares[0].share).toBeGreaterThanOrEqual(MARKET_SHARE_FLOOR);
    expect(market.countries).toEqual([]);
    expect(market.coverage).toBeLessThan(MARKET_COVERAGE_FLOOR);
  });

  it("reports a dropped market rather than omitting it", () => {
    // Three equal markets, a floor they all clear and a cap of two: two are bought and
    // the third is named as deferred. Ties break on the country code, so the dropped one
    // is `usa` (alphabetically last of aus/gbr/usa) — deterministic rather than
    // dependent on the order the rows happened to arrive in.
    const market = measureMarket(
      split([
        ["usa", 400],
        ["gbr", 400],
        ["aus", 400],
      ]),
      { shareFloor: 0.2, maxMarkets: 2 }
    );
    expect(market.countries).toEqual(["aus", "gbr"]);
    expect(market.dropped).toHaveLength(1);
    expect(market.dropped[0].country).toBe("usa");
    // The invariant that matters: every qualifying country is either bought or named.
    expect(market.countries.length + market.dropped.length).toBe(3);
  });

  it("breaks ties deterministically, so two runs agree", () => {
    const a = measureMarket(split([["usa", 100], ["gbr", 100]]), { shareFloor: 0.4 });
    const b = measureMarket(split([["gbr", 100], ["usa", 100]]), { shareFloor: 0.4 });
    expect(a.countries).toEqual(b.countries);
    expect(a.countries).toEqual(["gbr", "usa"]);
  });
});

describe("no evidence is reported as no evidence", () => {
  it("says so when there are no country rows at all", () => {
    // superincompetence and astridrincon: 0 impressions. There is no measured audience,
    // so no market can be inferred, and the honest answer is that one must be stated.
    const market = measureMarket([]);
    expect(market.countries).toEqual([]);
    expect(market.blockedReason).toContain("cannot be measured");
  });

  it("ignores unattributed impressions instead of naming 'nowhere' a market", () => {
    // Search Console writes an empty country for rows it could not attribute.
    const market = measureMarket(split([["", 5000], ["usa", 200]]));
    expect(market.countries).toEqual(["usa"]);
    expect(market.impressions).toBe(200);
  });

  it("says the audience is scattered when nothing clears the floor", () => {
    // Five countries at 20% each over 100 impressions: enough volume to look at, and no
    // country carrying the 25% that would make it the market.
    const market = measureMarket(
      split([
        ["usa", 20],
        ["fra", 20],
        ["deu", 20],
        ["jpn", 20],
        ["gbr", 20],
      ])
    );
    expect(market.countries).toEqual([]);
    expect(market.blockedReason).toContain("scattered");
  });

  it("refuses a negative or non-finite count rather than trusting it", () => {
    const market = measureMarket([
      { country: "usa", impressions: -50 },
      { country: "fra", impressions: Number.NaN },
      { country: "gbr", impressions: 200 },
    ]);
    expect(market.impressions).toBe(200);
    expect(market.countries).toEqual(["gbr"]);
  });
});

describe("the reader aggregates what the sync wrote", () => {
  it("sums impressions per country across rows", () => {
    // Search Console writes a row per query/date/page/device/country, so a country
    // appears many times.
    expect(
      countrySplit([
        { country: "usa", impressions: 10 },
        { country: "usa", impressions: 5 },
        { country: "mex", impressions: 3 },
      ])
    ).toEqual([
      { country: "usa", impressions: 15 },
      { country: "mex", impressions: 3 },
    ]);
  });

  it("drops empty and zero rows, which are not countries or not reach", () => {
    expect(countrySplit([{ country: "", impressions: 100 }, { country: "usa", impressions: 0 }])).toEqual([]);
  });

  it("matches the shape measureMarket consumes, end to end", () => {
    const rows = [
      { country: "usa", impressions: 600 },
      { country: "usa", impressions: 400 },
      { country: "mex", impressions: 100 },
      { country: "can", impressions: 50 },
    ];
    const market = measureMarket(countrySplit(rows));
    expect(market.impressions).toBe(1150);
    expect(market.countries).toEqual(["usa"]);
  });
});
