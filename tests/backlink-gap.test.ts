import { describe, expect, it, vi } from "vitest";

import {
  backlinkGap,
  linkTargetSummary,
  normalizeDomain,
  type ReferringDomain,
} from "@/lib/funnel/backlink-gap";
import { linkTargetsForOpportunity, runLinkGapPass, storeOwnDomainGap, storedReferringSet } from "@/lib/funnel/link-gap-pass";

/**
 * CMP-007's arithmetic and the pass that produces it.
 *
 * The acceptance is a set difference with known sets, so the fixture here has one:
 *
 *   ours        = { shared.com, ours-only.com }
 *   competitor  = { shared.com, theirs-1.com, theirs-2.com, theirs-3.com }
 *   gap         = 3  (theirs-1, theirs-2, theirs-3)
 *
 * Two failures this file exists to catch, both of which would look like data:
 *  - counting a shared domain as an opportunity (subtracting a *count* instead of
 *    a set),
 *  - reporting gap 0 for a competitor whose data was never measured.
 */

const NOW = new Date("2026-11-24T00:00:00Z");
const PERIOD_START = new Date("2026-11-01T00:00:00Z");

const ref = (domain: string, rank: number | null = null): ReferringDomain => ({
  domain,
  rank,
  backlinks: null,
  targetUrl: null,
  linkType: null,
});

describe("CMP-007 the gap is a set difference", () => {
  it("returns the domains that link to a competitor and not to us", () => {
    const gap = backlinkGap({
      ours: [ref("shared.com"), ref("ours-only.com")],
      competitors: [
        { domain: "rival.com", referring: [ref("shared.com"), ref("theirs-1.com"), ref("theirs-2.com"), ref("theirs-3.com")] },
      ],
    });
    expect(gap.gap).toBe(3);
    expect(gap.targets.map((row) => row.domain)).toEqual(["theirs-1.com", "theirs-2.com", "theirs-3.com"]);
    // A domain that already links to us is not a link opportunity.
    expect(gap.targets.map((row) => row.domain)).not.toContain("shared.com");
    expect(gap.shared).toEqual(["shared.com"]);
    expect(gap.ourDomainCount).toBe(2);
  });

  it("counts a domain once when two competitors both have it, and says how many do", () => {
    const gap = backlinkGap({
      ours: [],
      competitors: [
        { domain: "a.com", referring: [ref("both.com", 40)] },
        { domain: "b.com", referring: [ref("both.com", 60), ref("only-b.com")] },
      ],
    });
    expect(gap.gap).toBe(2);
    const both = gap.targets.find((row) => row.domain === "both.com");
    expect(both?.competitorsLinking).toBe(2);
    // The strongest link from one domain is what an outreach list needs.
    expect(both?.rank).toBe(60);
  });

  it("normalises scheme, www and trailing paths so one domain is one target", () => {
    expect(normalizeDomain("https://www.Rival.com/page")).toBe("rival.com");
    expect(normalizeDomain("rival.com")).toBe("rival.com");
    expect(normalizeDomain(" www.rival.com ")).toBe("rival.com");

    const gap = backlinkGap({
      ours: [ref("https://www.shared.com/x")],
      competitors: [
        {
          domain: "rival.com",
          referring: [ref("https://www.shared.com/y"), ref("https://www.theirs.com/p")],
        },
      ],
    });
    // Without normalisation this would report 2 targets and 0 shared.
    expect(gap.gap).toBe(1);
    expect(gap.targets[0].domain).toBe("theirs.com");
    expect(gap.shared).toEqual(["shared.com"]);
  });

  it("orders by provider rank, then by how many competitors a domain links to", () => {
    const gap = backlinkGap({
      ours: [],
      competitors: [
        { domain: "a.com", referring: [ref("low.com", 5), ref("high.com", 90)] },
        { domain: "b.com", referring: [ref("mid.com", 50), ref("kind-of-high.com", 50)] },
      ],
    });
    expect(gap.targets.map((row) => row.domain)).toEqual(["high.com", "kind-of-high.com", "mid.com", "low.com"]);
  });

  it("names a competitor with no data instead of reporting gap 0 for it", () => {
    const gap = backlinkGap({
      ours: [],
      competitors: [
        { domain: "has-data.com", referring: [ref("theirs.com")] },
        { domain: "no-data.com", referring: null },
      ],
    });
    expect(gap.gap).toBe(1);
    // An absent measurement is not "no links".
    expect(gap.missing).toEqual(["no-data.com"]);
    expect(gap.competitorDomainCount).toBe(1);
  });

  it("says the subtraction had no subtrahend when our own set was never read", () => {
    const gap = backlinkGap({
      ours: null,
      competitors: [{ domain: "rival.com", referring: [ref("a.com"), ref("b.com")] }],
    });
    // The targets are still listed, but the count of our own domains is *unknown*,
    // not zero: claiming 0 would excuse every shared domain.
    expect(gap.ourDomainCount).toBeNull();
    expect(gap.gap).toBe(2);
  });

  it("reports zero targets honestly when every competitor domain is shared", () => {
    const gap = backlinkGap({
      ours: [ref("a.com"), ref("b.com")],
      competitors: [{ domain: "rival.com", referring: [ref("a.com"), ref("b.com")] }],
    });
    expect(gap.gap).toBe(0);
    expect(gap.targets).toEqual([]);
    expect(gap.ourDomainCount).toBe(2);
    expect(linkTargetSummary(gap)).toContain("No link gap");
  });
});

describe("CMP-007 the summary names domains", () => {
  it("names the first targets and counts the rest", () => {
    const gap = backlinkGap({
      ours: [],
      competitors: [
        {
          domain: "rival.com",
          referring: [1, 2, 3, 4, 5].map((index) => ref(`target${index}.com`, 100 - index)),
        },
      ],
    });
    const summary = linkTargetSummary(gap);
    expect(summary).toContain("5 domains");
    expect(summary).toContain("target1.com");
    expect(summary).toContain("and 2 more");
  });

  it("says the gap is not measured when no competitor had data", () => {
    const gap = backlinkGap({
      ours: [ref("ours.com")],
      competitors: [{ domain: "silent.com", referring: null }],
    });
    const summary = linkTargetSummary(gap);
    expect(summary).toContain("not measured");
    expect(summary).toContain("silent.com");
  });
});

describe("CMP-007 the pass reuses a period's measurement", () => {
  type Row = { id: string; observedAt: Date; dimensions: Record<string, unknown>; rawResponseId?: string | null };

  function mockDb(rows: Row[]) {
    const written: Array<Record<string, unknown>> = [];
    return {
      written,
      db: {
        evidenceRecord: {
          findMany: vi.fn(async (args: { where?: { observedAt?: { gte: Date } } }) => {
            const cutoff = args.where?.observedAt?.gte;
            return cutoff ? rows.filter((row) => row.observedAt >= cutoff) : rows;
          }),
          upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
            written.push(args.create);
            return { id: `e-${written.length}`, ...args.create };
          }),
        },
        rawProviderResponse: { findUnique: vi.fn(async () => ({ costMicros: BigInt(1), status: "succeeded" })) },
      },
    };
  }

  const setRow = (id: string, scope: string, domain: string, domains: string[], observedAt = NOW): Row => ({
    id,
    observedAt,
    rawResponseId: `raw-${id}`,
    dimensions: { scope, domain, domains, domainRanks: domains.map(() => 10) },
  });

  it("does not re-buy a competitor profile inside the period", async () => {
    const { db } = mockDb([
      setRow("own", "own_referring_domains", "oursite.com", ["shared.com"]),
      setRow("comp", "competitor_referring_domains", "rival.com", ["shared.com", "theirs.com"]),
    ]);
    const collect = vi.fn();
    const result = await runLinkGapPass(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "oursite.com",
      competitors: ["rival.com"],
      periodStart: PERIOD_START,
      apply: true,
      now: NOW,
      collect: collect as never,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(result.reused).toEqual(["rival.com"]);
    expect(result.gap.gap).toBe(1);
    expect(result.gap.targets[0].domain).toBe("theirs.com");
  });

  it("ignores a stored set older than the period", async () => {
    const stale = new Date("2026-09-01T00:00:00Z");
    const { db } = mockDb([
      setRow("own", "own_referring_domains", "oursite.com", [], NOW),
      setRow("comp", "competitor_referring_domains", "rival.com", ["old.com"], stale),
    ]);
    const collect = vi.fn(async () => ({
      spentMicros: 40_000,
      evidence: [
        {
          id: "new-comp",
          kind: "backlink_profile",
          observedAt: NOW,
          rawResponseId: "raw-new",
          dimensions: { scope: "competitor_referring_domains", domain: "rival.com", domains: ["fresh.com"], domainRanks: [30] },
          metrics: {},
        },
      ],
    }));
    const result = await runLinkGapPass(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "oursite.com",
      competitors: ["rival.com"],
      periodStart: PERIOD_START,
      apply: true,
      now: NOW,
      collect: collect as never,
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(result.gap.targets.map((row) => row.domain)).toEqual(["fresh.com"]);
  });

  it("buys our own set too, because a count cannot be subtracted from a set", async () => {
    const { db } = mockDb([]);
    // The collector is called as `collect(db, input)`.
    const collect = vi.fn(async (_db: unknown, input: { domain: string }) => ({
      spentMicros: 40_000,
      evidence: [
        {
          id: `e-${input.domain}`,
          kind: "backlink_profile",
          observedAt: NOW,
          rawResponseId: `raw-${input.domain}`,
          dimensions: {
            scope: input.domain === "oursite.com" ? "own_referring_domains" : "competitor_referring_domains",
            domain: input.domain,
            domains: input.domain === "oursite.com" ? ["shared.com"] : ["shared.com", "theirs.com"],
            domainRanks: input.domain === "oursite.com" ? [10] : [10, 20],
          },
          metrics: {},
        },
      ],
    }));
    const result = await runLinkGapPass(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "oursite.com",
      competitors: ["rival.com"],
      periodStart: PERIOD_START,
      apply: true,
      now: NOW,
      collect: collect as never,
    });
    // One call for us, one for them.
    expect(collect).toHaveBeenCalledTimes(2);
    expect(result.calls.map((row) => row.role).sort()).toEqual(["competitor", "own"]);
    expect(result.gap.gap).toBe(1);
    expect(result.spentMicros).toBe(80_000);
  });

  it("reports the competitors a cap skipped instead of dropping them", async () => {
    const { db } = mockDb([setRow("own", "own_referring_domains", "oursite.com", [], NOW)]);
    const collect = vi.fn(async (_db: unknown, input: { domain: string }) => ({
      spentMicros: 40_000,
      evidence: [
        {
          id: `e-${input.domain}`,
          kind: "backlink_profile",
          observedAt: NOW,
          rawResponseId: `raw-${input.domain}`,
          dimensions: { scope: "competitor_referring_domains", domain: input.domain, domains: [`${input.domain}-link.com`], domainRanks: [5] },
          metrics: {},
        },
      ],
    }));
    const result = await runLinkGapPass(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "oursite.com",
      competitors: ["a.com", "b.com", "c.com"],
      periodStart: PERIOD_START,
      apply: true,
      cap: 1,
      now: NOW,
      collect: collect as never,
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual(["b.com", "c.com"]);
    expect(result.gap.targets).toHaveLength(1);
  });

  it("buys nothing on a dry run and does not claim a gap for unmeasured competitors", async () => {
    const { db } = mockDb([setRow("own", "own_referring_domains", "oursite.com", ["shared.com"], NOW)]);
    const collect = vi.fn();
    const result = await runLinkGapPass(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "oursite.com",
      competitors: ["rival.com"],
      periodStart: PERIOD_START,
      apply: false,
      now: NOW,
      collect: collect as never,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(result.spentMicros).toBe(0);
    // A dry run reports these as "not attempted", not as a cap hit.
    expect(result.notAttempted).toEqual(["rival.com"]);
    expect(result.skipped).toEqual([]);
    expect(result.gap.missing).toContain("rival.com");
  });

  it("names a competitor whose call failed rather than counting it as zero", async () => {
    const { db } = mockDb([setRow("own", "own_referring_domains", "oursite.com", [], NOW)]);
    const collect = vi.fn(async () => {
      throw new Error("Monetary research allowance is exhausted for this period");
    });
    const result = await runLinkGapPass(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "oursite.com",
      competitors: ["rival.com"],
      periodStart: PERIOD_START,
      apply: true,
      now: NOW,
      collect: collect as never,
    });
    expect(result.missing).toContain("rival.com");
    expect(result.gap.missing).toContain("rival.com");
    expect(result.gap.gap).toBe(0);
  });

  it("reads the newest stored set for a target", async () => {
    const { db } = mockDb([
      setRow("old", "competitor_referring_domains", "rival.com", ["old.com"], new Date("2026-11-05T00:00:00Z")),
      setRow("new", "competitor_referring_domains", "rival.com", ["new.com"], new Date("2026-11-20T00:00:00Z")),
    ]);
    const set = await storedReferringSet(db as never, {
      projectId: "p1",
      domain: "www.rival.com",
      scope: "competitor_referring_domains",
      since: PERIOD_START,
    });
    expect(set?.domains).toEqual(["new.com"]);
    expect(set?.evidenceId).toBe("new");
  });
});

describe("CMP-007 the collector stores the referring set, not the envelope", () => {
  it("reads domains from the operation's result rather than its outer envelope", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/dataforseo/collection.ts", "utf8")
    );
    const block = source.slice(source.indexOf("export async function collectReferringDomains"));
    const body = block.slice(0, block.indexOf("export async function collectAiVisibility"));
    // Measured 2026-11-24: the first version stored the whole operation, so four
    // paid calls landed with `domains` one level too deep and the gap read 0 for a
    // site that has 63 referring domains. The read must go through `result.result`.
    expect(body).toContain("result.result");
    expect(body).toContain("referringSet.domains");
  });

  it("stores the provider's own per-domain facts beside the domain list", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/dataforseo/collection.ts", "utf8")
    );
    const block = source.slice(source.indexOf("export async function collectReferringDomains"));
    const body = block.slice(0, block.indexOf("export async function collectAiVisibility"));
    // The outreach list shows authority without buying a second call.
    expect(body).toContain("domainRanks");
    expect(body).toContain("competitor_referring_domains");
  });

  it("writes a zero-count row rather than skipping an empty set", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("lib/dataforseo/collection.ts", "utf8")
    );
    const block = source.slice(source.indexOf("export async function collectReferringDomains"));
    const body = block.slice(0, block.indexOf("export async function collectAiVisibility"));
    // "This target had no referring domains" is a measurement; "we did not look" is
    // not, and the two must not be the same row.
    expect(body).toContain('"provider:referringDomains": { value: domainList.length');
    expect(body).not.toContain("if (domainList.length === 0) return");
  });
});

describe("CMP-007 the gap is written where O9 reads it", () => {
  it("writes referringDomainGap and targetDomainCount on the own-domain row", async () => {
    const written: Array<Record<string, unknown>> = [];
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => [
          {
            observedAt: NOW,
            dimensions: { scope: "own_domain", domain: "oursite.com" },
            metrics: {
              "provider:totalBacklinks": { value: 85, unit: "count", source: "provider" },
              "provider:referringDomains": { value: 63, unit: "count", source: "provider" },
            },
          },
        ]),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
          written.push(args.create);
          return { id: "gap-row", ...args.create };
        }),
      },
      rawProviderResponse: { findUnique: vi.fn(async () => ({ costMicros: BigInt(1), status: "succeeded" })) },
    };

    const gap = backlinkGap({
      ours: [ref("shared.com")],
      competitors: [{ domain: "rival.com", referring: [ref("shared.com"), ref("new1.com", 55), ref("new2.com", 20)] }],
    });

    await storeOwnDomainGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "www.oursite.com",
      gap,
      rawResponseId: "raw-own",
      competitorEvidenceIds: ["comp-1", "comp-2"],
    });

    const created = written[0];
    const metrics = created.metrics as Record<string, { value: number }>;
    expect(metrics["provider:referringDomainGap"].value).toBe(2);
    expect(metrics["provider:targetDomainCount"].value).toBe(2);
    // The summary numbers the row already had are carried forward, not dropped.
    expect(metrics["provider:totalBacklinks"].value).toBe(85);
    expect(metrics["provider:referringDomains"].value).toBe(63);
    // The named targets travel with the row, so a task carries the list.
    const dims = created.dimensions as { domains?: string[]; scope?: string };
    expect(dims.scope).toBe("own_domain");
    expect(dims.domains).toEqual(["new1.com", "new2.com"]);
    expect(created.rawResponseId).toBe("raw-own");
  });
});

describe("CMP-007 the gap is written where O9 reads it", () => {
  it("writes referringDomainGap and targetDomainCount on the own-domain row", async () => {
    const written: Array<Record<string, unknown>> = [];
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => [
          {
            observedAt: NOW,
            dimensions: { scope: "own_domain", domain: "oursite.com" },
            metrics: {
              "provider:totalBacklinks": { value: 85, unit: "count", source: "provider" },
              "provider:referringDomains": { value: 63, unit: "count", source: "provider" },
            },
          },
        ]),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
          written.push(args.create);
          return { id: "gap-row", ...args.create };
        }),
      },
      rawProviderResponse: { findUnique: vi.fn(async () => ({ costMicros: BigInt(1), status: "succeeded" })) },
    };

    const gap = backlinkGap({
      ours: [ref("shared.com")],
      competitors: [{ domain: "rival.com", referring: [ref("shared.com"), ref("new1.com", 55), ref("new2.com", 20)] }],
    });

    await storeOwnDomainGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      domain: "www.oursite.com",
      gap,
      rawResponseId: "raw-own",
      competitorEvidenceIds: ["comp-1", "comp-2"],
    });

    const created = written[0];
    const metrics = created.metrics as Record<string, { value: number }>;
    expect(metrics["provider:referringDomainGap"].value).toBe(2);
    expect(metrics["provider:targetDomainCount"].value).toBe(2);
    // The summary numbers the row already had are carried forward, not dropped.
    expect(metrics["provider:totalBacklinks"].value).toBe(85);
    expect(metrics["provider:referringDomains"].value).toBe(63);
    // The named targets travel with the row, so a task carries the list.
    const dims = created.dimensions as { domains?: string[]; scope?: string };
    expect(dims.scope).toBe("own_domain");
    expect(dims.domains).toEqual(["new1.com", "new2.com"]);
    expect(created.rawResponseId).toBe("raw-own");
  });
});

describe("CMP-007 the panel's numbers agree with the arithmetic", () => {
  it("counts a shared domain once even when three competitors link to it", async () => {
    // Measured 2026-11-24: the page reported "92 excluded" while the pass had
    // excluded 54, because it counted one occurrence per competitor set. Two numbers
    // describing one subtraction must not disagree on screen.
    const set = (scope: string, domain: string, domains: string[]) => ({
      id: `${scope}-${domain}`,
      observedAt: NOW,
      dimensions: { scope, domain, domains, domainRanks: domains.map(() => 10) },
      metrics: {},
    });
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => [
          set("own_referring_domains", "oursite.com", ["shared.com", "ours-only.com"]),
          set("competitor_referring_domains", "a.com", ["shared.com", "a-only.com"]),
          set("competitor_referring_domains", "b.com", ["shared.com", "b-only.com"]),
          set("competitor_referring_domains", "c.com", ["shared.com", "c-only.com"]),
          {
            id: "own-gap",
            observedAt: NOW,
            dimensions: {
              scope: "own_domain",
              domain: "oursite.com",
              domains: ["a-only.com", "b-only.com", "c-only.com"],
              domainRanks: [30, 20, 10],
              competitorEvidenceIds: ["x", "y", "z"],
            },
            metrics: {
              "provider:referringDomainGap": { value: 3, unit: "count", source: "provider" },
              "provider:referringDomains": { value: 2, unit: "count", source: "provider" },
            },
          },
        ]),
      },
    };
    const panel = await linkTargetsForOpportunity(db as never, { projectId: "p1" });
    expect(panel).not.toBeNull();
    expect(panel!.sharedCount).toBe(1);
    expect(panel!.targets).toHaveLength(3);
    expect(panel!.competitorCount).toBe(3);
    expect(panel!.ourDomainCount).toBe(2);
  });
});
