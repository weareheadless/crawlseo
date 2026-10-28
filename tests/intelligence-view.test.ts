import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { observedCount, visibilityState } from "@/lib/research/intelligence-view";

const read = (path: string) => readFile(path, "utf8");

describe("Intelligence visibility evidence rendering", () => {
  it("keeps unobserved values unknown rather than rendering zero", () => {
    expect(visibilityState({ status: "unknown" })).toBe("Unknown");
    expect(observedCount(null)).toBe("Unknown");
    expect(observedCount([])).toBe("0");
  });

  it("gives the visibility surface an explicit next-step empty state", async () => {
    const source = await read("app/(dashboard)/sites/[siteId]/aeo-geo/page.tsx");
    expect(source).toContain("No authorized export has been imported");
    expect(source).toContain("this is not zero mentions");
  });

  it("reads the canonical observation, coverage, research-source and crawl paths", async () => {
    const [intelligence, aeoGeo] = await Promise.all([
      read("app/(dashboard)/sites/[siteId]/intelligence/page.tsx"),
      read("app/(dashboard)/sites/[siteId]/aeo-geo/page.tsx"),
    ]);
    expect(aeoGeo).toContain("db.aIVisibilityObservation.findMany");
    expect(aeoGeo).toContain("db.questionCoverage.findMany");
    expect(aeoGeo).toContain("db.crawl.findFirst");
    expect(intelligence).toContain("db.researchSource.count");
    expect(intelligence).not.toContain("fetch(");
    expect(aeoGeo).not.toContain("fetch(");
  });

  it("keeps Intelligence an overview instead of an action dump", async () => {
    const source = await read("app/(dashboard)/sites/[siteId]/intelligence/page.tsx");
    expect(source).toContain("slice(0, 5)");
    expect(source).toContain("/aeo-geo");
    expect(source).toContain("/keyword-research");
    expect(source).toContain("/business");
  });
});
