import { describe, expect, it } from "vitest";

import { opportunityAnchor, withOpportunityAnchor } from "@/lib/connectors/opportunity-anchor";

const editorial = (target: { url: string; newAsset: boolean }) => ({
  schemaVersion: "phase3-v1",
  source: "phase3-topic-map",
  lane: "content_business",
  kind: "article",
  readiness: "actionable",
  title: "Freediving breath-hold training",
  summary: "Nine breath queries carry demand the site does not answer.",
  target,
  action: "Write one article.",
  expectedOutcome: "A page aimed at the cluster's main queries.",
  effort: "medium",
});

describe("Opportunity anchor", () => {
  it("projects the editorial target and whether the work creates that page", () => {
    expect(opportunityAnchor({
      type: "O3_content_gap",
      dedupKey: "phase3:content_business:9c756c1f48b284fb",
      scoreInputs: { worth: { targetPages: ["https://oceanicvibes.com/"] } },
      recommendationDecision: editorial({ url: "https://oceanicvibes.com/blog/breath-hold", newAsset: true }),
    })).toEqual({
      pageUrl: "https://oceanicvibes.com/blog/breath-hold",
      newPage: true,
      queries: [],
    });
  });

  it("keeps newPage false when the proposal updates an existing page", () => {
    const anchor = opportunityAnchor({
      type: "O3_content_gap",
      dedupKey: "phase3:content_business:abc",
      scoreInputs: {},
      recommendationDecision: editorial({ url: "https://oceanicvibes.com/", newAsset: false }),
    });
    expect(anchor.newPage).toBe(false);
    expect(anchor.pageUrl).toBe("https://oceanicvibes.com/");
  });

  it("reads the page from a crawl finding's identity, without touching the title", () => {
    expect(opportunityAnchor({
      type: "O7_technical_defect",
      dedupKey: "O7:https://oceanicvibes.com/blog/cenote-or-ocean-first-freediving-course:MISSING_CANONICAL",
      scoreInputs: { worth: { volume: 12 } },
      recommendationDecision: null,
    })).toEqual({
      pageUrl: "https://oceanicvibes.com/blog/cenote-or-ocean-first-freediving-course",
      newPage: null,
      queries: [],
    });
  });

  it("reads an answer-engine observation's query from its identity", () => {
    expect(opportunityAnchor({
      type: "O5_aeo_presence_gap",
      dedupKey: "O5:Where can I find Private freediving coaching from OceanicVibes?",
      scoreInputs: {},
      recommendationDecision: null,
    })).toEqual({
      pageUrl: null,
      newPage: null,
      queries: ["Where can I find Private freediving coaching from OceanicVibes?"],
    });
  });

  it("falls back to the scored page list when no proposal is stored", () => {
    const anchor = opportunityAnchor({
      type: "O4_aeo_citation_gap",
      dedupKey: "phase3:aeo_geo:8b88dc8841d720d3",
      scoreInputs: { worth: { targetPages: ["https://oceanicvibes.com/blog/beyond-the-course", "https://oceanicvibes.com/"] } },
      recommendationDecision: null,
    });
    expect(anchor.pageUrl).toBe("https://oceanicvibes.com/blog/beyond-the-course");
    expect(anchor.newPage).toBeNull();
  });

  it("reports nothing rather than a guess when the record names no anchor", () => {
    expect(opportunityAnchor({
      type: "O13_user_pain_point",
      dedupKey: "O13:A Reddit user asks whether recreational freediving is bad for health long term",
      scoreInputs: { worth: { volume: 40 } },
      recommendationDecision: null,
    })).toEqual({ pageUrl: null, newPage: null, queries: [] });
  });

  it("rejects anchors that are not absolute http(s) URLs or carry no detector code", () => {
    expect(opportunityAnchor({
      type: "O7_technical_defect",
      dedupKey: "O7:ftp://oceanicvibes.com/:DUPLICATE_TITLE",
      scoreInputs: {},
      recommendationDecision: null,
    }).pageUrl).toBeNull();
    expect(opportunityAnchor({
      type: "O8_structured_data_gap",
      dedupKey: "O8:https://oceanicvibes.com/",
      scoreInputs: {},
      recommendationDecision: null,
    }).pageUrl).toBeNull();
  });

  it("reads a rank finding's query and page from its identity", () => {
    expect(opportunityAnchor({
      type: "O1_winnable_rank",
      dedupKey: "O1:freediving course cancun:https://oceanicvibes.com/freediving-course",
      scoreInputs: {},
      recommendationDecision: null,
    })).toEqual({
      pageUrl: "https://oceanicvibes.com/freediving-course",
      newPage: null,
      queries: ["freediving course cancun"],
    });
  });

  it("keeps a query whole when it contains a colon", () => {
    const anchor = opportunityAnchor({
      type: "O2_striking_distance",
      dedupKey: "O2:coaching : tarif groupe:https://oceanicvibes.com/coaching",
      scoreInputs: {},
      recommendationDecision: null,
    });
    expect(anchor.queries).toEqual(["coaching : tarif groupe"]);
    expect(anchor.pageUrl).toBe("https://oceanicvibes.com/coaching");
  });

  it("splits at the last url boundary, so a site: operator query keeps its own url", () => {
    const anchor = opportunityAnchor({
      type: "O1_winnable_rank",
      dedupKey: "O1:site:https://oceanicvibes.com:https://oceanicvibes.com/courses",
      scoreInputs: {},
      recommendationDecision: null,
    });
    expect(anchor.queries).toEqual(["site:https://oceanicvibes.com"]);
    expect(anchor.pageUrl).toBe("https://oceanicvibes.com/courses");
  });

  it("reports the query and no page when the detector recorded an empty url", () => {
    expect(opportunityAnchor({
      type: "O2_striking_distance",
      dedupKey: "O2:freediving drills:",
      scoreInputs: {},
      recommendationDecision: null,
    })).toEqual({ pageUrl: null, newPage: null, queries: ["freediving drills"] });
  });

  it("keeps the query when the recorded url does not validate", () => {
    const anchor = opportunityAnchor({
      type: "O11_freshness_decay",
      dedupKey: "O11:breath hold training:https://",
      scoreInputs: {},
      recommendationDecision: null,
    });
    expect(anchor.pageUrl).toBeNull();
    expect(anchor.queries).toEqual(["breath hold training"]);
  });

  it("reads an overlap observation's query from its identity", () => {
    expect(opportunityAnchor({
      type: "O10_cannibalization",
      dedupKey: "O10:open water certification cancun",
      scoreInputs: {},
      recommendationDecision: null,
    })).toEqual({ pageUrl: null, newPage: null, queries: ["open water certification cancun"] });
  });

  it("reads a page-experience finding's page from its identity", () => {
    expect(opportunityAnchor({
      type: "O12_page_experience",
      dedupKey: "O12:https://oceanicvibes.com/courses",
      scoreInputs: {},
      recommendationDecision: null,
    })).toEqual({ pageUrl: "https://oceanicvibes.com/courses", newPage: null, queries: [] });
    expect(opportunityAnchor({
      type: "O12_page_experience",
      dedupKey: "O12:",
      scoreInputs: {},
      recommendationDecision: null,
    })).toEqual({ pageUrl: null, newPage: null, queries: [] });
  });

  it("keeps the stored row intact and appends the anchor", () => {
    const row = {
      id: "op",
      type: "O7_technical_defect",
      dedupKey: "O7:https://oceanicvibes.com/:DUPLICATE_TITLE",
      scoreInputs: {},
      recommendationDecision: null,
      status: "detected",
    };
    expect(withOpportunityAnchor(row)).toEqual({
      ...row,
      pageUrl: "https://oceanicvibes.com/",
      newPage: null,
      queries: [],
    });
  });
});
