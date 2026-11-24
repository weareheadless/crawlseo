import { describe, expect, it } from "vitest";

import { extractSerpCompetitors } from "@/lib/dataforseo/serp-competitors";
import { resolveRankedResult } from "@/lib/dataforseo/serp-attribution";

/**
 * CMP-003: which domains a paid SERP says are beating us.
 *
 * This is the rule the live collector and the backfill both use, so it is tested
 * on the response shape the provider actually returns — live organic items whose
 * `url` is an opaque `google.com/goto` wrapper and whose identity is the
 * breadcrumb (CMP-001).
 *
 * The acceptance cases each have a test: we rank #1 → no competitors; we are
 * absent → one row per attributable domain; an unobserved SERP → nothing at all.
 */

/** One organic item as the provider returns it: a wrapper URL plus a breadcrumb. */
function item(breadcrumb: string, rank: number | null, url = "https://www.google.com/goto?url=CAES") {
  // The shape the collector sees: `rankAbsolute` after the client maps the
  // provider's snake_case payload into our own type.
  return { rankAbsolute: rank, rank: null, url, domain: null, breadcrumb, websiteName: "" };
}

describe("CMP-003 attribution comes from the breadcrumb", () => {
  it("recovers the real host from a wrapper item", () => {
    const resolved = resolveRankedResult(item("https://rival.com › condos", 3) as never);
    expect(resolved?.domain).toBe("rival.com");
  });

  it("refuses to attribute an item with no breadcrumb", () => {
    // A wrapper URL is not a domain; storing it would put google.com on the board.
    expect(resolveRankedResult(item("", 2) as never)).toBeNull();
  });
});

describe("CMP-003 which domains are beating us", () => {
  it("names every domain above our position", () => {
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [
        item("https://a.com › page", 1),
        item("https://b.com › page", 2),
        item("https://oursite.com › page", 4),
        item("https://c.com › page", 7),
      ],
    });
    expect(result.ourPosition).toBe(4);
    expect(result.competitors.map((row) => row.domain)).toEqual(["a.com", "b.com"]);
    // c.com ranks below us and was never beating us.
    expect(result.competitors.map((row) => row.domain)).not.toContain("c.com");
  });

  it("names nobody when we rank first", () => {
    // The acceptance: for a query we lead, no competitor row exists.
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [item("https://oursite.com › page", 1), item("https://a.com › page", 2)],
    });
    expect(result.ourPosition).toBe(1);
    expect(result.competitors).toEqual([]);
  });

  it("names every attributable domain when we are absent", () => {
    // The acceptance: when we do not appear, one row per attributable domain.
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [
        item("https://a.com › page", 1),
        item("https://b.com › page", 3),
        item("https://c.com › page", 5),
      ],
    });
    expect(result.ourPosition).toBe(0);
    expect(result.competitors.map((row) => row.domain)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("produces nothing for an unobserved SERP", () => {
    // An empty result set is evidence of nothing, not evidence that nobody covers
    // the query — the same defect CMP-001 fixed for `competitorCovered`.
    const result = extractSerpCompetitors({ domain: "oursite.com", organic: [] });
    expect(result.observed).toBe(false);
    expect(result.competitors).toEqual([]);
    expect(result.ourPosition).toBe(0);
  });

  it("keeps one row per domain at the domain's best position", () => {
    // A SERP can list several pages from one site; two rows for one domain would
    // inflate its query count.
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [
        item("https://a.com › one", 1),
        item("https://a.com › two", 3),
        item("https://a.com › three", 6),
        item("https://oursite.com › page", 12),
      ],
    });
    const a = result.competitors.find((row) => row.domain === "a.com");
    expect(a?.position).toBe(1);
    expect(result.competitors.filter((row) => row.domain === "a.com")).toHaveLength(1);
  });

  it("does not match a lookalike domain as our own site", () => {
    // "notoursite.com" is not ours; treating it as a match would report our own
    // position from a competitor's SERP entry.
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [item("https://notoursite.com › page", 2), item("https://a.com › page", 5)],
    });
    expect(result.ourPosition).toBe(0);
    // Sorted by position: notoursite.com is #2, a.com is #5.
    expect(result.competitors.map((row) => row.domain)).toEqual(["notoursite.com", "a.com"]);
  });

  it("matches our own www and bare domain the same way", () => {
    const result = extractSerpCompetitors({
      domain: "www.oursite.com",
      organic: [item("https://a.com › page", 1), item("https://oursite.com › page", 8)],
    });
    expect(result.ourPosition).toBe(8);
    expect(result.competitors.map((row) => row.domain)).toEqual(["a.com"]);
  });

  it("falls back to the list position when the provider omits a rank", () => {
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [item("https://a.com › page", null), item("https://oursite.com › page", null)],
    });
    // Positions 1 and 2 from list order; we are second, so a.com is above us.
    expect(result.ourPosition).toBe(2);
    expect(result.competitors.map((row) => row.domain)).toEqual(["a.com"]);
  });

  it("orders competitors by position so the leaderboard reads top-down", () => {
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [
        item("https://late.com › page", 9),
        item("https://early.com › page", 2),
        item("https://mid.com › page", 5),
        item("https://oursite.com › page", 15),
      ],
    });
    expect(result.competitors.map((row) => row.domain)).toEqual(["early.com", "mid.com", "late.com"]);
  });

  it("reports how many items it could attribute", () => {
    const result = extractSerpCompetitors({
      domain: "oursite.com",
      organic: [item("https://a.com › page", 1), item("", 2), item("https://b.com › page", 3)],
    });
    // The breadcrumb-less wrapper is not evidence and is not counted.
    expect(result.attributable).toBe(2);
    expect(result.competitors).toHaveLength(2);
  });
});
