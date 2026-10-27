import { describe, expect, it } from "vitest";
import { actionDimension, filterActions } from "@/lib/work/categories";

describe("derived action dimensions", () => {
  it.each([
    [{ source: "ai_visibility_coverage", kind: "missing_evidence" }, "aeo"],
    [{ source: "research", kind: "visibility_gap" }, "geo"],
    [{ source: "crawl_issue", kind: "fix_technical_issue" }, "technical"],
    [{ source: "crawl_issue", kind: "fix_business_identity_jsonld" }, "aeo"],
    [{ source: "crawl_issue", kind: "fix_broken_link" }, "seo"],
    [{ source: "keyword_research", kind: "create_article" }, "content"],
    [{ source: "seo_opportunity", kind: "improve_metadata" }, "content"],
  ] as const)("maps %o", (input, expected) => expect(actionDimension(input)).toBe(expected));

  it("filters by dimension and state and reports the filtered count", () => {
    const rows = [
      { source: "ai_visibility_coverage", kind: "missing_evidence", status: "PROPOSED" },
      { source: "ai_visibility_coverage", kind: "missing_evidence", status: "FULFILLED" },
      { source: "crawl_issue", kind: "fix_broken_link", status: "PROPOSED" },
    ];
    expect(filterActions(rows, "aeo", "PROPOSED")).toEqual({ actions: [rows[0]], count: 1 });
    expect(filterActions(rows, "aeo", "all").count).toBe(2);
  });
});
