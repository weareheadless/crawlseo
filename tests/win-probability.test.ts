import { describe, expect, it, vi } from "vitest";

import {
  ASSUMED_WIN_PROBABILITY_CEILING,
  authorityGapFromSets,
  difficultyToSerpCompetition,
  isLowConfidence,
  pageStrength,
  resolveWinProbability,
} from "@/lib/funnel/win-probability";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * CMP-012: the fight we are actually in.
 *
 * The defect was not a wrong number, it was a **typed-in** one. Measured 2026-11-24 on 145
 * live opportunities: `pageStrength` and `serpCompetition` were the literal `0.5` on all
 * 145, `authorityGap` on 70. The score read as "this is a fair fight" while the fair-fight
 * number was a developer's constant.
 *
 * These tests pin the four things that make the replacement trustworthy:
 *  - one exported curve from difficulty to competition, and `0` means unmeasured,
 *  - `null` where nothing was measured, and `null` never silently becomes a neutral 0.5,
 *  - the values come from stored facts (difficulty, referring sets, the crawl),
 *  - an entirely-assumed row cannot reach the top band, and equal volume with different
 *    incumbents no longer scores the same.
 */

const difficulty = (value: number, observedAt = new Date("2026-11-01T00:00:00Z")) => ({
  kind: "keyword_metrics",
  dimensions: { query: "condos for sale" },
  metrics: { "provider:difficulty": { value, unit: "score", source: "provider" } },
  observedAt,
});

const referringSet = (scope: string, count: number) => ({
  kind: "backlink_profile",
  dimensions: { scope, domain: "x.test", domains: [] as string[] },
  metrics: { "provider:referringDomains": { value: count, unit: "count", source: "provider" } },
  observedAt: new Date("2026-11-01T00:00:00Z"),
});

function mockDb(input: {
  evidence?: Array<Record<string, unknown>>;
  pages?: Array<{ url: string; wordCount: number; hasSchema: boolean; internalLinks: number; responseTimeMs: number }>;
}) {
  return {
    evidenceRecord: { findMany: vi.fn(async () => input.evidence ?? []) },
    crawl: { findFirst: vi.fn(async () => ({ id: "crawl-1" })) },
    auditPage: { findMany: vi.fn(async () => input.pages ?? []) },
  };
}

describe("CMP-012 one exported curve from provider difficulty", () => {
  it("maps difficulty to a decreasing competition input", () => {
    // The acceptance asks for the curve at 0, 30, 50, 70, 100.
    expect(difficultyToSerpCompetition(0)).toBeNull();
    expect(difficultyToSerpCompetition(30)).toBeCloseTo(0.7, 3);
    expect(difficultyToSerpCompetition(50)).toBeCloseTo(0.5, 3);
    expect(difficultyToSerpCompetition(70)).toBeCloseTo(0.3, 3);
    expect(difficultyToSerpCompetition(100)).toBeCloseTo(0, 3);
  });

  it("is monotonic, so a harder keyword is never easier", () => {
    let previous = 1.1;
    for (let value = 1; value <= 100; value += 1) {
      const mapped = difficultyToSerpCompetition(value)!;
      expect(mapped).toBeLessThanOrEqual(previous);
      previous = mapped;
    }
  });

  it("treats a difficulty of 0 as unmeasured, not as a free win", () => {
    // Measured: 435 of 621 stored difficulties are 0, and those rows carry a median volume
    // of 1,900. A genuinely easy keyword would not. Mapping 0 to 1.0 would promote exactly
    // the rows nobody measured.
    expect(difficultyToSerpCompetition(0)).toBeNull();
  });

  it("returns null for a value that is not a number", () => {
    expect(difficultyToSerpCompetition(null)).toBeNull();
    expect(difficultyToSerpCompetition(undefined)).toBeNull();
    expect(difficultyToSerpCompetition(Number.NaN)).toBeNull();
  });

  it("clamps an out-of-range provider score rather than trusting it", () => {
    expect(difficultyToSerpCompetition(-5)).toBeNull();
    expect(difficultyToSerpCompetition(150)).toBe(0);
  });
});

describe("CMP-012 authority and page strength are ratios of measured facts", () => {
  it("reads authority as our share of the measured referring-domain pool", () => {
    // 63 ours against a competitor's 200: a different fight from 9-to-1.
    expect(authorityGapFromSets(63, 200)).toBeCloseTo(0.24, 2);
    expect(authorityGapFromSets(9, 1)).toBeCloseTo(0.9, 2);
  });

  it("returns null when either side was never measured", () => {
    expect(authorityGapFromSets(null, 200)).toBeNull();
    expect(authorityGapFromSets(63, null)).toBeNull();
    // Two empty sets measured nothing about relative authority.
    expect(authorityGapFromSets(0, 0)).toBeNull();
  });

  it("compares our page against the competitor's on facts, not on a constant", () => {
    const ours = { wordCount: 2_000, hasSchema: true, internalLinks: 40, responseTimeMs: 500 };
    const weakTheirs = { wordCount: 800, hasSchema: false, internalLinks: 5, responseTimeMs: 1_400 };
    const strongTheirs = { wordCount: 3_000, hasSchema: true, internalLinks: 90, responseTimeMs: 300 };
    expect(pageStrength(ours, weakTheirs)).toBe(1);
    // Worse on three of four dimensions; response time is still within 1.5×, so 0.25 is
    // the honest ratio rather than a flat zero.
    expect(pageStrength(ours, strongTheirs)).toBe(0.25);
    expect(pageStrength(ours, strongTheirs)!).toBeLessThan(0.5);
    // And it says so rather than guessing when one side was never crawled.
    expect(pageStrength(null, strongTheirs)).toBeNull();
    expect(pageStrength(ours, null)).toBeNull();
  });

  it("ignores a dimension neither side measured instead of scoring it", () => {
    const ours = { wordCount: 2_000, hasSchema: null, internalLinks: null, responseTimeMs: null };
    const theirs = { wordCount: 1_000, hasSchema: null, internalLinks: null, responseTimeMs: null };
    // One comparison, which we win — not one win out of four with three nulls counted.
    expect(pageStrength(ours, theirs)).toBe(1);
  });

  it("returns null when nothing could be compared", () => {
    const blank = { wordCount: null, hasSchema: null, internalLinks: null, responseTimeMs: null };
    expect(pageStrength(blank, blank)).toBeNull();
  });
});

describe("CMP-012 the resolver reads stored facts and reports what is missing", () => {
  it("fills serpCompetition from the stored difficulty", async () => {
    const db = mockDb({ evidence: [difficulty(58)] });
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      query: "condos for sale",
      rankDistance: 0.8,
      playTypeFactor: 0.6,
    });
    expect(result.winProbability.serpCompetition).toBeCloseTo(0.42, 2);
    expect(result.provenance.source.serpCompetition).toBe("measured");
  });

  it("leaves serpCompetition null when the stored difficulty is zero", async () => {
    const db = mockDb({ evidence: [difficulty(0)] });
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      query: "condos for sale",
      rankDistance: 0.8,
      playTypeFactor: 0.6,
    });
    expect(result.winProbability.serpCompetition).toBeNull();
    expect(result.provenance.source.serpCompetition).toBe("assumed");
    expect(result.provenance.missing.join(" ")).toContain("difficulty above zero");
  });

  it("fills authorityGap from our own and a competitor's referring set", async () => {
    const db = mockDb({
      evidence: [referringSet("own_referring_domains", 63), referringSet("competitor_referring_domains", 200)],
    });
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      query: "condos for sale",
      rankDistance: 0.8,
      playTypeFactor: 0.6,
    });
    expect(result.winProbability.authorityGap).toBeCloseTo(0.24, 2);
    expect(result.provenance.source.authorityGap).toBe("measured");
  });

  it("does not offer authority at all without both sides", async () => {
    const db = mockDb({ evidence: [referringSet("own_referring_domains", 63)] });
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      query: "condos for sale",
      rankDistance: 0.8,
      playTypeFactor: 0.6,
    });
    expect(result.winProbability.authorityGap).toBeNull();
    expect(result.provenance.missing.join(" ")).toContain("referring-domain set");
  });

  it("fills pageStrength from the crawl's own page row", async () => {
    const db = mockDb({
      evidence: [
        {
          kind: "onpage_crawl",
          dimensions: { scope: "competitor", query: "condos for sale", wordCount: 2_600, schemaTypes: ["Article"] },
          metrics: {},
          observedAt: new Date("2026-11-01T00:00:00Z"),
        },
      ],
      pages: [{ url: "https://oursite.com/condos", wordCount: 568, hasSchema: false, internalLinks: 12, responseTimeMs: 700 }],
    });
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "condos for sale",
      rankDistance: 0.8,
      playTypeFactor: 0.6,
      targetUrl: "https://www.oursite.com/condos/",
    });
    // 568 words against 2,600 and no schema: we lose both comparable dimensions.
    expect(result.winProbability.pageStrength).toBe(0);
    expect(result.provenance.source.pageStrength).toBe("measured");
  });

  it("says the target page was not crawled rather than assuming strength", async () => {
    const db = mockDb({ evidence: [], pages: [{ url: "https://oursite.com/other", wordCount: 900, hasSchema: true, internalLinks: 4, responseTimeMs: 400 }] });
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "condos for sale",
      rankDistance: 0.8,
      playTypeFactor: 0.6,
      targetUrl: "https://oursite.com/condos",
    });
    expect(result.winProbability.pageStrength).toBeNull();
    expect(result.provenance.missing.join(" ")).toContain("has not been crawled");
  });

  it("says an opportunity with no query cannot be looked up at all", async () => {
    const db = mockDb({});
    const result = await resolveWinProbability(db as never, {
      projectId: "p1",
      query: null,
      rankDistance: null,
      playTypeFactor: 0.6,
    });
    expect(result.entirelyAssumed).toBe(true);
    expect(result.provenance.missing.join(" ")).toContain("names no query");
  });

  it("reports entirelyAssumed only when nothing measurable was measured", async () => {
    const withDifficulty = await resolveWinProbability(mockDb({ evidence: [difficulty(40)] }) as never, {
      projectId: "p1",
      query: "condos for sale",
      rankDistance: null,
      playTypeFactor: 0.6,
    });
    expect(withDifficulty.entirelyAssumed).toBe(false);
    expect(isLowConfidence(withDifficulty.provenance)).toBe(false);

    const withNothing = await resolveWinProbability(mockDb({}) as never, {
      projectId: "p1",
      query: "condos for sale",
      rankDistance: null,
      playTypeFactor: 0.6,
    });
    expect(withNothing.entirelyAssumed).toBe(true);
    expect(isLowConfidence(withNothing.provenance)).toBe(true);
  });
});

describe("CMP-012 an unmeasured fight cannot score like a measured one", () => {
  /**
   * The SEO test from the acceptance, run as arithmetic: two opportunities, equal volume and
   * equal position, differing only in incumbent strength. Before this change they scored
   * identically, because `authorityGap`, `pageStrength` and `serpCompetition` were all 0.5.
   */
  const base: Omit<ScoreInputs, "evidenceCompleteness"> = {
    worth: {
      volume: 500,
      ctrAtPosition: 0.08,
      businessValue: 0.85,
      volumeSource: "provider",
      businessValueSource: "knowledge",
      currentPosition: 12,
      targetPosition: 3,
      windowDays: 30,
    },
    winProbability: { rankDistance: 0.8, authorityGap: null, pageStrength: null, serpCompetition: null, playTypeFactor: 0.6 },
    effort: { playTypeBase: 6, sizeFactor: 1 },
    freshness: 1,
    stability: 1,
  };
  const measuredSource = {
    rankDistance: "measured",
    authorityGap: "measured",
    pageStrength: "measured",
    serpCompetition: "measured",
    playTypeFactor: "assumed",
  } as const;

  it("orders a weak incumbent above a strong one at the same volume and position", () => {
    const easy = computeScore({
      ...base,
      evidenceCompleteness: "both",
      winProbability: { rankDistance: 0.8, authorityGap: 0.9, pageStrength: 0.9, serpCompetition: 0.9, playTypeFactor: 0.6 },
      winProbabilitySource: measuredSource,
    });
    const hard = computeScore({
      ...base,
      evidenceCompleteness: "both",
      winProbability: { rankDistance: 0.8, authorityGap: 0.15, pageStrength: 0.25, serpCompetition: 0.2, playTypeFactor: 0.6 },
      winProbabilitySource: measuredSource,
    });
    expect(easy.scoreValue).toBeGreaterThan(hard.scoreValue);
    // A material gap, not a rounding difference.
    expect(easy.scoreValue - hard.scoreValue).toBeGreaterThanOrEqual(10);
  });

  it("caps a row whose winnability is entirely assumed", () => {
    const assumed = computeScore({ ...base, evidenceCompleteness: "both" });
    expect(assumed.scoreValue).toBeLessThanOrEqual(ASSUMED_WIN_PROBABILITY_CEILING);
  });

  it("does not cap a row that measured at least one input", () => {
    const measured = computeScore({
      ...base,
      evidenceCompleteness: "both",
      winProbability: { rankDistance: 0.8, authorityGap: 0.9, pageStrength: 0.9, serpCompetition: 0.9, playTypeFactor: 0.6 },
      winProbabilitySource: measuredSource,
    });
    expect(measured.scoreValue).toBeGreaterThan(ASSUMED_WIN_PROBABILITY_CEILING);
  });

  it("treats a row with no provenance at all as assumed", () => {
    // Rows scored before this existed carry no source, so they must not be trusted as
    // measured — that is the whole defect, in one line.
    const legacy = computeScore({ ...base, evidenceCompleteness: "both" });
    expect(legacy.scoreValue).toBeLessThanOrEqual(ASSUMED_WIN_PROBABILITY_CEILING);
  });
});
