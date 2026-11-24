import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * CMP-011, the visible half.
 *
 * A board that shows a score without saying whether the demand behind it was
 * measured is handing an SEO a fake priority. Measured on 2026-11-24: every one of
 * the 75 live opportunities carried an assessment, and 71 were `hypothesis` — and
 * the UI showed all of them as a plain `20 /100`.
 *
 * These are source assertions because the label is a rendering decision; the
 * underlying value is covered by the views tests.
 */
const PAGE = readFileSync("app/(dashboard)/sites/[siteId]/opportunities/page.tsx", "utf8");

describe("the opportunities board states its demand basis", () => {
  it("labels unquantified demand as unmeasured", () => {
    expect(PAGE).toContain('row.measurement === "unquantified"');
    expect(PAGE.toLowerCase()).toContain("unmeasured");
  });

  it("labels an impressions-only basis differently from a purchased volume", () => {
    // "reach" is not the same claim as a measured search volume, and the board
    // must not let the two look identical.
    expect(PAGE).toContain('row.measurement === "observed_baseline"');
  });

  it("never renders a score without a basis beside it", () => {
    const scoreIndex = PAGE.indexOf("<ScoreBadge");
    expect(scoreIndex).toBeGreaterThan(-1);
    // CMP-012 added a winnability label immediately after the score, so the demand basis
    // sits further down than it used to. The assertion is about the same block, not about
    // a character offset.
    const after = PAGE.slice(scoreIndex, scoreIndex + 3000);
    expect(after).toContain("unmeasured");
  });

  it("states how much of the row's winnability was measured", () => {
    // CMP-012: a score whose difficulty, authority, page strength and SERP competition
    // were never looked at must not read as a fair fight.
    expect(PAGE).toContain("row.winnability.lowConfidence");
    expect(PAGE).toContain("row.winnability.measured");
    expect(PAGE).toContain("winnability");
  });
});
