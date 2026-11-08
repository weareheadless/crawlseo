import { describe, expect, it } from "vitest";

import {
  jobVerdictIndex,
  parseJobMap,
  sampleForJobs,
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
    expect(jobMap.counts).toEqual({ queries: 2, assigned: 2, unassigned: 0, omitted: 0 });
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
    expect(jobMap.counts.omitted).toBe(1);
    // The sample sent 900; only one got a verdict, so 899 sent queries are
    // unassigned. The one omitted query is not counted as unassigned.
    expect(jobMap.counts.unassigned).toBe(899);
  });
});
