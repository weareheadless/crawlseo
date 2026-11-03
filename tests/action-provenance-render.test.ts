import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Ported from the retired legacy action detail (Wave 6). The requirement it
 * encoded — provenance is visible and a missing hop is stated rather than
 * implied — now lives on the funnel opportunity page, which is the only place
 * work is read.
 */
describe("opportunity provenance rendering contract", () => {
  const page = readFileSync("app/(dashboard)/sites/[siteId]/opportunities/[opportunityId]/page.tsx", "utf8");

  it("shows evidence from both legs with its producer", () => {
    expect(page).toContain("whyEvidence");
    expect(page).toContain("howEvidence");
    expect(page).toContain("SourceChip");
    expect(page).toContain("producer");
  });

  it("makes a missing hop explicit instead of implying it", () => {
    expect(page).toContain("missing");
    expect(page).toContain("No business evidence yet");
    expect(page).toContain("No search evidence yet");
  });

  it("renders the score with its declared components, not a bare number", () => {
    expect(page).toContain("scoreInputs");
    expect(page).toContain("scoreHint");
  });

  it("states a lifecycle reason for every stage that has not happened", () => {
    expect(page).toContain("No research needed for this play");
    expect(page).toContain("Nothing delivered");
    expect(page).toContain("No baseline recorded");
  });

  it("never fabricates an outcome verdict", () => {
    expect(page).toContain("reported as unmeasured, never as a win");
  });
});
