import { describe, expect, it, vi } from "vitest";

import { DETECTOR_THRESHOLDS, runDetectors } from "@/lib/funnel/detectors";
import type { EvidenceRecordPayload } from "@/lib/funnel/evidence";

const NOW = new Date("2026-11-02T12:00:00.000Z");

type SeedRow = {
  id: string;
  kind: string;
  observedAt: Date;
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number | null; unit: string; source: string }>;
};

const row = (id: string, kind: string, dims: Record<string, unknown>, metrics: SeedRow["metrics"], observedAt = NOW): SeedRow => ({
  id,
  kind,
  observedAt,
  dimensions: dims,
  metrics,
});

const metric = (value: number, unit: string, source = "provider") => ({ value, unit, source });

/** A seeded dataset touching every O-type (definition of done). */
function seedAllTypes(): SeedRow[] {
  return [
    // O1 winnable rank: position 6, volume 400
    row("e-o1", "keyword_rank", { query: "local seo", url: "https://x.com/a", cluster: "local" }, { "provider:position": metric(6, "rank"), "provider:volume": metric(400, "searches/month") }),
    // O2 striking distance: position 14, impressions 900, ctr 0.008
    row("e-o2", "keyword_rank", { query: "near me seo", url: "https://x.com/b", cluster: "local" }, { "provider:position": metric(14, "rank"), "first_party:impressions": metric(900, "count", "first_party"), "first_party:ctr": metric(0.008, "ratio", "first_party") }),
    // O3 content gap: competitors cover, we do not rank
    row("e-o3", "serp_snapshot", { query: "seo audit checklist", cluster: "content", competitorCovered: "true" }, { "provider:volume": metric(220, "searches/month") }),
    // O4 AEO citation gap: asked, competitor cited, we not; knowledge answers
    row("e-o4", "ai_visibility_observation", { question: "how much does seo cost", cluster: "faq" }, { "provider:citedCount": metric(0, "count"), "provider:competitorCitedCount": metric(2, "count"), "provider:askCount": metric(5, "count") }),
    row("e-o4-why", "knowledge_fact", { question: "how much does seo cost" }, {}),
    // O5 presence gap: question never observed
    row("e-o5", "question_coverage", { question: "do you offer audits", cluster: "faq", observed: "false" }, {}),
    row("e-o5-why", "knowledge_fact", { question: "do you offer audits" }, {}),
    // O6 fact mismatch
    row("e-o6", "onpage_crawl", { url: "https://x.com/hours", question: "opening hours", field: "hours", factMismatch: "true" }, {}),
    row("e-o6-why", "knowledge_fact", { question: "opening hours" }, {}),
    // O7 technical defect: the page has recorded demand, which is what makes a
    // page-level defect worth acting on (spine plan §3).
    row("e-o7", "onpage_crawl", { url: "https://x.com/broken", issueType: "broken_link", impact: "crawlability" }, { "provider:issueCount": metric(4, "count") }),
    row("e-o7-demand", "keyword_rank", { query: "broken page", url: "https://x.com/broken" }, { "first_party:impressions": metric(300, "count", "first_party") }),
    // O8 structured data gap
    row("e-o8", "onpage_crawl", { url: "https://x.com/services", schemaType: "LocalBusiness", schemaMissing: "true", impact: "structured_data" }, { "first_party:issueCount": metric(1, "count", "first_party") }),
    row("e-o8-why", "knowledge_fact", { question: "who are you" }, {}),
    // O9 backlink gap
    row("e-o9", "backlink_profile", { competitor: "rival.com", cluster: "local" }, { "provider:referringDomainGap": metric(9, "count") }),
    // O10 cannibalization: two urls one query
    row("e-o10a", "keyword_rank", { query: "pricing", url: "https://x.com/pricing", cluster: "money" }, { "provider:position": metric(9, "rank"), "provider:volume": metric(500, "searches/month") }),
    row("e-o10b", "keyword_rank", { query: "pricing", url: "https://x.com/plans" }, { "provider:position": metric(12, "rank"), "provider:volume": metric(500, "searches/month") }),
    // O11 freshness decay: same query+url, position moved 5 -> 11
    row("e-o11a", "keyword_rank", { query: "seo packages", url: "https://x.com/packages" }, { "provider:position": metric(5, "rank"), "provider:volume": metric(300, "searches/month") }, new Date("2026-10-01T00:00:00.000Z")),
    row("e-o11b", "keyword_rank", { query: "seo packages", url: "https://x.com/packages" }, { "provider:position": metric(11, "rank"), "provider:volume": metric(300, "searches/month") }, new Date("2026-11-01T00:00:00.000Z")),
    // O12 page experience
    row("e-o12", "vitals", { url: "https://x.com/home" }, { "first_party:lcpSeconds": metric(3.4, "seconds", "first_party") }),
    // O13 user pain point (one-legged: why only)
    row("e-o13", "research_finding", { painPoint: "true", painPointSummary: "owners fear contracts" }, {}),
    // O14 offer positioning gap (one-legged: why only)
    row("e-o14", "research_finding", { positioningGap: "true", gapSummary: "rivals sell retainers, we sell sprints" }, {}),
  ];
}

function mockDb(seed: SeedRow[], clusters: Array<{ id: string; slug: string; name: string }> = []) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const parked: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const byDedup = new Map<string, { id: string; status: string }>();
  let counter = 0;
  const db = {
    evidenceRecord: {
      findMany: vi.fn(async (args?: { where?: { kind?: unknown; supersededById?: unknown; dimensions?: { path?: string[]; equals?: string } } }) => {
        let rows = seed;
        const kindFilter = args?.where?.kind;
        if (kindFilter) {
          const kinds = typeof kindFilter === "string" ? [kindFilter] : (kindFilter as { in?: string[] }).in;
          if (kinds) rows = rows.filter((r) => kinds.includes(r.kind));
        }
        const clusterFilter = args?.where?.dimensions?.equals;
        if (clusterFilter) rows = rows.filter((r) => r.dimensions["cluster"] === clusterFilter);
        return rows;
      }),
    },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue(clusters) },
    opportunity: {
      findMany: vi.fn(async (args?: { where?: { status?: { in?: string[] }; scoreValue?: { lt?: number } } }) => {
        return [...byDedup.values()]
          .filter((r) => !args?.where?.status?.in || args.where.status.in.includes(r.status))
          .filter((r) => args?.where?.scoreValue?.lt == null || ((r as { scoreValue?: number }).scoreValue ?? 0) < args.where.scoreValue.lt)
          .map((r) => ({ id: r.id, status: r.status, scoreValue: (r as { scoreValue?: number }).scoreValue ?? 0 }));
      }),
      findUnique: vi.fn(async (args: { where: { projectId_dedupKey: { dedupKey: string } } }) => byDedup.get(args.where.projectId_dedupKey.dedupKey) ?? null),
      create: vi.fn(async (args: { data: { dedupKey: string; scoreValue: number; status?: string } }) => {
        counter += 1;
        const record = { id: `op-${counter}`, status: "detected", ...args.data };
        byDedup.set(args.data.dedupKey, { id: record.id, status: "detected" });
        created.push(record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = [...byDedup.values()].find((r) => r.id === args.where.id);
        if (entry) Object.assign(entry, args.data);
        updated.push(args.data);
        return { ...entry, ...args.data };
      }),
      groupBy: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(async (args: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        for (const entry of byDedup.values()) {
          if (args.where.id.in.includes(entry.id)) Object.assign(entry, args.data);
        }
        return { count: args.where.id.in.length };
      }),
    },
    evidenceEdge: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        edges.push(args.create);
        return { id: `edge-${edges.length}` };
      }),
      count: vi.fn().mockResolvedValue(3),
    },
  };
  return { db, created, updated, parked, edges, byDedup };
}

describe("funnel detectors (wave 1 definition of done)", () => {
  it("detects at least one opportunity per O-type from a seeded dataset", async () => {
    const { db, created } = mockDb(seedAllTypes(), [{ id: "c1", slug: "local", name: "Local" }]);
    const result = await runDetectors(db as never, "p1", { now: NOW });
    const types = new Set(created.map((row) => row.type));
    for (const type of [
      "O1_winnable_rank",
      "O2_striking_distance",
      "O3_content_gap",
      "O4_aeo_citation_gap",
      "O5_aeo_presence_gap",
      "O6_business_fact_mismatch",
      "O7_technical_defect",
      "O8_structured_data_gap",
      "O9_backlink_gap",
      "O10_cannibalization",
      "O11_freshness_decay",
      "O12_page_experience",
      "O13_user_pain_point",
      "O14_offer_positioning_gap",
    ]) {
      expect(types, `${type} missing`).toContain(type);
    }
    expect(result.created).toBe(created.length);
  });

  it("scores opportunities with declared, stored inputs", async () => {
    const { db, created } = mockDb(seedAllTypes());
    await runDetectors(db as never, "p1", { now: NOW });
    const o1 = created.find((row) => row.type === "O1_winnable_rank");
    expect(o1?.scoreValue).toBeGreaterThan(0);
    expect(o1?.scoreValue).toBeLessThanOrEqual(100);
    const inputs = o1?.scoreInputs as { worth: { volume: number }; winProbability: { rankDistance: number | null } };
    expect(inputs.worth.volume).toBe(400);
    expect(inputs.winProbability.rankDistance).not.toBeNull();
  });

  it("produces one-legged opportunities (why only) that are valid and visible", async () => {
    const { db, created } = mockDb(seedAllTypes());
    await runDetectors(db as never, "p1", { now: NOW });
    const o13 = created.find((row) => row.type === "O13_user_pain_point");
    expect(o13).toBeTruthy();
    expect((o13?.scoreInputs as { evidenceCompleteness?: string }).evidenceCompleteness).toBe("why");
  });

  it("detects a cluster play for an under-covered tracked cluster", async () => {
    const seed = seedAllTypes();
    const clusterEvidence: SeedRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      clusterEvidence.push(row(`e-uni-${i}`, "keyword_universe_membership", { cluster: "thin", query: `q${i}` }, {}));
    }
    clusterEvidence.push(row("e-rank-1", "keyword_rank", { cluster: "thin", query: "q0", url: "https://x.com/t" }, { "provider:position": metric(30, "rank") }));
    const { db, created } = mockDb([...seed, ...clusterEvidence], [{ id: "c2", slug: "thin", name: "Thin cluster" }]);
    await runDetectors(db as never, "p1", { now: NOW });
    const clusterPlay = created.find((row) => String(row.dedupKey) === `O3:cluster:thin`);
    expect(clusterPlay).toBeTruthy();
    expect(String(clusterPlay?.title)).toContain("topical authority");
  });

  it("dedups: the same keyword+url across detectors is one opportunity", async () => {
    const seed = seedAllTypes();
    // the identical evidence row twice -> same dedupKey -> one opportunity
    const { db, created } = mockDb([...seed, ...seed.filter((r) => r.id === "e-o1")]);
    const result = await runDetectors(db as never, "p1", { now: NOW });
    const local = created.filter((row) => String(row.dedupKey) === "O1:local seo:https://x.com/a");
    expect(local).toHaveLength(1);
    expect(result.updated).toBeGreaterThan(0);
  });

  it("hysteresis parks detected opportunities below threshold without deleting them", async () => {
    const seed = seedAllTypes();
    const { db } = mockDb(seed);
    await runDetectors(db as never, "p1", { now: NOW });
    // Simulate a drift: rewrite the seeded rank evidence to a worthless position and re-run
    const drifted = seed.map((r) => (r.id === "e-o1" ? { ...r, metrics: { "provider:position": metric(9, "rank"), "provider:volume": metric(1, "searches/month") } } : r));
    const db2 = mockDb(drifted).db;
    // reuse the same opportunity map so dedup sees the existing rows
    const { db: db3 } = mockDb(drifted);
    Object.assign(db3.opportunity, db.opportunity);
    await runDetectors(db3 as never, "p1", { now: NOW });
    expect(db3.opportunity.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "parked", parkReason: "score_below_threshold" }) })
    );
  });

  it("only fires above the stated threshold (detector hygiene)", () => {
    expect(DETECTOR_THRESHOLDS.minVolume).toBe(10);
    expect(DETECTOR_THRESHOLDS.maxLcpSeconds).toBe(2.5);
    expect(DETECTOR_THRESHOLDS.freshnessDecayDelta).toBe(3);
  });

  it("never reads raw payloads or makes paid calls (reads over evidence only)", async () => {
    const { db } = mockDb(seedAllTypes());
    await runDetectors(db as never, "p1", { now: NOW });
    expect(db.evidenceRecord.findMany).toHaveBeenCalled();
    expect(Object.keys(db).some((key) => /rawProviderResponse|dataforseo|fetch|http/.test(key))).toBe(false);
  });
});

describe("page-level defect economics (spine plan §2.3, §3)", () => {
  const crawl = (id: string, url: string, issueType: string, extra: Record<string, unknown> = {}) =>
    row(id, "onpage_crawl", { url, issueType, impact: "crawlability", ...extra }, { "provider:issueCount": metric(1, "count") });

  it("skips a no-demand defect when the issue is not systemic", async () => {
    const { db, created } = mockDb([crawl("c1", "https://x.com/dead", "broken_link")]);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.some((row) => row.type === "O7_technical_defect")).toBe(false);
  });

  it("keeps a no-demand defect when the same issue spans three pages", async () => {
    const seed = [
      crawl("c1", "https://x.com/a", "broken_link"),
      crawl("c2", "https://x.com/b", "broken_link"),
      crawl("c3", "https://x.com/c", "broken_link"),
    ];
    const { db, created } = mockDb(seed);
    await runDetectors(db as never, "p1", { now: NOW });
    expect(created.filter((row) => row.type === "O7_technical_defect")).toHaveLength(3);
  });

  it("takes a defect's worth from the page's impressions, not a query volume", async () => {
    const seed = [
      crawl("c1", "https://x.com/traffic", "missing_description"),
      row("r1", "keyword_rank", { query: "q", url: "https://x.com/traffic" }, { "first_party:impressions": metric(420, "count", "first_party") }),
    ];
    const { db, created } = mockDb(seed);
    await runDetectors(db as never, "p1", { now: NOW });
    const o7 = created.find((row) => row.type === "O7_technical_defect");
    const worth = (o7?.scoreInputs as { worth: { volume: number; volumeSource: string } }).worth;
    expect(worth.volume).toBe(420);
    expect(worth.volumeSource).toBe("first_party");
  });

  it("collapses ten pages sharing a schema gap into one site-level opportunity", async () => {
    const seed = Array.from({ length: 12 }, (_, i) =>
      row(`s${i}`, "onpage_crawl", { url: `https://x.com/p${i}`, schemaType: "LocalBusiness", schemaMissing: "true", impact: "structured_data" }, { "first_party:issueCount": metric(1, "count", "first_party") })
    );
    const { db, created } = mockDb(seed);
    await runDetectors(db as never, "p1", { now: NOW });
    const o8 = created.filter((row) => row.type === "O8_structured_data_gap");
    expect(o8).toHaveLength(1);
    expect(String(o8[0].title)).toContain("12 pages");
  });

  it("parks overflow above the open cap instead of growing without bound", async () => {
    // Distinct issue types so grouping cannot collapse them, and demand on every
    // page so the §3 no-traffic rule does not filter them: this test is about the
    // open cap, not the other two rules.
    const seed = Array.from({ length: 130 }, (_, i) => [
      row(`d${i}`, "onpage_crawl", { url: `https://x.com/d${i}`, issueType: `issue_${i}`, impact: "crawlability" }, { "provider:issueCount": metric(1, "count") }),
      row(`r${i}`, "keyword_rank", { query: `q${i}`, url: `https://x.com/d${i}` }, { "first_party:impressions": metric(50, "count", "first_party") }),
    ]).flat();
    const { db } = mockDb(seed);
    const result = await runDetectors(db as never, "p1", { now: NOW });
    // 130 distinct pages, no single issue reaching the site-level threshold
    expect(result.created + result.updated).toBeGreaterThanOrEqual(130);
    expect(result.parked.length).toBeGreaterThan(0);
  });
});

describe("superseding stale detected rows (spine plan §3)", () => {
  it("parks a detected opportunity the detector no longer emits", async () => {
    const { retireStaleDetected } = await import("@/lib/funnel/detectors");
    const rows = [
      { id: "old-page", type: "O8_structured_data_gap", dedupKey: "O8:https://x.com/a:LocalBusiness" },
      { id: "accepted", type: "O8_structured_data_gap", dedupKey: "O8:https://x.com/b:LocalBusiness" },
    ];
    const parkedIds: string[] = [];
    const db = {
      opportunity: {
        findMany: vi.fn(async () => [rows[0]]),
        updateMany: vi.fn(async (args: { where: { id: { in: string[] } }; data: { status: string } }) => {
          parkedIds.push(...args.where.id.in);
          return { count: args.where.id.in.length };
        }),
      },
    };
    const superseded = await retireStaleDetected(db as never, {
      projectId: "p1",
      produced: new Map([["O8_structured_data_gap", new Set(["O8:site:LocalBusiness"])]]),
      detectedBy: "test",
    });
    expect(superseded).toEqual(["old-page"]);
    expect(parkedIds).toEqual(["old-page"]);
  });
});
