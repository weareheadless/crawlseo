import { describe, expect, it } from "vitest";
import { observedCount, visibilityState } from "@/lib/research/intelligence-view";

describe("Intelligence visibility evidence rendering", () => {
  it("keeps unobserved values unknown rather than rendering zero", () => {
    expect(visibilityState({ status: "unknown" })).toBe("Unknown");
    expect(observedCount(null)).toBe("Unknown");
    expect(observedCount([])).toBe("0");
  });
  it("provides an explicit next-step empty-state contract", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("app/(dashboard)/sites/[siteId]/intelligence/page.tsx", "utf8"));
    expect(source).toContain("Nothing observed yet");
    expect(source).toContain("Import an AI visibility export");
  });
  it("reads the canonical observation, coverage, research-source and crawl paths", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("app/(dashboard)/sites/[siteId]/intelligence/page.tsx", "utf8"));
    expect(source).toContain("db.aIVisibilityObservation.findMany");
    expect(source).toContain("db.questionCoverage.findMany");
    expect(source).toContain("db.researchSource.findMany");
    expect(source).toContain("db.crawl.findFirst");
    expect(source).not.toContain("fetch(");
  });
});
