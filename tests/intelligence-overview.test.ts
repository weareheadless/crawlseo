import { describe, expect, it } from "vitest";
import { hasRecordedProvenance, provenanceNote, summarizeIntelligence } from "@/lib/research/intelligence-overview";

const base = {
  keywords: 1200,
  researchRuns: 3,
  keywordRuns: 4,
  sources: 30,
  observations: 2,
  coverage: [{ status: "COVERED" }, { status: "UNRESOLVED" }],
};

describe("intelligence-overview", () => {
  it("counts open actions separately from dismissed ones", () => {
    const counts = summarizeIntelligence({
      ...base,
      actions: [
        { status: "PROPOSED", evidence: { originGap: "crawl_issue:1" } },
        { status: "DISMISSED", evidence: null },
        { status: "VERIFIED", evidence: { verifier: { ok: true } } },
      ],
    });
    expect(counts.actions).toBe(3);
    expect(counts.openActions).toBe(1);
    expect(counts.actionsWithProvenance).toBe(2);
  });

  it("counts unresolved coverage without treating it as missing", () => {
    const counts = summarizeIntelligence({ ...base, actions: [] });
    expect(counts.coverage).toBe(2);
    expect(counts.unresolvedCoverage).toBe(1);
  });

  it("summarises missing provenance once instead of per row", () => {
    const counts = summarizeIntelligence({
      ...base,
      actions: [
        { status: "PROPOSED", evidence: { originGap: "crawl_issue:1" } },
        { status: "PROPOSED", evidence: {} },
        { status: "PROPOSED", evidence: null },
      ],
    });
    expect(provenanceNote(counts)).toBe(
      "2 of 3 Actions do not record an origin gap or verifier; that is missing evidence, not a clean result."
    );
  });

  it("returns no note when every action records provenance", () => {
    const counts = summarizeIntelligence({
      ...base,
      actions: [{ status: "PROPOSED", evidence: { origin_gap: "x" } }],
    });
    expect(provenanceNote(counts)).toBeNull();
  });

  it("detects provenance in either naming convention", () => {
    expect(hasRecordedProvenance({ origin_gap: "a" })).toBe(true);
    expect(hasRecordedProvenance({ verifier_result: {} })).toBe(true);
    expect(hasRecordedProvenance({})).toBe(false);
    expect(hasRecordedProvenance([])).toBe(false);
  });
});
