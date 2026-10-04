import { describe, expect, it } from "vitest";
import {
  cachedBacklinksReport,
  cachedDomainReport,
  cachedKeywordReport,
  taskDefinitions,
  validateResearchBrief,
} from "@/lib/dataforseo/research";
import { resolveDataForSeoLocaleFromCatalog } from "@/lib/dataforseo/locale";

const localeCatalog = [
  { country: "US", languageCode: "en", locationCode: 2840 },
  { country: "MX", languageCode: "es", locationCode: 2484 },
  { country: "FR", languageCode: "fr", locationCode: 2250 },
];

const brief = {
  period: "2026-07",
  focus_market: { language: "en", country: "US" },
  business_goal: "Grow qualified organic reach",
  audience: ["Intent-driven buyers"],
  priority_services: ["Advisory"],
  keyword_seeds: ["one", "two", "three", "four", "five"],
  competitor: "competitor.example",
  research_questions: ["What should we write next?"],
  selection_rationale: {
    market: "The primary market has the clearest business priority",
    seeds: ["one", "two", "three", "four", "five"],
    competitor: "Configured direct competitor",
  },
  package: "standard-v1",
};

const report = {
  dataforseo: [
    {
      kind: "domain_overview",
      status: "completed",
      input: { domain: "site.example", language_code: "en", location_code: 2840 },
      result: { organicKeywords: 10 },
    },
    {
      kind: "backlinks_overview",
      status: "completed",
      input: { domain: "site.example" },
      result: { totalBacklinks: 20 },
    },
    {
      kind: "keyword_seed",
      status: "completed",
      input: { seed: "one" },
      result: [{ keyword: "one guide", volume: 100 }],
    },
  ],
};

describe("SEO research contract", () => {
  it("requires the fixed five-seed brief shape", () => {
    expect(validateResearchBrief(brief)).toMatchObject({
      period: "2026-07",
      focus_market: { language: "en", country: "US" },
      keyword_seeds: brief.keyword_seeds,
    });
    expect(() => validateResearchBrief({ ...brief, keyword_seeds: ["one"] })).toThrow(
      "keyword_seeds must contain exactly 5 items"
    );
  });

  it("allows competitor research to be skipped without spending competitor tasks", () => {
    const noCompetitor = validateResearchBrief({
      ...brief,
      competitor: null,
      selection_rationale: {
        ...brief.selection_rationale,
        competitor: "No reliable in-category competitor was available",
      },
    });
    const locale = resolveDataForSeoLocaleFromCatalog(
      localeCatalog,
      noCompetitor.focus_market.language,
      noCompetitor.focus_market.country
    );
    const tasks = taskDefinitions("site.example", noCompetitor, locale);
    expect(noCompetitor.competitor).toBeNull();
    expect(tasks).toHaveLength(7);
    expect(tasks.some((task) => task.operationKey.includes("competitor"))).toBe(false);
    expect(tasks[0].input).toMatchObject({ language_code: "en", location_code: 2840 });
    expect(tasks[2].input).toMatchObject({ language_code: "en", location_code: 2840 });
  });

  it("resolves provider codes from the country-scoped Google catalog", () => {
    expect(resolveDataForSeoLocaleFromCatalog(localeCatalog, "EN-US", "us")).toEqual({
      language: "en-us",
      languageCode: "en",
      country: "US",
      locationCode: 2840,
    });
    expect(resolveDataForSeoLocaleFromCatalog(localeCatalog, "es", "MX")).toMatchObject({
      languageCode: "es",
      locationCode: 2484,
    });
    expect(() => resolveDataForSeoLocaleFromCatalog(localeCatalog, "en", "MX")).toThrow(
      "available languages: es"
    );
  });

  it("serves dashboard data from completed cached tasks only", () => {
    expect(cachedDomainReport(report, "site.example")).toEqual({ organicKeywords: 10 });
    expect(cachedBacklinksReport(report, "site.example")).toEqual({ totalBacklinks: 20 });
    expect(cachedKeywordReport(report, "one")).toEqual([{ keyword: "one guide", volume: 100 }]);
    expect(cachedKeywordReport(report, "missing")).toBeNull();
  });
});
