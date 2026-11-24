import { describe, expect, it } from "vitest";

import { validateAgainstRegistry, type EvidenceRecordPayload } from "@/lib/funnel/evidence";

/**
 * CMP-011: the three rejections the registry promises, each with a test.
 *
 * These are what stop the recurrence: before, a writer could store a dimension or
 * a metric label nobody reads, or omit one a reader needs, and the build stayed
 * green.
 */

const base = (overrides: Partial<EvidenceRecordPayload> = {}): EvidenceRecordPayload => ({
  projectId: "p1",
  kind: "keyword_rank",
  observedAt: new Date("2026-11-24T00:00:00.000Z"),
  producer: "search_console",
  rawResponseId: null,
  dimensions: { query: "tapisserie de siège" },
  metrics: { "first_party:position": { value: 6, unit: "rank", source: "first_party" } },
  ...overrides,
});

describe("the registry rejects a write its kind never declared", () => {
  it("rejects an undeclared kind", () => {
    // The cast is the point: a caller passing a string is exactly the bug.
    expect(() => validateAgainstRegistry(base({ kind: "made_up_kind" as never }))).toThrow(/not declared in EVIDENCE_REGISTRY/);
  });

  it("rejects a missing required dimension", () => {
    expect(() => validateAgainstRegistry(base({ dimensions: {} }))).toThrow(/requires dimension "query"/);
  });

  it("rejects an empty required dimension", () => {
    expect(() => validateAgainstRegistry(base({ dimensions: { query: "   " } }))).toThrow(/requires dimension "query"/);
  });

  it("rejects an undeclared dimension", () => {
    expect(() => validateAgainstRegistry(base({ dimensions: { query: "x", clusterSlug: "y" } }))).toThrow(
      /undeclared dimension "clusterSlug"/
    );
  });

  it("rejects an undeclared metric label", () => {
    expect(() =>
      validateAgainstRegistry(
        base({ metrics: { "first_party:positionn": { value: 1, unit: "rank", source: "first_party" } } })
      )
    ).toThrow(/undeclared metric label "first_party:positionn"/);
  });

  it("rejects a metric label another kind declares but this one does not", () => {
    // provider:volume belongs to keyword_metrics, not to a rank row.
    expect(() =>
      validateAgainstRegistry(base({ metrics: { "provider:volume": { value: 10, unit: "searches/month", source: "provider" } } }))
    ).toThrow(/undeclared metric label "provider:volume"/);
  });

  it("accepts a declared shape", () => {
    expect(() =>
      validateAgainstRegistry(
        base({
          dimensions: { query: "tapisserie de siège", url: "https://x.test/a", windowRole: "current", windowEnd: "2026-11-19T00:00:00.000Z" },
          metrics: { "first_party:position": { value: 6, unit: "rank", source: "first_party" } },
        })
      )
    ).not.toThrow();
  });
});
