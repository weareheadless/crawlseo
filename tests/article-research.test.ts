import { describe, expect, it } from "vitest";
import {
  normalizeArticleResearchQueries,
  normalizeArticleResearchSeed,
} from "@/lib/dataforseo/article-research";

describe("article research seed contract", () => {
  it("normalizes whitespace without changing one query", () => {
    expect(normalizeArticleResearchSeed("  freediving   coach  ")).toBe("freediving coach");
  });

  it.each(["freediving coach; AIDA instructor", "freediving coach, AIDA instructor", "freediving coach | AIDA instructor", "freediving\ncoach"]) (
    "rejects multiple queries separated by delimiters: %s",
    (seed) => {
      expect(() => normalizeArticleResearchSeed(seed)).toThrow(
        "seed must be one concise query"
      );
    }
  );
});

describe("article research candidate queries contract", () => {
  const five = [
    "freediving playa del carmen",
    "cenote freediving for beginners",
    "how to choose a freediving course",
    "finding a freediving buddy",
    "freediving safety rules",
  ];

  it("accepts 5 and 10 unique bounded queries", () => {
    expect(normalizeArticleResearchQueries(five)).toEqual(five);
    const ten = [...five, "freediving equipment list", "freediving certification cost", "freediving vs scuba", "freediving breathing techniques", "freediving ear equalization"];
    expect(normalizeArticleResearchQueries(ten)).toHaveLength(10);
  });

  it.each([4, 11])("rejects %i candidates before any provider call", (count) => {
    const queries = Array.from({ length: count }, (_, index) => `candidate query ${index}`);
    expect(() => normalizeArticleResearchQueries(queries)).toThrow(
      "queries must contain 5 to 10 candidates"
    );
  });

  it("rejects duplicate queries case-insensitively", () => {
    expect(() => normalizeArticleResearchQueries([
      "Freediving Playa del Carmen",
      "freediving playa del carmen",
      "cenote freediving for beginners",
      "finding a freediving buddy",
      "freediving safety rules",
    ])).toThrow("queries must be unique");
  });

  it("rejects list-shaped individual queries", () => {
    expect(() => normalizeArticleResearchQueries([
      "freediving playa del carmen; cenote freediving",
      "cenote freediving for beginners",
      "finding a freediving buddy",
      "freediving safety rules",
      "freediving equipment list",
    ])).toThrow("seed must be one concise query");
  });
});
