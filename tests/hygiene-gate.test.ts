import { describe, expect, it } from "vitest";

import { DETECTOR_THRESHOLDS, technicalDefectEarnsSlot, type DetectorCandidate } from "@/lib/funnel/detectors";

/**
 * A presentational gap is not an opportunity until the page it affects earns.
 *
 * Measured 2026-11-25, inmersionfreediving's "Missing structured data on 48 pages" sat
 * above the only content proposal on the board — "New Spanish article: apnea as a
 * sport", the work that defines the offer — while none of its 48 pages had more than a
 * couple of impressions. An SEO does not choose between a schema sweep and the article;
 * they add schema when it serves a page that earns.
 *
 * The distinction this file pins is the one that makes the rule honest rather than a
 * blanket penalty on technical work:
 *
 *  - **Crawlability** (`O7`) is never gated. A page that cannot be crawled cannot earn
 *    the impressions a demand gate would ask it for, so gating it is circular.
 *  - **Presentational** (`O8`) is gated, at the same `minImpressions` floor the
 *    striking-distance detector already uses for "enough impressions that a click is
 *    worth winning" — not a second number invented for this rule.
 *
 * The row is parked as `hygiene_only`, not deleted, and the crawl page lists it with
 * its severity and page count either way. It comes back on its own the day those pages
 * gain demand.
 */

function candidate(over: {
  type?: string;
  technical?: boolean;
  volume?: number;
  volumeSource?: string;
}): DetectorCandidate {
  return {
    type: (over.type ?? "O8_structured_data_gap") as DetectorCandidate["type"],
    title: "Missing structured data on 48 pages",
    summary: "48 pages share this issue.",
    dedupKey: "O8:site:LocalBusiness",
    whyEvidenceIds: [],
    howEvidenceIds: [],
    scoreInputs: {
      worth: {
        volume: over.volume ?? 2,
        volumeSource: over.volumeSource ?? "first_party",
        technical: over.technical ?? true,
      },
    },
  } as unknown as DetectorCandidate;
}

describe("a presentational gap needs demand before it takes a board slot", () => {
  it("keeps a schema gap whose pages earn nothing off the board", () => {
    expect(technicalDefectEarnsSlot(candidate({ volume: 2 }), { clusterId: null })).toBe(false);
    expect(technicalDefectEarnsSlot(candidate({ volume: 0 }), { clusterId: null })).toBe(false);
  });

  it("admits it once the affected pages carry enough demand to justify the work", () => {
    expect(technicalDefectEarnsSlot(candidate({ volume: 400 }), { clusterId: null })).toBe(true);
  });

  it("uses the declared impressions floor, not a number invented for this rule", () => {
    // Below the floor that already means "a click is worth winning": gated.
    expect(technicalDefectEarnsSlot(candidate({ volume: DETECTOR_THRESHOLDS.minImpressions - 1 }), { clusterId: null })).toBe(false);
    // At the floor: admitted. One threshold, shared with the striking-distance detector.
    expect(technicalDefectEarnsSlot(candidate({ volume: DETECTOR_THRESHOLDS.minImpressions }), { clusterId: null })).toBe(true);
  });

  it("admits a gap whose page belongs to a topic someone is working", () => {
    // A cluster being drafted is demand in flight: the fix serves work already chosen.
    expect(technicalDefectEarnsSlot(candidate({ volume: 0 }), { clusterId: "cluster-1" })).toBe(true);
  });

  it("never gates a crawlability defect, because the fix is what lets the page earn", () => {
    // One broken link on a dead page and no impressions at all: still admitted. The
    // page cannot gain the demand the gate would ask for until the link is fixed.
    expect(
      technicalDefectEarnsSlot(candidate({ type: "O7_technical_defect", volume: 0, volumeSource: "impact_proxy" }), {
        clusterId: null,
      })
    ).toBe(true);
  });

  it("leaves non-technical work alone entirely", () => {
    // The gate is about the shape of technical work, not about lowering the board.
    expect(
      technicalDefectEarnsSlot(candidate({ type: "O3_content_gap", technical: false, volume: 0 }), { clusterId: null })
    ).toBe(true);
  });

  it("can be switched off, so the decision is visible rather than buried", () => {
    expect(technicalDefectEarnsSlot(candidate({ volume: 0 }), { clusterId: null, threshold: false })).toBe(true);
  });
});
