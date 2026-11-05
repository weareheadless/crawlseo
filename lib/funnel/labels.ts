import type { OpportunityDimension, OpportunityType } from "@prisma/client";

/**
 * One vocabulary for the funnel UI (docs/seo-funnel-spine-plan.md §3).
 * The type names are the plan's taxonomy; the short labels are what a person
 * reads on the board. Keeping them in one place stops each screen inventing
 * its own wording for the same thing.
 */

export type OpportunityTypeLabel = {
  code: string;
  label: string;
  /** what the play is, in one sentence — shown on the detail page */
  play: string;
  /** what a win looks like — the success metric from the taxonomy */
  successMetric: string;
  /** which leg normally discovers it */
  firesFrom: "search" | "business" | "both";
};

export const OPPORTUNITY_LABELS: Record<OpportunityType, OpportunityTypeLabel> = {
  O1_winnable_rank: {
    code: "O1",
    label: "Winnable rank",
    play: "Update the page and add internal links to push it into the top 3.",
    successMetric: "Rank delta on the keyword, then traffic delta.",
    firesFrom: "search",
  },
  O2_striking_distance: {
    code: "O2",
    label: "Striking distance",
    play: "Rewrite the title and meta to earn the click at the position we already hold.",
    successMetric: "CTR delta and rank delta.",
    firesFrom: "search",
  },
  O3_content_gap: {
    code: "O3",
    label: "Content gap",
    play: "Build the page or section competitors cover and we do not.",
    successMetric: "Keyword and question coverage, then impressions.",
    firesFrom: "search",
  },
  O4_aeo_citation_gap: {
    code: "O4",
    label: "AI citation gap",
    play: "Answer the question in answer format, using the fact we already hold.",
    successMetric: "Citation present when the question is asked again.",
    firesFrom: "both",
  },
  O5_aeo_presence_gap: {
    code: "O5",
    label: "AI presence gap",
    play: "Subscribe the question to the evaluation schedule.",
    successMetric: "Question moves from unobserved to observed.",
    firesFrom: "business",
  },
  O6_business_fact_mismatch: {
    code: "O6",
    label: "Fact mismatch",
    play: "Correct the page so it matches canonical business knowledge.",
    successMetric: "Knowledge-to-content consistency check passes.",
    firesFrom: "business",
  },
  O7_technical_defect: {
    code: "O7",
    label: "Technical defect",
    play: "Fix the defect, then recrawl to verify.",
    successMetric: "Issue count on the affected pages reaches zero.",
    firesFrom: "search",
  },
  O8_structured_data_gap: {
    code: "O8",
    label: "Structured data gap",
    play: "Add valid JSON-LD matching only the accepted business identity.",
    successMetric: "Rich-result validity, then rank movement on the page.",
    firesFrom: "business",
  },
  O9_backlink_gap: {
    code: "O9",
    label: "Authority gap",
    play: "Outreach or a content asset. Low automation.",
    successMetric: "Referring domains gained.",
    firesFrom: "search",
  },
  O10_cannibalization: {
    code: "O10",
    label: "Query overlap",
    // Overlap is not harm. The old text prescribed consolidation for every case,
    // which is how a legitimate second URL gets deleted.
    play: "Check the query's intent and both pages' content. Consolidate only if they demonstrably compete; otherwise leave them and record why.",
    successMetric: "A recorded decision, and one URL holding the query only where consolidation was justified.",
    firesFrom: "search",
  },
  O11_freshness_decay: {
    code: "O11",
    label: "Position decline",
    // A position that fell is an observation, not a diagnosis.
    play: "Check the SERP, the competitors and the page before changing anything. Refresh only if the check finds a reason to.",
    successMetric: "The cause is identified; rank and impressions recover if the fix addressed it.",
    firesFrom: "search",
  },
  O12_page_experience: {
    code: "O12",
    label: "Page experience",
    play: "Fix the performance problem on the revenue page.",
    successMetric: "Vitals pass, then rank and CTR.",
    firesFrom: "search",
  },
  O13_user_pain_point: {
    code: "O13",
    label: "Customer need",
    // Keyword data is not permission to answer a customer's question.
    play: "Answer the need where the site is weakest: update the page that should cover it, or add the missing answer.",
    successMetric: "The page answers the question in an owner review; traffic if it becomes measurable.",
    firesFrom: "business",
  },
  O14_offer_positioning_gap: {
    code: "O14",
    label: "Positioning gap",
    play: "State the offer where customers compare alternatives, using the page that already covers the topic.",
    successMetric: "The offer is explicit on the page; enquiry quality if it is trackable.",
    firesFrom: "business",
  },
};

export const DIMENSION_LABELS: Record<OpportunityDimension, string> = {
  seo: "SEO",
  aeo: "AEO",
  geo: "GEO",
  content: "Content",
  technical: "Technical",
};

export const STATUS_LABELS: Record<string, string> = {
  detected: "Detected",
  accepted: "Accepted",
  in_progress: "In progress",
  parked: "Parked",
  rejected: "Rejected",
  closed: "Closed",
  todo: "To do",
  awaiting_human: "Awaiting you",
  delivered: "Delivered",
  verified_outcome: "Verified",
};

export const COMPLETENESS_LABELS: Record<string, { label: string; hint: string }> = {
  both: { label: "Two evidence legs", hint: "Business evidence and search evidence both exist. Neither proves the other." },
  why: { label: "Business evidence", hint: "The need is evidenced; the search side is not measured." },
  how: { label: "Search evidence", hint: "The search side is measured; business fit is not established." },
  none: { label: "No evidence", hint: "Recorded without supporting evidence." },
};

export const VERDICT_LABELS: Record<string, string> = {
  verified_win: "Verified win",
  no_effect: "No effect",
  regression: "Regression",
  unmeasured: "Unmeasured",
  pending: "Pending re-check",
};

/** Producer → short source badge. Unknown producers keep their own name. */
export function sourceBadge(producer: string): string {
  switch (producer) {
    case "search_console":
      return "GSC";
    case "crawler":
      return "Crawler";
    case "dataforseo":
      return "DataForSEO";
    case "funnel-detectors":
    case "funnel-refresh":
      return "Detector";
    case "smoke-research":
      return "Research";
    default:
      return producer;
  }
}

const EVIDENCE_KIND_LABELS: Record<string, string> = {
  keyword_rank: "Search Console query",
  keyword_metrics: "Keyword metrics",
  serp_snapshot: "SERP snapshot",
  serp_features: "SERP features",
  intent_label: "Intent label",
  competitor_rank: "Competitor rank",
  backlink_profile: "Backlink profile",
  share_of_voice: "Share of voice",
  keyword_universe_membership: "Cluster membership",
  onpage_crawl: "Crawl observation",
  internal_link_graph: "Internal link graph",
  ai_visibility_observation: "AI visibility",
  gsc_query: "Search Console query",
  gsc_page: "Search Console page",
  vitals: "Core Web Vitals",
  analytics: "Analytics",
  knowledge_fact: "Business knowledge",
  question_coverage: "Question coverage",
  research_finding: "Research finding",
};

export function evidenceKindLabel(kind: string): string {
  return EVIDENCE_KIND_LABELS[kind] ?? kind.replaceAll("_", " ");
}
