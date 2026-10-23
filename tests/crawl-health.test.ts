import { describe, expect, it } from "vitest";
import {
  buildIssuePriorities,
  computeHealthScore,
  type HealthIssue,
} from "@/lib/crawler/health";

function issue(
  type: string,
  severity: string,
  url: string,
  details?: unknown,
): HealthIssue {
  return { type, severity, url, details };
}

describe("crawl health scoring", () => {
  it("returns 0 without pages and 100 without actionable issues", () => {
    expect(computeHealthScore([], 0)).toBe(0);
    expect(computeHealthScore([], 200)).toBe(100);
  });

  it("does not collapse a large site to zero for repeated warning issues", () => {
    const issues = Array.from({ length: 200 }, (_, index) =>
      issue("MISSING_ALT", "WARNING", `https://example.com/page-${index}`),
    );
    expect(computeHealthScore(issues, 200)).toBe(96);
  });

  it("keeps a small number of critical issues visible without zeroing the site", () => {
    const issues = [
      issue("BROKEN_LINK", "CRITICAL", "https://example.com/a"),
      issue("BROKEN_LINK", "CRITICAL", "https://example.com/b"),
      issue("BROKEN_LINK", "CRITICAL", "https://example.com/c"),
    ];
    const score = computeHealthScore(issues, 200);
    expect(score).toBe(87);
    expect(score).toBeGreaterThan(0);
  });

  it("deduplicates repeated issues on the same URL", () => {
    const priorities = buildIssuePriorities([
      issue("MISSING_ALT", "WARNING", "https://example.com/a"),
      issue("MISSING_ALT", "WARNING", "https://example.com/a"),
      issue("MISSING_ALT", "WARNING", "https://example.com/b"),
    ], 10);

    expect(priorities[0]).toMatchObject({
      type: "MISSING_ALT",
      affectedPages: 2,
      occurrences: 3,
      affectedPct: 20,
    });
  });

  it("excludes crawl summaries and content-score bookkeeping", () => {
    const issues = [
      issue("MISSING_SCHEMA", "INFO", "https://example.com/", { kind: "crawl_summary" }),
      issue("MISSING_DESCRIPTION", "INFO", "https://example.com/a", { kind: "content_score" }),
    ];
    expect(computeHealthScore(issues, 10)).toBe(100);
    expect(buildIssuePriorities(issues, 10)).toEqual([]);
  });

  it("ranks critical issues above higher-volume warnings", () => {
    const issues = [
      ...Array.from({ length: 80 }, (_, index) =>
        issue("MISSING_ALT", "WARNING", `https://example.com/page-${index}`),
      ),
      issue("BROKEN_LINK", "CRITICAL", "https://example.com/missing"),
    ];
    const priorities = buildIssuePriorities(issues, 200);
    expect(priorities[0].type).toBe("BROKEN_LINK");
    expect(priorities[0].penalty).toBeGreaterThan(priorities[1].penalty);
  });

  it("computes a useful score for a mixed issue profile", () => {
    const issues = [
      ...Array.from({ length: 200 }, (_, index) =>
        issue("MISSING_ALT", "WARNING", `https://example.com/page-${index}`),
      ),
      ...Array.from({ length: 49 }, (_, index) =>
        issue("DUPLICATE_TITLE", "WARNING", `https://example.com/dup-${index}`),
      ),
      ...Array.from({ length: 39 }, (_, index) =>
        issue("MISSING_SCHEMA", "INFO", `https://example.com/schema-${index}`),
      ),
    ];
    const score = computeHealthScore(issues, 200);
    expect(score).toBeGreaterThan(75);
    expect(score).toBeLessThan(100);
  });
});
