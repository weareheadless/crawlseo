import { describe, expect, it, vi } from "vitest";

import {
  SHARE_OF_VOICE_DEPTH,
  WIN_STREAK_SAMPLES,
  clusterStatus,
  computeShareOfVoice,
  storeShareOfVoice,
  type ClusterShareOfVoice,
} from "@/lib/funnel/share-of-voice";
import { ctrAtPosition } from "@/lib/funnel/scoring";

/**
 * CMP-008's arithmetic.
 *
 * The defect this replaces: `shareOfVoice = 1 - (ourBest - 1) / 19` — our own best
 * position wearing a share-of-voice label, with no competitor in it. Two clusters
 * could read 80% while one was uncontested and the other was lost on every query.
 *
 * These tests pin the replacement, and the three honesty rules that make it usable:
 *  - a domain's credit is the declared CTR curve at the positions it holds,
 *  - a cluster with no sample is `unobserved`, never 0%,
 *  - `winning` needs four consecutive samples **and** a delivered win.
 */

const observation = (query: string, domain: string, position: number) => ({
  query,
  domain,
  position,
  observedAt: new Date("2026-11-02T00:00:00Z"),
});

describe("CMP-008 credit is the declared CTR curve, not a count of queries", () => {
  it("credits each domain by ctrAtPosition at the positions it holds", () => {
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [
        observation("q1", "oursite.com", 1),
        observation("q2", "rival.com", 5),
      ],
    });
    const ours = result.domains.find((row) => row.domain === "oursite.com")!;
    expect(ours.credit).toBeCloseTo(ctrAtPosition(1)!, 6);
    const rival = result.domains.find((row) => row.domain === "rival.com")!;
    expect(rival.credit).toBeCloseTo(ctrAtPosition(5)!, 6);
    // Position 1 takes more of the click than position 5, so our share is the larger.
    expect(ours.share).toBeGreaterThan(rival.share);
  });

  it("sums to 100% across every attributable domain", () => {
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [
        observation("q1", "oursite.com", 2),
        observation("q1", "a.com", 1),
        observation("q2", "b.com", 4),
        observation("q2", "c.com", 7),
      ],
    });
    const total = result.domains.reduce((sum, row) => sum + row.share, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(result.domains).toHaveLength(4);
  });

  it("beats a count-of-queries model on the case that matters", () => {
    // A rival at #1 on one query takes more clicks than we do at #9 on five. A
    // "how many queries do we rank for" score would call this a win; it is a loss.
    const observations = [
      observation("money", "rival.com", 1),
      ...["a", "b", "c", "d", "e"].map((q) => observation(q, "oursite.com", 9)),
    ];
    const result = computeShareOfVoice({ cluster: "c1", week: "2026-11-02", domain: "oursite.com", observations });
    const ours = result.domains.find((row) => row.us)!;
    const rival = result.domains.find((row) => row.domain === "rival.com")!;
    expect(ours.queries).toBe(5);
    expect(rival.queries).toBe(1);
    expect(rival.share).toBeGreaterThan(ours.share);
  });

  it("ignores a position beyond the measured depth", () => {
    // A result at 40 does not take a meaningful share of the click, and crediting it
    // would let a long tail inflate a domain's share.
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [observation("q1", "oursite.com", 1), observation("q1", "deep.com", SHARE_OF_VOICE_DEPTH + 30)],
    });
    expect(result.domains.map((row) => row.domain)).toEqual(["oursite.com"]);
  });

  it("orders the lines by share, largest first, and keeps our zero line", () => {
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [
        observation("q1", "weak.com", 9),
        observation("q1", "leader.com", 1),
        observation("q1", "mid.com", 4),
      ],
    });
    // We hold no position here, but the sample was attributable, so our 0% line is
    // shown last rather than omitted: a client has to be able to see where they stand.
    expect(result.domains.map((row) => row.domain)).toEqual(["leader.com", "mid.com", "weak.com", "oursite.com"]);
    expect(result.domains.at(-1)!.share).toBe(0);
    expect(result.domains.at(-1)!.us).toBe(true);
  });

  it("does not invent our line when the sample could not attribute anyone", () => {
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [],
      ourObserved: false,
    });
    expect(result.domains).toEqual([]);
    expect(result.ourShare).toBeNull();
  });
});

describe("CMP-008 unobserved is never 0%", () => {
  it("reports unobserved for a cluster with no sample", () => {
    const result = computeShareOfVoice({ cluster: "c1", week: "2026-11-02", domain: "oursite.com", observations: [] });
    expect(result.unobserved).toBe(true);
    expect(result.ourShare).toBeNull();
    expect(result.domains).toEqual([]);
  });

  it("reports 0% only when the SERP was attributable and we hold no position", () => {
    // One line of competitor positions proves the SERP was read; our absence is then a
    // measurement, not an absence of one.
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [observation("q1", "rival.com", 3)],
    });
    expect(result.unobserved).toBe(false);
    expect(result.ourShare).toBe(0);
  });

  it("returns null, not zero, when our position was never attributed", () => {
    // Measured 2026-11-24 on atelier-harmonie: a brand-cluster snapshot carried
    // `competitorCovered: "true"` with an empty domain list. Reading that as 0% said
    // "we are invisible on our own brand" when the payload had named nobody.
    const result = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [observation("q1", "rival.com", 3)],
      ourObserved: false,
    });
    expect(result.ourShare).toBeNull();
    expect(result.ourObserved).toBe(false);
  });
});

describe("CMP-008 the win condition is four consecutive samples and a delivered win", () => {
  const sample = (week: string, ours: number, rival: number): ClusterShareOfVoice => ({
    cluster: "c1",
    week,
    queriesObserved: 3,
    attributable: 6,
    domains: [
      { domain: "oursite.com", credit: ours, share: ours, queries: 3, us: true },
      { domain: "rival.com", credit: rival, share: rival, queries: 3, us: false },
    ],
    ourShare: ours,
    ourObserved: true,
    unobserved: false,
    sampledAt: new Date(`${week}T00:00:00Z`),
  });

  it("is unobserved with no samples", () => {
    const standing = clusterStatus({ samples: [] });
    expect(standing.status).toBe("unobserved");
    expect(standing.reason).toContain("unknown");
  });

  it("is contending with fewer than four samples, however good they are", () => {
    const standing = clusterStatus({
      samples: [sample("2026-11-02", 0.8, 0.2), sample("2026-11-09", 0.8, 0.2), sample("2026-11-16", 0.8, 0.2)],
      deliveredWin: true,
    });
    expect(standing.status).toBe("contending");
    expect(standing.reason).toContain(`3 of ${WIN_STREAK_SAMPLES}`);
  });

  it("is losing when a rival leads the newest sample", () => {
    const standing = clusterStatus({
      samples: [
        sample("2026-11-02", 0.8, 0.2),
        sample("2026-11-09", 0.8, 0.2),
        sample("2026-11-16", 0.8, 0.2),
        sample("2026-11-23", 0.2, 0.8),
      ],
      deliveredWin: true,
    });
    expect(standing.status).toBe("losing");
    expect(standing.reason).toContain("rival.com");
  });

  it("is contending when we lead four samples but nothing has been delivered", () => {
    const standing = clusterStatus({
      samples: [
        sample("2026-11-02", 0.8, 0.2),
        sample("2026-11-09", 0.8, 0.2),
        sample("2026-11-16", 0.8, 0.2),
        sample("2026-11-23", 0.8, 0.2),
      ],
      deliveredWin: false,
    });
    expect(standing.status).toBe("contending");
    expect(standing.reason).toContain("no delivered opportunity");
  });

  it("is winning only with four consecutive leads and a delivered win", () => {
    const standing = clusterStatus({
      samples: [
        sample("2026-11-02", 0.8, 0.2),
        sample("2026-11-09", 0.8, 0.2),
        sample("2026-11-16", 0.8, 0.2),
        sample("2026-11-23", 0.8, 0.2),
      ],
      deliveredWin: true,
    });
    expect(standing.status).toBe("winning");
    expect(standing.weeks).toHaveLength(4);
    expect(standing.shares[0]).toBeCloseTo(0.8, 6);
  });

  it("does not treat a tie as a lead", () => {
    const tied = (week: string): ClusterShareOfVoice => ({
      cluster: "c1",
      week,
      queriesObserved: 1,
      attributable: 2,
      domains: [
        { domain: "oursite.com", credit: 0.5, share: 0.5, queries: 1, us: true },
        { domain: "rival.com", credit: 0.5, share: 0.5, queries: 1, us: false },
      ],
      ourShare: 0.5,
      ourObserved: true,
      unobserved: false,
      sampledAt: new Date(`${week}T00:00:00Z`),
    });
    const standing = clusterStatus({
      samples: [tied("2026-11-02"), tied("2026-11-09"), tied("2026-11-16"), tied("2026-11-23")],
      deliveredWin: true,
    });
    // Level is not ahead: calling a tie a win is how a board stops being believed.
    expect(standing.status).toBe("losing");
  });
});

describe("CMP-008 the series is stored and recomputable", () => {
  it("writes one row per domain for a measured week", async () => {
    const written: Array<Record<string, unknown>> = [];
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
          written.push(args.create);
          return { id: `e-${written.length}`, ...args.create };
        }),
      },
    };
    const sample = computeShareOfVoice({
      cluster: "c1",
      week: "2026-11-02",
      domain: "oursite.com",
      observations: [observation("q1", "oursite.com", 1), observation("q1", "a.com", 4), observation("q2", "b.com", 2)],
      sampledAt: new Date("2026-11-03T00:00:00Z"),
    });
    const result = await storeShareOfVoice(db as never, { projectId: "p1", siteId: "s1", sample });
    expect(result.written).toBe(3);
    expect(written).toHaveLength(3);
    const dims = written.map((row) => row.dimensions as Record<string, unknown>);
    expect(dims.every((row) => row.cluster === "c1" && row.week === "2026-11-02")).toBe(true);
    const metrics = written[0].metrics as Record<string, { value: number; source: string }>;
    // The share is first-party: computed from our own samples, nobody sold it to us.
    expect(metrics["first_party:share"].source).toBe("first_party");
    expect(written[0].kind).toBe("share_of_voice");
    expect(written[0].producer).toBe("lib/funnel/share-of-voice");
  });

  it("writes nothing for an unobserved week", async () => {
    const written: Array<Record<string, unknown>> = [];
    const db = {
      evidenceRecord: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
          written.push(args.create);
          return { id: "e", ...args.create };
        }),
      },
    };
    const sample = computeShareOfVoice({ cluster: "c1", week: "2026-11-02", domain: "oursite.com", observations: [] });
    const result = await storeShareOfVoice(db as never, { projectId: "p1", siteId: "s1", sample });
    expect(result.written).toBe(0);
    expect(written).toEqual([]);
  });

  it("produces identical values when recomputed from the same observations", () => {
    const observations = [
      observation("q1", "oursite.com", 3),
      observation("q1", "a.com", 1),
      observation("q2", "b.com", 2),
    ];
    const first = computeShareOfVoice({ cluster: "c1", week: "2026-11-02", domain: "oursite.com", observations });
    const second = computeShareOfVoice({ cluster: "c1", week: "2026-11-02", domain: "oursite.com", observations });
    expect(second.domains).toEqual(first.domains);
    expect(second.ourShare).toBe(first.ourShare);
  });
});
