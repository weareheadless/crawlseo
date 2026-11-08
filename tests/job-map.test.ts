import { describe, expect, it } from "vitest";

import {
  jobVerdictIndex,
  parseJobMap,
  parseVerdicts,
  sampleForJobs,
  type Job,
  type JobMapInput,
} from "@/lib/research/job-map";

function input(overrides: Partial<JobMapInput> = {}): JobMapInput {
  return {
    domain: "example.com",
    language: "en",
    country: "MX",
    business: {
      name: "Example Realty",
      services: ["Property listings"],
      location: "Playa del Carmen",
      serviceArea: ["Riviera Maya"],
      audience: null,
      differentiators: [],
      concerns: [],
    },
    offers: [{ offer: "Listings", scope: "local" }],
    pages: [{ path: "/properties", title: "Properties", h1: "Properties", wordCount: 800 }],
    queries: [
      { query: "tulum condos for sale", impressions: 10, volume: 500 },
      { query: "casas de cambio", impressions: 0, volume: 5_000 },
    ],
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    slug: "buy-tulum",
    statement: "I want to buy a condo in Tulum",
    who: "buyer",
    stage: "buy",
    language: "en",
    marketScope: "local",
    marketPlaces: ["Tulum"],
    businessFit: "serves",
    topic: {
      name: "Tulum condos",
      kind: "market",
      intent: "commercial",
      relevance: "high",
      coverageKind: "product",
      offerKey: "Listings",
      needTerms: ["tulum condos"],
      actionHint: "Check the listings page.",
    },
    queries: ["tulum condos for sale"],
    page: "/properties",
    reason: "The query names the place and the property need.",
    ...overrides,
  };
}

function verdict(overrides: Record<string, unknown> = {}) {
  return { query: "tulum condos for sale", verdict: "demand", job: "buy-tulum", reason: "", ...overrides };
}

describe("job map parsing", () => {
  it("accepts a job whose queries, page and market are supplied", () => {
    const { jobMap, rejected } = parseJobMap(
      {
        summary: "One job.",
        jobs: [job()],
        verdicts: [verdict(), { query: "casas de cambio", verdict: "noise", job: null, reason: "currency exchange" }],
      },
      input(),
      { proposedBy: "ai", model: "test-model" }
    );
    expect(rejected).toHaveLength(0);
    expect(jobMap.jobs).toHaveLength(1);
    expect(jobMap.counts).toEqual({ queries: 2, sent: 2, assigned: 2, unassigned: 0, deferred: 0 });
    expect(jobVerdictIndex(jobMap).get("casas de cambio")?.verdict).toBe("noise");
  });

  it("rejects a page that is not in the inventory", () => {
    const { jobMap, rejected } = parseJobMap(
      { jobs: [job({ page: "/invented" })], verdicts: [verdict()] },
      input(),
      { proposedBy: "ai", model: "test-model" }
    );
    expect(jobMap.jobs).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/not in the supplied inventory/);
  });

  it("does not let a job the business does not serve own demand", () => {
    const { jobMap, rejected } = parseJobMap(
      { jobs: [job({ businessFit: "does_not_serve" })], verdicts: [verdict()] },
      input(),
      { proposedBy: "ai", model: "test-model" }
    );
    expect(jobMap.jobs).toHaveLength(1);
    expect(jobMap.verdicts).toHaveLength(0);
    expect(jobMap.counts.unassigned).toBe(2);
    expect(rejected.some((row) => /does not serve/.test(row.reason))).toBe(true);
  });

  it("requires a local job to name its places", () => {
    const { rejected } = parseJobMap(
      { jobs: [job({ marketPlaces: [] })], verdicts: [verdict()] },
      input(),
      { proposedBy: "ai", model: "test-model" }
    );
    expect(rejected.some((row) => /market places/.test(row.reason))).toBe(true);
  });

  it("counts the queries with volume that no verdict assigned", () => {
    const { jobMap } = parseJobMap(
      { jobs: [job()], verdicts: [verdict()] },
      input(),
      { proposedBy: "ai", model: "test-model" }
    );
    expect(jobMap.counts.queries).toBe(2);
    expect(jobMap.counts.assigned).toBe(1);
    expect(jobMap.counts.unassigned).toBe(1);
  });
});

describe("job query sample", () => {
  it("includes high-volume queries even when they have no impressions", () => {
    const queries = [
      { query: "visible", impressions: 100, volume: 10 },
      { query: "invisible but big", impressions: 0, volume: 100_000 },
    ];
    const sample = sampleForJobs(queries, 1);
    expect(sample.map((row) => row.query)).toContain("invisible but big");
  });

  it("reports the queries the sample bound did not send", () => {
    const queries = Array.from({ length: 901 }, (_, index) => ({
      query: `query ${index}`,
      impressions: index,
      volume: 10,
    }));
    const { jobMap } = parseJobMap(
      {
        jobs: [job({ queries: ["query 900"] })],
        verdicts: [{ query: "query 900", verdict: "demand", job: "buy-tulum", reason: "" }],
      },
      input({ queries }),
      { proposedBy: "ai", model: "test-model" }
    );
    expect(jobMap.counts.queries).toBe(901);
    expect(jobMap.counts.deferred).toBe(651);
    // The tranche sent 250; only one got a verdict, so 249 sent queries are
    // unassigned. The 651 deferred queries are not counted as unassigned.
    expect(jobMap.counts.unassigned).toBe(249);
  });
});

describe("job verdicts", () => {
  const jobs: Job[] = [
    {
      slug: "buy-tulum",
      statement: "I want to buy a condo in Tulum",
      who: "buyer",
      stage: "buy",
      language: "en",
      market: { scope: "local", places: ["Tulum"] },
      businessFit: "serves",
      topic: {
        name: "Tulum condos",
        kind: "market",
        intent: "commercial",
        relevance: "high",
        coverageKind: "product",
        offerKey: "Listings",
        needTerms: ["tulum condos"],
        localIntent: [],
        actionHint: "",
      },
      queries: [],
      page: "/properties",
      reason: "",
    },
    {
      slug: "sell-own-home",
      statement: "I want to sell my own home",
      who: "owner",
      stage: "buy",
      language: "en",
      market: { scope: "local", places: ["Tulum"] },
      businessFit: "does_not_serve",
      topic: {
        name: "Home selling",
        kind: "market",
        intent: "commercial",
        relevance: "low",
        coverageKind: "service",
        offerKey: "Listings",
        needTerms: ["sell home"],
        localIntent: [],
        actionHint: "",
      },
      queries: [],
      page: null,
      reason: "",
    },
  ];
  const batch = [{ query: "tulum condos for sale" }, { query: "sell my house tulum" }, { query: "tulum" }];

  it("assigns demand to a served job", () => {
    const result = parseVerdicts(
      { verdicts: [{ query: "tulum condos for sale", verdict: "demand", job: "buy-tulum", reason: "buying" }] },
      batch,
      jobs
    );
    expect(result.rejected).toEqual([]);
    expect(result.verdicts).toEqual([
      { query: "tulum condos for sale", verdict: "demand", job: "buy-tulum", reason: "buying" },
    ]);
  });

  it("does not let a job the business does not serve own demand", () => {
    const result = parseVerdicts(
      { verdicts: [{ query: "sell my house tulum", verdict: "demand", job: "sell-own-home", reason: "" }] },
      batch,
      jobs
    );
    expect(result.verdicts).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/does not serve/);
  });

  it("rejects a verdict that names a job outside the supplied list", () => {
    const result = parseVerdicts(
      { verdicts: [{ query: "tulum", verdict: "demand", job: "made-up-job", reason: "" }] },
      batch,
      jobs
    );
    expect(result.verdicts).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/no supplied job/);
  });

  it("accepts a non-demand verdict with no job", () => {
    const result = parseVerdicts(
      { verdicts: [{ query: "tulum", verdict: "context", job: null, reason: "a place, not a job" }] },
      batch,
      jobs
    );
    expect(result.verdicts[0]).toMatchObject({ query: "tulum", verdict: "context", job: null });
  });
});
