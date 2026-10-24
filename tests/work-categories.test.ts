import { describe, expect, it } from "vitest";
import { workCategory, workCategoryLabel } from "@/lib/work/categories";

describe("work categories", () => {
  it("classifies crawl fixes as technical SEO", () => {
    expect(workCategory({ source: "crawl_issue", kind: "fix_technical_issue" })).toBe("technical");
    expect(workCategoryLabel("technical")).toBe("Technical SEO");
  });

  it("classifies editorial and SEO opportunity work as content", () => {
    expect(workCategory({ source: "seo_opportunity", kind: "add_section" })).toBe("content");
    expect(workCategory({ source: "market_research", kind: "create_article" })).toBe("content");
    expect(workCategory({ source: "manual", kind: "update_page" })).toBe("content");
    expect(workCategoryLabel("content")).toBe("Content");
  });
});
