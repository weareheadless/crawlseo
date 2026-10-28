import { describe, expect, it } from "vitest";
import { projectFindings, type FindingRow } from "@/lib/pipeline/findings";

const row = (id: string, source = "crawl_issue", projectId: string | null = "project-1"): FindingRow => ({
  id, title: id, recommendation: "Review evidence", kind: "fix_technical_issue", source,
  status: "OPEN", updatedAt: new Date("2026-01-01T00:00:00Z"), targetUrl: null,
  projectId, finding: null,
});

describe("pipeline findings projection", () => {
  it("reports counts after dimension filtering and discloses truncation", () => {
    const result = projectFindings([row("a"), row("b"), row("c")], { dimension: "technical", limit: 2 });
    expect(result.rows.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result.count).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it("excludes fixture observations from customer counts and empty state", () => {
    const result = projectFindings([row("fixture-source", "fixture", "project-1"), row("fixture-project", "crawl_issue", "fixture")]);
    expect(result.rows).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.available).toBe(false);
  });

  it("keeps only recorded finding/run relation details; unattached actions remain valid findings", () => {
    const result = projectFindings([row("canonical-action")]);
    expect(result.rows[0].id).toBe("canonical-action");
    expect(result.rows[0].finding).toBeNull();
  });
});
