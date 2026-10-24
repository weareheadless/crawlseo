import { describe, expect, it } from "vitest";
import {
  keywordPriorityFor,
  opportunityPriorityForAction,
} from "@/lib/ai-seo/opportunity-priority";

describe("opportunity priority", () => {
  it("explains the GSC opportunity score and the attached keyword demand", () => {
    const priority = opportunityPriorityForAction({
      kind: "improve_page",
      priority: 81,
      evidence: {
        signals: ["striking_distance", "low_ctr"],
        expected_clicks: 152,
        metrics: {
          position: 7.3,
          clicks: 2,
          impressions: 2196,
          ctr: 0.09,
          expected_ctr: 3,
          ctr_gap: 2.91,
        },
        keyword_research: {
          keyword: "hospital near me",
          volume: 1000,
          difficulty: 40,
          cpc: 1.2,
        },
      },
    });

    expect(priority).toMatchObject({
      signals: ["striking_distance", "low_ctr"],
      expectedClicks: 152,
      impressions: 2196,
      impact: 74,
      confidence: 88,
      effort: 38,
      seoScore: 75,
      keywordScore: 81,
      finalPriority: 81,
    });
  });

  it("keeps cannibalization effort in the score", () => {
    const priority = opportunityPriorityForAction({
      kind: "consolidate_pages",
      priority: 60,
      evidence: {
        signals: ["cannibalization"],
        expected_clicks: 15,
        metrics: { competing_pages: 3, impressions: 400 },
      },
    });

    expect(priority).toMatchObject({
      signals: ["cannibalization"],
      effort: 78,
      seoScore: 45,
    });
  });

  it("returns null when no opportunity evidence is attached", () => {
    expect(opportunityPriorityForAction({
      kind: "improve_page",
      priority: 50,
      evidence: { keyword_research: { keyword: "example", volume: 10 } },
    })).toBeNull();
  });

  it("computes keyword priority consistently", () => {
    expect(keywordPriorityFor(1000, 40)).toBe(81);
    expect(keywordPriorityFor(null, null)).toBe(25);
  });
});
