import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("action provenance rendering contract", () => {
  const page = readFileSync("app/(dashboard)/sites/[siteId]/actions/[actionId]/page.tsx", "utf8");
  it("loads a gap identity through its linked question coverage", () => {
    expect(page).toContain("questionCoverage");
    expect(page).toContain("businessKnowledgeRevision.findUnique");
    expect(page).toContain("coverage.fieldPath");
  });
  it("makes absent provenance hops explicit", () => {
    expect(page).toContain("Missing hop: no knowledge revision/field");
    expect(page).toContain("Missing hop: no research finding");
    expect(page).toContain("Missing hop: no source");
    expect(page).toContain("Missing hop: no coverage record");
    expect(page).toContain("Missing hop: no outcome");
  });
});
