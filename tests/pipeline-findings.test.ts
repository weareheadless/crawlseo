import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { researchAction: { findMany } } }));
import { db } from "@/lib/db";
import { formatResearchCost, recordedRunInputState, projectFindings, readFindings, type FindingRow } from "@/lib/pipeline/findings";

const row = (id: string, source = "crawl_issue", projectId: string | null = "project-1"): FindingRow => ({
  id, title: id, recommendation: "Review evidence", kind: "fix_technical_issue", source,
  status: "OPEN", updatedAt: new Date("2026-01-01T00:00:00Z"), targetUrl: null,
  projectId, finding: null,
});

describe("pipeline findings projection", () => {
  beforeEach(() => findMany.mockReset());

  it("reports counts after dimension filtering and discloses truncation", () => {
    const result = projectFindings([row("a"), row("b"), row("c")], { dimension: "technical", limit: 2 });
    expect(result.rows.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result.count).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it("reports no truncation when exactly at the limit and counts only filtered rows", () => {
    const exact = projectFindings([row("a"), row("b")], { limit: 2 });
    expect(exact.count).toBe(exact.rows.length);
    expect(exact.hasMore).toBe(false);
    const aeo = projectFindings([row("seo"), { ...row("aeo"), kind: "fix_business_identity_jsonld" }], { dimension: "aeo" });
    expect(aeo.rows.map(({ id }) => id)).toEqual(["aeo"]);
    expect(aeo.count).toBe(aeo.rows.length);
  });

  it("does not apply observation fixture markers to canonical actions", () => {
    const action = row("ordinary", "some fixture-import source", "project whose name contains fixture");
    const result = projectFindings([action]);
    expect(result.rows).toEqual([action]);
    expect(result.count).toBe(1);
    expect(result.available).toBe(true);
  });

  it("keeps only recorded finding/run relation details; unattached actions remain valid findings", () => {
    const result = projectFindings([row("canonical-action")]);
    expect(result.rows[0].id).toBe("canonical-action");
    expect(result.rows[0].finding).toBeNull();
  });

  it("queries only the requested site and exposes no mutation pathway", async () => {
    findMany.mockResolvedValue([row("site-a-action")]);
    const result = await readFindings("site-a");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "site-a" } }));
    expect(result.rows.map(({ id }) => id)).toEqual(["site-a-action"]);
    expect(Object.keys(db.researchAction)).toEqual(["findMany"]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("cannot return another site's action when the scoped query has no matching rows", async () => {
    findMany.mockResolvedValue([]);
    const result = await readFindings("site-b");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: "site-b" } }));
    expect(result.rows).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("recognizes stored brief/inputs but not a policy pin by itself", () => {
    expect(recordedRunInputState({ brief: { query: "stored" }, topics: null, providers: null })).toBe("brief");
    expect(recordedRunInputState({ brief: null, topics: null, providers: null })).toBe("not_recorded");
    expect(recordedRunInputState({ brief: null, topics: null, providers: null, policyRevision: 4 })).toBe("not_recorded");
    expect(recordedRunInputState({ brief: null, topics: [], providers: [], policyRevision: null })).toBe("not_recorded");
    expect(recordedRunInputState({ brief: null, topics: ["stored topic"], providers: null })).toBe("stored_fields");
  });

  it("does not render an unknown cost as zero", () => {
    expect(formatResearchCost(null)).toBe("Not recorded");
    expect(formatResearchCost(125000)).toBe("$0.1250");
  });
});
